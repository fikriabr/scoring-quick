// app/api/categories/route.ts
// API route handlers for listing and creating categories.
// Admin-only — guarded at both proxy and route handler level.
// Requirements: 1.3, 1.4

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import {
  listCategoriesByEvent,
  createCategory,
  DuplicateCategoryError,
} from '@/lib/services/category.service'

// -----------------------------------------------------------------------
// GET /api/categories?eventId=xxx — List all categories for an event
// -----------------------------------------------------------------------
export async function GET(request: NextRequest) {
  try {
    const session = await auth()
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Forbidden', message: 'Admin only', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }

    const { searchParams } = new URL(request.url)
    const eventId = searchParams.get('eventId')

    if (!eventId) {
      return NextResponse.json(
        {
          error: 'Validation Error',
          message: 'eventId query parameter is required',
          code: 'VALIDATION_ERROR',
        },
        { status: 400 },
      )
    }

    const categories = await listCategoriesByEvent(eventId)
    return NextResponse.json(categories)
  } catch (error) {
    return handleApiError(error)
  }
}

// -----------------------------------------------------------------------
// POST /api/categories — Create a new category
// -----------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const session = await auth()
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Forbidden', message: 'Admin only', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const category = await createCategory(body)
    return NextResponse.json(category, { status: 201 })
  } catch (error) {
    if (error instanceof DuplicateCategoryError) {
      return NextResponse.json(
        {
          error: 'Conflict',
          message: error.message,
          code: 'DUPLICATE_CATEGORY',
        },
        { status: 409 },
      )
    }
    return handleApiError(error)
  }
}
