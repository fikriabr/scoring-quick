// actions/category.actions.ts
// Server Actions for category CRUD operations.
// Called from client-side form components (CategoryForm).
// Requirements: 1.3, 1.4, 1.5

'use server'

import { revalidatePath } from 'next/cache'
import { auth } from '@/lib/auth/config'
import {
  createCategory,
  updateCategory,
  deleteCategory,
  DuplicateCategoryError,
} from '@/lib/services/category.service'
import { CategorySchema } from '@/lib/validators/schemas'
import { ZodError } from 'zod'

export type ActionResult = {
  success: boolean
  error?: string
  fieldErrors?: Record<string, string[]>
  code?: string
}

// -----------------------------------------------------------------------
// createCategoryAction
// Validates input via CategorySchema and calls createCategory service.
// Returns DUPLICATE_CATEGORY code if name already exists in event.
// Requirements: 1.3
// -----------------------------------------------------------------------
export async function createCategoryAction(formData: FormData): Promise<ActionResult> {
  const session = await auth()
  if (!session || session.user.role !== 'ADMIN') {
    return { success: false, error: 'Forbidden: Admin access required.' }
  }

  const rawInput = {
    eventId: formData.get('eventId') as string,
    name: formData.get('name') as string,
    description: (formData.get('description') as string) || null,
  }

  try {
    CategorySchema.parse(rawInput)
    await createCategory(rawInput)
    revalidatePath(`/admin/events/${rawInput.eventId}`)
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
    if (err instanceof DuplicateCategoryError) {
      return {
        success: false,
        error: err.message,
        code: 'DUPLICATE_CATEGORY',
      }
    }
    return { success: false, error: 'An unexpected error occurred.' }
  }
}

// -----------------------------------------------------------------------
// updateCategoryAction
// Validates partial input and calls updateCategory service.
// Requirements: 1.4
// -----------------------------------------------------------------------
export async function updateCategoryAction(
  id: string,
  formData: FormData,
): Promise<ActionResult> {
  const session = await auth()
  if (!session || session.user.role !== 'ADMIN') {
    return { success: false, error: 'Forbidden: Admin access required.' }
  }

  const rawInput = {
    eventId: formData.get('eventId') as string,
    name: formData.get('name') as string,
    description: (formData.get('description') as string) || null,
  }

  try {
    CategorySchema.parse(rawInput)
    await updateCategory(id, rawInput)
    revalidatePath(`/admin/events/${rawInput.eventId}`)
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
    if (err instanceof DuplicateCategoryError) {
      return {
        success: false,
        error: err.message,
        code: 'DUPLICATE_CATEGORY',
      }
    }
    return { success: false, error: 'An unexpected error occurred.' }
  }
}

// -----------------------------------------------------------------------
// deleteCategoryAction
// Deletes a category by ID.
// Returns CATEGORY_HAS_PROJECTS code if category has associated projects.
// Requirements: 1.5
// -----------------------------------------------------------------------
export async function deleteCategoryAction(
  id: string,
  eventId: string,
): Promise<ActionResult> {
  const session = await auth()
  if (!session || session.user.role !== 'ADMIN') {
    return { success: false, error: 'Forbidden: Admin access required.' }
  }

  try {
    await deleteCategory(id)
    revalidatePath(`/admin/events/${eventId}`)
    return { success: true }
  } catch (err) {
    if (err instanceof Error && (err as Error & { code?: string }).code === 'CATEGORY_HAS_PROJECTS') {
      return {
        success: false,
        error: err.message,
        code: 'CATEGORY_HAS_PROJECTS',
      }
    }
    return { success: false, error: 'Failed to delete category.' }
  }
}
