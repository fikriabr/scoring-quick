/**
 * Property-based tests for Property 26: Pasted Source Code Takes Precedence
 * Over Fetched Markup
 *
 * Property 26 states:
 *   _For any_ HTML project that already has a non-empty `sourceCode`, running
 *   or re-running a crawl SHALL NOT overwrite that `sourceCode`, even when the
 *   fetch succeeds. When `sourceCode` is empty, a successful fetch SHALL
 *   populate it.
 *
 * ---------------------------------------------------------------------------
 * What this file adds over `crawler-html.unit.test.ts`
 * ---------------------------------------------------------------------------
 * The unit test pins the decision for three hand-written cases: `null`, one
 * whitespace string, and one pasted document. This file proves the decision is
 * a function of *emptiness alone* — never of the relative size, similarity, or
 * shape of the two values. That distinction matters because the tempting bug
 * here is a comparison ("the fetched markup is longer, so it must be better")
 * rather than a missing guard.
 *
 * Two things shape the design of the tests:
 *
 *   1. **"Does not write" is asserted as key absence, not value equality.**
 *      `db.project.update` is handed a partial payload, so writing the old
 *      value back would satisfy any value check while still being a write. The
 *      only assertion that actually pins Requirement 3.6 is that the
 *      `sourceCode` key never appears in the payload at all.
 *
 *   2. **The mocked database keeps state.** `findUniqueOrThrow` reads from an
 *      in-memory record that `update` mutates, so a second `triggerCrawl` sees
 *      what the first one wrote. Without that, a re-run property would only be
 *      re-testing the first run with a fresh mock and P26-c would prove
 *      nothing.
 *
 * The generators deliberately stay away from exotic markup: this property is
 * about the *write decision*, not about parsing. Structural variety is the job
 * of `html-structure.property.test.ts` (Property 22). What is varied here is
 * the axis the decision actually depends on — the emptiness of the existing
 * `sourceCode` (absent, empty, several flavours of whitespace) and its
 * relation to the fetched markup (identical, longer, shorter, unrelated).
 *
 * **Validates: Requirements 3.6**
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import * as fc from 'fast-check'

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

// Scoring is fire-and-forget at the end of a crawl and irrelevant to this
// property; stubbing it keeps every run free of Gemini imports and network use.
vi.mock('@/lib/services/scorer.service', () => ({
  ScorerService: { triggerScoring: vi.fn().mockResolvedValue(undefined) },
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { db } from '@/lib/db'
import { CrawlerService } from '@/lib/services/crawler.service'
import { ScorerService } from '@/lib/services/scorer.service'

const mockTriggerScoring = vi.mocked(ScorerService.triggerScoring)
const mockProjectFindUniqueOrThrow = vi.mocked(db.project.findUniqueOrThrow)
const mockProjectUpdate = vi.mocked(db.project.update)
const mockCrawlMetadataUpsert = vi.mocked(db.crawlMetadata.upsert)
const mockCrawlMetadataDeleteMany = vi.mocked(db.crawlMetadata.deleteMany)

/** Cap the crawler applies to the `sourceCode` candidate. */
const MAX_SOURCE_CODE_LENGTH = 100_000

const PROJECT_ID = 'project-precedence-1'

// ---------------------------------------------------------------------------
// Stateful mock database
// ---------------------------------------------------------------------------

let projectRow: Record<string, unknown>

function buildProjectRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    categoryId: 'category-1',
    url: 'https://example.com/portfolio',
    participantName: 'Test User',
    teamName: null,
    projectType: 'HTML' as string,
    sourceCode: null as string | null,
    crawlStatus: 'PENDING' as string,
    crawlError: null as string | null,
    scoreStatus: 'PENDING' as string,
    finalScore: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    category: { id: 'category-1', name: 'Test Category' },
    ...overrides,
  }
}

/**
 * Re-arm every mock for one property run.
 *
 * `vi.clearAllMocks()` wipes recorded calls but keeps implementations, so the
 * implementations are re-installed here anyway: it makes each run's setup
 * self-contained and independent of shrinking order.
 */
