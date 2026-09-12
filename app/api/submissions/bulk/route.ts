// app/api/submissions/bulk/route.ts
// API route handler for bulk CSV import of project submissions.
// Admin-only + rate limited.
// Requirements: 3.1, 3.4, 3.5, 8.2, 9.6

export const runtime = 'nodejs'

import { NextRequest, NextResponse, after } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import { rateLimit } from '@/lib/rate-limit'
import { bulkImportFromCsv } from '@/lib/services/submission.service'
import { CrawlerService } from '@/lib/services/crawler.service'

// Rate limiter: 10 requests per 60 seconds per user
const limiter = rateLimit({ interval: 60_000, uniqueTokenPerInterval: 500 })

// -----------------------------------------------------------------------
// POST /api/submissions/bulk — Bulk import via CSV file upload
// Expects multipart/form-data with:
//   - file: CSV file
//   - categoryId: target category ID
// -----------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const session = await auth()

    // Admin-only guard
    if (!session?.user?.id || session.user.role !== 'ADMIN') {
      if (!session?.user?.id) {
        return NextResponse.json(
          { error: 'Unauthorized', message: 'Authentication required.', code: 'UNAUTHORIZED' },
          { status: 401 },
        )
      }
      return NextResponse.json(
        { error: 'Forbidden', message: 'Admin access required.', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }

    // Rate limit: 10 requests per minute per authenticated user
    limiter.check(10, session.user.id)

    // Parse multipart form data
    const formData = await request.formData()
    const file = formData.get('file')
    const categoryId = formData.get('categoryId')

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: 'Validation Error', message: 'CSV file is required.', code: 'VALIDATION_ERROR' },
        { status: 400 },
      )
    }

    if (!categoryId || typeof categoryId !== 'string' || categoryId.trim() === '') {
      return NextResponse.json(
        { error: 'Validation Error', message: 'Category ID is required.', code: 'VALIDATION_ERROR' },
        { status: 400 },
      )
    }

    // Read CSV content from the uploaded file
    const csvText = await file.text()

    if (!csvText.trim()) {
      return NextResponse.json(
        { error: 'Validation Error', message: 'CSV file is empty.', code: 'VALIDATION_ERROR' },
        { status: 400 },
      )
    }

    // Import valid rows and collect errors
    const result = await bulkImportFromCsv(csvText, categoryId.trim())

    // Start the crawl pipeline for every row this import created.
    // `result.created` carries the ids the writes returned, so there is no
    // guessing involved: a query for "recent PENDING projects in this
    // category" would also match projects left PENDING by an earlier import
    // and crawl them a second time.
    if (result.created.length > 0) {
      // Scheduled via `after()`, but sequential inside it: a 200-row import
      // would otherwise open 200 outbound fetches at once, each holding a
      // 15-second timeout. Looping inside one `after()` callback keeps one
      // crawl in flight at a time without delaying the response below, and
      // without introducing a scheduler this codebase has no other use for.
      // The tradeoff is latency — the last project in a large import starts
      // late — which is acceptable for a background pipeline whose status
      // the admin polls anyway.
      //
      // `after()` (rather than a bare un-awaited call) matters here for the
      // same reason as every other trigger point: on a serverless runtime
      // (Vercel) the invocation can be frozen the moment this response is
      // sent, which would kill the loop after crawling only the first project
      // or two.
      after(async () => {
        for (const project of result.created) {
          try {
            await CrawlerService.triggerCrawl(project.id)
          } catch (error) {
            // One project failing must not stop the rest of the batch.
            console.error(error)
          }
        }
      })
    }

    return NextResponse.json(result, { status: 200 })
  } catch (error) {
    return handleApiError(error)
  }
}
