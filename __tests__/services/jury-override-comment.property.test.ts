/**
 * Property-Based Tests: Property 13 — Jury Override Comment Requirement
 *
 * **Validates: Requirements 6.3**
 *
 * Property 13 (from design.md):
 *   For any jury score override where |newScore - aiScore| > 0.20 × (maxScore - minScore),
 *   the server SHALL reject the request if comment is absent or empty.
 *
 * Strategy:
 *   - Mock @/lib/db so no real database calls are made.
 *   - Mock next/cache revalidatePath to prevent Next.js internals from running.
 *   - Generate arbitrary parameter ranges, AI scores, and jury scores.
 *   - P13-A: Deviating scores with null/empty comment → always throws ScoreValidationError.
 *   - P13-B: Deviating scores WITH non-empty comment → does NOT throw ScoreValidationError.
 *   - P13-C: Scores within 20% threshold → succeeds regardless of comment presence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ---------------------------------------------------------------------------
// Mocks — hoisted so they're available when vi.mock factories execute.
// ---------------------------------------------------------------------------

const { mockCategoryJuryFindFirst, mockParameterFindUniqueOrThrow, mockAiScoreFindFirst, mockJuryScoreFindFirst, mockJuryScoreUpsert, mockAuditLogCreate, mockJuryScoreFindMany, mockProjectUpdate, mockProjectFindUniqueOrThrow } = vi.hoisted(() => ({
  mockCategoryJuryFindFirst: vi.fn(),
  mockParameterFindUniqueOrThrow: vi.fn(),
  mockAiScoreFindFirst: vi.fn(),
  mockJuryScoreFindFirst: vi.fn(),
  mockJuryScoreUpsert: vi.fn(),
  mockAuditLogCreate: vi.fn(),
  mockJuryScoreFindMany: vi.fn(),
  mockProjectUpdate: vi.fn(),
  mockProjectFindUniqueOrThrow: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    categoryJury: {
      findFirst: mockCategoryJuryFindFirst,
    },
    parameter: {
      findUniqueOrThrow: mockParameterFindUniqueOrThrow,
    },
    aIScore: {
      findFirst: mockAiScoreFindFirst,
    },
    juryScore: {
      findFirst: mockJuryScoreFindFirst,
      upsert: mockJuryScoreUpsert,
      findMany: mockJuryScoreFindMany,
    },
    auditLog: {
      create: mockAuditLogCreate,
    },
    project: {
      update: mockProjectUpdate,
      findUniqueOrThrow: mockProjectFindUniqueOrThrow,
    },
  },
}))

vi.mock('@/lib/services/leaderboard.service', () => ({
  calculateWeightedScore: vi.fn().mockReturnValue(50),
  calculateAverageJuryScore: vi.fn().mockReturnValue(50),
}))

// Final-score recalculation (track blending) has its own tests; here it is
// stubbed so these tests stay focused on the jury rules themselves.
vi.mock('@/lib/services/final-score.service', () => ({
  recalculateProjectScores: vi.fn().mockResolvedValue({
    ideaScore: null,
    htmlScore: null,
    finalScore: null,
  }),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { submitJuryScore, ScoreValidationError } from '@/lib/services/jury.service'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ID = 'project-test-id'
const PARAMETER_ID = 'parameter-test-id'
const JURY_ID = 'jury-test-id'

/**
 * Sets up default mock implementations for a successful flow.
 * Individual tests can override specific mocks as needed.
 */