function resetMocks(project: Record<string, unknown>) {
  vi.clearAllMocks()
  projectRow = project

  // Reads see whatever previous writes left behind — this is what makes the
  // re-run assertions in P26-c meaningful.
  mockProjectFindUniqueOrThrow.mockImplementation((async () => ({
    ...projectRow,
  })) as never)

  mockProjectUpdate.mockImplementation((async (args: unknown) => {
    const data = (args as { data: Record<string, unknown> }).data
    Object.assign(projectRow, data)
    return { ...projectRow }
  }) as never)

  mockCrawlMetadataUpsert.mockResolvedValue({} as never)
  mockCrawlMetadataDeleteMany.mockResolvedValue({ count: 1 } as never)
  mockTriggerScoring.mockResolvedValue(undefined)
}

/** Serve the given bodies to successive `fetch` calls, in order. */
function serveFetchBodies(bodies: string[]) {
  let index = 0
  mockFetch.mockImplementation(async () => {
    const body = bodies[Math.min(index, bodies.length - 1)]
    index += 1
    return { ok: true, status: 200, text: async () => body }
  })
}

/** Make every `fetch` fail the way a real one does. */
function serveFetchFailure(kind: 'reject' | 'non-2xx', detail: string) {
  if (kind === 'reject') {
    mockFetch.mockImplementation(async () => {
      throw new Error(detail)
    })
    return
  }
  mockFetch.mockImplementation(async () => ({
    ok: false,
    status: Number(detail),
    text: async () => '',
  }))
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** Every `data` payload handed to `db.project.update`, in call order. */
function allProjectUpdateData(): Array<Record<string, unknown>> {
  return mockProjectUpdate.mock.calls.map(
    (call) => (call[0] as { data: Record<string, unknown> }).data,
  )
}

/** The `data` payload of the `project.update` call that set `crawlStatus`. */
function findProjectUpdateData(
  crawlStatus: string,
): Record<string, unknown> | null {
  for (const data of allProjectUpdateData()) {
    if (data.crawlStatus === crawlStatus) return data
  }
  return null
}

/**
 * The core assertion of this file: no payload mentions `sourceCode` at all.
 *
 * Key absence rather than value equality — see the header note. `hasOwnProperty`
 * is used explicitly so an inherited or `undefined`-valued key would still be
 * caught.
 */
function expectNoSourceCodeWrite() {
  for (const data of allProjectUpdateData()) {
    expect(Object.prototype.hasOwnProperty.call(data, 'sourceCode')).toBe(false)
  }
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Simple, varied HTML documents. Every one starts with `<`, so any non-empty
 * prefix of one is guaranteed non-blank — which is what lets the "shorter"
 * relation below stay a valid *non-empty* existing `sourceCode`.
 */
const markupArbitrary: fc.Arbitrary<string> = fc
  .record({
    lang: fc.constantFrom('', ' lang="id"', ' lang="en-US"'),
    title: fc.constantFrom('Portofolio', 'Landing Page', 'Tugas Akhir', ''),
    description: fc.constantFrom(
      '',
      '<meta name="description" content="Halaman sederhana">',
      '<meta property="og:title" content="Judul OG">',
    ),
    body: fc.array(
      fc.constantFrom(
        '<h1>Judul</h1>',
        '<h2>Sub bagian</h2>',
        '<main><p>Isi halaman</p></main>',
        '<img src="a.png" alt="Tangkapan layar">',
        '<img src="b.png">',
        '<div><span>generic</span></div>',
        '<nav><a href="#main">Skip to main content</a></nav>',
        '<form><label for="n">Nama</label><input id="n"></form>',
        '<footer>2024</footer>',
        '<section aria-label="ringkasan">teks</section>',
      ),
      { maxLength: 6 },
    ),
    filler: fc.nat({ max: 300 }),
  })
  .map(({ lang, title, description, body, filler }) => {
    const head =
      (title === '' ? '' : `<title>${title}</title>`) + description
    const padding = filler === 0 ? '' : `<p>${'a'.repeat(filler)}</p>`
    return (
      `<!DOCTYPE html><html${lang}><head>${head}</head>` +
      `<body>${body.join('')}${padding}</body></html>`
    )
  })

/**
 * Existing `sourceCode` values the implementation must treat as **empty**.
 *
 * `''` rather than `null` is what a blank textarea actually submits, and the
 * whitespace forms cover the `trim()` semantics the implementation relies on
 * (including NBSP, which JavaScript's `trim` does remove).
 */
const emptySourceCodeArbitrary: fc.Arbitrary<string | null> = fc.constantFrom(
  null,
  '',
  ' ',
  '   ',
  '\n',
  '\t',
  '\r\n',
  '\t\r\n ',
  '\n\n\n',
  '  \u00a0  ',
)

/** Existing `sourceCode` values that count as **present**. */
const nonEmptySourceCodeArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    '<html><body><h1>Pasted by admin</h1></body></html>',
    '<!DOCTYPE html><html><body>manual</body></html>',
    'x',
    '<',
    '  <p>berspasi di tepi</p>  ',
    '\n<div>diawali newline</div>\n',
    'Widget: Chatbot\nPrompt: hello',
    'teks biasa tanpa tag',
    'א<div>ב</div>ג',
    '𝕳𝖊𝖑𝖑𝖔',
  ),
  markupArbitrary,
  fc
    .string({ minLength: 1, maxLength: 300 })
    .filter((s) => s.trim().length > 0),
)

