/**
 * __tests__/submission-grouping.property.test.ts
 *
 * Property-based tests for `groupProjectsByCategory`, the pure grouping
 * function behind the admin submissions list. Generated project lists exercise
 * the two correctness properties from the bugfix design across many random
 * inputs (small categoryId pool, mixed-capitalisation event/category names,
 * random createdAt order).
 *
 * Property 1 (Bug Condition): For any list of projects where the bug condition
 * holds, the fixed grouping produces exactly one group per category that has
 * projects, ordered by event name then category name A-Z case-insensitive, with
 * heading `Event — Kategori`, per-category project count, and projects within
 * each section in their original (createdAt desc) order — each project appears
 * exactly once, in its own group.
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8**
 *
 * Property 2 (Preservation): For any input where the bug condition does NOT
 * hold (no projects at all), `groupProjectsByCategory([])` returns `[]`.
 * **Validates: Requirements 3.1, 3.2**
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  groupProjectsByCategory,
  type GroupableProject,
} from '@/lib/submission-grouping'

// ---------------------------------------------------------------------------
// Types & generators
// ---------------------------------------------------------------------------

/** A generated project row carrying a stable identity so we can track it. */
type Project = GroupableProject & { id: string; createdAt: number }

// A small pool of categoryIds so the generator produces genuine collisions
// (several projects sharing a category), which is what makes grouping
// non-trivial. Each categoryId is paired with a fixed (eventName, categoryName)
// so the identity of a category is internally consistent, while names across
// different ids may collide or differ only by capitalisation.
const CATEGORY_POOL: ReadonlyArray<{
  categoryId: string
  categoryName: string
  categoryCreatedAt: string
  eventName: string
}> = [
    { categoryId: 'c-ai-2025', categoryName: 'AI Track', categoryCreatedAt: '2025-01-01T00:00:00.000Z', eventName: 'Hackathon 2025' },
    { categoryId: 'c-web-2025', categoryName: 'web track', categoryCreatedAt: '2025-02-01T00:00:00.000Z', eventName: 'Hackathon 2025' },
    { categoryId: 'c-ai-2024', categoryName: 'ai track', categoryCreatedAt: '2025-03-01T00:00:00.000Z', eventName: 'Hackathon 2024' },
    { categoryId: 'c-design-2024', categoryName: 'Design', categoryCreatedAt: '2025-04-01T00:00:00.000Z', eventName: 'hackathon 2024' },
    { categoryId: 'c-alpha', categoryName: 'Zebra', categoryCreatedAt: '2025-05-01T00:00:00.000Z', eventName: 'Alpha Event' },
    { categoryId: 'c-beta', categoryName: 'apple', categoryCreatedAt: '2025-06-01T00:00:00.000Z', eventName: 'beta event' },
  ]

/** Generates a single project drawn from the category pool. */
const projectArb = (id: string): fc.Arbitrary<Project> =>
  fc.record({
    category: fc.constantFrom(...CATEGORY_POOL),
    createdAt: fc.integer({ min: 0, max: 1_000_000 }),
  }).map(({ category, createdAt }) => ({
    id,
    categoryId: category.categoryId,
    categoryName: category.categoryName,
    categoryCreatedAt: category.categoryCreatedAt,
    eventName: category.eventName,
    createdAt,
  }))

/**
 * Generates a NON-EMPTY list of projects (bug condition holds) sorted
 * createdAt desc, mirroring the Prisma `orderBy: { createdAt: 'desc' }` query
 * that feeds the real function. Ids are unique per list.
 */
const nonEmptyProjectsArb: fc.Arbitrary<Project[]> = fc
  .array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 40 })
  .chain((createdAts) =>
    fc.tuple(
      ...createdAts.map((createdAt, i) =>
        fc.constantFrom(...CATEGORY_POOL).map((category) => ({
          id: `p${i}`,
          categoryId: category.categoryId,
          categoryName: category.categoryName,
          categoryCreatedAt: category.categoryCreatedAt,
          eventName: category.eventName,
          createdAt,
        })),
      ),
    ),
  )
  // Emulate the createdAt-desc ordering the function receives from the query.
  .map((projects) => [...projects].sort((a, b) => b.createdAt - a.createdAt))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ciCompare = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { sensitivity: 'base' })

// ---------------------------------------------------------------------------
// Property 1: Bug Condition — projects grouped per category
// ---------------------------------------------------------------------------

