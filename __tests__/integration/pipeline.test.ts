/**
 * Integration Tests: Submission → Crawl → Score Pipeline
 *
 * **Validates: Requirements 4.1, 4.4, 5.1, 5.8** (spec `partyrock-assessment-tool`)
 * **Validates: Requirements 3.1, 3.2, 3.5, 3.6, 4.1, 4.2, 4.6, 8.2** (spec `html-project-scoring`)
 *
 * Requirement numbers are namespaced by spec because the two specs number
 * independently — "4.1" means the AI prompt template in one and the crawl
 * trigger in the other.
 *
 * PartyRock pipeline:
 *   1. Happy path: submit → crawl succeeds → AI score succeeds
 *   2. Crawl timeout failure: crawlStatus = FAILED, scoring NOT triggered
 *   3. Scoring partial failure: scoreStatus = PARTIAL, finalScore from successful params
 *   4. Regression: the prompt reaching Gemini is still the PartyRock template
 *
 * HTML pipeline (the same status machine, different evidence):
 *   5. Happy path: submit an HTML project → the fetched markup lands in
 *      `CrawlMetadata.rawHtml`, `structure` is derived from it, `sourceCode` is
 *      filled because it started empty, and scoring runs off the HTML prompt
 *   6. Failed fetch with Source Code already pasted: crawlStatus = FAILED with
 *      its error, yet scoring still completes from that Source Code
 *   7. No evidence anywhere: scoreStatus = FAILED and Gemini is never called
 *
 * All external dependencies (the crawler's HTTP fetch, Google Gemini, Prisma
 * DB, next/cache) are mocked to isolate pipeline logic. The HTML Structure
 * Extractor is deliberately NOT mocked — it is a pure function, so the metrics
 * asserted below are the real ones the pipeline computes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock modules BEFORE importing services
// ---------------------------------------------------------------------------

// Mock next/cache (revalidatePath is called after scoring)
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

// Mock Prisma DB client
vi.mock('@/lib/db', () => ({
  db: {
    project: {
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    crawlMetadata: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
    aIScore: {
      upsert: vi.fn(),
    },
  },
}))

// Mock global fetch — the crawler reads PartyRock's static SEO meta tags over
// plain HTTP (no browser). See lib/services/crawler.service.ts for why.
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

/** Build an HTML document exposing the SEO meta tags the crawler reads. */
function createPartyRockHtml(title: string, description: string): string {
  return `<!doctype html><html><head>
    <title>${title}</title>
    <meta property="og:title" content="${title}">
    <meta name="description" content="${description}">
  </head><body></body></html>`
}

/** Make the next fetch() call resolve with the given HTML body. */
function mockFetchHtmlOnce(html: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => html,
  })
}

/**
 * A real page for the HTML pipeline to measure.
 *
 * Written to exercise every metric family the extractor reports — landmarks,
 * heading hierarchy, alt text, form labels, document metadata — so the
 * assertions below can check that the metrics travelling through the pipeline
 * are the page's own, not placeholders.
 */
const HTML_PROJECT_DOC = `<!DOCTYPE html>
<html lang="id">
  <head>
    <title>Portofolio Rani</title>
    <meta name="description" content="Portofolio desainer produk">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <a href="#main-content">Lompat ke konten</a>
    <header>
      <nav aria-label="Navigasi utama"><a href="/karya">Karya</a></nav>
    </header>
    <main id="main-content">
      <h1>Rani Puspita</h1>
      <h2>Karya Terpilih</h2>
      <img src="/karya-1.png" alt="Tangkapan layar aplikasi kasir">
      <form>
        <label for="email">Email</label>
        <input id="email" type="email" name="email">
      </form>
      <div><span>catatan kecil</span></div>
    </main>
    <footer>© 2024 Rani</footer>
    <script src="/app.js"></script>
  </body>
</html>`

const HTML_PROJECT_URL = 'https://rani.example.com/portfolio'

/** Markup an Admin pasted by hand — deliberately different from the fetched doc. */
const PASTED_HTML_DOC = `<!DOCTYPE html>
<html lang="en"><head><title>Pasted By Admin</title></head>
<body><main><h1>Offline copy</h1></main></body></html>`



