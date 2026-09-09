// components/CategoryForm.tsx
// Client component for creating, editing, and deleting categories.
// Performs client-side validation via CategorySchema before calling server actions.
// Shows confirmation dialog before deleting a category that has projects.
// Requirements: 1.3, 1.4, 1.5

'use client'

import { useState, useTransition } from 'react'
import { CategorySchema } from '@/lib/validators/schemas'
import {
  createCategoryAction,
  updateCategoryAction,
  deleteCategoryAction,
} from '@/actions/category.actions'
import { useRouter } from 'next/navigation'

interface CategoryFormProps {
  mode: 'create' | 'edit'
  eventId: string
  category?: {
    id: string
    name: string
    description?: string | null
  }
  /** Number of projects associated with this category (for delete confirmation) */
  projectCount?: number
}

export default function CategoryForm({
  mode,
  eventId,
  category,
  projectCount = 0,
}: CategoryFormProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [errors, setErrors] = useState<Record<string, string[]>>({})
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  async function handleSubmit(formData: FormData) {
    setErrors({})
    setGlobalError(null)

    // Client-side validation
    const rawInput = {
      eventId: formData.get('eventId') as string,
      name: formData.get('name') as string,
      description: (formData.get('description') as string) || null,
    }

    const result = CategorySchema.safeParse(rawInput)
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
          ? await createCategoryAction(formData)
          : await updateCategoryAction(category!.id, formData)

      if (actionResult.success) {
        router.push(`/admin/events/${eventId}`)
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

  function handleDeleteClick() {
    setShowDeleteConfirm(true)
  }

  async function handleDeleteConfirm() {
    setIsDeleting(true)
    setGlobalError(null)

    const result = await deleteCategoryAction(category!.id, eventId)

    if (result.success) {
      router.push(`/admin/events/${eventId}`)
    } else {
      setGlobalError(result.error ?? 'Failed to delete category.')
      setShowDeleteConfirm(false)
      setIsDeleting(false)
    }
  }

  return (
    <div className="space-y-4 max-w-lg">
      <form action={handleSubmit} className="space-y-4">
        {globalError && (
          <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded text-sm">
            {globalError}
          </div>
        )}

        {/* Hidden eventId */}
        <input type="hidden" name="eventId" value={eventId} />

        {/* Name field */}
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
            Category Name <span className="text-red-500">*</span>
          </label>
          <input
            id="name"
            name="name"
            type="text"
            defaultValue={category?.name ?? ''}
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
          <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">
            Description
          </label>
          <textarea
            id="description"
            name="description"
            defaultValue={category?.description ?? ''}
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

        {/* Submit button */}
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={isPending}
            className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending
              ? 'Saving...'
              : mode === 'create'
                ? 'Create Category'
                : 'Update Category'}
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

      {/* Delete section (only in edit mode) */}
      {mode === 'edit' && (
        <div className="pt-4 border-t border-gray-200">
          <button
            type="button"
            onClick={handleDeleteClick}
            disabled={isDeleting}
            className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Delete Category
          </button>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Delete Category
            </h3>
            <p className="text-gray-600 text-sm mb-4">
              {projectCount > 0
                ? `This category has ${projectCount} project(s) associated with it. Deleting it will remove all associated data. Are you sure?`
                : 'Are you sure you want to delete this category? This action cannot be undone.'}
            </p>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isDeleting}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                disabled={isDeleting}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isDeleting ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
