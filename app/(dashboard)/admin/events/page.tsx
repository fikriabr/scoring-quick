// app/(dashboard)/admin/events/page.tsx
// RSC page displaying all events for the admin dashboard.
// Requirements: 1.1, 9.1

import Link from 'next/link'
import { listEvents } from '@/lib/services/event.service'

export default async function AdminEventsPage() {
  const events = await listEvents()

  return (
    <div>
      {/* Page header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Events
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage your events and their categories
          </p>
        </div>
        <Link
          href="/admin/events/new"
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all hover:bg-blue-700 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          <span>＋</span>
          Create Event
        </Link>
      </div>

      {events.length === 0 ? (
        /* Empty state */
        <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-200 bg-white px-6 py-16 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-blue-50 text-3xl">
            📅
          </div>
          <h3 className="text-lg font-semibold text-gray-900">No events yet</h3>
          <p className="mt-1 max-w-sm text-sm text-gray-500">
            Create your first event to get started. Events contain categories
            and parameters for scoring.
          </p>
          <Link
            href="/admin/events/new"
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
          >
            <span>＋</span>
            Create Event
          </Link>
        </div>
      ) : (
        /* Events grid */
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {events.map((event) => (
            <div
              key={event.id}
              className="group rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100 transition-all hover:shadow-md hover:ring-gray-200"
            >
              {/* Main card body links to the event detail page */}
              <Link href={`/admin/events/${event.id}`} className="block">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-base font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                    {event.name}
                  </h2>
                  <span className="shrink-0 text-gray-400 transition-transform group-hover:translate-x-0.5">
                    →
                  </span>
                </div>

                {event.description && (
                  <p className="mt-2 line-clamp-2 text-sm text-gray-500">
                    {event.description}
                  </p>
                )}
              </Link>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-gray-50 pt-3 text-xs text-gray-400">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {event.startDate && (
                    <span className="flex items-center gap-1">
                      <span>📆</span>
                      {new Date(event.startDate).toLocaleDateString('id-ID')}
                    </span>
                  )}
                  {event.endDate && (
                    <span className="flex items-center gap-1">
                      <span>🏁</span>
                      {new Date(event.endDate).toLocaleDateString('id-ID')}
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <span>🕐</span>
                    {new Date(event.createdAt).toLocaleDateString('id-ID')}
                  </span>
                </div>

                {/* Edit link — kept outside the card Link to avoid nested anchors */}
                <Link
                  href={`/admin/events/${event.id}/edit`}
                  className="inline-flex items-center gap-1 font-medium text-gray-500 transition-colors hover:text-blue-600"
                >
                  <span>✏️</span>
                  Edit
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
