// app/api/users/[id]/route.ts
// API route handlers for single user operations (update, delete).
// Admin-only — guarded at both proxy and route handler level.
// Requirements: 7.5

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import { db } from '@/lib/db'

type RouteContext = { params: Promise<{ id: string }> }

// -----------------------------------------------------------------------
// Validation schema for updating a user
// -----------------------------------------------------------------------

const UpdateUserSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255).optional(),
  email: z.string().email('Invalid email format').optional(),
  role: z.enum(['ADMIN', 'JURY']).optional(),
})

// -----------------------------------------------------------------------
// PUT /api/users/[id] — Update a user
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
    const data = UpdateUserSchema.parse(body)

    // Check user exists
    const existing = await db.user.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json(
        { error: 'Not Found', message: 'User not found', code: 'NOT_FOUND' },
        { status: 404 },
      )
    }

    const user = await db.user.update({
      where: { id },
      data,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json(user)
  } catch (error) {
    return handleApiError(error)
  }
}

// -----------------------------------------------------------------------
// DELETE /api/users/[id] — Delete a user
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

    // Check user exists
    const existing = await db.user.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json(
        { error: 'Not Found', message: 'User not found', code: 'NOT_FOUND' },
        { status: 404 },
      )
    }

    await db.user.delete({ where: { id } })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    return handleApiError(error)
  }
}
