/**
 * Property-Based Tests: Property 9 — Crawl Re-trigger Overwrites Previous Data
 *
 * **Validates: Requirements 4.6**
 *
 * Property 9 (from design.md):
 *   For any project that already has CrawlMetadata stored, triggering a re-crawl
 *   SHALL replace all fields in CrawlMetadata with new results and mark
 *   scoreStatus as PENDING.
 *
 * Strategy:
 *   Mock `db` (Prisma) and `CrawlerService.crawl` (Playwright) to avoid real
 *   I/O. Then invoke `CrawlerService.retriggerCrawl(projectId)` and assert:
 *   - P9-A: `db.crawlMetadata.deleteMany` is called with the correct projectId
 *   - P9-B: `db.project.update` resets scoreStatus to 'PENDING'
 *   - P9-C: After retrigger, new CrawlMetadata is upserted with fresh data
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import type { PartyRockMetadata, WidgetInfo } from '@/types'

// ---------------------------------------------------------------------------
// Mock modules BEFORE importing the service under test.
// ---------------------------------------------------------------------------

vi.mock('@/lib/db', () => ({
  db: {
    project: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    crawlMetadata: {
      deleteMany: vi.fn(),
      upsert: vi.fn(),
    },
  },
}))

// We need to mock the `crawl` static method but keep the rest of the class.
// Since `retriggerCrawl` calls `triggerCrawl` which calls `CrawlerService.crawl`,
// we mock the `crawl` method via a spy on the actual module.
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(),
  },
}))

import { db } from '@/lib/db'
import { CrawlerService } from '@/lib/services/crawler.service'

// Mock CrawlerService.crawl to avoid launching Playwright
const crawlSpy = vi.spyOn(CrawlerService, 'crawl')

// Typed references to mocked DB functions
const mockDeleteMany = vi.mocked(db.crawlMetadata.deleteMany)
const mockProjectUpdate = vi.mocked(db.project.update)
const mockProjectFindUniqueOrThrow = vi.mocked(db.project.findUniqueOrThrow)
const mockCrawlMetadataUpsert = vi.mocked(db.crawlMetadata.upsert)

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** CUID-like project ID */
const projectIdArb = fc
  .stringMatching(/^[a-z0-9]{20,25}$/)
  .map((s) => `cl${s}`)

/** Non-empty title string */
const titleArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0)

/** Optional description */
const descriptionArb: fc.Arbitrary<string | null> = fc.option(
  fc.string({ minLength: 1, maxLength: 500 }),
  { nil: null },
)

/** Widget info */
const widgetInfoArb: fc.Arbitrary<WidgetInfo> = fc.record({
  type: fc.stringMatching(/^[a-z][a-z0-9\-]{0,19}$/),
  label: fc.oneof(fc.constant(''), fc.string({ minLength: 1, maxLength: 50 })),
})

/** Widgets array */
const widgetsArb = fc.array(widgetInfoArb, { minLength: 0, maxLength: 8 })

/** Prompts array */
const promptsArb = fc.array(
  fc.string({ minLength: 1, maxLength: 200 }),
  { minLength: 0, maxLength: 5 },
)

/** Valid PartyRockMetadata with consistent widgetCount */
const metadataArb: fc.Arbitrary<PartyRockMetadata> = fc
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
    widgetCount: widgets.length,
  }))

/** PartyRock URL */
const urlArb = fc
  .stringMatching(/^[a-z0-9\-]{3,20}$/)
  .map((slug) => `https://partyrock.aws/app/${slug}`)

/** Category ID */
const categoryIdArb = fc
  .stringMatching(/^[a-z0-9]{20,25}$/)
  .map((s) => `cat_${s}`)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a simulated project DB record for findUniqueOrThrow responses.
 */
function buildProjectRecord(projectId: string, url: string, categoryId: string) {
  return {
    id: projectId,
    url,
    categoryId,
    participantName: 'Test Participant',
    teamName: null,
    crawlStatus: 'SUCCESS' as const,
    crawlError: null,
    scoreStatus: 'SUCCESS' as const,
    finalScore: 85.5,
    createdAt: new Date(),
    updatedAt: new Date(),
    category: { id: categoryId, name: 'Test Category' },
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()

  // Default stubs — individual tests may override
  mockDeleteMany.mockResolvedValue({ count: 1 } as never)
  mockProjectUpdate.mockResolvedValue({} as never)
  mockProjectFindUniqueOrThrow.mockResolvedValue({} as never)
  mockCrawlMetadataUpsert.mockResolvedValue({} as never)
})

// ---------------------------------------------------------------------------
// Property 9: Crawl Re-trigger Overwrites Previous Data
// ---------------------------------------------------------------------------

