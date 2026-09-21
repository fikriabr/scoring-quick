// lib/services/category.service.ts
// CRUD operations for scoring categories within an event.
// All inputs are validated via CategorySchema before any DB call.
// Requirements: 1.3, 1.4, 1.5, 2.4, 8.5

import { db } from '@/lib/db'
import {
  getDefaultParameterSet,
  type DefaultParameterSet,
} from '@/lib/default-parameter-sets'
import {
  CategorySchema,
  CategoryScoringConfigSchema,
  type CategoryInput,
  type CategoryScoringConfigInput,
} from '@/lib/validators/schemas'
import { recalculateCategoryScores } from '@/lib/services/final-score.service'
import { replaceCategoryParameters } from '@/lib/services/parameter.service'
import { Prisma } from '@prisma/client'
import { randomUUID } from 'crypto'

// -----------------------------------------------------------------------
// DuplicateCategoryError
// Thrown when attempting to create a category whose name already exists
// within the same event (maps to Prisma P2002 unique constraint).
// Requirements: 1.3
// -----------------------------------------------------------------------
export class DuplicateCategoryError extends Error {
  readonly code = 'DUPLICATE_CATEGORY'
  constructor(name: string, eventId: string) {
    super(`Category "${name}" already exists in event "${eventId}"`)
    this.name = 'DuplicateCategoryError'
  }
}

// -----------------------------------------------------------------------
// createCategory
// Creates a new category within an event after validating the input.
// Throws DuplicateCategoryError if a category with the same name already
// exists for that event (Prisma P2002).
// Requirements: 1.3
// -----------------------------------------------------------------------
export async function createCategory(input: CategoryInput) {
  const data = CategorySchema.parse(input)
  try {
    return await db.category.create({
      data: {
        eventId: data.eventId,
        name: data.name,
        description: data.description ?? null,
      },
    })
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new DuplicateCategoryError(data.name, data.eventId)
    }
    throw err
  }
}

// -----------------------------------------------------------------------
// updateCategory
// Updates an existing category by ID.
// Requirements: 1.4
// -----------------------------------------------------------------------
export async function updateCategory(id: string, input: Partial<CategoryInput>) {
  const data = CategorySchema.partial().parse(input)
  try {
    return await db.category.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.description !== undefined && { description: data.description ?? null }),
      },
    })
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      throw new DuplicateCategoryError(data.name ?? '', data.eventId ?? '')
    }
    throw err
  }
}

// -----------------------------------------------------------------------
// deleteCategory
// Deletes a category by ID.
// Throws HTTP 409-equivalent error if existing projects reference this category.
// Requirements: 1.5
// -----------------------------------------------------------------------
export async function deleteCategory(id: string) {
  // Check for existing projects first
  const projectCount = await db.project.count({ where: { categoryId: id } })
  if (projectCount > 0) {
    const err = new Error(
      `Cannot delete category: ${projectCount} project(s) are associated with it.`,
    )
      ; (err as Error & { code: string }).code = 'CATEGORY_HAS_PROJECTS'
    throw err
  }
  return db.category.delete({ where: { id } })
}

// -----------------------------------------------------------------------
// listCategoriesByEvent
// Returns all categories for a given event, ordered by name.
// Requirements: 1.1
// -----------------------------------------------------------------------
export async function listCategoriesByEvent(eventId: string) {
  return db.category.findMany({
    where: { eventId },
    orderBy: { name: 'asc' },
    include: { parameters: true },
  })
}

// -----------------------------------------------------------------------
// getCategoryById
// Returns a single category by ID with its parameters.
// Returns null if not found.
// Requirements: 1.1
// -----------------------------------------------------------------------
export async function getCategoryById(id: string) {
  return db.category.findUnique({
    where: { id },
    include: { parameters: true, juryAssignments: true },
  })
}

// -----------------------------------------------------------------------
// updateCategoryScoringConfig
// Sets how the IDEA and HTML track scores are blended (must total 100%) and
// how the critic agent behaves, then re-blends every project's final score
// with the new weights — the per-track scores do not change, so no AI call
// is needed.
// -----------------------------------------------------------------------
export async function updateCategoryScoringConfig(
  id: string,
  input: CategoryScoringConfigInput,
) {
  const data = CategoryScoringConfigSchema.parse(input)
  const category = await db.category.update({ where: { id }, data })
  await recalculateCategoryScores(id)
  return category
}

// -----------------------------------------------------------------------
// publishCategory
// Sets isPublished = true and generates a UUID v4 publicToken.
// Requirements: 8.5
// -----------------------------------------------------------------------
export async function publishCategory(id: string) {
  return db.category.update({
    where: { id },
    data: {
      isPublished: true,
      publicToken: randomUUID(),
    },
  })
}

// -----------------------------------------------------------------------
// Default parameter sets
// The templates themselves live in `lib/default-parameter-sets.ts`, a module
// free of `@/lib/db` and of value imports from `@prisma/client`, so the client
// component that renders the template selector can read them without pulling
// the database client into the browser bundle. Re-exported here so existing
// call sites and tests keep importing from this service.
// Requirements: 6.1, 6.2, 6.3, 6.4
// -----------------------------------------------------------------------
export type {
  DefaultParameterSet,
  DefaultParameterTemplate,
} from '@/lib/default-parameter-sets'

export {
  DEFAULT_PARAMETER_SETS,
  DEFAULT_PARAMETER_SET_NAMES,
  DEFAULT_PARAMETER_SET_LABELS,
  DEFAULT_PARAMETER_SET_ORDER,
  getDefaultParameterSet,
  isDefaultParameterSet,
} from '@/lib/default-parameter-sets'

// -----------------------------------------------------------------------
// loadDefaultParameters
// Replaces the category's parameters with the default set (IDEA + HTML
// tracks, each totalling 100% weight).
//
// Reconciles rather than delete-all-then-create: parameters whose name and
// track match a template row are updated in place and keep their scores; the
// rest are removed with their AI scores. Loading therefore works on a
// category that has already been scored, and stays idempotent — it always
// lands on exactly the template. Removing a parameter jury members have
// already scored is refused (ParametersHaveJuryScoresError) before any write.
// -----------------------------------------------------------------------
export async function loadDefaultParameters(
  categoryId: string,
  set: DefaultParameterSet = 'IDEA_HTML',
) {
  const defaults = getDefaultParameterSet(set)
  const parameters = await replaceCategoryParameters(categoryId, defaults)
  await recalculateCategoryScores(categoryId)
  return parameters
}