function setupDefaultMocks(minScore: number, maxScore: number, aiScore: number): void {
  // Jury is assigned
  mockCategoryJuryFindFirst.mockResolvedValue({ id: 'assignment-1', userId: JURY_ID })

  // Parameter with configured range
  mockParameterFindUniqueOrThrow.mockResolvedValue({
    id: PARAMETER_ID,
    minScore,
    maxScore,
    weight: 20,
  })

  // AI score exists
  mockAiScoreFindFirst.mockResolvedValue({
    id: 'ai-score-1',
    projectId: PROJECT_ID,
    parameterId: PARAMETER_ID,
    score: aiScore,
  })

  // No existing jury score
  mockJuryScoreFindFirst.mockResolvedValue(null)

  // Upsert succeeds
  mockJuryScoreUpsert.mockResolvedValue({ id: 'jury-score-1' })

  // Audit log created
  mockAuditLogCreate.mockResolvedValue({ id: 'audit-1' })

  // For recalculateFinalScore
  mockJuryScoreFindMany.mockResolvedValue([
    { juryId: JURY_ID, score: aiScore, parameter: { weight: 20 } },
  ])
  mockProjectUpdate.mockResolvedValue({ id: PROJECT_ID })
  mockProjectFindUniqueOrThrow.mockResolvedValue({ id: PROJECT_ID, categoryId: 'cat-1' })
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates a valid [minScore, maxScore] pair where 0 ≤ min < max ≤ 100.
 * We ensure range is at least 5 so the 20% threshold is at least 1.
 */
const scoreRangeArb: fc.Arbitrary<{ minScore: number; maxScore: number }> = fc
  .tuple(
    fc.integer({ min: 0, max: 95 }),
    fc.integer({ min: 5, max: 100 }),
  )
  .filter(([min, max]) => max - min >= 5)
  .map(([minScore, maxScore]) => ({ minScore, maxScore }))

/**
 * Generates an AI score that is within the parameter range [minScore, maxScore].
 */
function aiScoreInRange(minScore: number, maxScore: number): fc.Arbitrary<number> {
  return fc.integer({ min: minScore, max: maxScore })
}

/**
 * Generates a jury score that deviates MORE than 20% of range from the AI score,
 * while still being within [minScore, maxScore].
 */
function deviatingScoreArb(
  minScore: number,
  maxScore: number,
  aiScore: number,
): fc.Arbitrary<number> {
  const range = maxScore - minScore
  const threshold = 0.2 * range

  // Scores that deviate > threshold from aiScore but are still within [minScore, maxScore]
  const lowerBound = minScore
  const upperBound = maxScore

  // Candidates below (aiScore - threshold) or above (aiScore + threshold)
  const belowCandidates: number[] = []
  const aboveCandidates: number[] = []

  const belowLimit = Math.floor(aiScore - threshold - 1)
  const aboveLimit = Math.ceil(aiScore + threshold + 1)

  if (belowLimit >= lowerBound) {
    belowCandidates.push(lowerBound, belowLimit)
  }
  if (aboveLimit <= upperBound) {
    aboveCandidates.push(aboveLimit, upperBound)
  }

  const arbs: fc.Arbitrary<number>[] = []
  if (belowCandidates.length >= 2) {
    arbs.push(fc.integer({ min: belowCandidates[0], max: belowCandidates[1] }))
  }
  if (aboveCandidates.length >= 2) {
    arbs.push(fc.integer({ min: aboveCandidates[0], max: aboveCandidates[1] }))
  }

  if (arbs.length === 0) {
    // Fallback: return a score that is definitely outside the 20% threshold but in range
    // This should rarely happen with our range constraint (>= 5)
    return fc.constant(aiScore > (minScore + maxScore) / 2 ? minScore : maxScore)
  }

  return fc.oneof(...arbs)
}

/**
 * Generates a jury score that is WITHIN 20% threshold of the AI score,
 * while still being within [minScore, maxScore].
 */
function withinThresholdScoreArb(
  minScore: number,
  maxScore: number,
  aiScore: number,
): fc.Arbitrary<number> {
  const range = maxScore - minScore
  const threshold = 0.2 * range

  // Scores where |score - aiScore| <= threshold AND within [minScore, maxScore]
  const low = Math.max(minScore, Math.ceil(aiScore - threshold))
  const high = Math.min(maxScore, Math.floor(aiScore + threshold))

  if (low > high) {
    // If range is so small this is impossible, just return aiScore
    return fc.constant(aiScore)
  }

  return fc.integer({ min: low, max: high })
}

/**
 * Generates null or empty string (whitespace-only) comments that should trigger rejection.
 */
const emptyCommentArb: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  fc.constant(''),
  fc.constant('   '),
  fc.constant('\t'),
  fc.constant('\n'),
)

/**
 * Generates non-empty comments that should allow the score submission.
 */
const nonEmptyCommentArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0)

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Property 13: Jury Override Comment Requirement
// ---------------------------------------------------------------------------

