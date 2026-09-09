/**
 * Property-Based Tests: Property 4 — Parameter Weight Sum Invariant
 *
 * **Validates: Requirements 2.2, 2.3**
 *
 * Property 4 (from design.md):
 *   For any set of parameters being saved to a category, the system SHALL
 *   accept the configuration if and only if the sum of all weights equals
 *   exactly 100% (within floating-point tolerance of ±0.001). Any
 *   configuration with a total differing from 100% SHALL be rejected with
 *   an error message indicating the discrepancy.
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { ParameterSetSchema } from '../../lib/validators/schemas'
import { ScoringMode } from '@prisma/client'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a valid parameter item with a given weight.
 * All fields other than `weight` are set to well-known valid values.
 */
function makeParam(weight: number) {
  return {
    name: 'Test Parameter',
    description: null,
    weight,
    minScore: 0,
    maxScore: 100,
    scoringMode: ScoringMode.AUTO,
    orderIndex: 0,
  }
}

/**
 * Build a named parameter item.
 */
function makeNamedParam(name: string, weight: number) {
  return {
    name,
    description: null,
    weight,
    minScore: 0,
    maxScore: 100,
    scoringMode: ScoringMode.AUTO,
    orderIndex: 0,
  }
}

/**
 * Distribute 100 across `n` slots in a way that sums exactly to 100.
 * Returns an array of weights (each > 0, each ≤ 100).
 */
function distributeWeights(n: number, seed: number[]): number[] {
  // Use the seed values to get proportions, then normalise to exactly 100
  const raw = seed.map((s) => Math.abs(s) + 1) // ensure > 0
  const total = raw.reduce((a, b) => a + b, 0)
  const scaled = raw.map((v) => (v / total) * 100)

  // Correct for floating-point drift: adjust last element
  const sumFirst = scaled.slice(0, -1).reduce((a, b) => a + b, 0)
  scaled[n - 1] = 100 - sumFirst

  return scaled
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Arbitrary for a single valid weight (1–99 as a round number).
 */
const validWeightArb = fc.integer({ min: 1, max: 99 })

/**
 * Arbitrary for N weights that sum exactly to 100.
 * Strategy: pick N-1 unique integers as "cut points" from 1..99, then
 * derive weights as the gaps between consecutive cut points.
 */
function weightsThatSumTo100(n: number) {
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
 * Arbitrary for N weights that do NOT sum to 100 (difference > 0.001).
 */
function weightsThatDoNotSumTo100(n: number) {
  return fc
    .tuple(
      fc.array(fc.float({ min: 1, max: 50, noNaN: true }), {
        minLength: n,
        maxLength: n,
      }),
      fc.boolean(), // whether to make sum < 100 or > 100
    )
    .map(([raw, makeLow]) => {
      const sum = raw.reduce((a, b) => a + b, 0)
      // Normalise to be clearly != 100
      if (makeLow) {
        // Sum to something between 1 and 99.998
        return raw.map((v) => (v / sum) * 99.998)
      } else {
        // Sum to something between 100.002 and 200
        return raw.map((v) => (v / sum) * 100.002)
      }
    })
}

// ---------------------------------------------------------------------------
// Property 4 — Acceptance: weights sum to 100 ± 0.001
// ---------------------------------------------------------------------------

describe('Property 4: Parameter Weight Sum Invariant', () => {
  /**
   * P4-A: For any non-empty array of valid parameters where weights sum to
   * exactly 100 (within ±0.001), ParameterSetSchema.safeParse MUST succeed.
   *
   * **Validates: Requirements 2.2, 2.3**
   */
  it('P4-A: accepts parameter sets whose weights sum to exactly 100', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }).chain((n) =>
          weightsThatSumTo100(n).map((weights) =>
            weights.map((w, i) => makeNamedParam(`Param ${i + 1}`, w)),
          ),
        ),
        (params) => {
          const totalWeight = params.reduce((s, p) => s + p.weight, 0)
          // Guard: only test inputs that truly satisfy the invariant
          fc.pre(Math.abs(totalWeight - 100) <= 0.001)

          const result = ParameterSetSchema.safeParse(params)
          expect(result.success).toBe(true)
        },
      ),
    )
  })

  /**
   * P4-B: For any non-empty array of valid parameters where weights do NOT
   * sum to 100 (difference > 0.001), ParameterSetSchema.safeParse MUST fail.
   *
   * **Validates: Requirements 2.2, 2.3**
   */
  it('P4-B: rejects parameter sets whose weights do not sum to 100', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }).chain((n) =>
          weightsThatDoNotSumTo100(n).map((weights) =>
            weights.map((w, i) => makeNamedParam(`Param ${i + 1}`, w)),
          ),
        ),
        (params) => {
          const totalWeight = params.reduce((s, p) => s + p.weight, 0)
          // Guard: only test inputs that truly violate the invariant
          fc.pre(Math.abs(totalWeight - 100) > 0.001)
          // Guard: all weights individually valid (>0, <=100)
          fc.pre(params.every((p) => p.weight > 0 && p.weight <= 100))

          const result = ParameterSetSchema.safeParse(params)
          expect(result.success).toBe(false)
        },
      ),
    )
  })

  /**
   * P4-C: When rejected, the error message MUST mention the discrepancy
   * (current total and/or how much to adjust).
   *
   * **Validates: Requirements 2.3**
   */
  it('P4-C: rejection error message describes the weight discrepancy', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }).chain((n) =>
          weightsThatDoNotSumTo100(n).map((weights) =>
            weights.map((w, i) => makeNamedParam(`Param ${i + 1}`, w)),
          ),
        ),
        (params) => {
          const totalWeight = params.reduce((s, p) => s + p.weight, 0)
          fc.pre(Math.abs(totalWeight - 100) > 0.001)
          fc.pre(params.every((p) => p.weight > 0 && p.weight <= 100))

          const result = ParameterSetSchema.safeParse(params)
          expect(result.success).toBe(false)
          if (!result.success) {
            // Zod v4 uses `.issues` instead of `.errors`
            const messages = result.error.issues.map((e) => e.message).join(' ')
            // Error must mention the weight total or required 100%
            expect(messages.toLowerCase()).toMatch(
              /weight|100|bobot|total/i,
            )
          }
        },
      ),
    )
  })
})

