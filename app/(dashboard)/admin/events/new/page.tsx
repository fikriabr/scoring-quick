import Link from 'next/link'
import EventForm from '@/components/EventForm'

export default function NewEventPage() {
  return (
    <div>
      <Link href="/admin/events" className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-blue-600 transition-colors">
        <span>←</span> Back to Events
      </Link>
      <h1 className="mt-4 text-2xl font-bold text-gray-900">Create Event</h1>
      <div className="mt-6">
        <EventForm mode="create" />
      </div>
    </div>
  )
}
