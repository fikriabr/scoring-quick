// app/api/events/[id]/route.ts
// API route handlers for single event operations (get, update, delete).
// Admin-only — guarded at both proxy and route handler level.
// Requirements: 1.1, 1.2, 1.4

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import {
  getEventById,
  updateEvent,
  deleteEvent,
} from '@/lib/services/event.service'

type RouteContext = { params: Promise<{ id: string }> }

// -----------------------------------------------------------------------
// GET /api/events/[id] — Get a single event by ID
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
    const event = await getEventById(id)

    if (!event) {
      return NextResponse.json(
        { error: 'Not Found', message: 'Event not found', code: 'NOT_FOUND' },
        { status: 404 },
      )
    }

    return NextResponse.json(event)
  } catch (error) {
    return handleApiError(error)
  }
}

// -----------------------------------------------------------------------
// PUT /api/events/[id] — Update an event
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
    const event = await updateEvent(id, body)
    return NextResponse.json(event)
  } catch (error) {
    return handleApiError(error)
  }
}

// -----------------------------------------------------------------------
// DELETE /api/events/[id] — Delete an event
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
    await deleteEvent(id)
    return new NextResponse(null, { status: 204 })
  } catch (error) {
    return handleApiError(error)
  }
}
