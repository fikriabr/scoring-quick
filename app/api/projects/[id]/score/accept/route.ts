// app/api/projects/[id]/score/accept/route.ts
// API route handler for accepting an AI score as the jury score.
// Authenticated users (jury or admin) — calls acceptAiScore from JuryService.
// Requirements: 6.5, 6.6, 6.7

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import {
  acceptAiScore,
  JuryAccessError,
  ScoreValidationError,
} from '@/lib/services/jury.service'

type RouteContext = { params: Promise<{ id: string }> }

// -----------------------------------------------------------------------
// POST /api/projects/[id]/score/accept — Accept AI score as jury score
// Body: { parameterId: string }
// -----------------------------------------------------------------------
export async function POST(
  request: NextRequest,
  context: RouteContext,
) {
  try {
    const session = await auth()
    if (!session) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required', code: 'UNAUTHORIZED' },
        { status: 401 },
      )
    }

    const { id: projectId } = await context.params
    const body = await request.json()

    await acceptAiScore(
      projectId,
      body.parameterId,
      session.user.id,
    )

    return NextResponse.json({ success: true }, { status: 200 })
  } catch (error) {
    if (error instanceof JuryAccessError) {
      return NextResponse.json(
        { error: 'Forbidden', message: error.message, code: 'FORBIDDEN' },
        { status: 403 },
      )
    }
    if (error instanceof ScoreValidationError) {
      return NextResponse.json(
        { error: 'Validation Error', message: error.message, code: 'VALIDATION_ERROR' },
        { status: 400 },
      )
    }
    return handleApiError(error)
  }
}
