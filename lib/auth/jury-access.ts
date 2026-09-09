// lib/auth/jury-access.ts
// Pure, testable functions for jury category-isolation access control.
// These are extracted from the service / API layer so they can be
// property-tested without a database or Next.js request context.

/**
 * Outcome of a jury access check.
 *
 * - `allowed`      → the jury is assigned to the category and may proceed.
 * - `forbidden`    → the jury is authenticated but NOT assigned to this category.
 * - `unauthenticated` → no jury identity was provided.
 */
export type JuryAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: 'unauthenticated' }
  | { allowed: false; reason: 'forbidden' }

/**
 * Determines whether `juryId` is allowed to access `categoryId` given the
 * set of categories they are currently assigned to (`assignedCategoryIds`).
 *
 * This function is a pure predicate — it has no side-effects and makes no
 * network or database calls. The caller is responsible for supplying the
 * correct assignment set (typically fetched from `CategoryJury` in the DB).
 *
 * Rules (in priority order):
 *  1. No juryId provided (null / undefined)   → denied, reason: 'unauthenticated'
 *  2. juryId present AND categoryId is in assignedCategoryIds → allowed
 *  3. juryId present AND categoryId is NOT in assignedCategoryIds → denied, reason: 'forbidden'
 *
 * @param juryId               The ID of the jury user making the request, or null.
 * @param categoryId           The target category being accessed.
 * @param assignedCategoryIds  The set of category IDs the jury is assigned to.
 */
export function checkJuryAccess(
  juryId: string | null | undefined,
  categoryId: string,
  assignedCategoryIds: ReadonlySet<string> | string[],
): JuryAccessDecision {
  // Rule 1: unauthenticated
  if (juryId == null || juryId.trim() === '') {
    return { allowed: false, reason: 'unauthenticated' }
  }

  // Normalise to Set for O(1) lookup
  const assigned =
    assignedCategoryIds instanceof Set
      ? assignedCategoryIds
      : new Set(assignedCategoryIds)

  // Rules 2 & 3
  if (assigned.has(categoryId)) {
    return { allowed: true }
  }

  return { allowed: false, reason: 'forbidden' }
}

/**
 * Filters a list of project-like objects to only those whose `categoryId`
 * appears in `assignedCategoryIds`.
 *
 * This mirrors the service-layer query filter that ensures a jury can only
 * retrieve projects from their assigned categories.
 *
 * @param projects            Array of objects that have a `categoryId` field.
 * @param assignedCategoryIds The set of category IDs the jury is assigned to.
 */
export function filterProjectsByAssignment<T extends { categoryId: string }>(
  projects: T[],
  assignedCategoryIds: ReadonlySet<string> | string[],
): T[] {
  const assigned =
    assignedCategoryIds instanceof Set
      ? assignedCategoryIds
      : new Set(assignedCategoryIds)

  return projects.filter((p) => assigned.has(p.categoryId))
}

/**
 * Returns true when `juryId` is assigned to `categoryId`.
 * Convenience thin wrapper around `checkJuryAccess` for boolean usage.
 */
export function isJuryAssignedToCategory(
  juryId: string | null | undefined,
  categoryId: string,
  assignedCategoryIds: ReadonlySet<string> | string[],
): boolean {
  return checkJuryAccess(juryId, categoryId, assignedCategoryIds).allowed
}