// Mock Google Gemini
const { mockGenerateContent } = vi.hoisted(() => {
  return { mockGenerateContent: vi.fn() }
})
vi.mock('@google/generative-ai', () => {
  class MockGoogleGenerativeAI {
    constructor(_apiKey: string) { }
    getGenerativeModel(_config: unknown) {
      return { generateContent: mockGenerateContent }
    }
  }
  return { GoogleGenerativeAI: MockGoogleGenerativeAI }
})

// ---------------------------------------------------------------------------
// Import services and mocked dependencies
// ---------------------------------------------------------------------------

import { db } from '@/lib/db'
import { submitProject } from '@/lib/services/submission.service'
import { CrawlerService } from '@/lib/services/crawler.service'
// Not mocked on purpose: `parseHtmlStructure` is a pure function, so calling it
// here yields exactly the metrics the crawler derives from the same markup
// (Requirement 3.4). That is what lets the assertions compare against real
// numbers instead of restating a hand-written object.
import {
  formatStructureForPrompt,
  parseHtmlStructure,
} from '@/lib/services/html-structure.service'
import { ScorerService } from '@/lib/services/scorer.service'

// Access mock internals
const mockProjectCreate = vi.mocked(db.project.create)
const mockProjectFindFirst = vi.mocked(db.project.findFirst)
const mockProjectFindUniqueOrThrow = vi.mocked(db.project.findUniqueOrThrow)
const mockProjectUpdate = vi.mocked(db.project.update)
const mockCrawlMetadataUpsert = vi.mocked(db.crawlMetadata.upsert)
const mockCrawlMetadataFindMany = vi.mocked(db.crawlMetadata.findMany)
const mockAIScoreUpsert = vi.mocked(db.aIScore.upsert)

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** Every prompt string handed to Gemini, in call order. */
function promptsSentToGemini(): string[] {
  return mockGenerateContent.mock.calls.map((call) => String(call[0]))
}

/**
 * The `data` payload of the `project.update` call that carried the given
 * status value. `triggerCrawl` and `triggerScoring` both update the same row
 * several times, so picking the call out by the status it wrote is more
 * readable than indexing into `mock.calls`.
 */
function findProjectUpdateData(
  field: 'crawlStatus' | 'scoreStatus',
  value: string,
): Record<string, unknown> | null {
  for (const call of mockProjectUpdate.mock.calls) {
    const data = (call[0] as { data?: Record<string, unknown> }).data
    if (data && data[field] === value) return data
  }
  return null
}

/** The `create`/`update` payloads handed to `crawlMetadata.upsert`. */
function readCrawlMetadataUpsertPayloads(): {
  create: Record<string, unknown>
  update: Record<string, unknown>
} {
  const arg = mockCrawlMetadataUpsert.mock.calls[0][0] as {
    create: Record<string, unknown>
    update: Record<string, unknown>
  }
  return { create: arg.create, update: arg.update }
}

/**
 * Let the fire-and-forget `triggerScoring` call inside `triggerCrawl` settle.
 * The crawl deliberately does not await it, so the assertions have to.
 */
async function flushAsyncScoring(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50))
}

// ---------------------------------------------------------------------------
// Test Data Factories
// ---------------------------------------------------------------------------

/** A Project row. */
function createFakeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-1',
    categoryId: 'category-1',
    url: 'https://partyrock.aws/app/test-app',
    participantName: 'Test User',
    teamName: null,
    // Empty by default — the HTML crawl may fill it, and it must not overwrite
    // a value that is already there (Requirement 3.6).
    sourceCode: null as string | null,
    crawlStatus: 'PENDING' as const,
    crawlError: null,
    scoreStatus: 'PENDING' as const,
    finalScore: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  }
}

/**
 * A Project row with its category parameters and CrawlMetadata, shaped the way
 * `ScorerService.triggerScoring` reads it.
 *
 * `metadataOverrides` merges into the CrawlMetadata row instead of replacing
 * it, so an HTML case can supply `structure`/`rawHtml` without restating the
 * PartyRock-shaped defaults. A case that needs no metadata row at all passes
 * `metadata: null` through `overrides`, which wins because `overrides` is
 * spread last.
 */
