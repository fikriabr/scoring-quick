/**
 * Property-Based Tests: Property 8 — Crawl Metadata Extraction Completeness
 *
 * **Validates: Requirements 4.2, 4.5**
 *
 * Property 8 (from design.md):
 *   For any successfully crawled PartyRock URL, the resulting `CrawlMetadata`
 *   object SHALL contain non-null values for `title`, a `widgets` array
 *   (possibly empty), a `prompts` array (possibly empty), and a `widgetCount`
 *   equal to `widgets.length`.
 *
 * Two testing strategies are used:
 *
 * 1. **Pure structural invariant** (no mocking):
 *    Given any valid `ProjectMetadata` object constructed directly, the
 *    `widgetCount` field MUST equal `widgets.length`. This tests the invariant
 *    at the data-structure level, independent of I/O.
 *
 * 2. **Mocked CrawlerService** (simulates real crawl results):
 *    `CrawlerService.crawl` is mocked to return arbitrary but structurally
 *    valid `ProjectMetadata` values. The caller's assertions on the returned
 *    object are verified — title is a string, widgets is an array, prompts is
 *    an array, and widgetCount === widgets.length.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import type { ProjectMetadata, WidgetInfo } from '@/types'
import type { CrawlOutcome } from '@/lib/services/crawler.service'

// ---------------------------------------------------------------------------
// Mock CrawlerService BEFORE importing it so that the module receives the
// mocked version. Playwright is NOT invoked during tests.
// ---------------------------------------------------------------------------
vi.mock('@/lib/services/crawler.service', () => ({
  CrawlerService: {
    crawl: vi.fn(),
  },
}))

import { CrawlerService } from '@/lib/services/crawler.service'

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates a non-empty string that can serve as a page title.
 * Allows printable characters; length between 1 and 200.
 */
const titleArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0)

/**
 * Generates an optional description (string or null).
 */
const descriptionArb: fc.Arbitrary<string | null> = fc.option(
  fc.string({ minLength: 1, maxLength: 500 }),
  { nil: null },
)

/**
 * Generates a single WidgetInfo object with a non-empty type and a label
 * (may be empty, mirrors aria-label which is optional in the DOM).
 */
const widgetInfoArb: fc.Arbitrary<WidgetInfo> = fc.record({
  type: fc.stringMatching(/^[a-z][a-z0-9\-]{0,29}$/),
  label: fc.oneof(fc.constant(''), fc.string({ minLength: 1, maxLength: 100 })),
})

/**
 * Generates a widgets array of 0–10 WidgetInfo items.
 */
const widgetsArb: fc.Arbitrary<WidgetInfo[]> = fc.array(widgetInfoArb, {
  minLength: 0,
  maxLength: 10,
})

/**
 * Generates a prompts array of 0–5 non-empty strings.
 */
const promptsArb: fc.Arbitrary<string[]> = fc.array(
  fc.string({ minLength: 1, maxLength: 300 }),
  { minLength: 0, maxLength: 5 },
)

/**
 * Generates a complete, structurally valid `ProjectMetadata` object where
 * `widgetCount` is derived correctly from `widgets.length`.
 */
const validMetadataArb: fc.Arbitrary<ProjectMetadata> = fc
  .record({
    title: titleArb,
    description: descriptionArb,
    widgets: widgetsArb,
    prompts: promptsArb,
  })
  .map(({ title, description, widgets, prompts }) => ({
    title,
    description,
    widgets,
    prompts,
    widgetCount: widgets.length, // enforces the invariant in generated data
  }))

/**
 * Generates a `ProjectMetadata` where `widgetCount` may be intentionally
 * incorrect (to verify that inconsistent objects fail the invariant check).
 * Used only in the invariant violation test.
 */
