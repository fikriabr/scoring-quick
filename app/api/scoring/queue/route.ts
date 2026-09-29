// app/api/scoring/queue/route.ts
// The scoring queue's control surface.
//
//   GET  — queue counts, polled by the admin panel
//   POST — process one slice of the queue, then return; the caller decides
//          whether to come back for more
//
// A slice rather than the whole queue because this runs on a platform with a
// hard function timeout: the run stops claiming new work at
// `QUEUE_TIME_BUDGET_MS` and returns what is left, so the invocation always
// ends on its own terms instead of being killed mid-project (which would leave
// claims to be reclaimed 15 minutes later).
//
// Callers: the admin panel (session-authenticated, loops until `remaining` is
// 0) and any external scheduler (cron-job.org, GitHub Actions) presenting
// `CRON_SECRET`. For the 3000-project bulk run, prefer `npm run score:queue` —
// it has no timeout to work around.

export const runtime = 'nodejs'
export const maxDuration = 300

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import {
  getQueueStats,
  requeueProjects,
  runScoringQueue,
} from '@/lib/services/scoring-queue.service'

/**
 * Stop claiming at 150s of a 300s budget: a project claimed just before the
 * cut-off still has to finish, and one scoring run (evaluator, critic rounds,
 * retries with backoff) can take well over a minute.
 */
const QUEUE_TIME_BUDGET_MS = 150_000

/** Admin session, or an external scheduler holding CRON_SECRET. */
async function authorize(request: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const header = request.headers.get('authorization')
    if (header === `Bearer ${secret}`) return true
  }
  const session = await auth()
  return session?.user?.role === 'ADMIN'
}

function forbidden() {
  return NextResponse.json(
    { error: 'Forbidden', message: 'Admin access required.', code: 'FORBIDDEN' },
    { status: 403 },
  )
}

export async function GET(request: NextRequest) {
  try {
    if (!(await authorize(request))) return forbidden()
    const categoryId = request.nextUrl.searchParams.get('categoryId') ?? undefined
    return NextResponse.json(await getQueueStats(categoryId))
  } catch (error) {
    return handleApiError(error)
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!(await authorize(request))) return forbidden()

    const body = await request.json().catch(() => ({}))
    const categoryId = typeof body.categoryId === 'string' ? body.categoryId : undefined

    // "Retry failed" resets the attempt counter first; without that the
    // projects would be claimed and dropped again immediately.
    const requeued =
      body.retryFailed === true
        ? await requeueProjects({ categoryId, onlyFailed: true })
        : 0

    const result = await runScoringQueue({
      categoryId,
      timeBudgetMs: QUEUE_TIME_BUDGET_MS,
      // Deliberately below the CLI worker's default: this shares an
      // invocation with whatever else the deployment is serving.
      concurrency: 2,
      batchSize: 4,
    })

    return NextResponse.json({ ...result, requeued })
  } catch (error) {
    return handleApiError(error)
  }
}
