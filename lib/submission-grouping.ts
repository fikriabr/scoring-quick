// lib/submission-grouping.ts
//
// Pure grouping logic for the admin submissions list. Kept in a neutral module
// — no `'use client'`, no `@/lib/db`, no Prisma runtime import — so it can be
// unit- and property-tested with plain object literals without rendering React.
// The function is generic over the row shape: callers pass whatever project
// object they already have as long as it carries the grouping fields.
//
// Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8

/**
 * Minimum shape a project row must have to be grouped. `categoryId` is the
 * grouping key rather than `categoryName`, because a category name is only
 * unique per event (`@@unique([eventId, name])`) — two different events can
 * both have an "AI Track".
 */
export type GroupableProject = {
  categoryId: string
  categoryName: string
  categoryCreatedAt: string // ISO string of Category.createdAt
  eventName: string
}

/**
 * A single category group: the identifying fields, a precomposed `heading`
 * (`Event — Category`), and the projects belonging to that category in their
 * original input order (createdAt desc).
 */
export type CategoryGroup<T> = {
  categoryId: string
  categoryName: string
  categoryCreatedAt: string
  eventName: string
  heading: string // `${eventName} — ${categoryName}`
  projects: T[]
}

/**
 * Group a flat, createdAt-desc list of projects into one group per category.
 *
 * Projects are collected into a `Map` keyed by `categoryId`; because `Map`
 * preserves insertion order per bucket and the input is already createdAt desc,
 * project order within each group is correct without any re-sort (2.5). The
 * resulting groups are then sorted by `categoryCreatedAt` (newest category
 * first), with `eventName` then `categoryName` as a deterministic tie-break.
 * Categories with no projects never enter the map, so they never produce a
 * group (2.6).
 */
export function groupProjectsByCategory<T extends GroupableProject>(
  projects: T[],
): CategoryGroup<T>[] {
  const groups = new Map<string, CategoryGroup<T>>()

  for (const project of projects) {
    let group = groups.get(project.categoryId)
    if (!group) {
      group = {
        categoryId: project.categoryId,
        categoryName: project.categoryName,
        categoryCreatedAt: project.categoryCreatedAt,
        eventName: project.eventName,
        heading: `${project.eventName} — ${project.categoryName}`,
        projects: [],
      }
      groups.set(project.categoryId, group)
    }
    group.projects.push(project)
  }

  return [...groups.values()].sort((a, b) => {
    // Primary: order categories by when the Category was created, newest
    // first. ISO 8601 strings sort chronologically under lexicographic
    // comparison, so comparing b vs a gives descending (newest) order.
    const byCreated = b.categoryCreatedAt.localeCompare(a.categoryCreatedAt)
    if (byCreated !== 0) return byCreated

    // Tie-break so the order stays deterministic when two categories share
    // the same createdAt: event name, then category name (case-insensitive).
    const byEvent = a.eventName.localeCompare(b.eventName, undefined, {
      sensitivity: 'base',
    })
    if (byEvent !== 0) return byEvent
    return a.categoryName.localeCompare(b.categoryName, undefined, {
      sensitivity: 'base',
    })
  })
}
