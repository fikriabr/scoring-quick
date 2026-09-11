// app/api/score/[projectId]/route.ts
// API route handler for triggering AI scoring on a project.
// Admin-only — guarded at both proxy and route handler level.
// Requirements: 5.1, 5.8, 9.6

export const runtime = 'nodejs'

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

    // Trigger AI scoring asynchronously without blocking the response.
    // `after()` keeps the serverless invocation alive until scoring actually
    // finishes, instead of risking the runtime killing an un-awaited promise
    // the moment this response is sent.
    after(() => ScorerService.triggerScoring(projectId).catch(console.error))

    // Return the project with current scoreStatus
    return NextResponse.json({
      id: project.id,
      scoreStatus: project.scoreStatus,
      message: 'AI scoring triggered.',
    })
  } catch (error) {
    return handleApiError(error)
  }
}
