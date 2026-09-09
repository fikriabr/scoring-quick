// app/api/categories/[id]/route.ts
// API route handlers for single category operations (get, update, delete).
// Admin-only — guarded at both proxy and route handler level.
// Requirements: 1.3, 1.4, 1.5

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import {
  getCategoryById,
  updateCategory,
  deleteCategory,
  DuplicateCategoryError,
} from '@/lib/services/category.service'

type RouteContext = { params: Promise<{ id: string }> }

// -----------------------------------------------------------------------
// GET /api/categories/[id] — Get a single category by ID
// -----------------------------------------------------------------------
export async function GET(
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
    const category = await getCategoryById(id)

    if (!category) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Category not found', code: 'NOT_FOUND' },
        { status: 404 },
      )
    }

    return NextResponse.json(category)
  } catch (error) {
    return handleApiError(error)
  }
}

// -----------------------------------------------------------------------
// PUT /api/categories/[id] — Update a category
// -----------------------------------------------------------------------
export async function PUT(
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

    const { id } = await context.params
    const body = await request.json()
    const category = await updateCategory(id, body)
    return NextResponse.json(category)
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

// -----------------------------------------------------------------------
// DELETE /api/categories/[id] — Delete a category
// Returns 409 if category has associated projects.
// -----------------------------------------------------------------------
export async function DELETE(
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
    await deleteCategory(id)
    return new NextResponse(null, { status: 204 })
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as Error & { code: string }).code === 'CATEGORY_HAS_PROJECTS'
    ) {
      return NextResponse.json(
        {
          error: 'Conflict',
          message: error.message,
          code: 'CATEGORY_HAS_PROJECTS',
        },
        { status: 409 },
      )
    }
    return handleApiError(error)
  }
}
