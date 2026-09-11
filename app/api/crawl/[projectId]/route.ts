// app/api/crawl/[projectId]/route.ts
// API route handler for triggering or re-triggering a crawl on a project.
// Admin-only — guarded via session check.
// Requirements: 4.1, 4.4, 4.6, 9.6

export const runtime = 'nodejs'

import { NextRequest, NextResponse, after } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import { rateLimit } from '@/lib/rate-limit'
import { CrawlerService } from '@/lib/services/crawler.service'
import { db } from '@/lib/db'

// Rate limiter: 10 requests per 60 seconds per user
const limiter = rateLimit({ interval: 60_000, uniqueTokenPerInterval: 500 })

type RouteContext = { params: Promise<{ projectId: string }> }

// -----------------------------------------------------------------------
// POST /api/crawl/[projectId]?action=trigger|retrigger
// -----------------------------------------------------------------------
export async function POST(
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

    const { projectId } = await context.params
    const action = request.nextUrl.searchParams.get('action') ?? 'trigger'

    // Validate the project exists
    const project = await db.project.findUnique({ where: { id: projectId } })
    if (!project) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Project not found', code: 'NOT_FOUND' },
        { status: 404 },
      )
    }

    // Trigger the crawl asynchronously without blocking the response.
    // Scheduled via `after()` so the serverless invocation stays alive until
    // the crawl (and the scoring it chains into) actually finishes — a bare
    // un-awaited promise can be killed by the runtime as soon as this response
    // is sent.
    if (action === 'retrigger') {
      after(() => CrawlerService.retriggerCrawl(projectId).catch(console.error))
    } else {
      after(() => CrawlerService.triggerCrawl(projectId).catch(console.error))
    }

    // Return the current project status (will transition to PROCESSING shortly)
    const updatedProject = await db.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        url: true,
        participantName: true,
        crawlStatus: true,
        crawlError: true,
        scoreStatus: true,
      },
    })

    return NextResponse.json(updatedProject)
  } catch (error) {
    return handleApiError(error)
  }
}
