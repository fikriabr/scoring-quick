// app/api/parameters/[id]/route.ts
// API route handlers for single parameter operations (update, delete).
// Admin-only — guarded at both proxy and route handler level.
// Requirements: 2.5, 2.6

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import {
  updateParameter,
  deleteParameter,
} from '@/lib/services/parameter.service'

type RouteContext = { params: Promise<{ id: string }> }

// -----------------------------------------------------------------------
// PUT /api/parameters/[id] — Update a parameter
// Returns { parameter, hasExistingScores } with warning header if scores exist.
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
    const result = await updateParameter(id, body)

    const response = NextResponse.json(result)

    // Add warning header if existing scores are affected by this change
    if (result.hasExistingScores) {
      response.headers.set(
        'X-Warning',
        'This parameter has existing AI or jury scores that may be affected by this change.',
      )
    }

    return response
  } catch (error) {
    return handleApiError(error)
  }
}

// -----------------------------------------------------------------------
// DELETE /api/parameters/[id] — Delete a parameter
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
    await deleteParameter(id)
    return new NextResponse(null, { status: 204 })
  } catch (error) {
    return handleApiError(error)
  }
}
