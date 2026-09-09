/**
 * Property-Based Tests: Property 10 — AI Score Range Invariant
 *
 * **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6**
 *
 * Property 10 (from design.md):
 *   For any parameter with a configured [minScore, maxScore] range and any
 *   CrawlMetadata input, the AI scorer SHALL produce a score value that falls
 *   within [minScore, maxScore] inclusive. If the raw Gemini response returns
 *   an out-of-range value, the service SHALL clamp it and record a warning in
 *   reasoning.
 *
 * Strategy:
 *   - Mock @google/generative-ai so no real Google API calls are made.
 *   - Generate arbitrary [minScore, maxScore] pairs (0 ≤ min < max ≤ 100).
 *   - Generate arbitrary raw scores including out-of-range values.
 *   - Assert score in result is always within [minScore, maxScore].
 *   - Assert clamped flag and WARNING in reasoning when raw score is out of range.
 *   - Assert clamped is falsy when raw score is already in range.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ---------------------------------------------------------------------------
// Mock all dependencies BEFORE importing the service.
// 1. @google/generative-ai — prevents real Google Gemini API calls.
// 2. @/lib/db — prevents PrismaClient instantiation errors in test env.
// 3. @/lib/services/leaderboard.service — prevents transitive db import.
//
// vi.hoisted() ensures mockGenerateContent is available when the hoisted
// vi.mock factory is evaluated (before any other module-level code runs).
// ---------------------------------------------------------------------------

const { mockGenerateContent } = vi.hoisted(() => {
  const mockGenerateContent = vi.fn()
  return { mockGenerateContent }
})

vi.mock('@google/generative-ai', () => {
  class MockGoogleGenerativeAI {
    constructor(_apiKey: string) { }
    getGenerativeModel(_config: unknown) {
      return { generateContent: mockGenerateContent }
    }
  }
  return { GoogleGenerativeAI: MockGoogleGenerativeAI }
})

vi.mock('@/lib/db', () => ({
  db: {
    project: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    crawlMetadata: {
      findMany: vi.fn(),
    },
    aIScore: {
      upsert: vi.fn(),
    },
  },
}))

vi.mock('@/lib/services/leaderboard.service', () => ({
  calculateWeightedScore: vi.fn().mockReturnValue(0),
}))

import { ScorerService } from '@/lib/services/scorer.service'
import type { ProjectMetadata, ScoringParameter } from '@/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake Gemini response text that mimics the JSON payload the
 * model is expected to return:
 *   '{"score": X, "reasoning": "..."}'
 */
function buildGeminiResponseText(score: number, reasoning = 'test reasoning'): string {
  return JSON.stringify({ score, reasoning })
}

/**
 * Configure the mock to return the given raw score from Gemini.
 */
function setupMockGemini(rawScore: number, reasoning = 'test reasoning'): void {
  mockGenerateContent.mockResolvedValueOnce({
    response: { text: () => buildGeminiResponseText(rawScore, reasoning) },
  })
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates a valid [minScore, maxScore] pair where:
 *   0 ≤ minScore < maxScore ≤ 100
 */
const scoreRangeArb: fc.Arbitrary<{ minScore: number; maxScore: number }> = fc
  .tuple(
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 1, max: 100 }),
  )
  .filter(([min, max]) => min < max)
  .map(([minScore, maxScore]) => ({ minScore, maxScore }))

/**
 * Generates raw scores that span all regions:
 *   - Well below range (e.g. -100 to -1)
 *   - Just below range (minScore - 1 .. minScore - 0.1)
 *   - Within range
 *   - Just above range (maxScore + 0.1 .. maxScore + 1)
 *   - Well above range (e.g. 101 to 200)
 */
const rawScoreArb: fc.Arbitrary<number> = fc.oneof(
  // Clearly out of range below
  fc.integer({ min: -100, max: -1 }),
  // Clearly out of range above
  fc.integer({ min: 101, max: 200 }),
  // Could be in or out of range — full integer span
  fc.integer({ min: 0, max: 100 }),
  // Boundary extremes
  fc.constantFrom(-1, 0, 50, 100, 101),
)