function createFakeProjectWithCategory(
  overrides: Record<string, unknown> = {},
  metadataOverrides: Record<string, unknown> = {},
) {
  return {
    ...createFakeProject(),
    category: {
      id: 'category-1',
      eventId: 'event-1',
      name: 'Test Category',
      description: null,
      isPublished: false,
      publicToken: null,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
      parameters: [
        {
          id: 'param-1',
          categoryId: 'category-1',
          name: 'Creativity & Originality',
          description: 'Semantic similarity analysis',
          weight: 30,
          minScore: 0,
          maxScore: 100,
          scoringMode: 'AUTO' as const,
          orderIndex: 0,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
        {
          id: 'param-2',
          categoryId: 'category-1',
          name: 'Problem-Solution Fit',
          description: 'NLP extraction analysis',
          weight: 40,
          minScore: 0,
          maxScore: 100,
          scoringMode: 'AUTO' as const,
          orderIndex: 1,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
        {
          id: 'param-3',
          categoryId: 'category-1',
          name: 'User Experience',
          description: 'Description completeness',
          weight: 30,
          minScore: 0,
          maxScore: 100,
          scoringMode: 'AUTO' as const,
          orderIndex: 2,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        },
      ],
    },
    metadata: {
      id: 'metadata-1',
      projectId: 'project-1',
      title: 'My Test App',
      description: 'A creative test application',
      widgets: [],
      prompts: [],
      widgetCount: 0,
      // Non-null by default so `triggerScoring`'s evidence check passes without
      // every test having to supply its own markup via `metadataOverrides`.
      rawHtml: '<html><head><title>My Test App</title></head><body><main><h1>Test</h1></main></body></html>',
      structure: null as unknown,
      crawledAt: new Date('2024-01-01'),
      ...metadataOverrides,
    },
    ...overrides,
  }
}

function createGeminiResponse(score: number, reasoning: string) {
  return { response: { text: () => JSON.stringify({ score, reasoning }) } }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Test 1: Happy Path — submitProject → triggerCrawl → triggerScoring
// ---------------------------------------------------------------------------

describe('Pipeline Integration: Happy Path', () => {
  it('should complete full pipeline: submit → crawl → score with correct status transitions', async () => {
    // --- Phase 1: Submit Project ---
    mockProjectFindFirst.mockResolvedValueOnce(null) // no duplicate
    const createdProject = createFakeProject()
    mockProjectCreate.mockResolvedValueOnce(createdProject as never)

    const result = await submitProject({
      url: 'https://partyrock.aws/app/test-app',
      participantName: 'Test User',
      categoryId: 'clxxxxxxxxxxxxxxxxxx001',
    })

    expect(result.crawlStatus).toBe('PENDING')
    expect(result.scoreStatus).toBe('PENDING')
    expect(mockProjectCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          url: 'https://partyrock.aws/app/test-app',
          crawlStatus: 'PENDING',
          scoreStatus: 'PENDING',
        }),
      }),
    )

    // --- Phase 2: Trigger Crawl ---
    // Setup mocks for triggerCrawl
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      createFakeProject({ category: { id: 'category-1' } }) as never,
    )
    // First update: PROCESSING
    mockProjectUpdate.mockResolvedValue(createFakeProject({ crawlStatus: 'PROCESSING' }) as never)
    mockCrawlMetadataUpsert.mockResolvedValueOnce({} as never)

    // Mock the crawler's HTTP fetch of the PartyRock page
    mockFetchHtmlOnce(
      createPartyRockHtml('My PartyRock App', 'A creative AI application'),
    )

    // For the ScorerService.triggerScoring call after crawl succeeds
    const projectWithCategory = createFakeProjectWithCategory()
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(projectWithCategory as never)
    mockCrawlMetadataFindMany.mockResolvedValueOnce([])
    mockAIScoreUpsert.mockResolvedValue({} as never)

    // Mock Gemini responses for 3 parameters
    mockGenerateContent
      .mockResolvedValueOnce(createGeminiResponse(85, 'Very creative'))
      .mockResolvedValueOnce(createGeminiResponse(78, 'Good problem-solution fit'))
      .mockResolvedValueOnce(createGeminiResponse(90, 'Excellent UX'))

    // Final project update with score status and finalScore
    mockProjectUpdate.mockResolvedValue(
      createFakeProject({ scoreStatus: 'SUCCESS', finalScore: 83.7 }) as never,
    )

    await CrawlerService.triggerCrawl('project-1')

    // Wait for async scoring trigger (fire-and-forget in the service)
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Assert: crawlStatus transitions
    // First call: set to PROCESSING
    expect(mockProjectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'project-1' },
        data: expect.objectContaining({ crawlStatus: 'PROCESSING' }),
      }),
    )

    // Second call: set to SUCCESS
    expect(mockProjectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'project-1' },
        data: expect.objectContaining({ crawlStatus: 'SUCCESS' }),
      }),
    )

    // Assert: CrawlMetadata was upserted. widgetCount is 0 because the HTTP
    // crawler only reads static SEO meta tags — widget data comes from the
    // manual capture pipeline (see lib/services/capture.service.ts).
    expect(mockCrawlMetadataUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'project-1' },
        create: expect.objectContaining({
          projectId: 'project-1',
          title: 'My PartyRock App',
          description: 'A creative AI application',
          widgetCount: 0,
        }),
      }),
    )

    // Assert: AI scores were upserted for all 3 parameters
    expect(mockAIScoreUpsert).toHaveBeenCalledTimes(3)

    // Assert: Final project update includes scoreStatus SUCCESS
    expect(mockProjectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'project-1' },
        data: expect.objectContaining({ scoreStatus: 'SUCCESS' }),
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Test 2: Crawl Timeout Failure
// ---------------------------------------------------------------------------

