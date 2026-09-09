/**
 * Property-Based Tests: Property 15 — Jury Category Isolation
 *
 * **Validates: Requirements 7.6**
 *
 * Property 15 (from design.md):
 *   For any jury user assigned to a subset of categories, API requests by
 *   that user to view or score projects in a category outside their
 *   assignment SHALL return HTTP 403, leaving the target project's scores
 *   unchanged.
 *
 * Concretely:
 *   - A jury member assigned to category A CAN access category A.
 *   - A jury member assigned to category A CANNOT access category B (or any
 *     other category they are not explicitly assigned to).
 *   - Category isolation is enforced at the service layer — not just in the
 *     UI — so even direct function calls return a "forbidden" decision for
 *     projects outside the jury's assigned categories.
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  checkJuryAccess,
  filterProjectsByAssignment,
  isJuryAssignedToCategory,
} from '@/lib/auth/jury-access'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property 15: Jury Category Isolation', () => {
  // -------------------------------------------------------------------------
  // P15-a: Jury accessing an ASSIGNED category is allowed
  // -------------------------------------------------------------------------
  it('P15-a — jury SHALL be allowed to access categories they are assigned to [**Validates: Requirements 7.6**]', () => {
    /**
     * Strategy: generate a non-empty list of unique category IDs (the
     * "assigned" list), a juryId, and an index to pick one category from
     * the list as the target. The access check must return { allowed: true }.
     */
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `user_${s}`),
        fc.uniqueArray(
          fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `cat_${s}`),
          { minLength: 1, maxLength: 6 },
        ),
        fc.integer({ min: 0, max: 5 }), // index seed; clamped with % in the body
        (juryId, assignedIds, indexSeed) => {
          const categoryId = assignedIds[indexSeed % assignedIds.length]
          const decision = checkJuryAccess(juryId, categoryId, assignedIds)
          expect(decision.allowed).toBe(true)
        },
      ),
      { numRuns: 300 },
    )
  })

  // -------------------------------------------------------------------------
  // P15-b: Jury accessing an UNASSIGNED category is forbidden
  // -------------------------------------------------------------------------
  it('P15-b — jury SHALL be denied (forbidden) when accessing a category they are NOT assigned to [**Validates: Requirements 7.6**]', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `user_${s}`),
        fc.uniqueArray(
          fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `cat_${s}`),
          { minLength: 1, maxLength: 6 },
        ),
        fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `cat_${s}`),
        (juryId, assignedIds, unassignedId) => {
          fc.pre(!assignedIds.includes(unassignedId))
          const decision = checkJuryAccess(juryId, unassignedId, assignedIds)
          expect(decision.allowed).toBe(false)
          if (!decision.allowed) {
            expect(decision.reason).toBe('forbidden')
          }
        },
      ),
      { numRuns: 300 },
    )
  })

  // -------------------------------------------------------------------------
  // P15-c: Unauthenticated / blank juryId is always denied
  // -------------------------------------------------------------------------
  it('P15-c — unauthenticated requests (null/undefined/blank juryId) SHALL always be denied [**Validates: Requirements 7.6**]', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<string | null | undefined>(null, undefined, '', '   '),
        fc.uniqueArray(
          fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `cat_${s}`),
          { minLength: 1, maxLength: 4 },
        ),
        fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `cat_${s}`),
        (juryId, assignedIds, categoryId) => {
          const decision = checkJuryAccess(juryId, categoryId, assignedIds)
          expect(decision.allowed).toBe(false)
          if (!decision.allowed) {
            expect(decision.reason).toBe('unauthenticated')
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P15-d: Category isolation is strict — assignment to A does not grant
  // access to B (two distinct categories, different prefixes)
  // -------------------------------------------------------------------------
  it('P15-d — category A assignment does NOT grant access to category B [**Validates: Requirements 7.6**]', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `user_${s}`),
        fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `cata_${s}`),
        fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `catb_${s}`),
        (juryId, categoryA, categoryB) => {
          // Different prefixes make A ≠ B practically certain; guard anyway
          fc.pre(categoryA !== categoryB)

          const assignedOnlyA = [categoryA]

          // Access A: allowed
          expect(checkJuryAccess(juryId, categoryA, assignedOnlyA).allowed).toBe(true)

          // Access B: forbidden
          const decisionB = checkJuryAccess(juryId, categoryB, assignedOnlyA)
          expect(decisionB.allowed).toBe(false)
          if (!decisionB.allowed) {
            expect(decisionB.reason).toBe('forbidden')
          }
        },
      ),
      { numRuns: 300 },
    )
  })

  // -------------------------------------------------------------------------
  // P15-e: Multi-assignment — jury can access all assigned categories and
  // is denied for any category outside those
  // -------------------------------------------------------------------------
  it('P15-e — jury with multiple assignments can access all assigned categories but none outside [**Validates: Requirements 7.6**]', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `user_${s}`),
        fc.uniqueArray(
          fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `cat_${s}`),
          { minLength: 1, maxLength: 6 },
        ),
        fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `cat_${s}`),
        (juryId, assignedIds, outsideId) => {
          fc.pre(!assignedIds.includes(outsideId))

          // All assigned categories: allowed
          for (const catId of assignedIds) {
            expect(checkJuryAccess(juryId, catId, assignedIds).allowed).toBe(true)
          }

          // Outside category: forbidden
          const outsideDecision = checkJuryAccess(juryId, outsideId, assignedIds)
          expect(outsideDecision.allowed).toBe(false)
          if (!outsideDecision.allowed) {
            expect(outsideDecision.reason).toBe('forbidden')
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P15-f: Access decisions are deterministic
  // -------------------------------------------------------------------------
  it('P15-f — access decisions SHALL be deterministic for identical inputs [**Validates: Requirements 7.6**]', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `user_${s}`),
        fc.uniqueArray(
          fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `cat_${s}`),
          { minLength: 1, maxLength: 4 },
        ),
        fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `cat_${s}`),
        (juryId, assignedIds, categoryId) => {
          const first = checkJuryAccess(juryId, categoryId, assignedIds)
          const second = checkJuryAccess(juryId, categoryId, assignedIds)
          expect(first).toEqual(second)
        },
      ),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P15-g: isJuryAssignedToCategory convenience wrapper is consistent
  // with checkJuryAccess
  // -------------------------------------------------------------------------
  it('P15-g — isJuryAssignedToCategory is consistent with checkJuryAccess [**Validates: Requirements 7.6**]', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `user_${s}`) as fc.Arbitrary<string | null>,
          fc.constant(null) as fc.Arbitrary<string | null>,
        ),
        fc.uniqueArray(
          fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `cat_${s}`),
          { minLength: 1, maxLength: 4 },
        ),
        fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `cat_${s}`),
        (juryId, assignedIds, categoryId) => {
          const decision = checkJuryAccess(juryId, categoryId, assignedIds)
          const helper = isJuryAssignedToCategory(juryId, categoryId, assignedIds)
          expect(helper).toBe(decision.allowed)
        },
      ),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P15-h: filterProjectsByAssignment has no false positives
  // (never returns projects from unassigned categories)
  // -------------------------------------------------------------------------
  it('P15-h — filterProjectsByAssignment SHALL only return projects in assigned categories [**Validates: Requirements 7.6**]', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.stringMatching(/^[a-z0-9]{8}$/).map((s) => `p_${s}`),
            categoryId: fc.stringMatching(/^[a-z0-9]{8}$/).map((s) => `cat_${s}`),
            url: fc.constant('https://partyrock.aws/app/test'),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        fc.uniqueArray(
          fc.stringMatching(/^[a-z0-9]{8}$/).map((s) => `cat_${s}`),
          { minLength: 1, maxLength: 5 },
        ),
        (projects, assignedIds) => {
          const filtered = filterProjectsByAssignment(projects, assignedIds)
          const assignedSet = new Set(assignedIds)
          for (const project of filtered) {
            expect(assignedSet.has(project.categoryId)).toBe(true)
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P15-i: filterProjectsByAssignment has no false negatives
  // (retains all projects from assigned categories)
  // -------------------------------------------------------------------------
  it('P15-i — filterProjectsByAssignment SHALL retain every project in an assigned category [**Validates: Requirements 7.6**]', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.stringMatching(/^[a-z0-9]{8}$/).map((s) => `p_${s}`),
            categoryId: fc.stringMatching(/^[a-z0-9]{8}$/).map((s) => `cat_${s}`),
            url: fc.constant('https://partyrock.aws/app/test'),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        fc.uniqueArray(
          fc.stringMatching(/^[a-z0-9]{8}$/).map((s) => `cat_${s}`),
          { minLength: 1, maxLength: 5 },
        ),
        (projects, assignedIds) => {
          const filtered = filterProjectsByAssignment(projects, assignedIds)
          const assignedSet = new Set(assignedIds)
          const expectedCount = projects.filter((p) =>
            assignedSet.has(p.categoryId),
          ).length
          expect(filtered.length).toBe(expectedCount)
        },
      ),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P15-j: Empty assignment list denies access to every category
  // -------------------------------------------------------------------------
  it('P15-j — jury with no category assignments SHALL be denied access to every category [**Validates: Requirements 7.6**]', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `user_${s}`),
        fc.stringMatching(/^[a-z0-9]{8,16}$/).map((s) => `cat_${s}`),
        (juryId, categoryId) => {
          const decision = checkJuryAccess(juryId, categoryId, [])
          expect(decision.allowed).toBe(false)
          if (!decision.allowed) {
            expect(decision.reason).toBe('forbidden')
          }
        },
      ),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Deterministic edge-case unit tests (complement the property tests)
// ---------------------------------------------------------------------------

describe('Property 15: Jury Category Isolation — deterministic edge cases', () => {
  const juryId = 'jury_user001'
  const catA = 'cat_alpha001'
  const catB = 'cat_beta0001'
  const catC = 'cat_gamma001'

  it('jury assigned to catA only: catA allowed, catB and catC forbidden', () => {
    expect(checkJuryAccess(juryId, catA, [catA])).toEqual({ allowed: true })
    expect(checkJuryAccess(juryId, catB, [catA])).toEqual({ allowed: false, reason: 'forbidden' })
    expect(checkJuryAccess(juryId, catC, [catA])).toEqual({ allowed: false, reason: 'forbidden' })
  })

  it('jury assigned to catA and catB: both allowed, catC forbidden', () => {
    expect(checkJuryAccess(juryId, catA, [catA, catB])).toEqual({ allowed: true })
    expect(checkJuryAccess(juryId, catB, [catA, catB])).toEqual({ allowed: true })
    expect(checkJuryAccess(juryId, catC, [catA, catB])).toEqual({ allowed: false, reason: 'forbidden' })
  })

  it('null juryId returns unauthenticated regardless of category', () => {
    expect(checkJuryAccess(null, catA, [catA])).toEqual({ allowed: false, reason: 'unauthenticated' })
    expect(checkJuryAccess(null, catB, [catA])).toEqual({ allowed: false, reason: 'unauthenticated' })
  })

  it('empty string juryId returns unauthenticated', () => {
    expect(checkJuryAccess('', catA, [catA])).toEqual({ allowed: false, reason: 'unauthenticated' })
  })

  it('whitespace-only juryId returns unauthenticated', () => {
    expect(checkJuryAccess('   ', catA, [catA])).toEqual({ allowed: false, reason: 'unauthenticated' })
  })

  it('empty assigned list: any category is forbidden', () => {
    expect(checkJuryAccess(juryId, catA, [])).toEqual({ allowed: false, reason: 'forbidden' })
  })

  it('accepts Set as well as Array for assignedCategoryIds', () => {
    const assignedSet = new Set([catA, catB])
    expect(checkJuryAccess(juryId, catA, assignedSet)).toEqual({ allowed: true })
    expect(checkJuryAccess(juryId, catC, assignedSet)).toEqual({ allowed: false, reason: 'forbidden' })
  })

  it('filterProjectsByAssignment: only projects from assigned categories survive', () => {
    const projects = [
      { id: 'p1', categoryId: catA, url: 'https://partyrock.aws/a' },
      { id: 'p2', categoryId: catB, url: 'https://partyrock.aws/b' },
      { id: 'p3', categoryId: catC, url: 'https://partyrock.aws/c' },
      { id: 'p4', categoryId: catA, url: 'https://partyrock.aws/d' },
    ]
    const result = filterProjectsByAssignment(projects, [catA])
    expect(result).toHaveLength(2)
    expect(result.map((p) => p.id)).toEqual(['p1', 'p4'])
  })

  it('filterProjectsByAssignment: returns empty array when no assignments', () => {
    const projects = [{ id: 'p1', categoryId: catA, url: 'https://partyrock.aws/a' }]
    expect(filterProjectsByAssignment(projects, [])).toHaveLength(0)
  })

  it('filterProjectsByAssignment: returns all projects when all categories assigned', () => {
    const projects = [
      { id: 'p1', categoryId: catA, url: 'https://partyrock.aws/a' },
      { id: 'p2', categoryId: catB, url: 'https://partyrock.aws/b' },
    ]
    expect(filterProjectsByAssignment(projects, [catA, catB])).toHaveLength(2)
  })
})
