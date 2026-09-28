// lib/services/scoring-queue.service.ts
//
// A queue for bulk scoring runs, stored in the database rather than in
// memory: on a serverless runtime every request is a fresh process, so an
// in-memory queue would lose its backlog on the next cold start, and three
// concurrent invocations would each build their own.
//
// The queue *is* `Project.scoreStatus`. A worker claims PENDING rows by
// flipping them to PROCESSING in one statement (`SKIP LOCKED`, so parallel
// workers never take the same row), runs the pipeline, and the pipeline
// itself writes the final status. A claim that is never finished — the worker
// was killed, the function timed out — is reclaimed after `STALE_AFTER_MINUTES`
// and retried until `DEFAULT_MAX_ATTEMPTS`.
//
// Why a queue at all: 3000 projects × 4+ model calls fired from `after()` on
// submission would hit provider rate limits and the platform's function
// timeout within minutes. The queue turns that spike into a controlled drip.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { CrawlerService } from '@/lib/services/crawler.service'
import { ScorerService } from '@/lib/services/scorer.service'

/** A project that keeps failing is parked rather than retried forever. */
export const DEFAULT_MAX_ATTEMPTS = 3

/** How long a PROCESSING claim may sit before a worker is presumed dead. */
export const STALE_AFTER_MINUTES = 15

/** Projects claimed per round trip. Small: each one costs several model calls. */
export const DEFAULT_BATCH_SIZE = 5

/** Projects scored in parallel. Every one of them holds several API calls open. */
export const DEFAULT_CONCURRENCY = 3

export interface ScoringJob {
  id: string
  crawlStatus: string
}

export interface QueueStats {
  pending: number
  processing: number
  /** PENDING rows that have already exhausted their attempts. */
  stuck: number
  failed: number
  scored: number
}

export interface RunQueueOptions {
  /** Projects to claim per round. */
  batchSize?: number
  /** Projects processed in parallel within a round. */
  concurrency?: number
  /**
   * Stop claiming new work once this much time has passed. The run finishes
   * what it already claimed. Set it below the platform's function timeout;
   * leave it undefined for a long-running worker (the CLI script).
   */
  timeBudgetMs?: number
  maxAttempts?: number
  /** Only this category. Omitted: every category. */
  categoryId?: string
  /** Stop after this many projects, however much budget is left. */
  maxProjects?: number
  /** Swapped out in tests; defaults to the real crawl/score pipeline. */
  process?: (job: ScoringJob) => Promise<void>
  onProgress?: (progress: { succeeded: number; failed: number; lastId: string }) => void
}

export interface RunQueueResult {
  claimed: number
  succeeded: number
  failed: number
  reclaimed: number
  /** PENDING rows still waiting when the run stopped. */
  remaining: number
  stoppedBecause: 'empty' | 'time-budget' | 'max-projects'
}

// -----------------------------------------------------------------------
// Claiming
// -----------------------------------------------------------------------

/**
 * Claim up to `limit` waiting projects.
 *
 * One statement, on purpose. The Neon HTTP adapter cannot run interactive
 * transactions, so a read-then-write claim would race: two workers would both
 * see the same PENDING row and both score it, paying twice and racing on the
 * result. `FOR UPDATE SKIP LOCKED` inside the sub-select makes the claim
 * atomic and lets parallel workers pass each other by.
 */
export async function claimScoringJobs(
  limit: number = DEFAULT_BATCH_SIZE,
  options: { maxAttempts?: number; categoryId?: string } = {},
): Promise<ScoringJob[]> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const categoryFilter = options.categoryId
    ? Prisma.sql`AND "categoryId" = ${options.categoryId}`
    : Prisma.empty

  return db.$queryRaw<ScoringJob[]>`
    UPDATE "Project" SET
      "scoreStatus" = 'PROCESSING'::"ScoreStatus",
      "scoreStartedAt" = NOW(),
      "scoreAttempts" = "scoreAttempts" + 1
    WHERE id IN (
      SELECT id FROM "Project"
      WHERE "isActive" = true
        AND "scoreStatus" = 'PENDING'::"ScoreStatus"
        AND "scoreAttempts" < ${maxAttempts}
        ${categoryFilter}
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, "crawlStatus"::text AS "crawlStatus"
  `
}

/**
 * Return claims whose worker never finished to the queue. Without this a
 * function timeout would leave the project stuck in PROCESSING forever, and
 * it would silently never be scored.
 */