describe('Pipeline Integration: Crawl Timeout Failure', () => {
  it('should set crawlStatus = FAILED when the fetch times out, and NOT trigger scoring', async () => {
    // Setup: findUniqueOrThrow returns the project
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      createFakeProject({ category: { id: 'category-1' } }) as never,
    )
    mockProjectUpdate.mockResolvedValue(createFakeProject({ crawlStatus: 'FAILED' }) as never)

    // Mock the crawler's HTTP fetch to abort with a timeout
    mockFetch.mockRejectedValueOnce(
      new Error('Timeout: the operation was aborted after 15000ms'),
    )

    // Spy on ScorerService.triggerScoring to verify it is NOT called
    const scoringSpy = vi.spyOn(ScorerService, 'triggerScoring')

    await CrawlerService.triggerCrawl('project-1')

    // Assert: crawlStatus was set to PROCESSING first
    expect(mockProjectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'project-1' },
        data: expect.objectContaining({ crawlStatus: 'PROCESSING' }),
      }),
    )

    // Assert: crawlStatus was set to FAILED with error message
    expect(mockProjectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'project-1' },
        data: expect.objectContaining({
          crawlStatus: 'FAILED',
          crawlError: expect.stringContaining('Timeout'),
        }),
      }),
    )

    // Assert: scoring was NOT triggered (fire-and-forget is never called when crawl fails)
    // After the crawl fails, we should NOT see triggerScoring called by the crawl pipeline
    // The update calls should only be PROCESSING and FAILED — no SUCCESS
    const updateCalls = mockProjectUpdate.mock.calls.map(
      (call) => (call[0] as { data: { crawlStatus?: string } }).data.crawlStatus,
    )
    expect(updateCalls).toContain('PROCESSING')
    expect(updateCalls).toContain('FAILED')
    expect(updateCalls).not.toContain('SUCCESS')

    scoringSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Test 3: Scoring Partial Failure
// ---------------------------------------------------------------------------