/**
 * A raw score that is guaranteed to be below the given min.
 */
function rawScoreBelowMin(minScore: number): fc.Arbitrary<number> {
  if (minScore <= 0) return fc.integer({ min: -100, max: -1 })
  return fc.integer({ min: -100, max: minScore - 1 })
}

/**
 * A raw score that is guaranteed to be above the given max.
 */
function rawScoreAboveMax(maxScore: number): fc.Arbitrary<number> {
  return fc.integer({ min: maxScore + 1, max: maxScore + 100 })
}

/**
 * A raw score that is guaranteed to be within [minScore, maxScore] (integer).
 */
function rawScoreInRange(minScore: number, maxScore: number): fc.Arbitrary<number> {
  return fc.integer({ min: minScore, max: maxScore })
}

/**
 * Minimal but valid ProjectMetadata — the prompt content doesn't matter
 * for clamping behaviour; we just need a structurally valid object.
 */
const metadataArb: fc.Arbitrary<ProjectMetadata> = fc.record({
  title: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 80 })),
  description: fc.oneof(fc.constant(null), fc.string({ minLength: 0, maxLength: 300 })),
  widgets: fc.array(
    fc.record({
      type: fc.constantFrom('text-input', 'ai-chat', 'image-generator', 'text-output'),
      label: fc.string({ minLength: 1, maxLength: 50 }),
    }),
    { minLength: 0, maxLength: 5 },
  ),
  prompts: fc.array(fc.string({ minLength: 0, maxLength: 200 }), {
    minLength: 0,
    maxLength: 3,
  }),
  widgetCount: fc.integer({ min: 0, max: 10 }),
})

/**
 * Build a ScoringParameter from a score range (other fields are fixed).
 */
