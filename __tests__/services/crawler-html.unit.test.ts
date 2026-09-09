/**
 * Unit Tests: CrawlerService per-project-type extraction
 *
 * Requirements: 3.1, 3.2, 3.5, 3.6, 3.7
 *
 * Three things are under test here:
 *
 *   1. `crawl(url, projectType)` dispatches to the right strategy. The HTML
 *      strategy keeps the fetched markup (`rawHtml`), derives `structure` from
 *      the real parser, and reads title/description off that parse. The
 *      PartyRock strategy behaves exactly as before — regex meta tags only, no
 *      markup retained.
 *
 *   2. `triggerCrawl` decides whether the fetched markup may become
 *      `Project.sourceCode`. `crawl()` only ever returns a *candidate*, because
 *      it is handed a URL and a type rather than the project record; the record
 *      lives one layer up. Pasted Source Code must survive a successful fetch
 *      (Requirement 3.6, the example-based counterpart to Property 26, which is
 *      covered as a property in task 6.4).
 *
 *   3. What `triggerCrawl` persists and what it triggers. `structure` reaches
 *      `CrawlMetadata` for HTML projects and is left alone for PartyRock ones
 *      (Requirement 3.2), and a failed fetch is recorded as `FAILED` yet still
 *      proceeds to scoring when Source Code is already on hand
 *      (Requirement 3.5).
 *
 * `fetch` is stubbed with `vi.stubGlobal` following the pattern in
 * `__tests__/integration/pipeline.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock modules BEFORE importing the service under test
// ---------------------------------------------------------------------------

vi.mock('@/lib/db', () => ({
  db: {
    project: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    crawlMetadata: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}))

// Scoring is fire-and-forget at the end of a crawl; stub it so the assertions
// here stay about crawling. Whether it is called at all is itself part of the
// contract (Requirement 3.5), so the mock is asserted on rather than ignored.
vi.mock('@/lib/services/scorer.service', () => ({
  ScorerService: { triggerScoring: vi.fn().mockResolvedValue(undefined) },
}))

// Passthrough spy over the real extractor: every test below gets genuine
// metrics, but one test needs the parser to blow up so the `structure = null`
// branch of the upsert can be observed. Wrapping beats hand-crafting markup
// that happens to break the parser, which would be brittle.
vi.mock('@/lib/services/html-structure.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/html-structure.service')>()
  return {
    ...actual,
    parseHtmlStructure: vi.fn((html: string) => actual.parseHtmlStructure(html)),
  }
})

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { CrawlerService } from '@/lib/services/crawler.service'
import { parseHtmlStructure } from '@/lib/services/html-structure.service'
import { ScorerService } from '@/lib/services/scorer.service'

const mockParseHtmlStructure = vi.mocked(parseHtmlStructure)

const mockTriggerScoring = vi.mocked(ScorerService.triggerScoring)
const mockProjectFindUniqueOrThrow = vi.mocked(db.project.findUniqueOrThrow)
const mockProjectUpdate = vi.mocked(db.project.update)
const mockCrawlMetadataUpsert = vi.mocked(db.crawlMetadata.upsert)

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const HTML_DOC = `<!DOCTYPE html>
<html lang="id">
  <head>
    <title>Portofolio Saya</title>
    <meta name="description" content="Halaman portofolio sederhana">
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body>
    <header><nav><a href="/about">Tentang</a></nav></header>
    <main>
      <h1>Portofolio</h1>
      <h2>Proyek</h2>
      <img src="a.png" alt="Tangkapan layar">
      <div><span>generic</span></div>
    </main>
    <footer>Footer</footer>
  </body>
</html>`

const PARTYROCK_DOC = `<!doctype html><html><head>
  <title>Fallback Title</title>
  <meta property="og:title" content="My PartyRock App">
  <meta name="description" content="A creative AI application">
</head><body></body></html>`

function mockFetchHtmlOnce(html: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: async () => html,
  })
}

function buildProjectRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-1',
    categoryId: 'category-1',
    url: 'https://example.com/portfolio',
    participantName: 'Test User',
    teamName: null,
    projectType: 'HTML' as const,
    sourceCode: null as string | null,
    crawlStatus: 'PENDING' as const,
    crawlError: null,
    scoreStatus: 'PENDING' as const,
    finalScore: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    category: { id: 'category-1', name: 'Test Category' },
    ...overrides,
  }
}

/** The `data` payload of the `project.update` call that set crawlStatus. */
function findProjectUpdateData(crawlStatus: string): Record<string, unknown> | null {
  for (const call of mockProjectUpdate.mock.calls) {
    const data = (call[0] as { data?: Record<string, unknown> }).data
    if (data && data.crawlStatus === crawlStatus) return data
  }
  return null
}