// ---------------------------------------------------------------------------
// Edge-case unit tests (deterministic examples)
// ---------------------------------------------------------------------------

describe('Parameter Weight Sum Invariant — edge cases', () => {
  it('single parameter with weight=100 is accepted', () => {
    const result = ParameterSetSchema.safeParse([makeParam(100)])
    expect(result.success).toBe(true)
  })

  it('two parameters summing to exactly 100 are accepted', () => {
    const result = ParameterSetSchema.safeParse([makeParam(60), makeParam(40)])
    expect(result.success).toBe(true)
  })

  it('five default-template parameters summing to exactly 100 are accepted', () => {
    const params = [
      makeNamedParam('Creativity & Originality', 20),
      makeNamedParam('Problem-Solution Fit', 25),
      makeNamedParam('Effective Use of PartyRock Features', 20),
      makeNamedParam('User Experience & Presentation', 20),
      makeNamedParam('Impact & Scalability', 15),
    ]
    const result = ParameterSetSchema.safeParse(params)
    expect(result.success).toBe(true)
  })

  it('weights within ±0.001 tolerance of 100 are accepted', () => {
    // 99.9995 — within tolerance (|99.9995 - 100| = 0.0005 < 0.001)
    const result = ParameterSetSchema.safeParse([makeParam(99.9995)])
    expect(result.success).toBe(true)
  })

  it('weights exceeding the ±0.001 tolerance are rejected', () => {
    // 99.998 — |99.998 - 100| = 0.002 > 0.001 — must fail
    const result = ParameterSetSchema.safeParse([makeParam(99.998)])
    expect(result.success).toBe(false)
  })

  it('empty array is rejected (at least one parameter required)', () => {
    const result = ParameterSetSchema.safeParse([])
    expect(result.success).toBe(false)
  })

  it('three parameters summing to 99 are rejected', () => {
    const result = ParameterSetSchema.safeParse([
      makeParam(33),
      makeParam(33),
      makeParam(33),
    ])
    expect(result.success).toBe(false)
  })

  it('two parameters summing to 101 are rejected', () => {
    const result = ParameterSetSchema.safeParse([makeParam(51), makeParam(50)])
    expect(result.success).toBe(false)
  })

  it('MANUAL scoringMode parameters also obey the weight invariant', () => {
    const params = [
      {
        name: 'Manual Param A',
        description: null,
        weight: 60,
        minScore: 0,
        maxScore: 10,
        scoringMode: ScoringMode.MANUAL,
        orderIndex: 0,
      },
      {
        name: 'Manual Param B',
        description: null,
        weight: 40,
        minScore: 0,
        maxScore: 10,
        scoringMode: ScoringMode.MANUAL,
        orderIndex: 1,
      },
    ]
    const result = ParameterSetSchema.safeParse(params)
    expect(result.success).toBe(true)
  })
})
