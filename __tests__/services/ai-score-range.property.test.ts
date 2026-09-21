/**
 * Property-Based Tests: Property 10 — AI Score Range Invariant
 *
 * **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6**
 *
 * Property 10 (from design.md):
 *   For any parameter with a configured [minScore, maxScore] range, the AI
 *   scorer SHALL produce a score value that falls within [minScore, maxScore]
 *   inclusive. If the raw model response returns an out-of-range value, the
 *   service SHALL clamp it and record a warning in reasoning.
 *
 * The evaluator agent scores every parameter of a track in one reply, so the
 * invariant is pinned on `parseEvaluatorResponse` — the single place a raw
 * model number becomes a stored score.
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  parseEvaluatorResponse,
  type EvaluatedParameter,
} from '@/lib/services/ai/evaluator'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParameter(minScore: number, maxScore: number, id = 'param-test'): EvaluatedParameter {
  return { id, name: 'Test Parameter', description: 'A parameter for testing', minScore, maxScore }
}

/** A reply shaped like the evaluator's JSON contract, for one parameter. */
function reply(score: unknown, reasoning = 'test reasoning', evidence = 'quote'): string {
  return JSON.stringify({ scores: [{ parameter: 'P1', score, evidence, reasoning }] })
}

function parseOne(rawScore: unknown, minScore: number, maxScore: number, reasoning?: string) {
  return parseEvaluatorResponse(reply(rawScore, reasoning), [makeParameter(minScore, maxScore)])[0]
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** 0 ≤ minScore < maxScore ≤ 100 */
const scoreRangeArb = fc
  .tuple(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 1, max: 100 }))
  .filter(([min, max]) => min < max)
  .map(([minScore, maxScore]) => ({ minScore, maxScore }))

const rawScoreArb = fc.oneof(
  fc.integer({ min: -100, max: -1 }),
  fc.integer({ min: 101, max: 200 }),
  fc.integer({ min: 0, max: 100 }),
  fc.double({ min: -50, max: 150, noNaN: true, noDefaultInfinity: true }),
)

// ---------------------------------------------------------------------------
// Property 10
// ---------------------------------------------------------------------------

describe('Property 10: AI Score Range Invariant', () => {
  it('P10-A — score is always within [minScore, maxScore] regardless of the raw value', () => {
    fc.assert(
      fc.property(scoreRangeArb, rawScoreArb, ({ minScore, maxScore }, raw) => {
        const result = parseOne(raw, minScore, maxScore)
        expect(result.score).toBeGreaterThanOrEqual(minScore)
        expect(result.score).toBeLessThanOrEqual(maxScore)
      }),
      { numRuns: 300 },
    )
  })

  it('P10-B — a raw score below minScore clamps to minScore with a WARNING', () => {
    fc.assert(
      fc.property(scoreRangeArb, fc.integer({ min: 1, max: 100 }), ({ minScore, maxScore }, below) => {
        const raw = minScore - below
        const result = parseOne(raw, minScore, maxScore)
        expect(result.score).toBe(minScore)
        expect(result.clamped).toBe(true)
        expect(result.reasoning).toContain('WARNING')
        expect(result.reasoning).toContain(String(raw))
        expect(result.reasoning).toContain(`clamped to ${minScore}`)
      }),
    )
  })

  it('P10-C — a raw score above maxScore clamps to maxScore with a WARNING', () => {
    fc.assert(
      fc.property(scoreRangeArb, fc.integer({ min: 1, max: 100 }), ({ minScore, maxScore }, above) => {
        const raw = maxScore + above
        const result = parseOne(raw, minScore, maxScore)
        expect(result.score).toBe(maxScore)
        expect(result.clamped).toBe(true)
        expect(result.reasoning).toContain(`clamped to ${maxScore}`)
      }),
    )
  })

  it('P10-D — an in-range score passes through unchanged, not clamped, no WARNING', () => {
    fc.assert(
      fc.property(
        scoreRangeArb.chain(({ minScore, maxScore }) =>
          fc.tuple(fc.constant({ minScore, maxScore }), fc.integer({ min: minScore, max: maxScore })),
        ),
        ([{ minScore, maxScore }, raw]) => {
          const result = parseOne(raw, minScore, maxScore)
          expect(result.score).toBe(raw)
          expect(result.clamped).toBeFalsy()
          expect(result.reasoning).not.toContain('WARNING')
        },
      ),
    )
  })

  it('P10-E — boundary values are not clamped', () => {
    expect(parseOne(10, 10, 50).clamped).toBeFalsy()
    expect(parseOne(50, 10, 50).clamped).toBeFalsy()
  })

  it('P10-F — original reasoning is preserved when a score is clamped', () => {
    const result = parseOne(150, 0, 100, 'strong semantic structure')
    expect(result.reasoning.startsWith('strong semantic structure')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Response shape handling
// ---------------------------------------------------------------------------

describe('parseEvaluatorResponse — response shape', () => {
  const params = [makeParameter(0, 100, 'a'), makeParameter(0, 10, 'b')]

  it('maps P1/P2 keys back to parameter ids, in parameter order', () => {
    const raw = JSON.stringify({
      scores: [
        { parameter: 'P2', score: 7, evidence: 'e2', reasoning: 'r2' },
        { parameter: 'p1', score: 80, evidence: 'e1', reasoning: 'r1' },
      ],
    })
    const result = parseEvaluatorResponse(raw, params)
    expect(result.map((r) => [r.parameterId, r.score, r.evidence])).toEqual([
      ['a', 80, 'e1'],
      ['b', 7, 'e2'],
    ])
  })

  it('strips markdown code fences and surrounding prose', () => {
    const inner = JSON.stringify({ scores: [{ parameter: 'P1', score: 42, reasoning: 'ok' }] })
    expect(parseEvaluatorResponse('```json\n' + inner + '\n```', [params[0]])[0].score).toBe(42)
    expect(parseEvaluatorResponse('Here you go: ' + inner + ' thanks', [params[0]])[0].score).toBe(42)
  })

  it('rejects a reply that is missing a parameter', () => {
    const raw = JSON.stringify({ scores: [{ parameter: 'P1', score: 50, reasoning: 'r' }] })
    expect(() => parseEvaluatorResponse(raw, params)).toThrow(/missing parameter P2/)
  })

  it('rejects a non-numeric score', () => {
    expect(() => parseOne('high', 0, 100)).toThrow(/non-numeric score/)
  })

  it('rejects a reply that is not JSON', () => {
    expect(() => parseEvaluatorResponse('I think it deserves 80.', [params[0]])).toThrow(
      /not a valid JSON object/,
    )
  })

  it('rejects an empty reply', () => {
    expect(() => parseEvaluatorResponse('', [params[0]])).toThrow(/Empty response/)
  })
})