/** The `create`/`update` payloads handed to `crawlMetadata.upsert`. */
function readUpsertPayloads(): {
  create: Record<string, unknown>
  update: Record<string, unknown>
} {
  const arg = mockCrawlMetadataUpsert.mock.calls[0][0] as {
    create: Record<string, unknown>
    update: Record<string, unknown>
  }
  return { create: arg.create, update: arg.update }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectUpdate.mockResolvedValue({} as never)
  mockCrawlMetadataUpsert.mockResolvedValue({} as never)
  mockTriggerScoring.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// crawl() — HTML strategy
// ---------------------------------------------------------------------------

describe('CrawlerService.crawl — HTML strategy', () => {
  it('keeps the fetched markup, derives structure, and reads title/description from the parser', async () => {
    mockFetchHtmlOnce(HTML_DOC)

    const outcome = await CrawlerService.crawl('https://example.com/portfolio', 'HTML')

    expect(outcome.rawHtml).toBe(HTML_DOC)
    expect(outcome.sourceCode).toBe(HTML_DOC)

    // Title/description come from parseHtmlStructure, not the regex helpers.
    expect(outcome.title).toBe('Portofolio Saya')
    expect(outcome.description).toBe('Halaman portofolio sederhana')

    expect(outcome.structure).not.toBeNull()
    expect(outcome.structure?.documentTitle).toBe('Portofolio Saya')
    expect(outcome.structure?.headingCount).toBe(2)
    expect(outcome.structure?.hasSingleH1).toBe(true)
    expect(outcome.structure?.langAttribute).toBe('id')
    expect(outcome.structure?.hasViewportMeta).toBe(true)
    expect(outcome.structure?.imageCount).toBe(1)
    expect(outcome.structure?.imagesWithAlt).toBe(1)
  })

  it('leaves widget and prompt data empty — those are PartyRock concepts', async () => {
    mockFetchHtmlOnce(HTML_DOC)

    const outcome = await CrawlerService.crawl('https://example.com/portfolio', 'HTML')

    expect(outcome.widgets).toEqual([])
    expect(outcome.prompts).toEqual([])
    expect(outcome.widgetCount).toBe(0)
  })

  it('caps rawHtml at 200,000 characters and the sourceCode candidate at 100,000', async () => {
    // Padding lives inside a comment so the markup still parses as one document.
    const huge = '<html><head><title>Big</title></head><body><!--' +
      'x'.repeat(300_000) +
      '--></body></html>'
    mockFetchHtmlOnce(huge)

    const outcome = await CrawlerService.crawl('https://example.com/big', 'HTML')

    expect(huge.length).toBeGreaterThan(200_000)
    expect(outcome.rawHtml).toHaveLength(200_000)
    expect(outcome.sourceCode).toHaveLength(100_000)
    // Truncation is a prefix cut, so the head of the document survives.
    expect(outcome.rawHtml?.startsWith('<html><head><title>Big</title>')).toBe(true)
    expect(outcome.sourceCode?.startsWith('<html><head><title>Big</title>')).toBe(true)
  })

  it('reports a document with no title or meta description as null rather than throwing', async () => {
    mockFetchHtmlOnce('<html><body><p>bare</p></body></html>')

    const outcome = await CrawlerService.crawl('https://example.com/bare', 'HTML')

    expect(outcome.title).toBeNull()
    expect(outcome.description).toBeNull()
    expect(outcome.structure).not.toBeNull()
  })

  it('propagates a non-2xx response as an error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => '' })

    await expect(
      CrawlerService.crawl('https://example.com/missing', 'HTML'),
    ).rejects.toThrow('HTTP 404')
  })
})

// ---------------------------------------------------------------------------
// crawl() — PartyRock strategy (unchanged behaviour)
// ---------------------------------------------------------------------------

