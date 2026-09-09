// app/api/leaderboard/[categoryId]/route.ts
// API route handler for fetching the leaderboard of a specific category.
// Admin-only — guarded at both proxy and route handler level.
// Requirements: 8.1, 8.2

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import { getLeaderboard } from '@/lib/services/leaderboard.service'

// -----------------------------------------------------------------------
// GET /api/leaderboard/[categoryId] — Fetch leaderboard for a category
// -----------------------------------------------------------------------
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ categoryId: string }> },
) {
  try {
    const session = await auth()
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Forbidden', message: 'Admin only', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }

    const { categoryId } = await params
    const leaderboard = await getLeaderboard(categoryId)
    return NextResponse.json(leaderboard)
  } catch (error) {
    return handleApiError(error)
  }
}
