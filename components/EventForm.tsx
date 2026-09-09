// components/EventForm.tsx
// Client component for creating and editing events.
// Performs client-side validation via EventSchema before calling server actions.
// Requirements: 1.2, 1.4

'use client'

import { useState, useTransition } from 'react'
import { EventSchema } from '@/lib/validators/schemas'
import { createEventAction, updateEventAction } from '@/actions/event.actions'
import { useRouter } from 'next/navigation'

interface EventFormProps {
  mode: 'create' | 'edit'
  event?: {
    id: string
    name: string
    description?: string | null
    startDate?: string | Date | null
    endDate?: string | Date | null
  }
}

export default function EventForm({ mode, event }: EventFormProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [errors, setErrors] = useState<Record<string, string[]>>({})
  const [globalError, setGlobalError] = useState<string | null>(null)

  function formatDateForInput(value: string | Date | null | undefined): string {
    if (!value) return ''
    const date = value instanceof Date ? value : new Date(value)
    return isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
  }

  async function handleSubmit(formData: FormData) {
    setErrors({})
    setGlobalError(null)

    // Client-side validation
    const rawInput = {
      name: formData.get('name') as string,
      description: (formData.get('description') as string) || null,
      startDate: (formData.get('startDate') as string) || null,
      endDate: (formData.get('endDate') as string) || null,
    }

    const result = EventSchema.safeParse(rawInput)
    if (!result.success) {
      const fieldErrors: Record<string, string[]> = {}
      for (const issue of result.error.issues) {
        const path = issue.path.join('.')
        if (!fieldErrors[path]) fieldErrors[path] = []
        fieldErrors[path].push(issue.message)
      }
      setErrors(fieldErrors)
      return
    }

    // Call server action
    startTransition(async () => {
      const actionResult =
        mode === 'create'
          ? await createEventAction(formData)
          : await updateEventAction(event!.id, formData)

      if (actionResult.success) {
        // After an edit, return to the event detail page the user came from;
        // after a create, go back to the events list.
        router.push(
          mode === 'edit' ? `/admin/events/${event!.id}` : '/admin/events',
        )
      } else {
        if (actionResult.fieldErrors) {
          setErrors(actionResult.fieldErrors)
        }
        if (actionResult.error) {
          setGlobalError(actionResult.error)
        }
      }
    })
  }

  return (
    <form action={handleSubmit} className="space-y-4 max-w-lg">
      {globalError && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded text-sm">
          {globalError}
        </div>
      )}

      {/* Name field */}
      <div>
        <label
          htmlFor="name"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Event Name <span className="text-red-500">*</span>
        </label>
        <input
          id="name"
          name="name"
          type="text"
          defaultValue={event?.name ?? ''}
          maxLength={255}
          required
          className={`w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            errors.name ? 'border-red-500' : 'border-gray-300'
          }`}
        />
        {errors.name && (
          <p className="mt-1 text-sm text-red-600">{errors.name[0]}</p>
        )}
      </div>

      {/* Description field */}
      <div>
        <label
          htmlFor="description"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Description
        </label>
        <textarea
          id="description"
          name="description"
          defaultValue={event?.description ?? ''}
          maxLength={1000}
          rows={3}
          className={`w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            errors.description ? 'border-red-500' : 'border-gray-300'
          }`}
        />
        {errors.description && (
          <p className="mt-1 text-sm text-red-600">{errors.description[0]}</p>
        )}
      </div>

      {/* Start Date field */}
      <div>
        <label
          htmlFor="startDate"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Start Date
        </label>
        <input
          id="startDate"
          name="startDate"
          type="date"
          defaultValue={formatDateForInput(event?.startDate)}
          className={`w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            errors.startDate ? 'border-red-500' : 'border-gray-300'
          }`}
        />
        {errors.startDate && (
          <p className="mt-1 text-sm text-red-600">{errors.startDate[0]}</p>
        )}
      </div>

      {/* End Date field */}
      <div>
        <label
          htmlFor="endDate"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          End Date
        </label>
        <input
          id="endDate"
          name="endDate"
          type="date"
          defaultValue={formatDateForInput(event?.endDate)}
          className={`w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            errors.endDate ? 'border-red-500' : 'border-gray-300'
          }`}
        />
        {errors.endDate && (
          <p className="mt-1 text-sm text-red-600">{errors.endDate[0]}</p>
        )}
      </div>

      {/* Submit button */}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPending
            ? 'Saving...'
            : mode === 'create'
              ? 'Create Event'
              : 'Update Event'}
        </button>
        <button
          type="button"
          onClick={() => router.back()}
          className="px-4 py-2 border border-gray-300 text-gray-700 rounded hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
