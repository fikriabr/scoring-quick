// app/api/sync/submissions/route.ts
// Imports selected rows of the external submissions database as projects.
// Admin-only + rate limited. The listing itself is read server-side by the
// /admin/sync page; this route only performs the sync.

export const runtime = 'nodejs'
// One insert per selected row plus a read of the source database; a full
// batch of MAX_SYNC_BATCH rows stays well inside this.
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import { rateLimit } from '@/lib/rate-limit'
import { SourceDbNotConfiguredError, SourceDbQueryError } from '@/lib/source-db'
import { syncSourceSubmissions } from '@/lib/services/source-sync.service'

// Rate limiter: 10 requests per 60 seconds per user
const limiter = rateLimit({ interval: 60_000, uniqueTokenPerInterval: 500 })

// -----------------------------------------------------------------------
// POST /api/sync/submissions
// Body: { items: [{ sourceId: number, categoryId: string }, ...] }
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
    if (session.user.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Forbidden', message: 'Admin access required.', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }

    // Rate limit: 10 requests per minute per authenticated user
    limiter.check(10, session.user.id)

    const body = await request.json().catch(() => null)
    const result = await syncSourceSubmissions(body)

    // Synced projects wait in the scoring queue (scoreStatus PENDING), like a
    // CSV import: "Process Queue" on the submissions page or
    // `npm run score:queue` scores them.
    return NextResponse.json({ ...result, queued: result.created.length })
  } catch (error) {
    if (error instanceof SourceDbNotConfiguredError) {
      return NextResponse.json(
        { error: 'Service Unavailable', message: error.message, code: error.code },
        { status: error.status },
      )
    }
    if (error instanceof SourceDbQueryError) {
      console.error('[Sync]', error)
      return NextResponse.json(
        { error: 'Bad Gateway', message: error.message, code: error.code },
        { status: error.status },
      )
    }
    return handleApiError(error)
  }
}