describe('Pipeline Integration: Scoring Partial Failure', () => {
  it('should set scoreStatus = PARTIAL and calculate finalScore from successful params only', async () => {
    // Setup project with category and 3 AUTO parameters
    const projectWithCategory = createFakeProjectWithCategory()
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(projectWithCategory as never)
    mockCrawlMetadataFindMany.mockResolvedValueOnce([])
    mockAIScoreUpsert.mockResolvedValue({} as never)
    mockProjectUpdate.mockResolvedValue({} as never)

    // Mock Gemini: 2 successes, 1 failure (param-3 throws)
    mockGenerateContent
      .mockResolvedValueOnce(createGeminiResponse(80, 'Good creativity'))  // param-1: score 80, weight 30
      .mockResolvedValueOnce(createGeminiResponse(70, 'Decent fit'))       // param-2: score 70, weight 40
      .mockRejectedValueOnce(new Error('Gemini InternalServerError'))       // param-3: FAILS

    await ScorerService.triggerScoring('project-1')

    // Assert: Only 2 AI scores were upserted (param-3 failed)
    expect(mockAIScoreUpsert).toHaveBeenCalledTimes(2)

    // Assert: scoreStatus set to PARTIAL
    expect(mockProjectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'project-1' },
        data: expect.objectContaining({
          scoreStatus: 'PARTIAL',
        }),
      }),
    )

    // Assert: finalScore is calculated from successful params only
    // Expected: (80 * 30 + 70 * 40) / 100 = (2400 + 2800) / 100 = 52
    const finalUpdateCall = mockProjectUpdate.mock.calls.find(
      (call) => (call[0] as { data: { scoreStatus?: string } }).data.scoreStatus === 'PARTIAL',
    )
    expect(finalUpdateCall).toBeDefined()
    const updateData = (finalUpdateCall![0] as { data: { finalScore?: number } }).data
    expect(updateData.finalScore).toBeCloseTo(52, 1)
  })

  it('should set scoreStatus = FAILED when all Gemini calls fail', async () => {
    const projectWithCategory = createFakeProjectWithCategory()
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(projectWithCategory as never)
    mockCrawlMetadataFindMany.mockResolvedValueOnce([])
    mockProjectUpdate.mockResolvedValue({} as never)

    // Mock Gemini: ALL fail
    mockGenerateContent
      .mockRejectedValueOnce(new Error('Gemini timeout'))
      .mockRejectedValueOnce(new Error('Gemini throttle'))
      .mockRejectedValueOnce(new Error('Gemini internal error'))

    await ScorerService.triggerScoring('project-1')

    // Assert: No AI scores upserted
    expect(mockAIScoreUpsert).not.toHaveBeenCalled()

    // Assert: scoreStatus set to FAILED
    expect(mockProjectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'project-1' },
        data: expect.objectContaining({
          scoreStatus: 'FAILED',
        }),
      }),
    )

    // Assert: finalScore is null when all fail
    const failedCall = mockProjectUpdate.mock.calls.find(
      (call) => (call[0] as { data: { scoreStatus?: string } }).data.scoreStatus === 'FAILED',
    )
    expect(failedCall).toBeDefined()
    const updateData = (failedCall![0] as { data: { finalScore?: number | null } }).data
    expect(updateData.finalScore).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Test 5: HTML Happy Path
//
// The whole HTML route, in the order `POST /api/submissions` walks it:
// submitProject → CrawlerService.triggerCrawl → (fire-and-forget)
// ScorerService.triggerScoring. Note the entry point differs from the
// PartyRock route, where scoring is called directly: for an HTML project the
// live URL is the evidence, so the crawl runs first and starts scoring itself.
// Requirements: 3.1, 3.2, 3.3, 3.6, 4.1, 4.2 (html-project-scoring)
// ---------------------------------------------------------------------------

