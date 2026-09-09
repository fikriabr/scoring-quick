// app/(dashboard)/admin/events/[id]/categories/[categoryId]/edit/page.tsx
// RSC page for editing an existing category within an event.
// Requirements: 1.4, 1.5

import { getCategoryById } from '@/lib/services/category.service'
import { db } from '@/lib/db'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import CategoryForm from '@/components/CategoryForm'

interface Props {
  params: Promise<{ id: string; categoryId: string }>
}

export default async function EditCategoryPage({ params }: Props) {
  const { id, categoryId } = await params
  const category = await getCategoryById(categoryId)

  // Guard against a category that does not exist or belongs to another event
  if (!category || category.eventId !== id) {
    notFound()
  }

  const projectCount = await db.project.count({ where: { categoryId } })

  return (
    <div>
      <Link
        href={`/admin/events/${id}`}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 transition-colors hover:text-blue-600"
      >
        <span>←</span> Back to Event
      </Link>
      <h1 className="mt-4 text-2xl font-bold text-gray-900">Edit Category</h1>
      <p className="text-sm text-gray-500">{category.name}</p>
      <div className="mt-6">
        <CategoryForm
          mode="edit"
          eventId={id}
          category={{
            id: category.id,
            name: category.name,
            description: category.description,
          }}
          projectCount={projectCount}
        />
      </div>
    </div>
  )
}
