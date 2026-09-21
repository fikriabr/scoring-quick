/**
 * Property-Based Tests: Property 14 — Audit Trail Completeness
 *
 * **Validates: Requirements 6.6**
 *
 * Property 14 (from design.md):
 *   For any jury score change (initial score or override), an AuditLog record
 *   SHALL be created containing: projectId, userId, parameterId, oldValue,
 *   newValue, and createdAt timestamp.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ---------------------------------------------------------------------------
// Mock next/cache (revalidatePath) BEFORE importing the service under test.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Mock the Prisma db client using vi.hoisted to avoid initialization order issues.
// ---------------------------------------------------------------------------
const mockDb = vi.hoisted(() => ({
  categoryJury: {
    findFirst: vi.fn(),
  },
  parameter: {
    findUniqueOrThrow: vi.fn(),
  },
  aIScore: {
    findFirst: vi.fn(),
  },
  juryScore: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
  auditLog: {
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  project: {
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('@/lib/db', () => ({
  db: mockDb,
}))

// Import the module under test after mocks are set up
import { submitJuryScore } from '../../lib/services/jury.service'

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary for a CUID-like string */
const cuidArb = fc.string({ minLength: 10, maxLength: 25 }).map((s) =>
  'c' + s.replace(/[^a-z0-9]/g, 'a').slice(0, 24),
)

/** Arbitrary for a score value within a parameter range [0, 100] */
const scoreArb = fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true })