describe('CrawlerService.crawl — PartyRock strategy', () => {
  it('prefers og:title, reads the meta description, and retains no markup', async () => {
    mockFetchHtmlOnce(PARTYROCK_DOC)

    const outcome = await CrawlerService.crawl(
      'https://partyrock.aws/app/test-app',
      'PARTYROCK',
    )

    expect(outcome.title).toBe('My PartyRock App')
    expect(outcome.description).toBe('A creative AI application')
    expect(outcome.widgets).toEqual([])
    expect(outcome.prompts).toEqual([])
    expect(outcome.widgetCount).toBe(0)
    // Not null — undefined, so triggerCrawl can tell "nothing to say" from
    // "clear the column".
    expect(outcome.rawHtml).toBeUndefined()
    expect(outcome.structure).toBeUndefined()
    expect(outcome.sourceCode).toBeUndefined()
  })

  it('defaults to the PartyRock strategy when no project type is passed', async () => {
    mockFetchHtmlOnce(PARTYROCK_DOC)

    const outcome = await CrawlerService.crawl('https://partyrock.aws/app/test-app')

    expect(outcome.title).toBe('My PartyRock App')
    expect(outcome.rawHtml).toBeUndefined()
    expect(outcome.structure).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// triggerCrawl() — the sourceCode write decision
// ---------------------------------------------------------------------------

describe('CrawlerService.triggerCrawl — sourceCode precedence', () => {
  it('fills sourceCode from the fetched markup when the project has none', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      buildProjectRecord({ sourceCode: null }) as never,
    )
    mockFetchHtmlOnce(HTML_DOC)

    await CrawlerService.triggerCrawl('project-1')

    const successUpdate = findProjectUpdateData('SUCCESS')
    expect(successUpdate).not.toBeNull()
    expect(successUpdate?.sourceCode).toBe(HTML_DOC)
  })

  it('treats a whitespace-only sourceCode as empty', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      buildProjectRecord({ sourceCode: '   \n  ' }) as never,
    )
    mockFetchHtmlOnce(HTML_DOC)

    await CrawlerService.triggerCrawl('project-1')

    expect(findProjectUpdateData('SUCCESS')?.sourceCode).toBe(HTML_DOC)
  })

  it('never overwrites an existing sourceCode, even when the fetch succeeds', async () => {
    const pasted = '<html><body><h1>Pasted by admin</h1></body></html>'
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      buildProjectRecord({ sourceCode: pasted }) as never,
    )
    mockFetchHtmlOnce(HTML_DOC)

    await CrawlerService.triggerCrawl('project-1')

    const successUpdate = findProjectUpdateData('SUCCESS')
    expect(successUpdate).not.toBeNull()
    // The key must be absent entirely — writing `pasted` back would also pass a
    // value check, but leaving it out is what guarantees no write happens.
    expect(successUpdate).not.toHaveProperty('sourceCode')
  })

  it('persists the fetched markup to CrawlMetadata.rawHtml for HTML projects', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      buildProjectRecord() as never,
    )
    mockFetchHtmlOnce(HTML_DOC)

    await CrawlerService.triggerCrawl('project-1')

    expect(mockCrawlMetadataUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'project-1' },
        create: expect.objectContaining({
          projectId: 'project-1',
          title: 'Portofolio Saya',
          rawHtml: HTML_DOC,
        }),
        update: expect.objectContaining({ rawHtml: HTML_DOC }),
      }),
    )
  })

  it('does not touch rawHtml or sourceCode for a PARTYROCK project', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      buildProjectRecord({
        projectType: 'PARTYROCK',
        url: 'https://partyrock.aws/app/test-app',
        sourceCode: null,
      }) as never,
    )
    mockFetchHtmlOnce(PARTYROCK_DOC)

    await CrawlerService.triggerCrawl('project-1')

    const upsertArg = mockCrawlMetadataUpsert.mock.calls[0][0] as {
      create: Record<string, unknown>
      update: Record<string, unknown>
    }
    // Capture Pipeline owns rawHtml for PartyRock projects — a crawl must not
    // clear it.
    expect(upsertArg.create).not.toHaveProperty('rawHtml')
    expect(upsertArg.update).not.toHaveProperty('rawHtml')
    expect(findProjectUpdateData('SUCCESS')).not.toHaveProperty('sourceCode')
  })

  it('marks the crawl FAILED and leaves sourceCode alone when the fetch fails', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      buildProjectRecord({ sourceCode: null }) as never,
    )
    mockFetch.mockRejectedValueOnce(new Error('This operation was aborted'))

    await CrawlerService.triggerCrawl('project-1')

    const failedUpdate = findProjectUpdateData('FAILED')
    expect(failedUpdate).not.toBeNull()
    expect(failedUpdate?.crawlError).toContain('aborted')
    expect(failedUpdate).not.toHaveProperty('sourceCode')
    expect(mockCrawlMetadataUpsert).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// triggerCrawl() — persisting `structure` (Requirement 3.2)
// ---------------------------------------------------------------------------