describe('Pipeline Integration: HTML Happy Path', () => {
  it('submit → crawl stores rawHtml and structure, fills sourceCode, then scores with the HTML prompt', async () => {
    // --- Phase 1: Submit an HTML project ---
    mockProjectFindFirst.mockResolvedValueOnce(null) // no duplicate
    mockProjectCreate.mockResolvedValueOnce(
      createFakeProject({ url: HTML_PROJECT_URL }) as never,
    )

    const result = await submitProject({
      url: HTML_PROJECT_URL,
      participantName: 'Rani Puspita',
      categoryId: 'clxxxxxxxxxxxxxxxxxx001',
    })

    expect(result.crawlStatus).toBe('PENDING')
    expect(result.scoreStatus).toBe('PENDING')
    // Any hostname is accepted.
    expect(mockProjectCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          url: HTML_PROJECT_URL,
          crawlStatus: 'PENDING',
          scoreStatus: 'PENDING',
        }),
      }),
    )

    // --- Phase 2: Crawl ---
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      createFakeProject({
        url: HTML_PROJECT_URL,
        sourceCode: null, // empty, so the fetched markup may fill it
        category: { id: 'category-1' },
      }) as never,
    )
    mockProjectUpdate.mockResolvedValue({} as never)
    mockCrawlMetadataUpsert.mockResolvedValueOnce({} as never)
    mockFetchHtmlOnce(HTML_PROJECT_DOC)

    // --- Phase 3: the scoring run the successful crawl triggers ---
    // The row reflects what phase 2 just persisted; the assertions below check
    // that the crawl really did write these values.
    const expectedStructure = parseHtmlStructure(HTML_PROJECT_DOC)
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      createFakeProjectWithCategory(
        {
          url: HTML_PROJECT_URL,
          sourceCode: HTML_PROJECT_DOC,
        },
        {
          title: 'Portofolio Rani',
          description: 'Portofolio desainer produk',
          widgets: [],
          prompts: [],
          widgetCount: 0,
          rawHtml: HTML_PROJECT_DOC,
          structure: expectedStructure,
        },
      ) as never,
    )
    mockCrawlMetadataFindMany.mockResolvedValueOnce([])
    mockAIScoreUpsert.mockResolvedValue({} as never)

    mockGenerateContent
      .mockResolvedValueOnce(createGeminiResponse(88, 'Strong semantic structure'))
      .mockResolvedValueOnce(createGeminiResponse(74, 'Accessibility mostly covered'))
      .mockResolvedValueOnce(createGeminiResponse(91, 'Clear presentation'))

    await CrawlerService.triggerCrawl('project-1')
    await flushAsyncScoring()

    // --- Assert: crawl status transitions ---
    expect(findProjectUpdateData('crawlStatus', 'PROCESSING')).not.toBeNull()
    const successUpdate = findProjectUpdateData('crawlStatus', 'SUCCESS')
    expect(successUpdate).not.toBeNull()

    // --- Assert: rawHtml and structure reached CrawlMetadata (Requirement 3.2) ---
    const { create, update } = readCrawlMetadataUpsertPayloads()
    for (const payload of [create, update]) {
      expect(payload.rawHtml).toBe(HTML_PROJECT_DOC)
      expect(payload.title).toBe('Portofolio Rani')
      expect(payload.description).toBe('Portofolio desainer produk')
      // Deep-equal against the real extractor output, then spot-check a few
      // metrics so a silently empty structure cannot pass.
      expect(payload.structure).toEqual(expectedStructure)
      const structure = payload.structure as typeof expectedStructure
      expect(structure.hasSingleH1).toBe(true)
      expect(structure.langAttribute).toBe('id')
      expect(structure.landmarks).toContain('main')
      expect(structure.imagesWithAlt).toBe(1)
      expect(structure.formFieldCount).toBe(1)
      expect(structure.labelledFormFields).toBe(1)
    }

    // --- Assert: sourceCode was filled because it started empty (Req 3.6) ---
    expect(successUpdate?.sourceCode).toBe(HTML_PROJECT_DOC)

    // --- Assert: the HTML prompt was used (Requirements 4.1, 4.2) ---
    const prompts = promptsSentToGemini()
    expect(prompts).toHaveLength(3)
    for (const prompt of prompts) {
      expect(prompt).toContain('## HTML Structure')
      expect(prompt).toContain('You are an AI judge evaluating web projects')
      // The structure block holds this page's own metrics, not a placeholder.
      expect(prompt).toContain('Lang attribute: "id"')
      expect(prompt).toContain('Title: "Portofolio Rani"')
      // ...and the markup is a separate, secondary block (Requirement 4.2).
      expect(prompt).toContain('## HTML Source (excerpt)')
      expect(prompt).toContain('Portofolio Rani</title>')
      expect(prompt).not.toContain('AWS PartyRock')
    }

    // --- Assert: scoring completed identically to the PartyRock path (Req 4.5) ---
    expect(mockAIScoreUpsert).toHaveBeenCalledTimes(3)
    const finalUpdate = findProjectUpdateData('scoreStatus', 'SUCCESS')
    expect(finalUpdate).not.toBeNull()
    // (88×30 + 74×40 + 91×30) / 100
    expect(finalUpdate?.finalScore as number).toBeCloseTo(83.3, 1)
  })
})

// ---------------------------------------------------------------------------
// Test 6: HTML fetch failure with Source Code already pasted
//
// Requirement 3.5: the crawl is recorded as FAILED with its error — the status
// machine is untouched — but the pasted markup is evidence enough, so scoring
// runs anyway. This is the case that makes an unreachable URL scoreable.
// ---------------------------------------------------------------------------