/** Arbitrary for the previous (existing) score or null */
const previousScoreArb = fc.option(
  fc.float({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
  { nil: null },
)

// ---------------------------------------------------------------------------
// Helper: set up mocks for a successful submitJuryScore call
// ---------------------------------------------------------------------------
function setupMocks(opts: {
  projectId: string
  parameterId: string
  juryId: string
  score: number
  previousScore: number | null
}) {
  // Reset all mocks
  mockDb.categoryJury.findFirst.mockReset()
  mockDb.parameter.findUniqueOrThrow.mockReset()
  mockDb.aIScore.findFirst.mockReset()
  mockDb.juryScore.findFirst.mockReset()
  mockDb.juryScore.findMany.mockReset()
  mockDb.juryScore.upsert.mockReset()
  mockDb.auditLog.create.mockReset()
  mockDb.auditLog.update.mockReset()
  mockDb.auditLog.upsert.mockReset()
  mockDb.auditLog.delete.mockReset()
  mockDb.auditLog.deleteMany.mockReset()
  mockDb.project.findUniqueOrThrow.mockReset()
  mockDb.project.update.mockReset()

  // Jury is assigned to the category
  mockDb.categoryJury.findFirst.mockResolvedValue({ categoryId: 'cat1', userId: opts.juryId })

  // Parameter with range 0-100
  mockDb.parameter.findUniqueOrThrow.mockResolvedValue({
    id: opts.parameterId,
    minScore: 0,
    maxScore: 100,
    weight: 20,
  })

  // AI Score: set to same value as jury score to avoid comment requirement
  // (deviation = 0, which is within 20% threshold)
  mockDb.aIScore.findFirst.mockResolvedValue({
    projectId: opts.projectId,
    parameterId: opts.parameterId,
    score: opts.score,
  })

  // Existing jury score (or null)
  if (opts.previousScore !== null) {
    mockDb.juryScore.findFirst.mockResolvedValue({
      projectId: opts.projectId,
      parameterId: opts.parameterId,
      juryId: opts.juryId,
      score: opts.previousScore,
    })
  } else {
    mockDb.juryScore.findFirst.mockResolvedValue(null)
  }

  // Upsert succeeds
  mockDb.juryScore.upsert.mockResolvedValue({})

  // AuditLog create succeeds
  mockDb.auditLog.create.mockResolvedValue({})

  // For recalculateFinalScore: return the current jury score only
  mockDb.juryScore.findMany.mockResolvedValue([
    {
      juryId: opts.juryId,
      score: opts.score,
      parameter: { weight: 20 },
    },
  ])

  // Project update for finalScore recalculation
  mockDb.project.update.mockResolvedValue({})

  // Project lookup for revalidation
  mockDb.project.findUniqueOrThrow.mockResolvedValue({ categoryId: 'cat1' })
}

// ---------------------------------------------------------------------------
// Property 14: Audit Trail Completeness
// ---------------------------------------------------------------------------

describe('Property 14: Audit Trail Completeness', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  /**
   * P14-A: After submitJuryScore, db.auditLog.create is called with
   * { projectId, userId: juryId, parameterId, action: 'JURY_SCORE', oldValue, newValue }
   *
   * **Validates: Requirements 6.6**
   */
  it('P14-A: auditLog.create is called with correct fields after submitJuryScore [**Validates: Requirements 6.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        cuidArb,
        cuidArb,
        cuidArb,
        scoreArb,
        async (projectId, parameterId, juryId, score) => {
          setupMocks({
            projectId,
            parameterId,
            juryId,
            score,
            previousScore: 50, // existing score
          })

          await submitJuryScore(
            projectId,
            parameterId,
            juryId,
            score,
            'Override justification',
          )

          // Verify auditLog.create was called exactly once
          expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1)

          // Verify the data passed to auditLog.create
          const createCall = mockDb.auditLog.create.mock.calls[0][0]
          expect(createCall.data.projectId).toBe(projectId)
          expect(createCall.data.userId).toBe(juryId)
          expect(createCall.data.parameterId).toBe(parameterId)
          expect(createCall.data.action).toBe('JURY_SCORE')
          expect(createCall.data.newValue).toBe(score)
          expect(createCall.data.oldValue).toBe(50) // previous score
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P14-B: oldValue is null (Prisma.JsonNull) when no previous score exists
   *
   * **Validates: Requirements 6.6**
   */
  it('P14-B: oldValue is Prisma JsonNull when no previous score exists [**Validates: Requirements 6.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        cuidArb,
        cuidArb,
        cuidArb,
        scoreArb,
        async (projectId, parameterId, juryId, score) => {
          setupMocks({
            projectId,
            parameterId,
            juryId,
            score,
            previousScore: null, // no existing score
          })

          await submitJuryScore(
            projectId,
            parameterId,
            juryId,
            score,
            'First score',
          )

          expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1)

          const createCall = mockDb.auditLog.create.mock.calls[0][0]
          // When no existing score, oldValue should be Prisma.JsonNull
          // (a special Prisma symbol that is NOT a number and NOT a regular null)
          expect(createCall.data.oldValue).not.toBeTypeOf('number')
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P14-C: oldValue contains the previous score when updating
   *
   * **Validates: Requirements 6.6**
   */
  it('P14-C: oldValue contains the previous score when updating an existing score [**Validates: Requirements 6.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        cuidArb,
        cuidArb,
        cuidArb,
        scoreArb,
        scoreArb,
        async (projectId, parameterId, juryId, newScore, previousScore) => {
          setupMocks({
            projectId,
            parameterId,
            juryId,
            score: newScore,
            previousScore,
          })

          await submitJuryScore(
            projectId,
            parameterId,
            juryId,
            newScore,
            'Updating score',
          )

          expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1)

          const createCall = mockDb.auditLog.create.mock.calls[0][0]
          expect(createCall.data.oldValue).toBe(previousScore)
          expect(createCall.data.newValue).toBe(newScore)
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P14-D: AuditLog is immutable — verify it's created (not updated or deleted).
   * The mock DB should show that only `create` is called for auditLog,
   * never `update`, `upsert`, `delete`, or `deleteMany`.
   *
   * **Validates: Requirements 6.6**
   */
  it('P14-D: AuditLog is only ever created, never updated or deleted [**Validates: Requirements 6.6**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        cuidArb,
        cuidArb,
        cuidArb,
        scoreArb,
        previousScoreArb,
        async (projectId, parameterId, juryId, score, previousScore) => {
          setupMocks({
            projectId,
            parameterId,
            juryId,
            score,
            previousScore,
          })

          await submitJuryScore(
            projectId,
            parameterId,
            juryId,
            score,
            'Test comment',
          )

          // AuditLog should be created exactly once
          expect(mockDb.auditLog.create).toHaveBeenCalledTimes(1)

          // AuditLog should NEVER be updated or deleted
          expect(mockDb.auditLog.update).not.toHaveBeenCalled()
          expect(mockDb.auditLog.upsert).not.toHaveBeenCalled()
          expect(mockDb.auditLog.delete).not.toHaveBeenCalled()
          expect(mockDb.auditLog.deleteMany).not.toHaveBeenCalled()
        },
      ),
      { numRuns: 200 },
    )
  })
})
