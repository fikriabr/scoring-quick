/**
 * Unit Tests: the scoring queue (lib/services/scoring-queue.service.ts)
 *
 *   - work is claimed in one atomic statement, so parallel workers never take
 *     the same project twice;
 *   - a project that fails is recorded as FAILED with its reason, and one
 *     failure never stops the rest of the batch;
 *   - the run stops on its time budget instead of being killed by the
 *     platform's function timeout;
 *   - claims left behind by a dead worker are reclaimed and retried, but only
 *     up to the attempt limit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDb = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  project: {
    count: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}))

vi.mock('@/lib/db', () => ({ db: mockDb }))
vi.mock('@/lib/services/crawler.service', () => ({
  CrawlerService: { triggerCrawl: vi.fn() },
}))
vi.mock('@/lib/services/scorer.service', () => ({
  ScorerService: { triggerScoring: vi.fn() },
}))

import {
  DEFAULT_MAX_ATTEMPTS,
  requeueProjects,
  runScoringQueue,
  type ScoringJob,
} from '@/lib/services/scoring-queue.service'
import { CrawlerService } from '@/lib/services/crawler.service'
import { ScorerService } from '@/lib/services/scorer.service'

/**
 * The SQL text of the nth `$queryRaw` call. It is a tagged template, so the
 * first argument is the array of literal fragments around the values.
 */
function sqlOf(callIndex: number): string {
  return Array.from(mockDb.$queryRaw.mock.calls[callIndex][0] as string[]).join(' ')
}

function job(id: string, crawlStatus = 'SUCCESS'): ScoringJob {
  return { id, crawlStatus }
}

/** `$queryRaw` serves the reclaim query first, then each claim in turn. */
function serveClaims(batches: ScoringJob[][]) {
  mockDb.$queryRaw.mockImplementation(async (strings: string[]) => {
    const sql = Array.from(strings).join(' ')
    if (sql.includes('scoreStartedAt" <')) return [] // reclaim: nothing stale
    return batches.shift() ?? []
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.project.count.mockResolvedValue(0)
  mockDb.project.update.mockResolvedValue({})
  mockDb.project.updateMany.mockResolvedValue({ count: 0 })
})

describe('claiming', () => {
  it('claims atomically with SKIP LOCKED, so parallel workers cannot collide', async () => {
    serveClaims([[job('p1')]])

    await runScoringQueue({ process: vi.fn() })

    const claimSql = sqlOf(1)
    expect(claimSql).toContain('UPDATE "Project"')
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED')
    // One statement: no read-then-write window for a second worker to slip into.
    expect(claimSql).toContain('RETURNING')
  })

  it('does not claim a project that has used all its attempts', async () => {
    serveClaims([[]])

    await runScoringQueue({ process: vi.fn(), maxAttempts: DEFAULT_MAX_ATTEMPTS })

    expect(sqlOf(1)).toContain('scoreAttempts" <')
  })

  it('reclaims claims a dead worker left behind before claiming new work', async () => {
    mockDb.$queryRaw.mockImplementation(async (strings: string[]) => {
      const sql = Array.from(strings).join(' ')
      if (sql.includes('scoreStartedAt" <')) return [{ id: 'stale-1' }, { id: 'stale-2' }]
      return []
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runScoringQueue({ process: vi.fn() })

    expect(result.reclaimed).toBe(2)
    expect(sqlOf(0)).toContain("'PROCESSING'")
  })
})

describe('processing', () => {
  it('crawls first when the page was never fetched, scores directly otherwise', async () => {
    serveClaims([[job('needs-crawl', 'PENDING'), job('already-crawled', 'SUCCESS')]])

    await runScoringQueue({ concurrency: 1 })

    expect(CrawlerService.triggerCrawl).toHaveBeenCalledExactlyOnceWith('needs-crawl')
    expect(ScorerService.triggerScoring).toHaveBeenCalledExactlyOnceWith('already-crawled')
  })

  it('records a failure with its reason and keeps going', async () => {
    serveClaims([[job('p1'), job('p2')]])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const process = vi
      .fn()
      .mockRejectedValueOnce(new Error('Gemini quota exceeded'))
      .mockResolvedValueOnce(undefined)

    const result = await runScoringQueue({ process, concurrency: 1 })

    expect(result).toMatchObject({ claimed: 2, succeeded: 1, failed: 1 })
    const failureWrite = mockDb.project.update.mock.calls.find(
      (call) => (call[0] as { data: { scoreStatus?: string } }).data.scoreStatus === 'FAILED',
    )
    expect(failureWrite?.[0]).toMatchObject({
      where: { id: 'p1' },
      data: { scoreStatus: 'FAILED', scoreError: 'Gemini quota exceeded' },
    })
  })

  it('clears the previous attempt error after a successful run', async () => {
    serveClaims([[job('p1')]])

    await runScoringQueue({ process: vi.fn() })

    expect(mockDb.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { scoreError: null, scoreStartedAt: null },
    })
  })

  it('never runs more than `concurrency` projects at once', async () => {
    serveClaims([[job('p1'), job('p2'), job('p3'), job('p4')]])
    let inFlight = 0
    let peak = 0
    const process = vi.fn().mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
    })

    await runScoringQueue({ process, concurrency: 2 })

    expect(peak).toBe(2)
    expect(process).toHaveBeenCalledTimes(4)
  })
})

describe('stopping conditions', () => {
  it('stops claiming once the time budget is spent, rather than being killed mid-project', async () => {
    // Endless work available; each project takes longer than the budget.
    mockDb.$queryRaw.mockImplementation(async (strings: string[]) => {
      const sql = Array.from(strings).join(' ')
      if (sql.includes('scoreStartedAt" <')) return []
      return [job(`p${Math.random()}`)]
    })
    const process = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 30)))

    const result = await runScoringQueue({ process, timeBudgetMs: 40, concurrency: 1 })

    expect(result.stoppedBecause).toBe('time-budget')
    // Whatever it claimed, it finished — nothing is abandoned in PROCESSING.
    expect(result.succeeded + result.failed).toBe(result.claimed)
  })

  it('stops at maxProjects', async () => {
    mockDb.$queryRaw.mockImplementation(async (strings: string[]) => {
      const sql = Array.from(strings).join(' ')
      if (sql.includes('scoreStartedAt" <')) return []
      return [job('a'), job('b')]
    })

    const result = await runScoringQueue({ process: vi.fn(), maxProjects: 2, batchSize: 5 })

    expect(result.claimed).toBe(2)
    expect(result.stoppedBecause).toBe('max-projects')
  })

  it('stops when the queue is empty and reports what is left', async () => {
    serveClaims([[job('p1')], []])
    mockDb.project.count.mockResolvedValue(7)

    const result = await runScoringQueue({ process: vi.fn() })

    expect(result.stoppedBecause).toBe('empty')
    expect(result.remaining).toBe(7)
  })
})

describe('requeueProjects', () => {
  it('resets the attempt counter, or a parked project would be dropped again', async () => {
    mockDb.project.updateMany.mockResolvedValue({ count: 3 })

    const count = await requeueProjects({ onlyFailed: true, categoryId: 'cat-1' })

    expect(count).toBe(3)
    expect(mockDb.project.updateMany).toHaveBeenCalledWith({
      where: { isActive: true, categoryId: 'cat-1', scoreStatus: 'FAILED' },
      data: { scoreStatus: 'PENDING', scoreAttempts: 0, scoreStartedAt: null, scoreError: null },
    })
  })
})
