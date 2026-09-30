// app/api/crawl/[projectId]/route.ts
// API route handler for triggering or re-triggering a crawl on a project.
// Admin-only — guarded via session check.
// Requirements: 4.1, 4.4, 4.6, 9.6

export const runtime = 'nodejs'
// The `after()` callback runs the crawl and the AI scoring that follows it;
// scoring alone can outlive the default function timeout. 300s is the ceiling
// every Vercel plan allows.
export const maxDuration = 300

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

    // A project submitted with Source Code only has no URL to crawl. The
    // "Retry Crawl" button is disabled client-side for this case; this is the
    // server-side backstop for a direct API call.
    if (!project.url || project.url.trim().length === 0) {
      return NextResponse.json(
        {
          error: 'Bad Request',
          message: 'This project has no URL to crawl — it was submitted with Source Code only.',
          code: 'NO_URL',
        },
        { status: 400 },
      )
    }

    if (project.crawlStatus === 'PROCESSING') {
      return NextResponse.json(
        { error: 'Conflict', message: 'A crawl is already running for this project.', code: 'ALREADY_RUNNING' },
        { status: 409 },
      )
    }

    // Mark the crawl as started *before* responding, for the same reason as
    // the score route: the crawl only begins in `after()`, and the client's
    // refresh right after this response would otherwise still read the old
    // status and never show the processing banner. A retrigger also re-scores,
    // so its score is marked PENDING here too.
    await db.project.update({
      where: { id: projectId },
      data: {
        crawlStatus: 'PROCESSING',
        crawlError: null,
        ...(action === 'retrigger' ? { scoreStatus: 'PENDING' as const } : {}),
      },
    })

    // Covers a failure before the pipeline writes its own status (e.g. the
    // metadata delete in a retrigger), which would otherwise leave the row
    // PROCESSING.
    const recordFailure = async (error: unknown) => {
      console.error('[Crawl] Retry failed for project ' + projectId + ':', error)
      await db.project
        .update({
          where: { id: projectId },
          data: {
            crawlStatus: 'FAILED',
            crawlError: error instanceof Error ? error.message : String(error),
          },
        })
        .catch((updateError) =>
          console.error('[Crawl] Could not record failure for ' + projectId + ':', updateError),
        )
    }

    // Trigger the crawl asynchronously without blocking the response.
    // Scheduled via `after()` so the serverless invocation stays alive until
    // the crawl (and the scoring it chains into) actually finishes — a bare
    // un-awaited promise can be killed by the runtime as soon as this response
    // is sent.
    if (action === 'retrigger') {
      after(() => CrawlerService.retriggerCrawl(projectId).catch(recordFailure))
    } else {
      after(() => CrawlerService.triggerCrawl(projectId).catch(recordFailure))
    }

    // Return the current project status (already PROCESSING, written above)
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
