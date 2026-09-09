// app/api/categories/[id]/publish/route.ts
// API route handler for publishing a category (generates public leaderboard token).
// Admin-only.
// Requirements: 8.5

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import { publishCategory } from '@/lib/services/category.service'

type RouteContext = { params: Promise<{ id: string }> }

// -----------------------------------------------------------------------
// POST /api/categories/[id]/publish — Publish a category
// Sets isPublished = true and generates a UUID v4 publicToken.
// -----------------------------------------------------------------------
export async function POST(
  _request: NextRequest,
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

    const { id } = await context.params
    const category = await publishCategory(id)
    return NextResponse.json(category)
  } catch (error) {
    return handleApiError(error)
  }
}