describe('Property 9: Crawl Re-trigger Overwrites Previous Data', () => {
  /**
   * P9-A: After retriggerCrawl, `db.crawlMetadata.deleteMany` is called
   * with the correct projectId — ensuring previous metadata is removed.
   *
   * **Validates: Requirements 4.6**
   */
  it('P9-A — retriggerCrawl SHALL call deleteMany on crawlMetadata with the correct projectId [**Validates: Requirements 4.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        projectIdArb,
        urlArb,
        categoryIdArb,
        metadataArb,
        async (projectId, url, categoryId, newMetadata) => {
          vi.clearAllMocks()

          const project = buildProjectRecord(projectId, url, categoryId)
          mockProjectFindUniqueOrThrow.mockResolvedValue(project as never)
          mockDeleteMany.mockResolvedValue({ count: 1 } as never)
          mockProjectUpdate.mockResolvedValue({} as never)
          mockCrawlMetadataUpsert.mockResolvedValue({} as never)
          crawlSpy.mockResolvedValue(newMetadata)

          await CrawlerService.retriggerCrawl(projectId)

          // deleteMany must be called with the correct projectId
          expect(mockDeleteMany).toHaveBeenCalledWith({
            where: { projectId },
          })
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P9-B: After retriggerCrawl, the project's scoreStatus is set to 'PENDING'
   * — indicating AI scoring needs to be rerun.
   *
   * **Validates: Requirements 4.6**
   */
  it('P9-B — retriggerCrawl SHALL reset scoreStatus to PENDING [**Validates: Requirements 4.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        projectIdArb,
        urlArb,
        categoryIdArb,
        metadataArb,
        async (projectId, url, categoryId, newMetadata) => {
          vi.clearAllMocks()

          const project = buildProjectRecord(projectId, url, categoryId)
          mockProjectFindUniqueOrThrow.mockResolvedValue(project as never)
          mockDeleteMany.mockResolvedValue({ count: 1 } as never)
          mockProjectUpdate.mockResolvedValue({} as never)
          mockCrawlMetadataUpsert.mockResolvedValue({} as never)
          crawlSpy.mockResolvedValue(newMetadata)

          await CrawlerService.retriggerCrawl(projectId)

          // Find the update call that sets scoreStatus to PENDING
          const updateCalls = mockProjectUpdate.mock.calls
          const scoreResetCall = updateCalls.find(
            (call) =>
              (call[0] as { data: { scoreStatus?: string } }).data
                .scoreStatus === 'PENDING',
          )

          expect(scoreResetCall).toBeDefined()
          expect(
            (scoreResetCall![0] as { where: { id: string } }).where.id,
          ).toBe(projectId)
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P9-C: After retriggerCrawl, new CrawlMetadata is upserted with fresh
   * crawl data — the new metadata fields come from the latest crawl result.
   *
   * **Validates: Requirements 4.6**
   */
  it('P9-C — retriggerCrawl SHALL upsert new CrawlMetadata with fresh data from the latest crawl [**Validates: Requirements 4.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        projectIdArb,
        urlArb,
        categoryIdArb,
        metadataArb,
        async (projectId, url, categoryId, newMetadata) => {
          vi.clearAllMocks()

          const project = buildProjectRecord(projectId, url, categoryId)
          mockProjectFindUniqueOrThrow.mockResolvedValue(project as never)
          mockDeleteMany.mockResolvedValue({ count: 1 } as never)
          mockProjectUpdate.mockResolvedValue({} as never)
          mockCrawlMetadataUpsert.mockResolvedValue({} as never)
          crawlSpy.mockResolvedValue(newMetadata)

          await CrawlerService.retriggerCrawl(projectId)

          // crawlMetadata.upsert must have been called with the new metadata
          expect(mockCrawlMetadataUpsert).toHaveBeenCalled()

          const upsertCall = mockCrawlMetadataUpsert.mock.calls[0][0] as {
            where: { projectId: string }
            create: {
              projectId: string
              title: string | null
              description: string | null
              widgets: unknown
              prompts: unknown
              widgetCount: number
            }
            update: {
              title: string | null
              description: string | null
              widgets: unknown
              prompts: unknown
              widgetCount: number
            }
          }

          // The upsert is keyed on projectId
          expect(upsertCall.where.projectId).toBe(projectId)

          // create payload contains the new metadata fields
          expect(upsertCall.create.projectId).toBe(projectId)
          expect(upsertCall.create.title).toBe(newMetadata.title)
          expect(upsertCall.create.description).toBe(newMetadata.description)
          expect(upsertCall.create.widgetCount).toBe(newMetadata.widgetCount)

          // update payload also contains fresh data
          expect(upsertCall.update.title).toBe(newMetadata.title)
          expect(upsertCall.update.description).toBe(newMetadata.description)
          expect(upsertCall.update.widgetCount).toBe(newMetadata.widgetCount)
        },
      ),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Deterministic edge-case unit tests (complement the property tests)
// ---------------------------------------------------------------------------

describe('Property 9: Crawl Re-trigger — deterministic edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('retrigger on project with existing metadata deletes old data before re-crawl', async () => {
    const projectId = 'cl_test_retrigger_001'
    const project = buildProjectRecord(
      projectId,
      'https://partyrock.aws/app/my-app',
      'cat_001',
    )
    const newMetadata: PartyRockMetadata = {
      title: 'Updated App',
      description: 'Fresh description',
      widgets: [{ type: 'ai', label: 'AI Widget' }],
      prompts: ['Generate something'],
      widgetCount: 1,
    }

    mockProjectFindUniqueOrThrow.mockResolvedValue(project as never)
    mockDeleteMany.mockResolvedValue({ count: 1 } as never)
    mockProjectUpdate.mockResolvedValue({} as never)
    mockCrawlMetadataUpsert.mockResolvedValue({} as never)
    crawlSpy.mockResolvedValue(newMetadata)

    await CrawlerService.retriggerCrawl(projectId)

    // deleteMany called before triggerCrawl
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { projectId },
    })

    // scoreStatus reset to PENDING
    const scoreResetCall = mockProjectUpdate.mock.calls.find(
      (call) =>
        (call[0] as { data: { scoreStatus?: string } }).data.scoreStatus ===
        'PENDING',
    )
    expect(scoreResetCall).toBeDefined()

    // New metadata upserted
    expect(mockCrawlMetadataUpsert).toHaveBeenCalled()
  })

  it('retrigger sets crawlStatus to SUCCESS when crawl succeeds', async () => {
    const projectId = 'cl_test_retrigger_002'
    const project = buildProjectRecord(
      projectId,
      'https://partyrock.aws/app/success-app',
      'cat_002',
    )
    const metadata: PartyRockMetadata = {
      title: 'Success App',
      description: null,
      widgets: [],
      prompts: [],
      widgetCount: 0,
    }

    mockProjectFindUniqueOrThrow.mockResolvedValue(project as never)
    mockDeleteMany.mockResolvedValue({ count: 1 } as never)
    mockProjectUpdate.mockResolvedValue({} as never)
    mockCrawlMetadataUpsert.mockResolvedValue({} as never)
    crawlSpy.mockResolvedValue(metadata)

    await CrawlerService.retriggerCrawl(projectId)

    // There should be a project.update call setting crawlStatus to SUCCESS
    const successCall = mockProjectUpdate.mock.calls.find(
      (call) =>
        (call[0] as { data: { crawlStatus?: string } }).data.crawlStatus ===
        'SUCCESS',
    )
    expect(successCall).toBeDefined()
  })

  it('retrigger sets crawlStatus to FAILED when crawl throws', async () => {
    const projectId = 'cl_test_retrigger_003'
    const project = buildProjectRecord(
      projectId,
      'https://partyrock.aws/app/fail-app',
      'cat_003',
    )

    mockProjectFindUniqueOrThrow.mockResolvedValue(project as never)
    mockDeleteMany.mockResolvedValue({ count: 1 } as never)
    mockProjectUpdate.mockResolvedValue({} as never)
    crawlSpy.mockRejectedValue(new Error('Timeout after 30s'))

    await CrawlerService.retriggerCrawl(projectId)

    // There should be a project.update call setting crawlStatus to FAILED
    const failedCall = mockProjectUpdate.mock.calls.find(
      (call) =>
        (call[0] as { data: { crawlStatus?: string } }).data.crawlStatus ===
        'FAILED',
    )
    expect(failedCall).toBeDefined()
    expect(
      (failedCall![0] as { data: { crawlError?: string } }).data.crawlError,
    ).toBe('Timeout after 30s')
  })

  it('order of operations: deleteMany before scoreStatus reset before triggerCrawl', async () => {
    const projectId = 'cl_test_retrigger_004'
    const callOrder: string[] = []

    const project = buildProjectRecord(
      projectId,
      'https://partyrock.aws/app/order-app',
      'cat_004',
    )
    const metadata: PartyRockMetadata = {
      title: 'Order Test',
      description: 'Testing call order',
      widgets: [{ type: 'text', label: 'Input' }],
      prompts: ['test'],
      widgetCount: 1,
    }

    mockProjectFindUniqueOrThrow.mockResolvedValue(project as never)
    // These implementations only record call order; the Prisma return types
    // are irrelevant here, so the functions are cast rather than fully typed.
    mockDeleteMany.mockImplementation((async () => {
      callOrder.push('deleteMany')
      return { count: 1 }
    }) as never)
    mockProjectUpdate.mockImplementation((async (args: unknown) => {
      const data = (args as { data: Record<string, unknown> }).data
      if (data.scoreStatus === 'PENDING') {
        callOrder.push('resetScoreStatus')
      } else if (data.crawlStatus === 'PROCESSING') {
        callOrder.push('setProcessing')
      } else if (data.crawlStatus === 'SUCCESS') {
        callOrder.push('setSuccess')
      }
      return {}
    }) as never)
    mockCrawlMetadataUpsert.mockImplementation((async () => {
      callOrder.push('upsertMetadata')
      return {}
    }) as never)
    crawlSpy.mockResolvedValue(metadata)

    await CrawlerService.retriggerCrawl(projectId)

    // deleteMany and resetScoreStatus must come before setProcessing
    const deleteIdx = callOrder.indexOf('deleteMany')
    const resetIdx = callOrder.indexOf('resetScoreStatus')
    const processingIdx = callOrder.indexOf('setProcessing')

    expect(deleteIdx).toBeLessThan(processingIdx)
    expect(resetIdx).toBeLessThan(processingIdx)
  })
})
