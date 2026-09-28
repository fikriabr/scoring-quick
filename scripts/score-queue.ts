// scripts/score-queue.ts
//
// Long-running queue worker, run from a laptop or any box with the project
// checked out:
//
//   npm run score:queue -- --concurrency 3
//
// This exists because the deployment is on a platform whose functions are
// capped at ~60 seconds. A 3000-project run needs hours of model calls, so it
// happens here instead, where the only limits are the provider's rate limits.
// It talks to the same database and the same queue as the app, so the admin UI
// shows progress live and the two can even run at the same time — claims are
// atomic (`SKIP LOCKED`).
//
// Ctrl-C stops it cleanly: the projects already in flight finish, nothing new
// is claimed, and anything half-done is reclaimed by the next run.

import 'dotenv/config'
import {
  getQueueStats,
  runScoringQueue,
  requeueProjects,
  DEFAULT_CONCURRENCY,
} from '../lib/services/scoring-queue.service'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

async function main() {
  const concurrency = Number(arg('concurrency')) || DEFAULT_CONCURRENCY
  const categoryId = arg('category')
  const maxProjects = arg('limit') ? Number(arg('limit')) : undefined

  if (flag('retry-failed')) {
    const requeued = await requeueProjects({ categoryId, onlyFailed: true })
    console.log(`Requeued ${requeued} failed project(s).`)
  }

  const before = await getQueueStats(categoryId)
  console.log(
    `Queue: ${before.pending} waiting, ${before.processing} in flight, ${before.failed} failed, ${before.scored} scored` +
      (before.stuck > 0 ? ` (${before.stuck} parked after too many attempts)` : ''),
  )
  if (before.pending === 0) {
    console.log('Nothing to do.')
    return
  }

  let stopping = false
  process.on('SIGINT', () => {
    if (stopping) process.exit(1)
    stopping = true
    console.log('\nStopping after the projects currently in flight...')
  })

  const startedAt = Date.now()
  let processed = 0

  const result = await runScoringQueue({
    concurrency,
    categoryId,
    maxProjects,
    // No time budget: this worker is not the one racing a function timeout.
    // `stopping` ends the run at the next claim instead.
    batchSize: Math.max(concurrency, 3),
    onProgress: ({ succeeded, failed, lastId }) => {
      processed = succeeded + failed
      const perMinute = processed / ((Date.now() - startedAt) / 60000)
      console.log(
        `  [${processed}] ${lastId} — ok ${succeeded}, failed ${failed}, ${perMinute.toFixed(1)}/min`,
      )
    },
    process: async (job) => {
      if (stopping) throw new Error('Worker stopped before this project started')
      const { processScoringJob } = await import('../lib/services/scoring-queue.service')
      await processScoringJob(job)
    },
  })

  const minutes = (Date.now() - startedAt) / 60000
  console.log(
    `\nDone in ${minutes.toFixed(1)} min — claimed ${result.claimed}, ok ${result.succeeded}, failed ${result.failed}, ${result.remaining} still waiting.`,
  )
  if (result.remaining > 0) {
    console.log('Run it again to continue, or --retry-failed to reset failed projects.')
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