describe('Property 13: Jury Override Comment Requirement', () => {
  /**
   * P13-A: For any jury score where |score - aiScore| > 0.20 × range,
   * submitting with null or empty comment SHALL throw ScoreValidationError.
   *
   * **Validates: Requirements 6.3**
   */
  it('P13-A — deviating score with absent/empty comment always throws ScoreValidationError [**Validates: Requirements 6.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        scoreRangeArb.chain(({ minScore, maxScore }) =>
          aiScoreInRange(minScore, maxScore).chain((aiScore) =>
            deviatingScoreArb(minScore, maxScore, aiScore).chain((juryScore) =>
              emptyCommentArb.map((comment) => ({
                minScore,
                maxScore,
                aiScore,
                juryScore,
                comment,
              })),
            ),
          ),
        ),
        async ({ minScore, maxScore, aiScore, juryScore, comment }) => {
          setupDefaultMocks(minScore, maxScore, aiScore)

          // Verify the score actually deviates more than 20%
          const range = maxScore - minScore
          const threshold = 0.2 * range
          const deviation = Math.abs(juryScore - aiScore)
          fc.pre(deviation > threshold)
          fc.pre(juryScore >= minScore && juryScore <= maxScore)

          await expect(
            submitJuryScore(PROJECT_ID, PARAMETER_ID, JURY_ID, juryScore, comment),
          ).rejects.toThrow(ScoreValidationError)
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P13-B: For any jury score where |score - aiScore| > 0.20 × range,
   * submitting WITH a non-empty comment SHALL NOT throw ScoreValidationError
   * (the request should succeed).
   *
   * **Validates: Requirements 6.3**
   */
  it('P13-B — deviating score WITH non-empty comment does NOT throw ScoreValidationError [**Validates: Requirements 6.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        scoreRangeArb.chain(({ minScore, maxScore }) =>
          aiScoreInRange(minScore, maxScore).chain((aiScore) =>
            deviatingScoreArb(minScore, maxScore, aiScore).chain((juryScore) =>
              nonEmptyCommentArb.map((comment) => ({
                minScore,
                maxScore,
                aiScore,
                juryScore,
                comment,
              })),
            ),
          ),
        ),
        async ({ minScore, maxScore, aiScore, juryScore, comment }) => {
          setupDefaultMocks(minScore, maxScore, aiScore)

          // Verify the score actually deviates more than 20%
          const range = maxScore - minScore
          const threshold = 0.2 * range
          const deviation = Math.abs(juryScore - aiScore)
          fc.pre(deviation > threshold)
          fc.pre(juryScore >= minScore && juryScore <= maxScore)

          // Should NOT throw ScoreValidationError
          await expect(
            submitJuryScore(PROJECT_ID, PARAMETER_ID, JURY_ID, juryScore, comment),
          ).resolves.not.toThrow()
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P13-C: For any jury score where |score - aiScore| ≤ 0.20 × range,
   * the submission SHALL succeed regardless of whether comment is present
   * or absent.
   *
   * **Validates: Requirements 6.3**
   */
  it('P13-C — score within 20% threshold succeeds regardless of comment presence [**Validates: Requirements 6.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        scoreRangeArb.chain(({ minScore, maxScore }) =>
          aiScoreInRange(minScore, maxScore).chain((aiScore) =>
            withinThresholdScoreArb(minScore, maxScore, aiScore).chain((juryScore) =>
              fc.oneof(emptyCommentArb, nonEmptyCommentArb).map((comment) => ({
                minScore,
                maxScore,
                aiScore,
                juryScore,
                comment,
              })),
            ),
          ),
        ),
        async ({ minScore, maxScore, aiScore, juryScore, comment }) => {
          setupDefaultMocks(minScore, maxScore, aiScore)

          // Verify the score is within threshold
          const range = maxScore - minScore
          const threshold = 0.2 * range
          const deviation = Math.abs(juryScore - aiScore)
          fc.pre(deviation <= threshold)
          fc.pre(juryScore >= minScore && juryScore <= maxScore)

          // Should NOT throw — succeeds regardless of comment
          await expect(
            submitJuryScore(PROJECT_ID, PARAMETER_ID, JURY_ID, juryScore, comment),
          ).resolves.not.toThrow()
        },
      ),
      { numRuns: 200 },
    )
  })
})
