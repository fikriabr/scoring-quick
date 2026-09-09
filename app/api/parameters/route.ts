// app/api/parameters/route.ts
// API route handlers for listing and batch-saving parameters.
// Admin-only — guarded at both proxy and route handler level.
// Requirements: 2.1, 2.2, 2.3

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import {
  listParametersByCategory,
  saveParameterSet,
} from '@/lib/services/parameter.service'

// -----------------------------------------------------------------------
// GET /api/parameters?categoryId=xxx — List all parameters for a category
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

    const categoryId = request.nextUrl.searchParams.get('categoryId')
    if (!categoryId) {
      return NextResponse.json(
        {
          error: 'Validation Error',
          message: 'categoryId query parameter is required',
          code: 'VALIDATION_ERROR',
        },
        { status: 400 },
      )
    }

    const parameters = await listParametersByCategory(categoryId)
    return NextResponse.json(parameters)
  } catch (error) {
    return handleApiError(error)
  }
}

// -----------------------------------------------------------------------
// POST /api/parameters — Batch save parameters for a category
// Validates total weight = 100% via ParameterSetSchema before saving.
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
    const { categoryId, parameters } = body

    if (!categoryId) {
      return NextResponse.json(
        {
          error: 'Validation Error',
          message: 'categoryId is required in request body',
          code: 'VALIDATION_ERROR',
        },
        { status: 400 },
      )
    }

    // saveParameterSet validates via ParameterSetSchema (total weight = 100%)
    const created = await saveParameterSet(categoryId, parameters)
    return NextResponse.json(created, { status: 201 })
  } catch (error) {
    return handleApiError(error)
  }
}