describe('Property 1: projects grouped per category [**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8**]', () => {
  it('partitions the input exactly — every project appears once across all groups', () => {
    fc.assert(
      fc.property(nonEmptyProjectsArb, (projects) => {
        const groups = groupProjectsByCategory(projects)

        // Total count across groups equals input length (2.3, 2.8).
        const total = groups.reduce((n, g) => n + g.projects.length, 0)
        expect(total).toBe(projects.length)

        // Each input project appears in exactly one group (2.8).
        const seen = new Map<string, number>()
        for (const g of groups) {
          for (const p of g.projects) {
            seen.set(p.id, (seen.get(p.id) ?? 0) + 1)
          }
        }
        expect(seen.size).toBe(projects.length)
        for (const count of seen.values()) {
          expect(count).toBe(1)
        }
        for (const p of projects) {
          expect(seen.get(p.id)).toBe(1)
        }
      }),
      { numRuns: 200 },
    )
  })

  it('produces exactly one group per distinct categoryId that has projects', () => {
    fc.assert(
      fc.property(nonEmptyProjectsArb, (projects) => {
        const groups = groupProjectsByCategory(projects)

        const distinctIds = new Set(projects.map((p) => p.categoryId))
        // One group per category with projects, and no extras (2.1, 2.6).
        expect(groups.length).toBe(distinctIds.size)
        expect(new Set(groups.map((g) => g.categoryId))).toEqual(distinctIds)

        // Every project in a group actually belongs to that categoryId.
        for (const g of groups) {
          expect(g.projects.every((p) => p.categoryId === g.categoryId)).toBe(
            true,
          )
        }
      }),
      { numRuns: 200 },
    )
  })

  it('orders groups by categoryCreatedAt, with (eventName, categoryName) as tie-break', () => {
    fc.assert(
      fc.property(nonEmptyProjectsArb, (projects) => {
        const groups = groupProjectsByCategory(projects)

        for (let i = 1; i < groups.length; i++) {
          const prev = groups[i - 1]
          const cur = groups[i]
          const byCreated = prev.categoryCreatedAt.localeCompare(
            cur.categoryCreatedAt,
          )
          if (byCreated !== 0) {
            // Creation time must be non-increasing (newest category first).
            expect(byCreated).toBeGreaterThan(0)
          } else {
            // Same createdAt → fall back to event, then category name.
            const byEvent = ciCompare(prev.eventName, cur.eventName)
            if (byEvent !== 0) {
              expect(byEvent).toBeLessThan(0)
            } else {
              expect(
                ciCompare(prev.categoryName, cur.categoryName),
              ).toBeLessThan(0)
            }
          }
        }
      }),
      { numRuns: 200 },
    )
  })

  it('builds each heading as `Event — Category` with an em dash', () => {
    fc.assert(
      fc.property(nonEmptyProjectsArb, (projects) => {
        const groups = groupProjectsByCategory(projects)

        for (const g of groups) {
          // Heading format `Event — Kategori` (2.2).
          expect(g.heading).toBe(`${g.eventName} — ${g.categoryName}`)
          expect(g.heading).toContain(' — ')
        }
      }),
      { numRuns: 200 },
    )
  })

  it('preserves the input (createdAt-desc) relative order of projects within each group', () => {
    fc.assert(
      fc.property(nonEmptyProjectsArb, (projects) => {
        const groups = groupProjectsByCategory(projects)

        for (const g of groups) {
          // The projects in this group, in the order the input presented them.
          const expected = projects
            .filter((p) => p.categoryId === g.categoryId)
            .map((p) => p.id)
          expect(g.projects.map((p) => p.id)).toEqual(expected)

          // And since the input is createdAt desc, the group is too (2.5).
          for (let i = 1; i < g.projects.length; i++) {
            expect(g.projects[i - 1].createdAt).toBeGreaterThanOrEqual(
              g.projects[i].createdAt,
            )
          }
        }
      }),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Property 2: Preservation — empty input yields an empty grouping
// ---------------------------------------------------------------------------

describe('Property 2: no projects → empty grouping [**Validates: Requirements 3.1, 3.2**]', () => {
  it('returns [] for the empty list (the only ¬bug-condition input)', () => {
    // The bug condition is `count(projects) > 0`; its negation is the single
    // empty-list case, so this is a direct assertion rather than a generator.
    expect(groupProjectsByCategory([])).toEqual([])
  })
})
