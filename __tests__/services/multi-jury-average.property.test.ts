/**
 * Property-Based Tests: Property 12 — Multi-Jury Average Final Score
 *
 * **Validates: Requirements 6.7**
 *
 * Property 12 (from design.md):
 *   For any category with N jury members (N ≥ 1) who have each submitted
 *   scores for all parameters, the project's finalScore SHALL equal the
 *   arithmetic mean of each jury member's individual weighted score:
 *   (Σ jury_k_finalScore) / N.
 */

import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'

// ---------------------------------------------------------------------------
// Mock the Prisma db client BEFORE importing the service under test.
// calculateAverageJuryScore is a pure function — it never touches the DB —
// but leaderboard.service.ts imports `db` at the module level.
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

import { calculateAverageJuryScore } from '../../lib/services/leaderboard.service'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reference implementation of arithmetic mean.
 */
function referenceMean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/**
 * Shuffle an array using Fisher-Yates with a deterministic seed.
 */
function shuffle<T>(arr: T[], seed: number): T[] {
  const copy = [...arr]
  let s = seed
  for (let i = copy.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff
    const j = Math.abs(s) % (i + 1)
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Arbitrary for a single jury weighted score — a finite float in a
 * reasonable range simulating weighted score outputs.
 */
const juryScoreArb = fc.float({
  min: 0,
  max: 100,
  noNaN: true,
  noDefaultInfinity: true,
})

/**
 * Arbitrary for a non-empty array of jury scores (N ≥ 1).
 */
const nonEmptyJuryScoresArb = fc.array(juryScoreArb, {
  minLength: 1,
  maxLength: 50,
})

// ---------------------------------------------------------------------------
// Property 12: Multi-Jury Average Final Score
// ---------------------------------------------------------------------------

describe('Property 12: Multi-Jury Average Final Score', () => {
  /**
   * P12-A: For N ≥ 1 jury scores, result equals arithmetic mean within
   * tolerance 1e-10.
   *
   * **Validates: Requirements 6.7**
   */
  it('P12-A: result equals arithmetic mean within tolerance 1e-10 [**Validates: Requirements 6.7**]', () => {
    fc.assert(
      fc.property(nonEmptyJuryScoresArb, (juryScores) => {
        const result = calculateAverageJuryScore(juryScores)
        const expected = referenceMean(juryScores)
        expect(Math.abs(result - expected)).toBeLessThanOrEqual(1e-10)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * P12-B: Single jury score N=1 → result equals that score exactly.
   *
   * **Validates: Requirements 6.7**
   */
  it('P12-B: single jury score (N=1) returns that score exactly [**Validates: Requirements 6.7**]', () => {
    fc.assert(
      fc.property(juryScoreArb, (score) => {
        const result = calculateAverageJuryScore([score])
        expect(result).toBe(score)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * P12-C: All jury scores equal S → result equals S.
   *
   * **Validates: Requirements 6.7**
   */
  it('P12-C: all jury scores equal S → result equals S [**Validates: Requirements 6.7**]', () => {
    fc.assert(
      fc.property(
        juryScoreArb,
        fc.integer({ min: 1, max: 50 }),
        (score, count) => {
          const juryScores = Array.from({ length: count }, () => score)
          const result = calculateAverageJuryScore(juryScores)
          expect(Math.abs(result - score)).toBeLessThanOrEqual(1e-10)
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P12-D: Determinism — same inputs always return same result.
   *
   * **Validates: Requirements 6.7**
   */
  it('P12-D: deterministic — same inputs always produce the same output [**Validates: Requirements 6.7**]', () => {
    fc.assert(
      fc.property(nonEmptyJuryScoresArb, (juryScores) => {
        const result1 = calculateAverageJuryScore(juryScores)
        const result2 = calculateAverageJuryScore(juryScores)
        expect(result1).toBe(result2)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * P12-E: Empty array returns 0.
   *
   * **Validates: Requirements 6.7**
   */
  it('P12-E: empty array returns 0 [**Validates: Requirements 6.7**]', () => {
    expect(calculateAverageJuryScore([])).toBe(0)
  })

  /**
   * P12-F: Order independence — shuffling doesn't change result.
   *
   * **Validates: Requirements 6.7**
   */
  it('P12-F: order independence — shuffling does not change the result [**Validates: Requirements 6.7**]', () => {
    fc.assert(
      fc.property(
        nonEmptyJuryScoresArb,
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (juryScores, seed) => {
          fc.pre(juryScores.length >= 2)

          const original = calculateAverageJuryScore(juryScores)
          const shuffled = calculateAverageJuryScore(shuffle(juryScores, seed))
          expect(Math.abs(original - shuffled)).toBeLessThanOrEqual(1e-10)
        },
      ),
      { numRuns: 200 },
    )
  })
})
