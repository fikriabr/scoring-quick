// actions/event.actions.ts
// Server Actions for event CRUD operations.
// Called from client-side form components (EventForm).
// Requirements: 1.2, 1.4

'use server'

import { revalidatePath } from 'next/cache'
import { auth } from '@/lib/auth/config'
import { createEvent, updateEvent, deleteEvent } from '@/lib/services/event.service'
import { EventSchema } from '@/lib/validators/schemas'
import { ZodError } from 'zod'

export type ActionResult = {
  success: boolean
  error?: string
  fieldErrors?: Record<string, string[]>
}

// -----------------------------------------------------------------------
// createEventAction
// Validates input via EventSchema and calls createEvent service.
// Requirements: 1.2
// -----------------------------------------------------------------------
export async function createEventAction(formData: FormData): Promise<ActionResult> {
  const session = await auth()
  if (!session || session.user.role !== 'ADMIN') {
    return { success: false, error: 'Forbidden: Admin access required.' }
  }

  const rawInput = {
    name: formData.get('name') as string,
    description: (formData.get('description') as string) || null,
    startDate: (formData.get('startDate') as string) || null,
    endDate: (formData.get('endDate') as string) || null,
  }

  try {
    EventSchema.parse(rawInput)
    await createEvent(rawInput)
    revalidatePath('/admin/events')
    return { success: true }
  } catch (err) {
    if (err instanceof ZodError) {
      const fieldErrors: Record<string, string[]> = {}
      for (const issue of err.issues) {
        const path = issue.path.join('.')
        if (!fieldErrors[path]) fieldErrors[path] = []
        fieldErrors[path].push(issue.message)
      }
      return { success: false, error: 'Validation failed.', fieldErrors }
    }
    return { success: false, error: 'An unexpected error occurred.' }
  }
}

// -----------------------------------------------------------------------
// updateEventAction
// Validates partial input via EventSchema and calls updateEvent service.
// Requirements: 1.4
// -----------------------------------------------------------------------
export async function updateEventAction(id: string, formData: FormData): Promise<ActionResult> {
  const session = await auth()
  if (!session || session.user.role !== 'ADMIN') {
    return { success: false, error: 'Forbidden: Admin access required.' }
  }

  const rawInput = {
    name: formData.get('name') as string,
    description: (formData.get('description') as string) || null,
    startDate: (formData.get('startDate') as string) || null,
    endDate: (formData.get('endDate') as string) || null,
  }

  try {
    EventSchema.parse(rawInput)
    await updateEvent(id, rawInput)
    revalidatePath('/admin/events')
    revalidatePath(`/admin/events/${id}`)
    return { success: true }
  } catch (err) {
    if (err instanceof ZodError) {
      const fieldErrors: Record<string, string[]> = {}
      for (const issue of err.issues) {
        const path = issue.path.join('.')
        if (!fieldErrors[path]) fieldErrors[path] = []
        fieldErrors[path].push(issue.message)
      }
      return { success: false, error: 'Validation failed.', fieldErrors }
    }
    return { success: false, error: 'An unexpected error occurred.' }
  }
}

// -----------------------------------------------------------------------
// deleteEventAction
// Deletes an event by ID and revalidates the events list.
// Requirements: 1.4
// -----------------------------------------------------------------------
export async function deleteEventAction(id: string): Promise<ActionResult> {
  const session = await auth()
  if (!session || session.user.role !== 'ADMIN') {
    return { success: false, error: 'Forbidden: Admin access required.' }
  }

  try {
    await deleteEvent(id)
    revalidatePath('/admin/events')
    return { success: true }
  } catch {
    return { success: false, error: 'Failed to delete event.' }
  }
}
