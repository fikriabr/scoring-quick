/**
 * Integration Tests: Submission → Crawl → Two-Track Score Pipeline
 *
 * A submission carries two files, each scored on its own track by an isolated
 * evaluator agent and audited by a critic agent:
 *
 *   IDEA — the markdown idea document
 *   HTML — the page (fetched markup / pasted Source Code + structure metrics)
 *
 * The track scores are blended with the category's ideaWeight / htmlWeight.
 *
 *   1. Happy path: submit → crawl → both tracks scored → final score blended
 *   2. Crawl failure: crawlStatus = FAILED, scoring still runs (idea track)
 *   3. One track's evaluator fails → PARTIAL; all fail → FAILED
 *   4. HTML happy path: rawHtml + structure stored, prompts are isolated
 *   5. Failed fetch with pasted Source Code: HTML scored from the paste
 *   6. No HTML evidence: HTML track fails without calling the model
 *
 * External dependencies (fetch, Gemini, Prisma, next/cache) are mocked. The
 * HTML Structure Extractor is not — it is a pure function, so the metrics
 * asserted below are the real ones.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

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
    },
    parameter: {
      findMany: vi.fn(),
    },
    aIScore: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    juryScore: {
      findMany: vi.fn(),
    },
    aIEvaluationRun: {
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
  },
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockFetchHtmlOnce(html: string) {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: async () => html })
}

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

const IDEA_DOC = `# KasirKu
Small shops lose sales because queues are slow. KasirKu is an offline-first
point-of-sale app for warungs that syncs when a connection is available.`

const { mockGenerateContent } = vi.hoisted(() => ({ mockGenerateContent: vi.fn() }))
vi.mock('@google/generative-ai', () => {
  class MockGoogleGenerativeAI {
    constructor(_apiKey: string) { }
    getGenerativeModel(_config: unknown) {
      return { generateContent: mockGenerateContent }
    }
  }
  return { GoogleGenerativeAI: MockGoogleGenerativeAI }
})

import { db } from '@/lib/db'
import { submitProject } from '@/lib/services/submission.service'
import { CrawlerService } from '@/lib/services/crawler.service'
import {
  formatStructureForPrompt,
  parseHtmlStructure,
} from '@/lib/services/html-structure.service'
import { ScorerService } from '@/lib/services/scorer.service'

const mockProjectCreate = vi.mocked(db.project.create)
const mockProjectFindFirst = vi.mocked(db.project.findFirst)
const mockProjectFindUniqueOrThrow = vi.mocked(db.project.findUniqueOrThrow)
const mockProjectUpdate = vi.mocked(db.project.update)
const mockCrawlMetadataUpsert = vi.mocked(db.crawlMetadata.upsert)
const mockAIScoreUpsert = vi.mocked(db.aIScore.upsert)
const mockAIScoreDeleteMany = vi.mocked(db.aIScore.deleteMany)
const mockRunCreate = vi.mocked(db.aIEvaluationRun.create)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PARAMETERS = [
  { id: 'idea-1', name: 'Problem & Relevance', weight: 60, track: 'IDEA' },
  { id: 'idea-2', name: 'Feasibility', weight: 40, track: 'IDEA' },
  { id: 'html-1', name: 'Semantic HTML', weight: 30, track: 'HTML' },
  { id: 'html-2', name: 'Accessibility', weight: 40, track: 'HTML' },
  { id: 'html-3', name: 'Presentation', weight: 30, track: 'HTML' },
].map((p, i) => ({
  ...p,
  categoryId: 'category-1',
  description: `${p.name} criterion`,
  minScore: 0,
  maxScore: 100,
  scoringMode: 'AUTO' as const,
  orderIndex: i,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
}))

const CATEGORY = {
  id: 'category-1',
  eventId: 'event-1',
  name: 'Test Category',
  description: null,
  isPublished: false,
  publicToken: null,
  ideaWeight: 60,
  htmlWeight: 40,
  criticEnabled: true,
  maxCriticRounds: 2,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  parameters: PARAMETERS,
}

function createFakeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-1',
    categoryId: 'category-1',
    url: HTML_PROJECT_URL,
    participantName: 'Test User',
    teamName: null,
    sourceCode: null as string | null,
    ideaDoc: IDEA_DOC as string | null,
    crawlStatus: 'PENDING' as const,
    crawlError: null,
    scoreStatus: 'PENDING' as const,
    finalScore: null,
    ideaScore: null,
    htmlScore: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  }
}

/** The row `triggerScoring` reads (project + category + metadata). */
function createScoringRow(
  overrides: Record<string, unknown> = {},
  metadataOverrides: Record<string, unknown> = {},
) {
  return {
    ...createFakeProject(),
    category: CATEGORY,
    metadata: {
      id: 'metadata-1',
      projectId: 'project-1',
      title: 'Portofolio Rani',
      description: null,
      widgets: [],
      prompts: [],
      widgetCount: 0,
      rawHtml: '<html><body><main><h1>Test</h1></main></body></html>',
      structure: null as unknown,
      crawledAt: new Date('2024-01-01'),
      ...metadataOverrides,
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Model + store fakes
// ---------------------------------------------------------------------------

type Scripted = { idea?: number[] | Error; html?: number[] | Error; critic?: 'approve' }

/**
 * Route each prompt by its role/track: the evaluator prompts carry the track's
 * evidence block, the critic prompt announces itself as the Auditor.
 */
function scriptModel({ idea = [80, 70], html = [88, 74, 91] }: Scripted = {}) {
  mockGenerateContent.mockImplementation(async (prompt: string) => {
    const text = (body: unknown) => ({ response: { text: () => JSON.stringify(body) } })
    if (prompt.includes('independent Auditor')) {
      return text({ approved: true, findings: [], feedback: 'Scores are grounded.' })
    }
    const scores = prompt.includes('<<<IDEA_DOCUMENT') ? idea : html
    if (scores instanceof Error) throw scores
    return text({
      scores: scores.map((score, i) => ({
        parameter: `P${i + 1}`,
        score,
        evidence: 'quoted evidence',
        reasoning: `reasoning ${i + 1}`,
      })),
    })
  })
}

/** Keep AI score upserts in memory so the final-score recalculation reads them. */
function installScoreStore() {
  const store = new Map<string, { parameterId: string; score: number }>()
  mockAIScoreUpsert.mockImplementation((async (args: {
    create: { parameterId: string; score: number }
  }) => {
    store.set(args.create.parameterId, {
      parameterId: args.create.parameterId,
      score: args.create.score,
    })
    return {}
  }) as never)
  vi.mocked(db.aIScore.findMany).mockImplementation((async () => [...store.values()]) as never)
  return store
}

function evaluatorPrompts(track: 'IDEA' | 'HTML'): string[] {
  const marker = track === 'IDEA' ? '<<<IDEA_DOCUMENT' : '<<<HTML_SOURCE'
  return mockGenerateContent.mock.calls
    .map((c) => String(c[0]))
    .filter((p) => p.includes('(Evaluator)') && p.includes(marker))
}

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

/** The last update that wrote a finalScore — the blended result. */
function lastScoreUpdate(): Record<string, unknown> | null {
  const calls = mockProjectUpdate.mock.calls
    .map((c) => (c[0] as { data?: Record<string, unknown> }).data)
    .filter((d): d is Record<string, unknown> => !!d && 'finalScore' in d)
  return calls.at(-1) ?? null
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGenerateContent.mockReset()
  mockProjectUpdate.mockResolvedValue({} as never)
  vi.mocked(db.parameter.findMany).mockResolvedValue(PARAMETERS as never)
  vi.mocked(db.juryScore.findMany).mockResolvedValue([] as never)
  mockAIScoreDeleteMany.mockResolvedValue({ count: 0 } as never)
  vi.mocked(db.aIEvaluationRun.deleteMany).mockResolvedValue({ count: 0 } as never)
  mockRunCreate.mockResolvedValue({} as never)
  installScoreStore()
})

/**
 * `triggerScoring` reads the project twice: the full scoring row, then the
 * category weights for the final-score recalculation. Both are served the
 * same row.
 */
function serveScoringRow(row: ReturnType<typeof createScoringRow>) {
  mockProjectFindUniqueOrThrow.mockResolvedValueOnce(row as never)
  mockProjectFindUniqueOrThrow.mockResolvedValueOnce(row as never)
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe('Pipeline Integration: Happy Path', () => {
  it('submit → crawl → both tracks scored and audited → final score blended 60/40', async () => {
    mockProjectFindFirst.mockResolvedValueOnce(null)
    mockProjectCreate.mockResolvedValueOnce(createFakeProject() as never)

    const result = await submitProject({
      url: HTML_PROJECT_URL,
      participantName: 'Test User',
      ideaDoc: IDEA_DOC,
      categoryId: 'clxxxxxxxxxxxxxxxxxx001',
    })
    expect(result.scoreStatus).toBe('PENDING')
    expect(mockProjectCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ideaDoc: IDEA_DOC }) }),
    )

    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      createFakeProject({ category: { id: 'category-1' } }) as never,
    )
    mockCrawlMetadataUpsert.mockResolvedValueOnce({} as never)
    mockFetchHtmlOnce(HTML_PROJECT_DOC)
    serveScoringRow(createScoringRow({ sourceCode: HTML_PROJECT_DOC }))
    scriptModel({ idea: [80, 70], html: [88, 74, 91] })

    await CrawlerService.triggerCrawl('project-1')

    expect(findProjectUpdateData('crawlStatus', 'SUCCESS')).not.toBeNull()

    // One evaluator + one critic call per track.
    expect(mockGenerateContent).toHaveBeenCalledTimes(4)
    expect(mockAIScoreUpsert).toHaveBeenCalledTimes(5)
    expect(mockRunCreate).toHaveBeenCalledTimes(2)
    for (const call of mockAIScoreUpsert.mock.calls) {
      const args = call[0] as { create: { criticApproved: boolean | null } }
      expect(args.create.criticApproved).toBe(true)
    }

    expect(findProjectUpdateData('scoreStatus', 'SUCCESS')).not.toBeNull()
    const scores = lastScoreUpdate()
    // idea: 80×0.6 + 70×0.4 = 76 · html: 88×0.3 + 74×0.4 + 91×0.3 = 83.3
    expect(scores?.ideaScore as number).toBeCloseTo(76, 5)
    expect(scores?.htmlScore as number).toBeCloseTo(83.3, 5)
    // final: 76×0.6 + 83.3×0.4
    expect(scores?.finalScore as number).toBeCloseTo(78.92, 5)
  })
})