describe('CrawlerService.triggerCrawl — structure persistence', () => {
  it('writes the derived structure to CrawlMetadata on both create and update', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(buildProjectRecord() as never)
    mockFetchHtmlOnce(HTML_DOC)

    await CrawlerService.triggerCrawl('project-1')

    const { create, update } = readUpsertPayloads()

    // Same object on both branches, so an existing metadata row is refreshed
    // rather than left with stale metrics.
    for (const payload of [create, update]) {
      const structure = payload.structure as Record<string, unknown>
      expect(structure).toBeDefined()
      expect(structure.documentTitle).toBe('Portofolio Saya')
      expect(structure.headingCount).toBe(2)
      expect(structure.langAttribute).toBe('id')
    }

    expect(create.structure).toEqual(update.structure)
  })

  it('clears the column with a database NULL when the markup cannot be parsed', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(buildProjectRecord() as never)
    mockFetchHtmlOnce(HTML_DOC)
    mockParseHtmlStructure.mockImplementationOnce(() => {
      throw new Error('parser exploded')
    })

    await CrawlerService.triggerCrawl('project-1')

    const { create, update } = readUpsertPayloads()

    // `Prisma.DbNull` (column has no value), not `Prisma.JsonNull` (column
    // holds the JSON literal `null`) — see the comment in crawler.service.ts.
    expect(create.structure).toBe(Prisma.DbNull)
    expect(update.structure).toBe(Prisma.DbNull)
    expect(create.structure).not.toBe(Prisma.JsonNull)

    // A parse failure is not fatal: the markup is still stored and the crawl
    // still succeeds.
    expect(create.rawHtml).toBe(HTML_DOC)
    expect(findProjectUpdateData('SUCCESS')).not.toBeNull()
  })

  it('does not write structure at all for a PARTYROCK project', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      buildProjectRecord({
        projectType: 'PARTYROCK',
        url: 'https://partyrock.aws/app/test-app',
      }) as never,
    )
    mockFetchHtmlOnce(PARTYROCK_DOC)

    await CrawlerService.triggerCrawl('project-1')

    const { create, update } = readUpsertPayloads()
    // The key must be absent, not null: passing null would clear a structure
    // some other writer may own, and PartyRock has no opinion on this column.
    expect(create).not.toHaveProperty('structure')
    expect(update).not.toHaveProperty('structure')
  })
})

// ---------------------------------------------------------------------------
// triggerCrawl() — failed fetch, Source Code rescue (Requirement 3.5)
// ---------------------------------------------------------------------------

describe('CrawlerService.triggerCrawl — scoring after a failed fetch', () => {
  it('records FAILED yet still scores an HTML project that already has sourceCode', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      buildProjectRecord({
        sourceCode: '<html><body><h1>Pasted by admin</h1></body></html>',
      }) as never,
    )
    mockFetch.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND example.com'))

    await CrawlerService.triggerCrawl('project-1')

    // The status machine is unchanged: the crawl really did fail and says so.
    const failedUpdate = findProjectUpdateData('FAILED')
    expect(failedUpdate).not.toBeNull()
    expect(failedUpdate?.crawlError).toContain('ENOTFOUND')
    expect(findProjectUpdateData('SUCCESS')).toBeNull()

    // ...but the evidence is already in the database, so scoring proceeds.
    expect(mockTriggerScoring).toHaveBeenCalledWith('project-1')
  })

  it('does not score an HTML project with no sourceCode — that path belongs to the scorer', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      buildProjectRecord({ sourceCode: null }) as never,
    )
    mockFetch.mockRejectedValueOnce(new Error('This operation was aborted'))

    await CrawlerService.triggerCrawl('project-1')

    expect(findProjectUpdateData('FAILED')).not.toBeNull()
    expect(mockTriggerScoring).not.toHaveBeenCalled()
  })

  it('treats a whitespace-only sourceCode as no evidence at all', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      buildProjectRecord({ sourceCode: '   \n\t ' }) as never,
    )
    mockFetch.mockRejectedValueOnce(new Error('HTTP 403'))

    await CrawlerService.triggerCrawl('project-1')

    expect(findProjectUpdateData('FAILED')).not.toBeNull()
    expect(mockTriggerScoring).not.toHaveBeenCalled()
  })

  it('leaves PARTYROCK behaviour untouched — a failed crawl never triggers scoring', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(
      buildProjectRecord({
        projectType: 'PARTYROCK',
        url: 'https://partyrock.aws/app/test-app',
        // Capture Pipeline output; it schedules its own scoring run, so a
        // failed crawl must not fire a second one (Requirement 8.2).
        sourceCode: 'Widget: Chatbot\nPrompt: hello',
      }) as never,
    )
    mockFetch.mockRejectedValueOnce(new Error('HTTP 403'))

    await CrawlerService.triggerCrawl('project-1')

    expect(findProjectUpdateData('FAILED')).not.toBeNull()
    expect(mockTriggerScoring).not.toHaveBeenCalled()
  })

  it('still triggers scoring on a successful crawl', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValueOnce(buildProjectRecord() as never)
    mockFetchHtmlOnce(HTML_DOC)

    await CrawlerService.triggerCrawl('project-1')

    expect(mockTriggerScoring).toHaveBeenCalledWith('project-1')
  })
})
