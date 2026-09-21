/**
 * Unit Tests: two-track weighting
 *
 *   - a track's score is the weighted average of its own parameters;
 *   - the final score blends the tracks with the category's idea/html weights;
 *   - a missing track contributes 0 (never re-weighted onto the other);
 *   - jury scores override the AI score per parameter, averaged across juries;
 *   - the category config must blend to exactly 100%.
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  calculateTrackScore,
  calculateTrackedFinalScore,
  combineTrackScores,
} from '@/lib/scoring/tracks'
import { effectiveParameterScores } from '@/lib/services/final-score.service'
import { CategoryScoringConfigSchema } from '@/lib/validators/schemas'

describe('calculateTrackScore', () => {
  it('is the weighted average of the track parameters', () => {
    expect(
      calculateTrackScore([
        { score: 80, weight: 60 },
        { score: 70, weight: 40 },
      ]),
    ).toBeCloseTo(76, 10)
  })

  it('is null for an empty track', () => {
    expect(calculateTrackScore([])).toBeNull()
  })

  it('stays within the min/max of its inputs (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            score: fc.integer({ min: 0, max: 100 }),
            weight: fc.integer({ min: 1, max: 100 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (scores) => {
          const result = calculateTrackScore(scores) as number
          expect(result).toBeGreaterThanOrEqual(Math.min(...scores.map((s) => s.score)) - 1e-9)
          expect(result).toBeLessThanOrEqual(Math.max(...scores.map((s) => s.score)) + 1e-9)
        },
      ),
    )
  })
})

describe('combineTrackScores', () => {
  it('blends with the configured weights, e.g. idea 60% / html 40%', () => {
    expect(
      combineTrackScores({ IDEA: 90, HTML: 50 }, { ideaWeight: 60, htmlWeight: 40 }),
    ).toBeCloseTo(74, 10)
  })

  it('changing the blend changes the final score without re-scoring', () => {
    const tracks = { IDEA: 90, HTML: 50 }
    expect(combineTrackScores(tracks, { ideaWeight: 30, htmlWeight: 70 })).toBeCloseTo(62, 10)
  })

  it('a missing track contributes 0 — a pretty page cannot carry a missing idea', () => {
    expect(
      combineTrackScores({ IDEA: null, HTML: 100 }, { ideaWeight: 60, htmlWeight: 40 }),
    ).toBeCloseTo(40, 10)
  })
})

describe('calculateTrackedFinalScore', () => {
  it('groups parameter scores by track before blending', () => {
    const result = calculateTrackedFinalScore(
      [
        { score: 80, weight: 60, track: 'IDEA' },
        { score: 70, weight: 40, track: 'IDEA' },
        { score: 50, weight: 100, track: 'HTML' },
      ],
      { ideaWeight: 60, htmlWeight: 40 },
    )
    expect(result.ideaScore).toBeCloseTo(76, 10)
    expect(result.htmlScore).toBeCloseTo(50, 10)
    expect(result.finalScore).toBeCloseTo(76 * 0.6 + 50 * 0.4, 10)
  })
})

describe('effectiveParameterScores', () => {
  const params = [
    { id: 'a', weight: 100, track: 'IDEA' as const },
    { id: 'b', weight: 100, track: 'HTML' as const },
  ]

  it('uses the mean of jury scores where any jury scored, the AI score elsewhere', () => {
    const result = effectiveParameterScores(
      params,
      [
        { parameterId: 'a', score: 90 },
        { parameterId: 'b', score: 40 },
      ],
      [
        { parameterId: 'a', score: 70 },
        { parameterId: 'a', score: 80 },
      ],
    )
    expect(result).toEqual([
      { score: 75, weight: 100, track: 'IDEA' },
      { score: 40, weight: 100, track: 'HTML' },
    ])
  })

  it('leaves out parameters nobody has scored', () => {
    expect(effectiveParameterScores(params, [{ parameterId: 'b', score: 10 }], [])).toEqual([
      { score: 10, weight: 100, track: 'HTML' },
    ])
  })
})

describe('CategoryScoringConfigSchema', () => {
  it('accepts a blend that totals 100%', () => {
    expect(
      CategoryScoringConfigSchema.safeParse({ ideaWeight: 60, htmlWeight: 40 }).success,
    ).toBe(true)
  })

  it('rejects a blend that does not total 100%', () => {
    const result = CategoryScoringConfigSchema.safeParse({ ideaWeight: 60, htmlWeight: 60 })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toMatch(/must equal 100%/)
  })

  it('rejects too many critic rounds', () => {
    expect(
      CategoryScoringConfigSchema.safeParse({
        ideaWeight: 50,
        htmlWeight: 50,
        maxCriticRounds: 99,
      }).success,
    ).toBe(false)
  })
})
