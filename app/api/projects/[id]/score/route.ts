// app/api/projects/[id]/score/route.ts
// API route handler for submitting a jury score on a project parameter.
// Authenticated users (jury or admin) — calls submitJuryScore from JuryService.
// Requirements: 6.1, 6.2, 6.3, 6.4, 6.6, 6.7

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import {
  submitJuryScore,
  JuryAccessError,
  ScoreValidationError,
} from '@/lib/services/jury.service'

type RouteContext = { params: Promise<{ id: string }> }

/** The range check needs the parameter, so it happens in the service. */
const JuryScoreBodySchema = z.object({
  parameterId: z.string().min(1, 'Parameter ID is required'),
  score: z.number().finite('Score must be a finite number'),
  comment: z.string().max(2000, 'Comment must not exceed 2000 characters').nullish(),
})

// -----------------------------------------------------------------------
// POST /api/projects/[id]/score — Submit jury score for a parameter
// Body: { parameterId: string, score: number, comment?: string | null }
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
    const body = JuryScoreBodySchema.parse(await request.json().catch(() => null))

    await submitJuryScore(
      projectId,
      body.parameterId,
      session.user.id,
      body.score,
      body.comment ?? null,
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
