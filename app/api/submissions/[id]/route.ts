// app/api/submissions/[id]/route.ts
// API route handler for updating a submitted project's Source Code.
// Admin-only — guarded via session check.
// Requirements: 5.2, 5.3, 5.4

export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import { rateLimit } from '@/lib/rate-limit'
import { SourceCodeUpdateSchema } from '@/lib/validators/schemas'
import { ScorerService } from '@/lib/services/scorer.service'
import { db } from '@/lib/db'

// Rate limiter: 10 requests per 60 seconds per user
const limiter = rateLimit({ interval: 60_000, uniqueTokenPerInterval: 500 })

type RouteContext = { params: Promise<{ id: string }> }

// -----------------------------------------------------------------------
// PATCH /api/submissions/[id] — replace a project's Source Code
//
// Body: { sourceCode: string | null }
//
// The order of the steps below is the contract, not a style choice
// (Property 24): authorization, rate limit, project existence and body
// validation all happen before the first write, so a request that is rejected
// for any reason leaves both `sourceCode` and `scoreStatus` exactly as they
// were. Nothing here short-circuits into a partial update.
//
// Applies to both project types. Requirement 5.1 puts the editor on the detail
// page of every project; only the Capture Pipeline panel is PartyRock-specific
// (Requirement 5.5), and that lives in the UI, not here.
// -----------------------------------------------------------------------
export async function PATCH(
  request: NextRequest,
  context: RouteContext,
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

    const { id } = await context.params

    // Validate the project exists before touching the body — a 404 for an
    // unknown id is more useful than a validation error about a row that does
    // not exist.
    const project = await db.project.findUnique({
      where: { id },
      select: { id: true },
    })
    if (!project) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Project not found', code: 'NOT_FOUND' },
        { status: 404 },
      )
    }

    // Throws ZodError on an over-length or malformed payload, which
    // `handleApiError` turns into 400 VALIDATION_ERROR. Blank input is
    // normalised to `null` by the schema so `''` never reaches the column.
    const body = await request.json()
    const { sourceCode } = SourceCodeUpdateSchema.parse(body)

    // Single write: the new evidence and the fact that the existing AI score no
    // longer reflects it (Requirement 5.4) are one state change, so they are
    // persisted together rather than in two updates that could interleave.
    const updated = await db.project.update({
      where: { id },
      data: { sourceCode, scoreStatus: 'PENDING' },
      select: { id: true, sourceCode: true, scoreStatus: true },
    })

    // Fire-and-forget: re-scoring runs on the AI provider's clock, well past
    // any request timeout. The row already reads PENDING, so a caller who
    // never sees this promise settle still reads a truthful status.
    ScorerService.triggerScoring(id).catch(console.error)

    return NextResponse.json(updated)
  } catch (error) {
    return handleApiError(error)
  }
}
