/**
 * Property-Based Tests: Property 11 — Weighted Score Calculation
 *
 * **Validates: Requirements 5.9, 6.4**
 *
 * Property 11 (from design.md):
 *   For any non-empty array of {score, weight} pairs where all weights are
 *   positive and sum to 100, the calculated final score SHALL equal
 *   Σ(score_i × weight_i) / 100, and this value SHALL be deterministic —
 *   calling calculateWeightedScore with the same inputs always returns the
 *   same result.
 */

import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'

// ---------------------------------------------------------------------------
// Mock the Prisma db client BEFORE importing the service under test.
// calculateWeightedScore is a pure function — it never touches the DB —
// but leaderboard.service.ts imports `db` at the module level, which would
// trigger PrismaClient instantiation without a driver adapter in the test env.
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

import { calculateWeightedScore } from '../../lib/services/leaderboard.service'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reference implementation of the weighted score formula.
 * Used to verify the service function independently.
 */
function referenceWeightedScore(
  scores: { score: number; weight: number }[],
): number {
  return scores.reduce((sum, { score, weight }) => sum + (score * weight) / 100, 0)
}

/**
 * Shuffle an array using Fisher-Yates algorithm.
 * Returns a new array — does not mutate the input.
 */
function shuffle<T>(arr: T[], seed: number): T[] {
  const copy = [...arr]
  let s = seed
  for (let i = copy.length - 1; i > 0; i--) {
    // Simple LCG-based pseudo-random to get a deterministic shuffle from seed
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
 * Builds N weights that sum to exactly 100 using the cut-point method.
 */
function weightsThatSumTo100(n: number): fc.Arbitrary<number[]> {
  if (n === 1) return fc.constant([100])

  return fc
    .uniqueArray(fc.integer({ min: 1, max: 99 }), {
      minLength: n - 1,
      maxLength: n - 1,
    })
    .map((cuts) => {
      const sorted = [...cuts].sort((a, b) => a - b)
      const boundaries = [0, ...sorted, 100]
      return boundaries.slice(1).map((v, i) => v - boundaries[i])
    })
}

/**
 * Arbitrary for a valid score value — any finite number in a reasonable range.
 * Scores can be outside the [0, 100] range to test the math generality.
 */
const scoreArb = fc.float({
  min: -1000,
  max: 1000,
  noNaN: true,
  noDefaultInfinity: true,
})

/**
 * Arbitrary for a non-empty array of {score, weight} pairs where weights sum
 * to exactly 100. This matches the precondition of Property 11.
 */
const validScoreArrayArb = fc.integer({ min: 1, max: 10 }).chain((n) =>
  fc.tuple(
    weightsThatSumTo100(n),
    fc.array(scoreArb, { minLength: n, maxLength: n }),
  ).map(([weights, scores]) =>
    weights.map((weight, i) => ({ score: scores[i], weight })),
  ),
)

// ---------------------------------------------------------------------------
// Property 11: Weighted Score Calculation
// ---------------------------------------------------------------------------

describe('Property 11: Weighted Score Calculation', () => {
  /**
   * P11-A: For any array of {score, weight} pairs, the result equals
   * Σ(score_i × weight_i) / 100 within floating-point tolerance (1e-10).
   *
   * **Validates: Requirements 5.9, 6.4**
   */
  it('P11-A: result equals Σ(score_i × weight_i) / 100 within tolerance 1e-10 [**Validates: Requirements 5.9, 6.4**]', () => {
    fc.assert(
      fc.property(validScoreArrayArb, (pairs) => {
        const result = calculateWeightedScore(pairs)
        const expected = referenceWeightedScore(pairs)
        expect(Math.abs(result - expected)).toBeLessThanOrEqual(1e-10)
      }),
      { numRuns: 500 },
    )
  })

  /**
   * P11-B: Determinism — calling calculateWeightedScore with the same inputs
   * twice always returns the exact same result.
   *
   * **Validates: Requirements 5.9, 6.4**
   */
  it('P11-B: deterministic — same inputs always produce the same output [**Validates: Requirements 5.9, 6.4**]', () => {
    fc.assert(
      fc.property(validScoreArrayArb, (pairs) => {
        const result1 = calculateWeightedScore(pairs)
        const result2 = calculateWeightedScore(pairs)
        expect(result1).toBe(result2)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * P11-F: Order independence — shuffling the input array does not change the
   * result (within floating-point tolerance 1e-10), since weighted sums are
   * commutative.
   *
   * **Validates: Requirements 5.9, 6.4**
   */
  it('P11-F: order independence — shuffling the array does not change the result [**Validates: Requirements 5.9, 6.4**]', () => {
    fc.assert(
      fc.property(
        validScoreArrayArb,
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (pairs, seed) => {
          // Only meaningful for arrays with 2+ elements
          fc.pre(pairs.length >= 2)

          const original = calculateWeightedScore(pairs)
          const shuffled = calculateWeightedScore(shuffle(pairs, seed))
          expect(Math.abs(original - shuffled)).toBeLessThanOrEqual(1e-10)
        },
      ),
      { numRuns: 300 },
    )
  })
})

// ---------------------------------------------------------------------------
// Deterministic edge-case unit tests (complement the property tests)
// ---------------------------------------------------------------------------

describe('Property 11: Weighted Score Calculation — edge cases', () => {
  /**
   * P11-C: Empty array returns 0.
   *
   * **Validates: Requirements 5.9, 6.4**
   */
  it('P11-C: empty array returns 0', () => {
    expect(calculateWeightedScore([])).toBe(0)
  })

  /**
   * P11-D: Single element [{score: s, weight: 100}] returns s (within tolerance).
   *
   * **Validates: Requirements 5.9, 6.4**
   */
  it('P11-D: single element [{score: s, weight: 100}] returns s within tolerance', () => {
    fc.assert(
      fc.property(scoreArb, (s) => {
        const result = calculateWeightedScore([{ score: s, weight: 100 }])
        expect(Math.abs(result - s)).toBeLessThanOrEqual(1e-10)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * P11-E: All zero scores returns 0, regardless of weights.
   *
   * **Validates: Requirements 5.9, 6.4**
   */
  it('P11-E: all zero scores returns 0 regardless of weights', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }).chain((n) =>
          weightsThatSumTo100(n).map((weights) =>
            weights.map((weight) => ({ score: 0, weight })),
          ),
        ),
        (pairs) => {
          expect(calculateWeightedScore(pairs)).toBe(0)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('two parameters with equal weights (50/50) produce the arithmetic mean of scores', () => {
    const result = calculateWeightedScore([
      { score: 80, weight: 50 },
      { score: 60, weight: 50 },
    ])
    expect(result).toBeCloseTo(70, 10)
  })

  it('default template parameters (20+25+20+20+15 = 100) compute correctly', () => {
    const pairs = [
      { score: 85, weight: 20 },  // Creativity
      { score: 90, weight: 25 },  // Problem-Solution Fit
      { score: 75, weight: 20 },  // PartyRock Features
      { score: 80, weight: 20 },  // UX & Presentation
      { score: 70, weight: 15 },  // Impact
    ]
    const expected = (85 * 20 + 90 * 25 + 75 * 20 + 80 * 20 + 70 * 15) / 100
    expect(calculateWeightedScore(pairs)).toBeCloseTo(expected, 10)
  })

  it('single perfect score [{score: 100, weight: 100}] returns 100', () => {
    expect(calculateWeightedScore([{ score: 100, weight: 100 }])).toBeCloseTo(100, 10)
  })

  it('single minimum score [{score: 0, weight: 100}] returns 0', () => {
    expect(calculateWeightedScore([{ score: 0, weight: 100 }])).toBe(0)
  })

  it('ten equal-weight parameters (10% each) with score 50 all return 50', () => {
    const pairs = Array.from({ length: 10 }, () => ({ score: 50, weight: 10 }))
    expect(calculateWeightedScore(pairs)).toBeCloseTo(50, 10)
  })

  it('result matches manual calculation for known values', () => {
    // score1=70, weight1=30 → 70*30/100 = 21
    // score2=90, weight2=70 → 90*70/100 = 63
    // total = 84
    const result = calculateWeightedScore([
      { score: 70, weight: 30 },
      { score: 90, weight: 70 },
    ])
    expect(result).toBeCloseTo(84, 10)
  })
})
