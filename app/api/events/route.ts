// app/api/events/route.ts
// API route handlers for listing and creating events.
// Admin-only — guarded at both proxy and route handler level.
// Requirements: 1.1, 1.2

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import { listEvents, createEvent } from '@/lib/services/event.service'

// -----------------------------------------------------------------------
// GET /api/events — List all events
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

    const events = await listEvents()
    return NextResponse.json(events)
  } catch (error) {
    return handleApiError(error)
  }
}

// -----------------------------------------------------------------------
// POST /api/events — Create a new event
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
    const event = await createEvent(body)
    return NextResponse.json(event, { status: 201 })
  } catch (error) {
    return handleApiError(error)
  }
}