function makeParameter(minScore: number, maxScore: number): ScoringParameter {
  return {
    id: 'param-test',
    name: 'Test Parameter',
    description: 'A parameter for testing',
    weight: 20,
    minScore,
    maxScore,
    scoringMode: 'AUTO' as const,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Property 10: AI Score Range Invariant — Property-Based Tests
// ---------------------------------------------------------------------------

describe('Property 10: AI Score Range Invariant', () => {
  /**
   * P10-A (core invariant): For any parameter range and any raw Gemini score,
   * the returned score MUST always be within [minScore, maxScore].
   *
   * **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6**
   */
  it('P10-A — result.score is always within [minScore, maxScore] regardless of raw Gemini value [**Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        scoreRangeArb,
        rawScoreArb,
        metadataArb,
        async ({ minScore, maxScore }, rawScore, metadata) => {
          setupMockGemini(rawScore)
          const parameter = makeParameter(minScore, maxScore)

          const result = await ScorerService.scoreParameter(metadata, parameter, [])

          expect(result.score).toBeGreaterThanOrEqual(minScore)
          expect(result.score).toBeLessThanOrEqual(maxScore)
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P10-B (clamp below): When the raw score is below minScore, the result
   * score is clamped to minScore, clamped flag is true, and reasoning contains
   * "WARNING".
   *
   * **Validates: Requirements 5.2, 5.6**
   */
  it('P10-B — raw score below minScore is clamped to minScore with clamped=true and WARNING in reasoning [**Validates: Requirements 5.2, 5.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        scoreRangeArb,
        metadataArb,
        async ({ minScore, maxScore }, metadata) => {
          // Get a score that is definitely below minScore
          const rawScore = minScore - 1 - Math.floor(Math.random() * 50)
          setupMockGemini(rawScore)
          const parameter = makeParameter(minScore, maxScore)

          const result = await ScorerService.scoreParameter(metadata, parameter, [])

          expect(result.score).toBe(minScore)
          expect(result.clamped).toBe(true)
          expect(result.reasoning).toContain('WARNING')
        },
      ),
      { numRuns: 150 },
    )
  })

  /**
   * P10-B2 (clamp below — property based): Using fc.integer generators to
   * produce values strictly below minScore.
   *
   * **Validates: Requirements 5.2, 5.6**
   */
  it('P10-B2 — arbitrary scores strictly below minScore always clamp to minScore [**Validates: Requirements 5.2, 5.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        scoreRangeArb,
        async ({ minScore, maxScore }) => {
          // Use a fixed metadata for simplicity
          const metadata: ProjectMetadata = {
            title: 'Test App',
            description: 'A test',
            widgets: [],
            prompts: [],
            widgetCount: 0,
          }

          await fc.assert(
            fc.asyncProperty(
              rawScoreBelowMin(minScore),
              async (rawScore) => {
                setupMockGemini(rawScore)
                const parameter = makeParameter(minScore, maxScore)
                const result = await ScorerService.scoreParameter(metadata, parameter, [])

                expect(result.score).toBe(minScore)
                expect(result.clamped).toBe(true)
                expect(result.reasoning).toContain('WARNING')
              },
            ),
            { numRuns: 20 },
          )
        },
      ),
      { numRuns: 30 },
    )
  })

  /**
   * P10-C (clamp above): When the raw score is above maxScore, the result
   * score is clamped to maxScore, clamped flag is true, and reasoning contains
   * "WARNING".
   *
   * **Validates: Requirements 5.3, 5.6**
   */
  it('P10-C — raw score above maxScore is clamped to maxScore with clamped=true and WARNING in reasoning [**Validates: Requirements 5.3, 5.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        scoreRangeArb,
        metadataArb,
        async ({ minScore, maxScore }, metadata) => {
          const rawScore = maxScore + 1 + Math.floor(Math.random() * 50)
          setupMockGemini(rawScore)
          const parameter = makeParameter(minScore, maxScore)

          const result = await ScorerService.scoreParameter(metadata, parameter, [])

          expect(result.score).toBe(maxScore)
          expect(result.clamped).toBe(true)
          expect(result.reasoning).toContain('WARNING')
        },
      ),
      { numRuns: 150 },
    )
  })

  /**
   * P10-C2 (clamp above — property based): Using fc generators to produce
   * values strictly above maxScore.
   *
   * **Validates: Requirements 5.3, 5.6**
   */
  it('P10-C2 — arbitrary scores strictly above maxScore always clamp to maxScore [**Validates: Requirements 5.3, 5.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        scoreRangeArb,
        async ({ minScore, maxScore }) => {
          const metadata: ProjectMetadata = {
            title: 'Test App',
            description: 'A test',
            widgets: [],
            prompts: [],
            widgetCount: 0,
          }

          await fc.assert(
            fc.asyncProperty(
              rawScoreAboveMax(maxScore),
              async (rawScore) => {
                setupMockGemini(rawScore)
                const parameter = makeParameter(minScore, maxScore)
                const result = await ScorerService.scoreParameter(metadata, parameter, [])

                expect(result.score).toBe(maxScore)
                expect(result.clamped).toBe(true)
                expect(result.reasoning).toContain('WARNING')
              },
            ),
            { numRuns: 20 },
          )
        },
      ),
      { numRuns: 30 },
    )
  })

  /**
   * P10-D (in-range passthrough): When the raw score is already within
   * [minScore, maxScore], the score is passed through unchanged, clamped is
   * falsy, and reasoning does NOT contain "WARNING".
   *
   * **Validates: Requirements 5.4, 5.5**
   */
  it('P10-D — raw score within range passes through unchanged with clamped falsy and no WARNING [**Validates: Requirements 5.4, 5.5**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        scoreRangeArb,
        async ({ minScore, maxScore }) => {
          const metadata: ProjectMetadata = {
            title: 'Test App',
            description: 'A test',
            widgets: [],
            prompts: [],
            widgetCount: 0,
          }

          await fc.assert(
            fc.asyncProperty(
              rawScoreInRange(minScore, maxScore),
              async (rawScore) => {
                setupMockGemini(rawScore, 'clean reasoning without warning')
                const parameter = makeParameter(minScore, maxScore)
                const result = await ScorerService.scoreParameter(metadata, parameter, [])

                expect(result.score).toBe(rawScore)
                expect(result.clamped).toBeFalsy()
                expect(result.reasoning).not.toContain('WARNING')
              },
            ),
            { numRuns: 20 },
          )
        },
      ),
      { numRuns: 30 },
    )
  })

  /**
   * P10-E (boundary values — minScore exactly): A raw score equal to minScore
   * is not clamped.
   *
   * **Validates: Requirements 5.4**
   */
  it('P10-E — raw score equal to minScore is NOT clamped [**Validates: Requirements 5.4**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        scoreRangeArb,
        metadataArb,
        async ({ minScore, maxScore }, metadata) => {
          setupMockGemini(minScore)
          const parameter = makeParameter(minScore, maxScore)

          const result = await ScorerService.scoreParameter(metadata, parameter, [])

          expect(result.score).toBe(minScore)
          expect(result.clamped).toBeFalsy()
        },
      ),
      { numRuns: 150 },
    )
  })

  /**
   * P10-F (boundary values — maxScore exactly): A raw score equal to maxScore
   * is not clamped.
   *
   * **Validates: Requirements 5.5**
   */
  it('P10-F — raw score equal to maxScore is NOT clamped [**Validates: Requirements 5.5**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        scoreRangeArb,
        metadataArb,
        async ({ minScore, maxScore }, metadata) => {
          setupMockGemini(maxScore)
          const parameter = makeParameter(minScore, maxScore)

          const result = await ScorerService.scoreParameter(metadata, parameter, [])

          expect(result.score).toBe(maxScore)
          expect(result.clamped).toBeFalsy()
        },
      ),
      { numRuns: 150 },
    )
  })

  /**
   * P10-G (WARNING message format): When clamped, the reasoning must contain
   * the original raw score value and the boundary it was clamped to.
   *
   * **Validates: Requirements 5.6**
   */
  it('P10-G — WARNING message in reasoning includes the original raw score and the clamped boundary [**Validates: Requirements 5.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        scoreRangeArb,
        metadataArb,
        async ({ minScore, maxScore }, metadata) => {
          // Test clamp to min
          const rawBelowMin = minScore - 5
          setupMockGemini(rawBelowMin)
          const parameter = makeParameter(minScore, maxScore)
          const resultBelow = await ScorerService.scoreParameter(metadata, parameter, [])

          expect(resultBelow.reasoning).toContain(String(rawBelowMin))
          expect(resultBelow.reasoning).toContain(String(minScore))

          // Test clamp to max
          const rawAboveMax = maxScore + 5
          setupMockGemini(rawAboveMax)
          const resultAbove = await ScorerService.scoreParameter(metadata, parameter, [])

          expect(resultAbove.reasoning).toContain(String(rawAboveMax))
          expect(resultAbove.reasoning).toContain(String(maxScore))
        },
      ),
      { numRuns: 100 },
    )
  })

  /**
   * P10-H (context projects included): The invariant holds even when context
   * projects are provided. Verifies the property is independent of context.
   *
   * **Validates: Requirements 5.2, 5.3, 5.4, 5.5**
   */
  it('P10-H — score range invariant holds regardless of context projects list [**Validates: Requirements 5.2, 5.3, 5.4, 5.5**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        scoreRangeArb,
        rawScoreArb,
        fc.array(metadataArb, { minLength: 0, maxLength: 5 }),
        metadataArb,
        async ({ minScore, maxScore }, rawScore, contextProjects, metadata) => {
          setupMockGemini(rawScore)
          const parameter = makeParameter(minScore, maxScore)

          const result = await ScorerService.scoreParameter(
            metadata,
            parameter,
            contextProjects,
          )

          expect(result.score).toBeGreaterThanOrEqual(minScore)
          expect(result.score).toBeLessThanOrEqual(maxScore)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Deterministic edge-case unit tests (complement the property tests)
// ---------------------------------------------------------------------------

describe('Property 10: AI Score Range Invariant — deterministic edge cases', () => {
  const metadata: ProjectMetadata = {
    title: 'Sample App',
    description: 'A sample application for testing',
    widgets: [{ type: 'ai-chat', label: 'Chat' }],
    prompts: ['You are a helpful assistant'],
    widgetCount: 1,
  }

  it('score of exactly 0 on a [0, 100] parameter is not clamped', async () => {
    setupMockGemini(0)
    const param = makeParameter(0, 100)
    const result = await ScorerService.scoreParameter(metadata, param, [])
    expect(result.score).toBe(0)
    expect(result.clamped).toBeFalsy()
  })

  it('score of exactly 100 on a [0, 100] parameter is not clamped', async () => {
    setupMockGemini(100)
    const param = makeParameter(0, 100)
    const result = await ScorerService.scoreParameter(metadata, param, [])
    expect(result.score).toBe(100)
    expect(result.clamped).toBeFalsy()
  })

  it('raw score -5 on [0, 100] parameter clamps to 0', async () => {
    setupMockGemini(-5)
    const param = makeParameter(0, 100)
    const result = await ScorerService.scoreParameter(metadata, param, [])
    expect(result.score).toBe(0)
    expect(result.clamped).toBe(true)
    expect(result.reasoning).toContain('WARNING')
    expect(result.reasoning).toContain('-5')
    expect(result.reasoning).toContain('0')
  })

  it('raw score 150 on [0, 100] parameter clamps to 100', async () => {
    setupMockGemini(150)
    const param = makeParameter(0, 100)
    const result = await ScorerService.scoreParameter(metadata, param, [])
    expect(result.score).toBe(100)
    expect(result.clamped).toBe(true)
    expect(result.reasoning).toContain('WARNING')
    expect(result.reasoning).toContain('150')
    expect(result.reasoning).toContain('100')
  })

  it('raw score 25 on [10, 50] parameter is unchanged and not clamped', async () => {
    setupMockGemini(25)
    const param = makeParameter(10, 50)
    const result = await ScorerService.scoreParameter(metadata, param, [])
    expect(result.score).toBe(25)
    expect(result.clamped).toBeFalsy()
    expect(result.reasoning).not.toContain('WARNING')
  })

  it('raw score 5 on [10, 50] parameter clamps to 10', async () => {
    setupMockGemini(5)
    const param = makeParameter(10, 50)
    const result = await ScorerService.scoreParameter(metadata, param, [])
    expect(result.score).toBe(10)
    expect(result.clamped).toBe(true)
    expect(result.reasoning).toContain('WARNING')
  })

  it('raw score 60 on [10, 50] parameter clamps to 50', async () => {
    setupMockGemini(60)
    const param = makeParameter(10, 50)
    const result = await ScorerService.scoreParameter(metadata, param, [])
    expect(result.score).toBe(50)
    expect(result.clamped).toBe(true)
    expect(result.reasoning).toContain('WARNING')
  })

  it('original reasoning is preserved in the result (not discarded on clamp)', async () => {
    const customReasoning = 'This app is creative and well-designed.'
    setupMockGemini(-1, customReasoning)
    const param = makeParameter(0, 100)
    const result = await ScorerService.scoreParameter(metadata, param, [])
    // Original reasoning is prepended to the WARNING message
    expect(result.reasoning).toContain(customReasoning)
  })

  it('result includes score, reasoning, and optional clamped fields', async () => {
    setupMockGemini(50)
    const param = makeParameter(0, 100)
    const result = await ScorerService.scoreParameter(metadata, param, [])
    expect(result).toHaveProperty('score')
    expect(result).toHaveProperty('reasoning')
    expect(typeof result.score).toBe('number')
    expect(typeof result.reasoning).toBe('string')
  })

  it('handles Gemini response with potential markdown code fences stripped', async () => {
    // Simulate a response where Gemini wraps JSON in ```json ... ```
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => '```json\n{"score": 75, "reasoning": "Good app"}\n```' },
    })
    const param = makeParameter(0, 100)
    const result = await ScorerService.scoreParameter(metadata, param, [])
    expect(result.score).toBe(75)
    expect(result.reasoning).toBe('Good app')
    expect(result.clamped).toBeFalsy()
  })
})
