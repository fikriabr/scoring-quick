// app/(dashboard)/admin/events/[id]/page.tsx
// RSC page displaying event details and its categories.
// Requirements: 1.1, 9.1

import { getEventById } from '@/lib/services/event.service'
import { notFound } from 'next/navigation'
import Link from 'next/link'

interface Props {
  params: Promise<{ id: string }>
}

export default async function AdminEventDetailPage({ params }: Props) {
  const { id } = await params
  const event = await getEventById(id)

  if (!event) {
    notFound()
  }

  return (
    <div>
      {/* Back link */}
      <Link
        href="/admin/events"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 transition-colors hover:text-blue-600"
      >
        <span>←</span>
        Back to Events
      </Link>

      {/* Event header card */}
      <div className="mt-4 rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">
              {event.name}
            </h1>
            {event.description && (
              <p className="mt-2 max-w-2xl text-sm text-gray-500">
                {event.description}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-gray-400">
              {event.startDate && (
                <span className="inline-flex items-center gap-1 rounded-md bg-gray-50 px-2 py-1">
                  <span>📆</span>
                  Start: {new Date(event.startDate).toLocaleDateString('id-ID')}
                </span>
              )}
              {event.endDate && (
                <span className="inline-flex items-center gap-1 rounded-md bg-gray-50 px-2 py-1">
                  <span>🏁</span>
                  End: {new Date(event.endDate).toLocaleDateString('id-ID')}
                </span>
              )}
            </div>
          </div>

          {/* Edit event action */}
          <Link
            href={`/admin/events/${event.id}/edit`}
            className="inline-flex shrink-0 items-center gap-2 self-start rounded-lg border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 hover:text-blue-600"
          >
            <span>✏️</span>
            Edit Event
          </Link>
        </div>
      </div>

      {/* Categories section */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Categories</h2>
            <p className="text-sm text-gray-500">
              {event.categories.length}{' '}
              {event.categories.length === 1 ? 'category' : 'categories'}
            </p>
          </div>
          <Link
            href={`/admin/events/${event.id}/categories/new`}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-all hover:bg-blue-700 hover:shadow-md"
          >
            <span>＋</span>
            Add Category
          </Link>
        </div>

        {event.categories.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 bg-white px-6 py-12 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-50 text-2xl">
              📁
            </div>
            <h3 className="text-sm font-semibold text-gray-900">
              No categories yet
            </h3>
            <p className="mt-1 max-w-sm text-sm text-gray-500">
              Add a category to start configuring assessment parameters.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {event.categories.map((category) => (
              <div
                key={category.id}
                className="group rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100 transition-all hover:shadow-md hover:ring-gray-200"
              >
                <Link
                  href={`/admin/categories/${category.id}/parameters`}
                  className="block"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-medium text-gray-900 group-hover:text-blue-600 transition-colors">
                      {category.name}
                    </h3>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        category.isPublished
                          ? 'bg-green-50 text-green-700 ring-1 ring-green-200'
                          : 'bg-gray-50 text-gray-500 ring-1 ring-gray-200'
                      }`}
                    >
                      {category.isPublished ? 'Published' : 'Draft'}
                    </span>
                  </div>
                  {category.description && (
                    <p className="mt-2 line-clamp-2 text-sm text-gray-500">
                      {category.description}
                    </p>
                  )}
                </Link>

                {/* Footer links — leaderboard and category edit */}
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-gray-50 pt-2">
                  <Link
                    href={`/admin/leaderboard/${category.id}`}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-blue-600"
                  >
                    <span>📊</span>
                    View Leaderboard
                  </Link>
                  <Link
                    href={`/admin/events/${event.id}/categories/${category.id}/edit`}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-blue-600"
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
    </div>
  )
}
