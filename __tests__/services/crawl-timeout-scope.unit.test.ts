/**
 * Unit Tests: the 60s crawl deadline covers the crawl only, not AI scoring.
 *
 * Regression: scoring used to run inside `triggerCrawl`'s timeout race. A
 * healthy scoring run that took longer than 60s tripped the deadline, the
 * project was marked `crawlStatus = FAILED` ("Crawl timed out after 60
 * seconds") although the crawl had finished — or had no URL to fetch at all —
 * and `triggerCrawl` resolved while scoring was still running, which on a
 * serverless runtime ends the `after()` invocation and kills the scoring.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

vi.mock('@/lib/services/scorer.service', () => ({
  ScorerService: { triggerScoring: vi.fn() },
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

const PROJECT_ID = 'project-1'
const SCORING_MS = 90_000

function projectRecord(url: string | null) {
  return {
    id: PROJECT_ID,
    url,
    sourceCode: '<html><body>pasted</body></html>',
    category: {},
  } as unknown as Awaited<ReturnType<typeof db.project.findUniqueOrThrow>>
}

/** Every `crawlStatus` written to the project, in order. */
function crawlStatusWrites(): string[] {
  return mockProjectUpdate.mock.calls
    .map(([args]) => (args as { data: { crawlStatus?: string } }).data.crawlStatus)
    .filter((status): status is string => status !== undefined)
}

describe('triggerCrawl — crawl deadline scope', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mockProjectUpdate.mockResolvedValue({} as never)
    mockCrawlMetadataUpsert.mockResolvedValue({} as never)
    // Scoring slower than the 60s crawl deadline.
    mockTriggerScoring.mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, SCORING_MS)),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['without a URL', null],
    ['with a URL', 'https://example.com/'],
  ])('slow scoring does not mark the crawl FAILED (project %s)', async (_label, url) => {
    mockProjectFindUniqueOrThrow.mockResolvedValue(projectRecord(url))
    mockFetch.mockResolvedValue(new Response('<html><head><title>T</title></head></html>'))

    let settled = false
    const run = CrawlerService.triggerCrawl(PROJECT_ID).then(() => {
      settled = true
    })

    // Past the crawl deadline, scoring still running.
    await vi.advanceTimersByTimeAsync(61_000)
    expect(mockTriggerScoring).toHaveBeenCalledTimes(1)
    expect(crawlStatusWrites()).not.toContain('FAILED')
    // `triggerCrawl` must still be pending, keeping an enclosing `after()` alive.
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(SCORING_MS)
    await run
    expect(settled).toBe(true)
    expect(crawlStatusWrites().at(-1)).toBe('SUCCESS')
  })

  it('a crawl that really hangs is marked FAILED and still proceeds to scoring', async () => {
    mockProjectFindUniqueOrThrow.mockResolvedValue(projectRecord('https://example.com/'))
    // A hung crawlMetadata write — the per-fetch timeout cannot see it.
    mockCrawlMetadataUpsert.mockReturnValue(new Promise(() => {}) as never)
    mockFetch.mockResolvedValue(new Response('<html></html>'))
    mockTriggerScoring.mockResolvedValue(undefined)

    const run = CrawlerService.triggerCrawl(PROJECT_ID)
    await vi.advanceTimersByTimeAsync(60_000)
    await run

    expect(crawlStatusWrites().at(-1)).toBe('FAILED')
    expect(mockTriggerScoring).toHaveBeenCalledTimes(1)
  })
})