export async function reclaimStaleScoringJobs(
  staleAfterMinutes: number = STALE_AFTER_MINUTES,
): Promise<number> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE "Project" SET "scoreStatus" = 'PENDING'::"ScoreStatus"
    WHERE "scoreStatus" = 'PROCESSING'::"ScoreStatus"
      AND "scoreStartedAt" < NOW() - ${`${staleAfterMinutes} minutes`}::interval
    RETURNING id
  `
  if (rows.length > 0) {
    console.warn(`[Queue] Reclaimed ${rows.length} stale claim(s) older than ${staleAfterMinutes}m`)
  }
  return rows.length
}

// -----------------------------------------------------------------------
// Stats
// -----------------------------------------------------------------------

export async function getQueueStats(categoryId?: string): Promise<QueueStats> {
  const where = { isActive: true, ...(categoryId ? { categoryId } : {}) }
  const [pending, processing, stuck, failed, scored] = await Promise.all([
    db.project.count({ where: { ...where, scoreStatus: 'PENDING' } }),
    db.project.count({ where: { ...where, scoreStatus: 'PROCESSING' } }),
    db.project.count({
      where: { ...where, scoreStatus: 'PENDING', scoreAttempts: { gte: DEFAULT_MAX_ATTEMPTS } },
    }),
    db.project.count({ where: { ...where, scoreStatus: 'FAILED' } }),
    db.project.count({ where: { ...where, scoreStatus: { in: ['SUCCESS', 'PARTIAL'] } } }),
  ])
  return { pending, processing, stuck, failed, scored }
}

// -----------------------------------------------------------------------
// Processing
// -----------------------------------------------------------------------

/**
 * The real work for one claimed project: crawl first when the page has never
 * been fetched (the crawl triggers scoring itself), otherwise score directly.
 */
export async function processScoringJob(job: ScoringJob): Promise<void> {
  if (job.crawlStatus === 'PENDING') {
    await CrawlerService.triggerCrawl(job.id)
  } else {
    await ScorerService.triggerScoring(job.id)
  }
}

/** Runs `jobs` through `worker`, never more than `concurrency` at a time. */
async function mapWithConcurrency<T>(
  jobs: T[],
  concurrency: number,
  worker: (job: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      await worker(job)
    }
  })
  await Promise.all(runners)
}

export async function runScoringQueue(options: RunQueueOptions = {}): Promise<RunQueueResult> {
  const {
    batchSize = DEFAULT_BATCH_SIZE,
    concurrency = DEFAULT_CONCURRENCY,
    timeBudgetMs,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    categoryId,
    maxProjects,
    process: processJob = processScoringJob,
    onProgress,
  } = options

  const startedAt = Date.now()
  const outOfTime = () => timeBudgetMs !== undefined && Date.now() - startedAt >= timeBudgetMs

  const reclaimed = await reclaimStaleScoringJobs()

  let claimed = 0
  let succeeded = 0
  let failed = 0
  let stoppedBecause: RunQueueResult['stoppedBecause'] = 'empty'

  for (;;) {
    if (outOfTime()) {
      stoppedBecause = 'time-budget'
      break
    }
    if (maxProjects !== undefined && claimed >= maxProjects) {
      stoppedBecause = 'max-projects'
      break
    }

    const limit =
      maxProjects === undefined ? batchSize : Math.min(batchSize, maxProjects - claimed)
    const jobs = await claimScoringJobs(limit, { maxAttempts, categoryId })
    if (jobs.length === 0) {
      stoppedBecause = 'empty'
      break
    }
    claimed += jobs.length

    await mapWithConcurrency(jobs, concurrency, async (job) => {
      try {
        await processJob(job)
        succeeded++
        // The pipeline owns `scoreStatus`; the queue only clears the error of
        // the previous attempt so a stale message cannot outlive its failure.
        await db.project.update({
          where: { id: job.id },
          data: { scoreError: null, scoreStartedAt: null },
        })
      } catch (error) {
        failed++
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[Queue] Project ${job.id} failed:`, message)
        // FAILED, not back to PENDING: the attempt counter already decides
        // whether it is retried, and a claim left PROCESSING would only be
        // reclaimed 15 minutes later.
        await db.project
          .update({
            where: { id: job.id },
            data: {
              scoreStatus: 'FAILED',
              scoreError: message.slice(0, 1000),
              scoreStartedAt: null,
            },
          })
          .catch((updateError) =>
            console.error(`[Queue] Could not record failure for ${job.id}:`, updateError),
          )
      }
      onProgress?.({ succeeded, failed, lastId: job.id })
    })
  }

  const remaining = await db.project.count({
    where: {
      isActive: true,
      scoreStatus: 'PENDING',
      scoreAttempts: { lt: maxAttempts },
      ...(categoryId ? { categoryId } : {}),
    },
  })

  return { claimed, succeeded, failed, reclaimed, remaining, stoppedBecause }
}

/**
 * Put projects back in the queue — the admin action behind "retry the ones
 * that failed". Resets the attempt counter, otherwise a project that already
 * spent its attempts would be claimed and dropped again immediately.
 */
export async function requeueProjects(
  filter: { categoryId?: string; onlyFailed?: boolean } = {},
): Promise<number> {
  const { count } = await db.project.updateMany({
    where: {
      isActive: true,
      ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
      ...(filter.onlyFailed
        ? { scoreStatus: 'FAILED' }
        : { scoreStatus: { in: ['FAILED', 'PENDING'] } }),
    },
    data: { scoreStatus: 'PENDING', scoreAttempts: 0, scoreStartedAt: null, scoreError: null },
  })
  return count
}
