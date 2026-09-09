// app/api/users/route.ts
// API route handlers for listing and creating users.
// Admin-only — guarded at both proxy and route handler level.
// Requirements: 7.5

import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import { db } from '@/lib/db'

// -----------------------------------------------------------------------
// Validation schema for creating a jury user
// -----------------------------------------------------------------------

const CreateUserSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.enum(['ADMIN', 'JURY']).default('JURY'),
})

// -----------------------------------------------------------------------
// GET /api/users — List all users (Admin-only)
// -----------------------------------------------------------------------
export async function GET() {
  try {
    const session = await auth()
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Forbidden', message: 'Admin only', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }

    const users = await db.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json(users)
  } catch (error) {
    return handleApiError(error)
  }
}

// -----------------------------------------------------------------------
// POST /api/users — Create a new user (Admin-only)
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
    const data = CreateUserSchema.parse(body)

    // Hash password before storing
    const passwordHash = await bcrypt.hash(data.password, 10)

    const user = await db.user.create({
      data: {
        name: data.name,
        email: data.email,
        passwordHash,
        role: data.role,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    return NextResponse.json(user, { status: 201 })
  } catch (error) {
    return handleApiError(error)
  }
}
