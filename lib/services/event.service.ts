// lib/services/event.service.ts
// CRUD operations for competition events.
// All inputs are validated via EventSchema before any DB call.
// Requirements: 1.1, 1.2, 1.4

import { db } from '@/lib/db'
import { EventSchema, type EventInput } from '@/lib/validators/schemas'

/**
 * Coerce a Date | null | undefined value from EventSchema
 * into a Date | null | undefined that Prisma's DateTime? field accepts.
 * (EventSchema's date fields are already normalised to Date | null,
 * so this is now effectively a passthrough kept for API stability.)
 */
function toDate(
  value: Date | null | undefined,
): Date | null | undefined {
  return value
}

// -----------------------------------------------------------------------
// createEvent
// Creates a new event after validating the input against EventSchema.
// Requirements: 1.2
// -----------------------------------------------------------------------
export async function createEvent(input: EventInput) {
  const data = EventSchema.parse(input)
  return db.event.create({
    data: {
      name: data.name,
      description: data.description ?? null,
      startDate: toDate(data.startDate),
      endDate: toDate(data.endDate),
    },
  })
}

// -----------------------------------------------------------------------
// updateEvent
// Updates an existing event by ID after validating partial input.
// Requirements: 1.4
// -----------------------------------------------------------------------
export async function updateEvent(id: string, input: Partial<EventInput>) {
  const data = EventSchema.partial().parse(input)
  return db.event.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description ?? null }),
      ...('startDate' in data && { startDate: toDate(data.startDate) }),
      ...('endDate' in data && { endDate: toDate(data.endDate) }),
    },
  })
}

// -----------------------------------------------------------------------
// deleteEvent
// Deletes an event by ID.
// Requirements: 1.4
// -----------------------------------------------------------------------
export async function deleteEvent(id: string) {
  return db.event.delete({ where: { id } })
}

// -----------------------------------------------------------------------
// listEvents
// Returns all events ordered by creation date descending.
// Requirements: 1.1
// -----------------------------------------------------------------------
export async function listEvents() {
  return db.event.findMany({ orderBy: { createdAt: 'desc' } })
}

// -----------------------------------------------------------------------
// getEventById
// Returns a single event by ID, including its categories.
// Returns null if not found.
// Requirements: 1.1, 1.2
// -----------------------------------------------------------------------
export async function getEventById(id: string) {
  return db.event.findUnique({
    where: { id },
    include: { categories: true },
  })
}