/**
 * How the already-stored `sourceCode` relates to the markup the fetch returns.
 *
 * The interesting bug this rules out is a size or similarity comparison, so the
 * relation is generated rather than left to chance: `identical` (a naive
 * "changed?" check would skip the write for the right reason by accident),
 * `longer` and `shorter` (a "keep the bigger one" heuristic would split on
 * these), and `unrelated`.
 */
type Relation = 'identical' | 'longer' | 'shorter' | 'unrelated'

const relationArbitrary: fc.Arbitrary<Relation> = fc.constantFrom(
  'identical',
  'longer',
  'shorter',
  'unrelated',
)

function existingFromRelation(
  markup: string,
  relation: Relation,
  unrelated: string,
): string {
  switch (relation) {
    case 'identical':
      return markup
    case 'longer':
      return markup + '<!-- tambahan admin -->' + 'z'.repeat(500)
    case 'shorter':
      // Markup always begins with `<`, so a non-empty prefix is never blank.
      return markup.slice(0, Math.max(1, Math.floor(markup.length / 3)))
    case 'unrelated':
      return unrelated
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * The crawler narrates each step to the console. Across ~1.000 generated
 * crawls that output is noise, so it is silenced for this file only.
 */
beforeAll(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterAll(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  resetMocks(buildProjectRecord())
})

// ---------------------------------------------------------------------------
// P26-a: an existing sourceCode is never overwritten by a successful fetch
// ---------------------------------------------------------------------------

describe('Property 26: Pasted Source Code Takes Precedence Over Fetched Markup', () => {
  it('P26-a — a non-empty sourceCode SHALL never appear in the update payload, whatever the fetched markup looks like [**Validates: Requirements 3.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        markupArbitrary,
        relationArbitrary,
        nonEmptySourceCodeArbitrary,
        async (markup, relation, unrelated) => {
          const existing = existingFromRelation(markup, relation, unrelated)
          resetMocks(buildProjectRecord({ sourceCode: existing }))
          serveFetchBodies([markup])

          await CrawlerService.triggerCrawl(PROJECT_ID)

          // The crawl itself succeeded — this is the "even when the fetch
          // succeeds" half of the property, not a silently skipped crawl.
          expect(findProjectUpdateData('SUCCESS')).not.toBeNull()

          // ...and yet nothing was written to the column.
          expectNoSourceCodeWrite()

          // The stored value is still exactly what the admin pasted.
          expect(projectRow.sourceCode).toBe(existing)
        },
      ),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P26-b: an empty sourceCode is filled from a successful fetch
  // -------------------------------------------------------------------------

  it('P26-b — an empty sourceCode SHALL be populated with the fetched markup [**Validates: Requirements 3.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        markupArbitrary,
        emptySourceCodeArbitrary,
        async (markup, empty) => {
          resetMocks(buildProjectRecord({ sourceCode: empty }))
          serveFetchBodies([markup])

          await CrawlerService.triggerCrawl(PROJECT_ID)

          const successUpdate = findProjectUpdateData('SUCCESS')
          expect(successUpdate).not.toBeNull()
          // Generated markup stays well under the cap, so the written value is
          // the markup verbatim rather than a truncation of it.
          expect(markup.length).toBeLessThanOrEqual(MAX_SOURCE_CODE_LENGTH)
          expect(successUpdate?.sourceCode).toBe(markup)
          expect(projectRow.sourceCode).toBe(markup)
        },
      ),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P26-c: re-running a crawl changes nothing
  // -------------------------------------------------------------------------

  it('P26-c — re-running triggerCrawl SHALL leave an existing sourceCode untouched, even with different markup on the second fetch [**Validates: Requirements 3.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptySourceCodeArbitrary,
        markupArbitrary,
        markupArbitrary,
        async (existing, firstMarkup, secondMarkup) => {
          resetMocks(buildProjectRecord({ sourceCode: existing }))
          serveFetchBodies([firstMarkup, secondMarkup])

          await CrawlerService.triggerCrawl(PROJECT_ID)
          await CrawlerService.triggerCrawl(PROJECT_ID)

          // Both runs really did crawl, and neither of them wrote.
          expect(mockCrawlMetadataUpsert).toHaveBeenCalledTimes(2)
          expectNoSourceCodeWrite()
          expect(projectRow.sourceCode).toBe(existing)
        },
      ),
      { numRuns: 150 },
    )
  })

  it('P26-c — retriggerCrawl SHALL NOT overwrite a sourceCode an earlier crawl already stored [**Validates: Requirements 3.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        emptySourceCodeArbitrary,
        markupArbitrary,
        markupArbitrary,
        async (empty, firstMarkup, secondMarkup) => {
          resetMocks(buildProjectRecord({ sourceCode: empty }))
          serveFetchBodies([firstMarkup, secondMarkup])

          // First crawl fills the empty column...
          await CrawlerService.triggerCrawl(PROJECT_ID)
          expect(projectRow.sourceCode).toBe(firstMarkup)

          const writesAfterFirstRun = allProjectUpdateData().length
          await CrawlerService.retriggerCrawl(PROJECT_ID)

          // ...and the re-run leaves it alone, because by then it is no longer
          // empty. Only the payloads produced by the re-run are inspected; the
          // first run's write is legitimate.
          for (const data of allProjectUpdateData().slice(writesAfterFirstRun)) {
            expect(
              Object.prototype.hasOwnProperty.call(data, 'sourceCode'),
            ).toBe(false)
          }
          expect(mockCrawlMetadataDeleteMany).toHaveBeenCalledWith({
            where: { projectId: PROJECT_ID },
          })
          expect(projectRow.sourceCode).toBe(firstMarkup)
        },
      ),
      { numRuns: 150 },
    )
  })

  it('P26-c — retriggerCrawl on a project with pasted sourceCode SHALL NOT write it [**Validates: Requirements 3.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptySourceCodeArbitrary,
        markupArbitrary,
        async (existing, markup) => {
          resetMocks(buildProjectRecord({ sourceCode: existing }))
          serveFetchBodies([markup])

          await CrawlerService.retriggerCrawl(PROJECT_ID)

          expect(findProjectUpdateData('SUCCESS')).not.toBeNull()
          expectNoSourceCodeWrite()
          expect(projectRow.sourceCode).toBe(existing)
        },
      ),
      { numRuns: 150 },
    )
  })

  // -------------------------------------------------------------------------
  // P26-d: a failed fetch never writes sourceCode
  // -------------------------------------------------------------------------

  it('P26-d — a failed fetch SHALL never write sourceCode, whatever the starting value [**Validates: Requirements 3.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(emptySourceCodeArbitrary, nonEmptySourceCodeArbitrary),
        fc.oneof(
          fc
            .constantFrom(
              'This operation was aborted',
              'getaddrinfo ENOTFOUND example.com',
              'fetch failed',
            )
            .map((detail) => ({ kind: 'reject' as const, detail })),
          fc
            .constantFrom('403', '404', '500', '503')
            .map((detail) => ({ kind: 'non-2xx' as const, detail })),
        ),
        async (initial, failure) => {
          resetMocks(buildProjectRecord({ sourceCode: initial }))
          serveFetchFailure(failure.kind, failure.detail)

          await CrawlerService.triggerCrawl(PROJECT_ID)

          // The crawl is recorded as failed and no markup was persisted...
          expect(findProjectUpdateData('FAILED')).not.toBeNull()
          expect(findProjectUpdateData('SUCCESS')).toBeNull()
          expect(mockCrawlMetadataUpsert).not.toHaveBeenCalled()

          // ...and the column was not touched in either direction: a failed
          // fetch has nothing to offer, and must not clear a pasted value.
          expectNoSourceCodeWrite()
          expect(projectRow.sourceCode).toBe(initial)
        },
      ),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P26-e: the written value respects the 100.000 character cap
  // -------------------------------------------------------------------------

  it('P26-e — markup beyond 100.000 characters SHALL be stored as an exact 100.000 character prefix [**Validates: Requirements 3.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: MAX_SOURCE_CODE_LENGTH + 1, max: 160_000 }),
        emptySourceCodeArbitrary,
        async (paddingLength, empty) => {
          // Padding lives inside a comment so the document still parses as one.
          const markup =
            '<!DOCTYPE html><html><head><title>Besar</title></head>' +
            '<body><h1>Judul</h1><!--' +
            'x'.repeat(paddingLength) +
            '--></body></html>'

          resetMocks(buildProjectRecord({ sourceCode: empty }))
          serveFetchBodies([markup])

          await CrawlerService.triggerCrawl(PROJECT_ID)

          const written = findProjectUpdateData('SUCCESS')?.sourceCode as string
          expect(markup.length).toBeGreaterThan(MAX_SOURCE_CODE_LENGTH)
          expect(written).toHaveLength(MAX_SOURCE_CODE_LENGTH)
          // A prefix cut, so the head of the document survives.
          expect(markup.startsWith(written)).toBe(true)
        },
      ),
      // Deliberately fewer runs than the other sub-properties: each run builds
      // and parses a document north of 100.000 characters, and the only axis
      // being varied is a length that the cap flattens anyway.
      { numRuns: 40 },
    )
  })

  // -------------------------------------------------------------------------
  // PARTYROCK: the column is not this crawler's business at all
  // -------------------------------------------------------------------------

  it('P26-f — a PARTYROCK crawl SHALL never write sourceCode, empty column or not [**Validates: Requirements 3.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(emptySourceCodeArbitrary, nonEmptySourceCodeArbitrary),
        markupArbitrary,
        async (initial, markup) => {
          resetMocks(
            buildProjectRecord({
              projectType: 'PARTYROCK',
              url: 'https://partyrock.aws/app/test-app',
              sourceCode: initial,
            }),
          )
          serveFetchBodies([markup])

          await CrawlerService.triggerCrawl(PROJECT_ID)

          expect(findProjectUpdateData('SUCCESS')).not.toBeNull()
          // The PartyRock strategy produces no `sourceCode` candidate, so the
          // Capture Pipeline's value — present or not — is never disturbed.
          expectNoSourceCodeWrite()
          expect(projectRow.sourceCode).toBe(initial)
        },
      ),
      { numRuns: 200 },
    )
  })
})