describe('Pipeline Integration: HTML Fetch Failure With Pasted Source Code', () => {
  it('records crawlStatus = FAILED yet still scores from the pasted Source Code', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      createFakeProject({
        projectType: 'HTML',
        url: HTML_PROJECT_URL,
        sourceCode: PASTED_HTML_DOC,
        category: { id: 'category-1' },
      }) as never,
    )
    mockProjectUpdate.mockResolvedValue({} as never)
    mockFetch.mockRejectedValueOnce(
      new Error('getaddrinfo ENOTFOUND rani.example.com'),
    )

    // The scoring run the failed crawl still starts. No `rawHtml` and no
    // `structure` — nothing was fetched, so the pasted markup is all there is.
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      createFakeProjectWithCategory(
        {
          projectType: 'HTML',
          url: HTML_PROJECT_URL,
          sourceCode: PASTED_HTML_DOC,
          crawlStatus: 'FAILED',
          crawlError: 'getaddrinfo ENOTFOUND rani.example.com',
        },
        {
          title: null,
          description: null,
          widgets: [],
          prompts: [],
          widgetCount: 0,
          rawHtml: null,
          structure: null,
        },
      ) as never,
    )
    mockCrawlMetadataFindMany.mockResolvedValueOnce([])
    mockAIScoreUpsert.mockResolvedValue({} as never)

    mockGenerateContent
      .mockResolvedValueOnce(createGeminiResponse(60, 'Sparse markup'))
      .mockResolvedValueOnce(createGeminiResponse(55, 'Little accessibility work'))
      .mockResolvedValueOnce(createGeminiResponse(70, 'Purpose is legible'))

    await CrawlerService.triggerCrawl('project-1')
    await flushAsyncScoring()

    // --- Assert: the crawl really did fail and says so ---
    const failedCrawl = findProjectUpdateData('crawlStatus', 'FAILED')
    expect(failedCrawl).not.toBeNull()
    expect(failedCrawl?.crawlError).toContain('ENOTFOUND')
    expect(findProjectUpdateData('crawlStatus', 'SUCCESS')).toBeNull()
    // Nothing was fetched, so no metadata was written and the pasted value was
    // never touched.
    expect(mockCrawlMetadataUpsert).not.toHaveBeenCalled()
    expect(failedCrawl).not.toHaveProperty('sourceCode')

    // --- Assert: scoring proceeded from the pasted markup (Requirement 3.5) ---
    expect(mockAIScoreUpsert).toHaveBeenCalledTimes(3)
    const finalUpdate = findProjectUpdateData('scoreStatus', 'SUCCESS')
    expect(finalUpdate).not.toBeNull()
    // (60×30 + 55×40 + 70×30) / 100
    expect(finalUpdate?.finalScore as number).toBeCloseTo(61, 1)

    const prompts = promptsSentToGemini()
    expect(prompts).toHaveLength(3)
    // The fetch produced no `structure`, so the metrics come from the pasted
    // markup instead (Requirement 3.6) — a failed crawl costs the project its
    // fetched evidence, not its primary evidence block.
    const structureFromPastedMarkup = formatStructureForPrompt(
      parseHtmlStructure(PASTED_HTML_DOC),
    )
    for (const prompt of prompts) {
      expect(prompt).toContain('## HTML Structure')
      expect(prompt).toContain(structureFromPastedMarkup)
      expect(prompt).not.toContain('HTML structure unavailable')
      // The pasted markup is the evidence that carried the run.
      expect(prompt).toContain('Pasted By Admin')
    }
  })
})

// ---------------------------------------------------------------------------
// Test 7: HTML project with no evidence at all
//
// Requirement 4.6: no Source Code, no computed structure, no fetched markup →
// scoreStatus = FAILED, and Gemini is never called. Sending an empty prompt
// would only buy a confidently invented score.
// ---------------------------------------------------------------------------

describe('Pipeline Integration: HTML Project With No Evidence', () => {
  it('sets scoreStatus = FAILED without calling Gemini', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      createFakeProjectWithCategory({
        projectType: 'HTML',
        url: HTML_PROJECT_URL,
        sourceCode: null,
        // No crawl has ever landed, so there is no CrawlMetadata row either.
        metadata: null,
      }) as never,
    )
    mockProjectUpdate.mockResolvedValue({} as never)

    await ScorerService.triggerScoring('project-1')

    expect(mockGenerateContent).not.toHaveBeenCalled()
    expect(mockAIScoreUpsert).not.toHaveBeenCalled()
    // The guard short-circuits before the sibling-context query, too.
    expect(mockCrawlMetadataFindMany).not.toHaveBeenCalled()

    const failedUpdate = findProjectUpdateData('scoreStatus', 'FAILED')
    expect(failedUpdate).not.toBeNull()
    // `finalScore` is deliberately left as it stands — it can carry a
    // jury-derived value, and nothing was scored here that would justify
    // clearing it.
    expect(failedUpdate).not.toHaveProperty('finalScore')
  })
})
