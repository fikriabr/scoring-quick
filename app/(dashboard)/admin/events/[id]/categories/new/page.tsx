// app/(dashboard)/admin/events/[id]/categories/new/page.tsx
// RSC page for creating a new category under an event.
// Requirements: 1.3

import { getEventById } from '@/lib/services/event.service'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import CategoryForm from '@/components/CategoryForm'

interface Props {
  params: Promise<{ id: string }>
}

export default async function NewCategoryPage({ params }: Props) {
  const { id } = await params
  const event = await getEventById(id)

  if (!event) {
    notFound()
  }

  return (
    <div>
      <Link
        href={`/admin/events/${id}`}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-blue-600 transition-colors"
      >
        <span>←</span> Back to Event
      </Link>
      <h1 className="mt-4 text-2xl font-bold text-gray-900">Add Category</h1>
      <p className="text-sm text-gray-500">{event.name}</p>
      <div className="mt-6">
        <CategoryForm mode="create" eventId={id} />
      </div>
    </div>
  )
}
