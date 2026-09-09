// app/api/public/leaderboard/[token]/route.ts
// Public API route handler for fetching a published leaderboard by token.
// NO authentication required — this is a public endpoint.
// Requirements: 8.5

import { NextRequest, NextResponse } from 'next/server'
import { handleApiError } from '@/lib/api-error'
import { getPublicLeaderboard } from '@/lib/services/leaderboard.service'

// -----------------------------------------------------------------------
// GET /api/public/leaderboard/[token] — Fetch public leaderboard
// -----------------------------------------------------------------------
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params

    const leaderboard = await getPublicLeaderboard(token)

    if (leaderboard === null) {
      return NextResponse.json(
        {
          error: 'Not Found',
          message: 'Leaderboard not found or not published',
          code: 'NOT_FOUND',
        },
        { status: 404 },
      )
    }

    return NextResponse.json(leaderboard)
  } catch (error) {
    return handleApiError(error)
  }
}
