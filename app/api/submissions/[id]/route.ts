// app/api/submissions/[id]/route.ts
// API route handler for updating a submitted project's Source Code.
// Admin-only — guarded via session check.
// Requirements: 5.2, 5.3, 5.4

export const runtime = 'nodejs'

import { NextRequest, NextResponse, after } from 'next/server'
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
// GET /api/submissions/[id] — poll the crawl/score pipeline status
//
// Read-only, so it skips the rate limiter that guards the mutating PATCH
// below — the processing indicator on the detail page calls this every 10
// seconds while a project is still PENDING/PROCESSING, which a 10-req/min
// limiter would start rejecting on its own.
// -----------------------------------------------------------------------
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required.', code: 'UNAUTHORIZED' },
        { status: 401 },
      )
    }

    const { id } = await context.params

    const project = await db.project.findUnique({
      where: { id },
      select: {
        id: true,
        crawlStatus: true,
        crawlError: true,
        scoreStatus: true,
        finalScore: true,
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Project not found', code: 'NOT_FOUND' },
        { status: 404 },
      )
    }

    return NextResponse.json(project)
  } catch (error) {
    return handleApiError(error)
  }
}

// -----------------------------------------------------------------------
// DELETE /api/submissions/[id] — soft-delete a submission
//
// Sets `isActive = false` rather than removing the row: AIScore/JuryScore/
// AuditLog history stays intact for audit purposes, and the (categoryId,
// url) pair frees up so the same URL can be re-submitted. Listings (admin
// submissions, jury queue, leaderboards) filter on `isActive: true`, so a
// deleted submission simply stops appearing there; its detail page still
// resolves by id for an admin who has the direct link.
// -----------------------------------------------------------------------
export async function DELETE(request: NextRequest, context: RouteContext) {
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

    const project = await db.project.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    })
    if (!project) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Project not found', code: 'NOT_FOUND' },
        { status: 404 },
      )
    }

    // Already deleted — treat as a successful no-op rather than erroring, so
    // a retried request (double-click, slow network) doesn't surface a
    // spurious failure.
    if (!project.isActive) {
      return NextResponse.json({ id: project.id, isActive: false })
    }

    const updated = await db.project.update({
      where: { id },
      data: { isActive: false },
      select: { id: true, isActive: true },
    })

    return NextResponse.json(updated)
  } catch (error) {
    return handleApiError(error)
  }
}

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
// The editor is available on the detail page of every project.
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

    // Re-scoring runs on the AI provider's clock, well past any request
    // timeout, so it is scheduled rather than awaited. The row already reads
    // PENDING, so a caller who never sees this promise settle still reads a
    // truthful status. Scheduled via `after()` so the serverless invocation
    // stays alive long enough for scoring to actually finish.
    after(() => ScorerService.triggerScoring(id).catch(console.error))

    return NextResponse.json(updated)
  } catch (error) {
    return handleApiError(error)
  }
}
