// app/(dashboard)/admin/events/[id]/edit/page.tsx
// RSC page for editing an existing event.
// Requirements: 1.4

import { getEventById } from '@/lib/services/event.service'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import EventForm from '@/components/EventForm'

interface Props {
  params: Promise<{ id: string }>
}

export default async function EditEventPage({ params }: Props) {
  const { id } = await params
  const event = await getEventById(id)

  if (!event) {
    notFound()
  }

  return (
    <div>
      <Link
        href={`/admin/events/${id}`}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 transition-colors hover:text-blue-600"
      >
        <span>←</span> Back to Event
      </Link>
      <h1 className="mt-4 text-2xl font-bold text-gray-900">Edit Event</h1>
      <p className="text-sm text-gray-500">{event.name}</p>
      <div className="mt-6">
        <EventForm
          mode="edit"
          event={{
            id: event.id,
            name: event.name,
            description: event.description,
            startDate: event.startDate,
            endDate: event.endDate,
          }}
        />
      </div>
    </div>
  )
}
