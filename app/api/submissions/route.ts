// app/api/submissions/route.ts
// API route handler for creating a single project submission.
// Requirements: 3.1, 3.2, 3.3, 9.6

export const runtime = 'nodejs'

import { NextRequest, NextResponse, after } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import { rateLimit } from '@/lib/rate-limit'
import { submitProject, DuplicateUrlError } from '@/lib/services/submission.service'
import { CrawlerService } from '@/lib/services/crawler.service'

// Rate limiter: 10 requests per 60 seconds per user
const limiter = rateLimit({ interval: 60_000, uniqueTokenPerInterval: 500 })

// -----------------------------------------------------------------------
// POST /api/submissions — Submit a single project
// -----------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required.', code: 'UNAUTHORIZED' },
        { status: 401 },
      )
    }

    // Rate limit: 10 requests per minute per authenticated user
    limiter.check(10, session.user.id)

    const body = await request.json()
    const project = await submitProject(body)

    // Kick off the asynchronous pipeline without blocking the response. The
    // project is created with crawlStatus/scoreStatus = PENDING, so a caller
    // who never sees this promise settle still reads a truthful status.
    //
    // Scheduled via `after()` rather than a bare fire-and-forget: on a
    // serverless runtime (Vercel) the function can be frozen or torn down the
    // moment the response is sent, which kills an un-awaited promise before
    // the crawl (and the scoring it triggers) ever finishes. `after()` keeps
    // the invocation alive until the callback settles, so the pipeline
    // reliably runs to completion instead of silently never starting.
    //
    // The live URL is the primary evidence: the crawl stores `rawHtml`,
    // derives `structure`, and only then calls triggerScoring itself. It also
    // handles the failed-fetch case, scoring from a pasted `sourceCode` when
    // one exists. Submitting with `sourceCode` already filled in does not skip
    // the crawl — `rawHtml` and `structure` are still worth collecting, and
    // triggerCrawl never overwrites a pasted value.
    after(() => CrawlerService.triggerCrawl(project.id).catch(console.error))

    return NextResponse.json(project, { status: 201 })
  } catch (error) {
    // Handle duplicate URL errors with a 409 Conflict response
    if (error instanceof DuplicateUrlError) {
      return NextResponse.json(
        { error: 'Conflict', message: error.message, code: 'DUPLICATE_URL' },
        { status: 409 },
      )
    }

    return handleApiError(error)
  }
}