// ---------------------------------------------------------------------------
// 2. Crawl failure
// ---------------------------------------------------------------------------

describe('Pipeline Integration: Crawl Failure', () => {
  it('sets crawlStatus = FAILED and still starts scoring — the idea track does not need the page', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      createFakeProject({ category: { id: 'category-1' } }) as never,
    )
    mockFetch.mockRejectedValueOnce(new Error('Timeout: the operation was aborted after 15000ms'))
    const scoringSpy = vi.spyOn(ScorerService, 'triggerScoring').mockResolvedValue()

    await CrawlerService.triggerCrawl('project-1')

    const failed = findProjectUpdateData('crawlStatus', 'FAILED')
    expect(failed?.crawlError).toContain('Timeout')
    expect(findProjectUpdateData('crawlStatus', 'SUCCESS')).toBeNull()
    expect(scoringSpy).toHaveBeenCalledWith('project-1')
    scoringSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 3. Track failures
// ---------------------------------------------------------------------------

describe('Pipeline Integration: Scoring Partial Failure', () => {
  it('sets scoreStatus = PARTIAL when one track fails, keeping the other track', async () => {
    serveScoringRow(createScoringRow({ sourceCode: HTML_PROJECT_DOC }))
    scriptModel({ idea: [80, 70], html: new Error('Gemini InternalServerError') })

    await ScorerService.triggerScoring('project-1')

    expect(mockAIScoreUpsert).toHaveBeenCalledTimes(2)
    expect(findProjectUpdateData('scoreStatus', 'PARTIAL')).not.toBeNull()
    const scores = lastScoreUpdate()
    expect(scores?.ideaScore as number).toBeCloseTo(76, 5)
    expect(scores?.htmlScore).toBeNull()
    // The missing track contributes 0 — it is never re-weighted onto the other.
    expect(scores?.finalScore as number).toBeCloseTo(76 * 0.6, 5)
  })

  it('sets scoreStatus = FAILED when every track fails', async () => {
    serveScoringRow(createScoringRow({ sourceCode: HTML_PROJECT_DOC }))
    scriptModel({ idea: new Error('Gemini timeout'), html: new Error('Gemini throttle') })

    await ScorerService.triggerScoring('project-1')

    expect(mockAIScoreUpsert).not.toHaveBeenCalled()
    expect(findProjectUpdateData('scoreStatus', 'FAILED')).not.toBeNull()
    expect(lastScoreUpdate()?.finalScore).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. HTML happy path — stored evidence and prompt isolation
// ---------------------------------------------------------------------------

describe('Pipeline Integration: HTML Happy Path', () => {
  it('crawl stores rawHtml and structure, fills sourceCode, and each track sees only its own file', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      createFakeProject({ sourceCode: null, category: { id: 'category-1' } }) as never,
    )
    mockCrawlMetadataUpsert.mockResolvedValueOnce({} as never)
    mockFetchHtmlOnce(HTML_PROJECT_DOC)

    const expectedStructure = parseHtmlStructure(HTML_PROJECT_DOC)
    serveScoringRow(
      createScoringRow(
        { sourceCode: HTML_PROJECT_DOC },
        { rawHtml: HTML_PROJECT_DOC, structure: expectedStructure },
      ),
    )
    scriptModel()

    await CrawlerService.triggerCrawl('project-1')

    const successUpdate = findProjectUpdateData('crawlStatus', 'SUCCESS')
    expect(successUpdate?.sourceCode).toBe(HTML_PROJECT_DOC)

    const upsert = mockCrawlMetadataUpsert.mock.calls[0][0] as {
      create: Record<string, unknown>
    }
    expect(upsert.create.rawHtml).toBe(HTML_PROJECT_DOC)
    expect(upsert.create.structure).toEqual(expectedStructure)

    const [htmlPrompt] = evaluatorPrompts('HTML')
    expect(htmlPrompt).toContain('## HTML Structure')
    expect(htmlPrompt).toContain('Lang attribute: "id"')
    expect(htmlPrompt).toContain('Portofolio Rani</title>')
    // Isolation: the HTML evaluator never sees the idea document.
    expect(htmlPrompt).not.toContain('KasirKu')

    const [ideaPrompt] = evaluatorPrompts('IDEA')
    expect(ideaPrompt).toContain('KasirKu')
    // Isolation: the idea evaluator never sees the page.
    expect(ideaPrompt).not.toContain('Portofolio Rani')
    expect(ideaPrompt).not.toContain('<html')
  })
})

// ---------------------------------------------------------------------------
// 5. Failed fetch with pasted Source Code
// ---------------------------------------------------------------------------

describe('Pipeline Integration: HTML Fetch Failure With Pasted Source Code', () => {
  it('records crawlStatus = FAILED yet scores the HTML track from the pasted Source Code', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      createFakeProject({ sourceCode: PASTED_HTML_DOC, category: { id: 'category-1' } }) as never,
    )
    mockFetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND rani.example.com'))
    serveScoringRow(
      createScoringRow(
        { sourceCode: PASTED_HTML_DOC, crawlStatus: 'FAILED' },
        { rawHtml: null, structure: null },
      ),
    )
    scriptModel({ html: [60, 55, 70] })

    await CrawlerService.triggerCrawl('project-1')

    expect(findProjectUpdateData('crawlStatus', 'FAILED')?.crawlError).toContain('ENOTFOUND')
    expect(mockCrawlMetadataUpsert).not.toHaveBeenCalled()

    const [htmlPrompt] = evaluatorPrompts('HTML')
    expect(htmlPrompt).toContain(formatStructureForPrompt(parseHtmlStructure(PASTED_HTML_DOC)))
    expect(htmlPrompt).not.toContain('HTML structure unavailable')
    expect(htmlPrompt).toContain('Pasted By Admin')

    expect(findProjectUpdateData('scoreStatus', 'SUCCESS')).not.toBeNull()
    // html: 60×0.3 + 55×0.4 + 70×0.3 = 61
    expect(lastScoreUpdate()?.htmlScore as number).toBeCloseTo(61, 5)
  })
})

// ---------------------------------------------------------------------------
// 6. No HTML evidence
// ---------------------------------------------------------------------------

describe('Pipeline Integration: HTML Project With No Evidence', () => {
  it('fails the HTML track without calling the model, clears its stale scores, still scores the idea', async () => {
    serveScoringRow(createScoringRow({ sourceCode: null, metadata: null }))
    scriptModel()

    await ScorerService.triggerScoring('project-1')

    expect(evaluatorPrompts('HTML')).toHaveLength(0)
    expect(evaluatorPrompts('IDEA')).toHaveLength(1)
    expect(mockAIScoreDeleteMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1', parameter: { track: 'HTML' } },
    })
    expect(findProjectUpdateData('scoreStatus', 'PARTIAL')).not.toBeNull()
  })

  it('fails the IDEA track the same way when the idea document is missing', async () => {
    serveScoringRow(createScoringRow({ sourceCode: HTML_PROJECT_DOC, ideaDoc: '   ' }))
    scriptModel()

    await ScorerService.triggerScoring('project-1')

    expect(evaluatorPrompts('IDEA')).toHaveLength(0)
    expect(evaluatorPrompts('HTML')).toHaveLength(1)
    expect(findProjectUpdateData('scoreStatus', 'PARTIAL')).not.toBeNull()
  })
})
