// app/api/score/[projectId]/route.ts
// API route handler for triggering AI scoring on a project.
// Admin-only — guarded at both proxy and route handler level.
// Requirements: 5.1, 5.8, 9.6

export const runtime = 'nodejs'
// AI scoring runs in `after()` and can outlive the default function timeout.
// 300s is the ceiling every Vercel plan allows.
export const maxDuration = 300

import { NextRequest, NextResponse, after } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import { rateLimit } from '@/lib/rate-limit'
import { ScorerService } from '@/lib/services/scorer.service'
import { db } from '@/lib/db'

// Rate limiter: 10 requests per 60 seconds per user
const limiter = rateLimit({ interval: 60_000, uniqueTokenPerInterval: 500 })

// -----------------------------------------------------------------------
// POST /api/score/[projectId] — Trigger or retry AI scoring
// -----------------------------------------------------------------------
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) {
  try {
    const session = await auth()
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Forbidden', message: 'Admin only', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }

    // Rate limit: 10 requests per minute per authenticated user
    limiter.check(10, session.user.id)

    const { projectId } = await params

    // Verify project exists
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, scoreStatus: true },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Project not found.', code: 'NOT_FOUND' },
        { status: 404 },
      )
    }

    // Already running (a queue worker or an earlier click): a second run would
    // pay for the same model calls twice and race on the result.
    if (project.scoreStatus === 'PROCESSING') {
      return NextResponse.json(
        { error: 'Conflict', message: 'Scoring is already running for this project.', code: 'ALREADY_RUNNING' },
        { status: 409 },
      )
    }

    // Mark the run as started *before* responding. Scoring itself only begins
    // in `after()`, once this response is sent — and the client refreshes the
    // page the moment it gets the response. Without this write that refresh
    // still reads the old status, the processing banner never appears, and the
    // run stays invisible until a manual reload. `scoreStartedAt` lets the
    // queue's stale-claim sweep recover the row if this invocation dies.
    await db.project.update({
      where: { id: projectId },
      data: { scoreStatus: 'PROCESSING', scoreStartedAt: new Date(), scoreError: null },
    })

    // `after()` keeps the serverless invocation alive until scoring actually
    // finishes, instead of risking the runtime killing an un-awaited promise
    // the moment this response is sent.
    after(() =>
      ScorerService.triggerScoring(projectId).catch(async (error) => {
        // triggerScoring writes its own final status; this only covers a
        // failure before it got that far, which would otherwise leave the row
        // PROCESSING.
        console.error('[Score] Retry failed for project ' + projectId + ':', error)
        await db.project
          .update({
            where: { id: projectId },
            data: {
              scoreStatus: 'FAILED',
              scoreError: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
              scoreStartedAt: null,
            },
          })
          .catch((updateError) =>
            console.error('[Score] Could not record failure for ' + projectId + ':', updateError),
          )
      }),
    )

    return NextResponse.json({
      id: project.id,
      scoreStatus: 'PROCESSING',
      message: 'AI scoring triggered.',
    })
  } catch (error) {
    return handleApiError(error)
  }
}
