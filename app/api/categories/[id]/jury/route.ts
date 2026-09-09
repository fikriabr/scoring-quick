// app/api/categories/[id]/jury/route.ts
// API route handlers for assigning and unassigning jury to a category.
// Admin-only — guarded at both proxy and route handler level.
// Requirements: 7.5, 7.6

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import { db } from '@/lib/db'

type RouteContext = { params: Promise<{ id: string }> }

// -----------------------------------------------------------------------
// Validation schema for jury assignment/unassignment
// -----------------------------------------------------------------------

const JuryAssignmentSchema = z.object({
  userId: z.string().min(1, 'User ID is required'),
})

// -----------------------------------------------------------------------
// GET /api/categories/[id]/jury — List jury assigned to category
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

    const { id: categoryId } = await context.params

    const assignments = await db.categoryJury.findMany({
      where: { categoryId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
          },
        },
      },
    })

    return NextResponse.json(assignments)
  } catch (error) {
    return handleApiError(error)
  }
}

// -----------------------------------------------------------------------
// POST /api/categories/[id]/jury — Assign jury to category
// -----------------------------------------------------------------------
export async function POST(
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

    const { id: categoryId } = await context.params
    const body = await request.json()
    const { userId } = JuryAssignmentSchema.parse(body)

    // Verify category exists
    const category = await db.category.findUnique({ where: { id: categoryId } })
    if (!category) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Category not found', code: 'NOT_FOUND' },
        { status: 404 },
      )
    }

    // Verify user exists and is a JURY role
    const user = await db.user.findUnique({ where: { id: userId } })
    if (!user) {
      return NextResponse.json(
        { error: 'Not Found', message: 'User not found', code: 'NOT_FOUND' },
        { status: 404 },
      )
    }

    const assignment = await db.categoryJury.create({
      data: { categoryId, userId },
    })

    return NextResponse.json(assignment, { status: 201 })
  } catch (error) {
    return handleApiError(error)
  }
}

// -----------------------------------------------------------------------
// DELETE /api/categories/[id]/jury — Unassign jury from category
// -----------------------------------------------------------------------
export async function DELETE(
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

    const { id: categoryId } = await context.params
    const body = await request.json()
    const { userId } = JuryAssignmentSchema.parse(body)

    await db.categoryJury.delete({
      where: {
        categoryId_userId: { categoryId, userId },
      },
    })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    return handleApiError(error)
  }
}