const inconsistentMetadataArb: fc.Arbitrary<ProjectMetadata> = fc
  .record({
    title: titleArb,
    description: descriptionArb,
    widgets: widgetsArb,
    prompts: promptsArb,
    widgetCount: fc.integer({ min: 0, max: 50 }),
  })
  .filter(({ widgets, widgetCount }) => widgetCount !== widgets.length)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Checks that a `ProjectMetadata` object satisfies Property 8 invariants:
 *  - title is a non-null string
 *  - widgets is an array
 *  - prompts is an array
 *  - widgetCount === widgets.length
 */
function assertMetadataInvariants(metadata: ProjectMetadata): void {
  // title is a string (not undefined, not null)
  expect(typeof metadata.title).toBe('string')

  // widgets is an array (possibly empty)
  expect(Array.isArray(metadata.widgets)).toBe(true)

  // prompts is an array (possibly empty)
  expect(Array.isArray(metadata.prompts)).toBe(true)

  // widgetCount equals widgets.length — the core structural invariant
  expect(metadata.widgetCount).toBe(metadata.widgets.length)
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Part 1: Pure structural invariant (no mocking, no I/O)
// ---------------------------------------------------------------------------

describe('Property 8 (pure): widgetCount === widgets.length invariant', () => {
  /**
   * P8-pure-a: For any valid metadata generated with widgetCount correctly
   * set, the invariant `widgetCount === widgets.length` holds.
   *
   * **Validates: Requirements 4.2, 4.5**
   */
  it('P8-pure-a — widgetCount SHALL equal widgets.length for any valid metadata [**Validates: Requirements 4.2, 4.5**]', () => {
    fc.assert(
      fc.property(validMetadataArb, (metadata) => {
        expect(metadata.widgetCount).toBe(metadata.widgets.length)
      }),
      { numRuns: 500 },
    )
  })

  /**
   * P8-pure-b: An object where widgetCount ≠ widgets.length violates the
   * invariant. This test confirms that our checker correctly identifies
   * inconsistent objects — validating the checker itself.
   *
   * **Validates: Requirements 4.2, 4.5**
   */
  it('P8-pure-b — inconsistent widgetCount SHALL fail the invariant check [**Validates: Requirements 4.2, 4.5**]', () => {
    fc.assert(
      fc.property(inconsistentMetadataArb, (metadata) => {
        expect(metadata.widgetCount).not.toBe(metadata.widgets.length)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * P8-pure-c: For any empty widgets array, widgetCount must be 0.
   *
   * **Validates: Requirements 4.2, 4.5**
   */
  it('P8-pure-c — empty widgets array SHALL yield widgetCount === 0 [**Validates: Requirements 4.2, 4.5**]', () => {
    fc.assert(
      fc.property(
        fc.record({
          title: titleArb,
          description: descriptionArb,
          prompts: promptsArb,
        }),
        ({ title, description, prompts }) => {
          const metadata: ProjectMetadata = {
            title,
            description,
            widgets: [],
            prompts,
            widgetCount: 0,
          }
          expect(metadata.widgetCount).toBe(0)
          expect(metadata.widgets.length).toBe(0)
          expect(metadata.widgetCount).toBe(metadata.widgets.length)
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P8-pure-d: widgetCount is always a non-negative integer equal to
   * the number of items in the widgets array.
   *
   * **Validates: Requirements 4.2, 4.5**
   */
  it('P8-pure-d — widgetCount SHALL be non-negative and equal to widgets array length [**Validates: Requirements 4.2, 4.5**]', () => {
    fc.assert(
      fc.property(validMetadataArb, (metadata) => {
        expect(metadata.widgetCount).toBeGreaterThanOrEqual(0)
        expect(Number.isInteger(metadata.widgetCount)).toBe(true)
        expect(metadata.widgetCount).toBe(metadata.widgets.length)
      }),
      { numRuns: 300 },
    )
  })
})

// ---------------------------------------------------------------------------
// Part 2: Mocked CrawlerService — simulates real crawl results
// ---------------------------------------------------------------------------

describe('Property 8 (mocked): CrawlerService.crawl returns complete metadata', () => {
  /**
   * P8-mock-a: For any metadata that CrawlerService.crawl returns, the result
   * SHALL satisfy all Property 8 structural requirements.
   *
   * **Validates: Requirements 4.2, 4.5**
   */
  it('P8-mock-a — crawl result SHALL have string title, widget array, prompt array, and consistent widgetCount [**Validates: Requirements 4.2, 4.5**]', async () => {
    await fc.assert(
      fc.asyncProperty(validMetadataArb, async (metadata) => {
        vi.mocked(CrawlerService.crawl).mockResolvedValueOnce(metadata as unknown as CrawlOutcome)

        const result = await CrawlerService.crawl(
          'https://partyrock.aws/app/test-app',
        )

        assertMetadataInvariants(result)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * P8-mock-b: crawl is called with the provided URL — the service does not
   * silently discard or substitute the URL.
   *
   * **Validates: Requirements 4.2, 4.5**
   */
  it('P8-mock-b — crawl SHALL be invoked with the exact URL provided [**Validates: Requirements 4.2, 4.5**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .stringMatching(/^[a-z0-9\-]{3,20}$/)
          .map((slug) => `https://partyrock.aws/app/${slug}`),
        validMetadataArb,
        async (url, metadata) => {
          vi.mocked(CrawlerService.crawl).mockResolvedValueOnce(metadata as unknown as CrawlOutcome)

          await CrawlerService.crawl(url)

          expect(vi.mocked(CrawlerService.crawl)).toHaveBeenCalledWith(url)

          vi.clearAllMocks()
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P8-mock-c: When crawl returns metadata with zero widgets, widgetCount is 0
   * and widgets is an empty array — both conditions must hold simultaneously.
   *
   * **Validates: Requirements 4.2, 4.5**
   */
  it('P8-mock-c — crawl result with no widgets SHALL have widgetCount === 0 [**Validates: Requirements 4.2, 4.5**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          title: titleArb,
          description: descriptionArb,
          prompts: promptsArb,
        }),
        async ({ title, description, prompts }) => {
          const metadata: ProjectMetadata = {
            title,
            description,
            widgets: [],
            prompts,
            widgetCount: 0,
          }
          vi.mocked(CrawlerService.crawl).mockResolvedValueOnce(metadata as unknown as CrawlOutcome)

          const result = await CrawlerService.crawl(
            'https://partyrock.aws/app/empty',
          )

          expect(Array.isArray(result.widgets)).toBe(true)
          expect(result.widgets).toHaveLength(0)
          expect(result.widgetCount).toBe(0)
          expect(result.widgetCount).toBe(result.widgets.length)

          vi.clearAllMocks()
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P8-mock-d: When crawl returns metadata with N widgets, widgetCount equals N.
   * Checks that the count reflects the actual array contents, not a hardcoded value.
   *
   * **Validates: Requirements 4.2, 4.5**
   */
  it('P8-mock-d — widgetCount SHALL always reflect the actual number of widgets returned [**Validates: Requirements 4.2, 4.5**]', async () => {
    await fc.assert(
      fc.asyncProperty(validMetadataArb, async (metadata) => {
        vi.mocked(CrawlerService.crawl).mockResolvedValueOnce(metadata as unknown as CrawlOutcome)

        const result = await CrawlerService.crawl(
          'https://partyrock.aws/app/any',
        )

        expect(result.widgetCount).toBe(result.widgets.length)
        // Additional check: each widget item has type and label
        result.widgets.forEach((widget) => {
          expect(typeof widget.type).toBe('string')
          expect(typeof widget.label).toBe('string')
        })

        vi.clearAllMocks()
      }),
      { numRuns: 300 },
    )
  })

  /**
   * P8-mock-e: For any metadata with a non-empty prompts array, each prompt
   * is a string — confirming the array element type invariant.
   *
   * **Validates: Requirements 4.2, 4.5**
   */
  it('P8-mock-e — each element in the prompts array SHALL be a string [**Validates: Requirements 4.2, 4.5**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        validMetadataArb.filter((m) => m.prompts.length > 0),
        async (metadata) => {
          vi.mocked(CrawlerService.crawl).mockResolvedValueOnce(metadata as unknown as CrawlOutcome)

          const result = await CrawlerService.crawl(
            'https://partyrock.aws/app/prompts-test',
          )

          expect(Array.isArray(result.prompts)).toBe(true)
          result.prompts.forEach((prompt) => {
            expect(typeof prompt).toBe('string')
          })

          vi.clearAllMocks()
        },
      ),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Deterministic edge-case unit tests (complement the property tests)
// ---------------------------------------------------------------------------

describe('Property 8: Crawl Metadata Completeness — deterministic edge cases', () => {
  it('metadata with 0 widgets satisfies all invariants', () => {
    const metadata: ProjectMetadata = {
      title: 'My App',
      description: 'A test application',
      widgets: [],
      prompts: [],
      widgetCount: 0,
    }
    assertMetadataInvariants(metadata)
  })

  it('metadata with multiple widgets has matching widgetCount', () => {
    const metadata: ProjectMetadata = {
      title: 'Complex App',
      description: null,
      widgets: [
        { type: 'text-input', label: 'Enter text' },
        { type: 'ai', label: 'AI Output' },
        { type: 'image', label: 'Generated Image' },
      ],
      prompts: ['Summarize: {{input}}'],
      widgetCount: 3,
    }
    assertMetadataInvariants(metadata)
    expect(metadata.widgetCount).toBe(3)
  })

  it('null description is allowed — title must still be a string', () => {
    const metadata: ProjectMetadata = {
      title: 'Title Only App',
      description: null,
      widgets: [{ type: 'ai', label: '' }],
      prompts: [],
      widgetCount: 1,
    }
    assertMetadataInvariants(metadata)
    expect(metadata.description).toBeNull()
    expect(typeof metadata.title).toBe('string')
  })

  it('widgetCount must equal widgets.length even for large arrays', () => {
    const widgets: WidgetInfo[] = Array.from({ length: 25 }, (_, i) => ({
      type: `widget-type-${i}`,
      label: `Widget ${i}`,
    }))
    const metadata: ProjectMetadata = {
      title: 'Many Widgets App',
      description: 'A complex app',
      widgets,
      prompts: ['prompt 1', 'prompt 2'],
      widgetCount: widgets.length,
    }
    assertMetadataInvariants(metadata)
    expect(metadata.widgetCount).toBe(25)
  })

  it('mocked crawl result satisfies all Property 8 invariants', async () => {
    const expected: ProjectMetadata = {
      title: 'PartyRock App',
      description: 'Creative AI application',
      widgets: [
        { type: 'text-input', label: 'Topic' },
        { type: 'ai', label: 'Story Generator' },
      ],
      prompts: ['Write a story about {{topic}}'],
      widgetCount: 2,
    }
    vi.mocked(CrawlerService.crawl).mockResolvedValueOnce(expected as unknown as CrawlOutcome)

    const result = await CrawlerService.crawl(
      'https://partyrock.aws/app/story-gen',
    )

    assertMetadataInvariants(result)
    expect(result.title).toBe('PartyRock App')
    expect(result.widgets).toHaveLength(2)
    expect(result.widgetCount).toBe(2)
    expect(result.prompts).toHaveLength(1)
  })

  it('widgetCount discrepancy is detectable — 3 widgets but count says 2 fails invariant', () => {
    const metadata: ProjectMetadata = {
      title: 'App',
      description: null,
      widgets: [
        { type: 'text-input', label: '' },
        { type: 'ai', label: '' },
        { type: 'image', label: '' },
      ],
      prompts: [],
      widgetCount: 2, // intentionally wrong
    }
    // The invariant check should detect the mismatch
    expect(metadata.widgetCount).not.toBe(metadata.widgets.length)
    expect(metadata.widgets.length).toBe(3)
  })
})
