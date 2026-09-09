/**
 * Property-Based Tests: Property 16 — Leaderboard Sort Order
 *
 * **Validates: Requirements 8.1**
 *
 * Property 16 (from design.md):
 *   For any category with 2+ projects, the leaderboard SHALL return projects
 *   in strictly descending order of finalScore. Equal finalScores are
 *   deterministic (by createdAt ascending). No project with null finalScore
 *   SHALL appear ahead of a non-null project.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ---------------------------------------------------------------------------
// Mock the Prisma db client BEFORE importing the service under test.
// ---------------------------------------------------------------------------
vi.mock('@/lib/db', () => ({
  db: {
    project: {
      findMany: vi.fn(),
    },
    category: {
      findUnique: vi.fn(),
    },
  },
}))

import { getLeaderboard } from '../../lib/services/leaderboard.service'
import { db } from '../../lib/db'

// ---------------------------------------------------------------------------
// Helpers & Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates a mock project row matching the shape expected by the service.
 */
function projectArb(opts?: {
  finalScore?: fc.Arbitrary<number | null>
  createdAt?: fc.Arbitrary<Date>
}) {
  const finalScoreArb =
    opts?.finalScore ?? fc.oneof(fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }), fc.constant(null))
  const createdAtArb =
    opts?.createdAt ??
    fc.integer({ min: 1_600_000_000_000, max: 1_700_000_000_000 }).map(
      (ms) => new Date(ms),
    )

  return fc.tuple(fc.uuid(), finalScoreArb, createdAtArb).map(
    ([id, finalScore, createdAt]) => ({
      id,
      categoryId: 'cat-1',
      url: `https://partyrock.aws/u/test/${id}`,
      participantName: `Participant ${id.slice(0, 4)}`,
      teamName: null,
      crawlStatus: 'SUCCESS' as const,
      scoreStatus: 'SUCCESS' as const,
      finalScore,
      createdAt,
      updatedAt: createdAt,
      crawlError: null,
      aiScores: [],
      juryScores: [],
    }),
  )
}

/**
 * Arbitrary for an array of 2+ projects with mixed finalScore values.
 */
const projectsArb = fc.array(projectArb(), { minLength: 2, maxLength: 20 })

/**
 * Arbitrary for an array of 2+ projects where all have non-null scores.
 * Used for testing strict descending order.
 */
const projectsWithScoresArb = fc.array(
  projectArb({
    finalScore: fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  }),
  { minLength: 2, maxLength: 20 },
)

/**
 * Arbitrary for projects that include at least one null and one non-null
 * finalScore, to test null-after-non-null ordering.
 */
const mixedNullProjectsArb = fc
  .tuple(
    fc.array(
      projectArb({
        finalScore: fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
      }),
      { minLength: 1, maxLength: 10 },
    ),
    fc.array(
      projectArb({ finalScore: fc.constant(null) }),
      { minLength: 1, maxLength: 10 },
    ),
  )
  .map(([scored, unscored]) => [...scored, ...unscored])

/**
 * Arbitrary for projects that share the same finalScore to test tie-breaking.
 */
function tiedProjectsArb() {
  return fc
    .tuple(
      fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
      fc.array(
        fc.integer({ min: 1_600_000_000_000, max: 1_700_000_000_000 }).map(
          (ms) => new Date(ms),
        ),
        { minLength: 2, maxLength: 10 },
      ),
    )
    .map(([score, dates]) =>
      dates.map((createdAt, i) => ({
        id: `tied-${i}-${createdAt.getTime()}`,
        categoryId: 'cat-1',
        url: `https://partyrock.aws/u/test/tied-${i}`,
        participantName: `Tied Participant ${i}`,
        teamName: null,
        crawlStatus: 'SUCCESS' as const,
        scoreStatus: 'SUCCESS' as const,
        finalScore: score,
        createdAt,
        updatedAt: createdAt,
        crawlError: null,
        aiScores: [],
        juryScores: [],
      })),
    )
}

// ---------------------------------------------------------------------------
// Property 16: Leaderboard Sort Order
// ---------------------------------------------------------------------------

describe('Property 16: Leaderboard Sort Order', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /**
   * P16-A: All returned projects with non-null scores are in descending order.
   *
   * **Validates: Requirements 8.1**
   */
  it('P16-A: projects with non-null finalScore are in descending order [**Validates: Requirements 8.1**]', () => {
    fc.assert(
      fc.asyncProperty(projectsWithScoresArb, async (projects) => {
        ;(db.project.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(projects)

        const result = await getLeaderboard('cat-1')
        const scoredResults = result.filter((p) => p.finalScore !== null)

        for (let i = 1; i < scoredResults.length; i++) {
          const prev = scoredResults[i - 1].finalScore!
          const curr = scoredResults[i].finalScore!
          expect(prev).toBeGreaterThanOrEqual(curr)
        }
      }),
      { numRuns: 200 },
    )
  })

  /**
   * P16-B: All null-finalScore projects appear after all non-null projects.
   *
   * **Validates: Requirements 8.1**
   */
  it('P16-B: null-finalScore projects appear after all non-null projects [**Validates: Requirements 8.1**]', () => {
    fc.assert(
      fc.asyncProperty(mixedNullProjectsArb, async (projects) => {
        ;(db.project.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(projects)

        const result = await getLeaderboard('cat-1')

        // Find the index of the first null-score project
        const firstNullIndex = result.findIndex((p) => p.finalScore === null)
        if (firstNullIndex === -1) return // no nulls (all were non-null)

        // Every project after firstNullIndex must also be null
        for (let i = firstNullIndex; i < result.length; i++) {
          expect(result[i].finalScore).toBeNull()
        }

        // Every project before firstNullIndex must be non-null
        for (let i = 0; i < firstNullIndex; i++) {
          expect(result[i].finalScore).not.toBeNull()
        }
      }),
      { numRuns: 200 },
    )
  })

  /**
   * P16-C: For tied scores, projects are sorted by createdAt ascending.
   *
   * **Validates: Requirements 8.1**
   */
  it('P16-C: tied finalScores are sorted by createdAt ascending [**Validates: Requirements 8.1**]', () => {
    fc.assert(
      fc.asyncProperty(tiedProjectsArb(), async (projects) => {
        ;(db.project.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(projects)

        const result = await getLeaderboard('cat-1')

        // Group consecutive projects with the same finalScore
        for (let i = 1; i < result.length; i++) {
          if (
            result[i].finalScore !== null &&
            result[i - 1].finalScore !== null &&
            result[i].finalScore === result[i - 1].finalScore
          ) {
            // For tied scores, earlier createdAt should come first
            expect(
              result[i - 1].createdAt.getTime(),
            ).toBeLessThanOrEqual(result[i].createdAt.getTime())
          }
        }
      }),
      { numRuns: 200 },
    )
  })

  /**
   * P16-D: The rank field is 1-indexed and sequential.
   *
   * **Validates: Requirements 8.1**
   */
  it('P16-D: rank field is 1-indexed and sequential [**Validates: Requirements 8.1**]', () => {
    fc.assert(
      fc.asyncProperty(projectsArb, async (projects) => {
        ;(db.project.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(projects)

        const result = await getLeaderboard('cat-1')

        for (let i = 0; i < result.length; i++) {
          expect(result[i].rank).toBe(i + 1)
        }
      }),
      { numRuns: 200 },
    )
  })
})
