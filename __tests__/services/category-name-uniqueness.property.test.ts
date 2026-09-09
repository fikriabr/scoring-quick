/**
 * Property-Based Tests: Property 3 — Category Name Uniqueness Within Event
 *
 * **Validates: Requirements 1.3**
 *
 * Property 3 (from design.md):
 *   For any event, attempting to create two categories with the same name
 *   within that event should succeed on the first creation and fail with a
 *   uniqueness error on the second.
 *
 * The Prisma schema enforces this via `@@unique([eventId, name])` on the
 * Category model. At the service layer, a P2002 error from Prisma is
 * translated into a `DuplicateCategoryError` to give callers a typed,
 * actionable signal.
 *
 * Because the uniqueness constraint lives in the database, we mock the
 * Prisma client: the first `db.category.create` call returns a synthetic
 * Category record, and the second call throws a
 * `PrismaClientKnownRequestError` with code `P2002` — exactly what
 * PostgreSQL would produce for the `@@unique([eventId, name])` constraint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import { Prisma } from '@prisma/client'

// ---------------------------------------------------------------------------
// Mock lib/db BEFORE importing the service so that the module receives the
// mocked version of `db`.
// ---------------------------------------------------------------------------
vi.mock('@/lib/db', () => ({
  db: {
    category: {
      create: vi.fn(),
    },
  },
  prisma: {
    category: {
      create: vi.fn(),
    },
  },
}))

import { createCategory, DuplicateCategoryError } from '@/lib/services/category.service'
import { db } from '@/lib/db'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic Prisma Category record for a given name + eventId.
 * Simulates what `db.category.create` would return on success.
 */
function makeCategoryRecord(name: string, eventId: string) {
  return {
    id: `cat_${Math.random().toString(36).slice(2, 10)}`,
    eventId,
    name,
    description: null,
    isPublished: false,
    publicToken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

/**
 * Build the Prisma P2002 error that a database unique constraint violation
 * would produce. The `meta.target` field mirrors what Prisma sets for a
 * `@@unique([eventId, name])` violation.
 */
function makeP2002Error(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`eventId`,`name`)',
    {
      code: 'P2002',
      clientVersion: '5.0.0',
      meta: { target: ['eventId', 'name'] },
    },
  )
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates a valid category name: 1–255 printable characters, non-empty
 * after trimming. Mirrors the CategorySchema constraint.
 */
const categoryNameArb = fc
  .string({ minLength: 1, maxLength: 255 })
  .filter((s) => s.trim().length > 0)

/**
 * Generates a synthetic event ID string (mimics cuid() values).
 */
const eventIdArb = fc
  .stringMatching(/^[a-z0-9]{8,20}$/)
  .map((s) => `event_${s}`)

// ---------------------------------------------------------------------------
// Property 3 — Property-Based Tests
// ---------------------------------------------------------------------------

describe('Property 3: Category Name Uniqueness Within Event', () => {
  // -------------------------------------------------------------------------
  // P3-a: First creation succeeds for any valid name + eventId
  // -------------------------------------------------------------------------
  it('P3-a — first createCategory call SHALL succeed for any valid name and eventId [**Validates: Requirements 1.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(categoryNameArb, eventIdArb, async (name, eventId) => {
        const mockCreate = vi.mocked(db.category.create)
        mockCreate.mockResolvedValueOnce(makeCategoryRecord(name, eventId) as never)

        const result = await createCategory({ name, eventId, description: null })

        expect(result).toBeDefined()
        expect(result.name).toBe(name)
        expect(result.eventId).toBe(eventId)
        expect(mockCreate).toHaveBeenCalledOnce()
        expect(mockCreate).toHaveBeenCalledWith({
          data: { name, eventId, description: null },
        })

        vi.clearAllMocks()
      }),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P3-b: Second creation with same name+eventId throws DuplicateCategoryError
  // -------------------------------------------------------------------------
  it('P3-b — second createCategory with same name+eventId SHALL throw DuplicateCategoryError [**Validates: Requirements 1.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(categoryNameArb, eventIdArb, async (name, eventId) => {
        const mockCreate = vi.mocked(db.category.create)

        // First call: success
        mockCreate.mockResolvedValueOnce(makeCategoryRecord(name, eventId) as never)
        // Second call: simulate DB unique constraint violation
        mockCreate.mockRejectedValueOnce(makeP2002Error())

        // First creation succeeds
        const first = await createCategory({ name, eventId, description: null })
        expect(first).toBeDefined()
        expect(first.name).toBe(name)

        // Second creation with same name + eventId throws
        await expect(
          createCategory({ name, eventId, description: null }),
        ).rejects.toThrow(DuplicateCategoryError)

        vi.clearAllMocks()
      }),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P3-c: DuplicateCategoryError has the correct code and message shape
  // -------------------------------------------------------------------------
  it('P3-c — DuplicateCategoryError SHALL carry code "DUPLICATE_CATEGORY" and mention name+eventId [**Validates: Requirements 1.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(categoryNameArb, eventIdArb, async (name, eventId) => {
        const mockCreate = vi.mocked(db.category.create)
        mockCreate.mockRejectedValueOnce(makeP2002Error())

        let caught: unknown
        try {
          await createCategory({ name, eventId, description: null })
        } catch (err) {
          caught = err
        }

        expect(caught).toBeDefined()
        expect(caught).toBeInstanceOf(DuplicateCategoryError)
        expect((caught as DuplicateCategoryError).code).toBe('DUPLICATE_CATEGORY')
        expect((caught as DuplicateCategoryError).name).toBe('DuplicateCategoryError')
        expect((caught as DuplicateCategoryError).message).toContain(name)
        expect((caught as DuplicateCategoryError).message).toContain(eventId)

        vi.clearAllMocks()
      }),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P3-d: Same name in DIFFERENT events succeeds (uniqueness is per-event)
  // -------------------------------------------------------------------------
  it('P3-d — same category name in different events SHALL succeed independently [**Validates: Requirements 1.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        categoryNameArb,
        eventIdArb,
        eventIdArb,
        async (name, eventId1, eventId2) => {
          fc.pre(eventId1 !== eventId2)

          const mockCreate = vi.mocked(db.category.create)
          mockCreate.mockResolvedValueOnce(makeCategoryRecord(name, eventId1) as never)
          mockCreate.mockResolvedValueOnce(makeCategoryRecord(name, eventId2) as never)

          // Both calls succeed — different events, so no uniqueness conflict
          const first = await createCategory({ name, eventId: eventId1, description: null })
          const second = await createCategory({ name, eventId: eventId2, description: null })

          expect(first.name).toBe(name)
          expect(first.eventId).toBe(eventId1)
          expect(second.name).toBe(name)
          expect(second.eventId).toBe(eventId2)

          vi.clearAllMocks()
        },
      ),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P3-e: Different names in the same event both succeed
  // -------------------------------------------------------------------------
  it('P3-e — different category names within the same event SHALL each succeed [**Validates: Requirements 1.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        categoryNameArb,
        categoryNameArb,
        eventIdArb,
        async (name1, name2, eventId) => {
          fc.pre(name1 !== name2)

          const mockCreate = vi.mocked(db.category.create)
          mockCreate.mockResolvedValueOnce(makeCategoryRecord(name1, eventId) as never)
          mockCreate.mockResolvedValueOnce(makeCategoryRecord(name2, eventId) as never)

          const first = await createCategory({ name: name1, eventId, description: null })
          const second = await createCategory({ name: name2, eventId, description: null })

          expect(first.name).toBe(name1)
          expect(second.name).toBe(name2)

          vi.clearAllMocks()
        },
      ),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P3-f: Non-P2002 Prisma errors are re-thrown unchanged
  // -------------------------------------------------------------------------
  it('P3-f — non-P2002 database errors SHALL be re-thrown without wrapping [**Validates: Requirements 1.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(categoryNameArb, eventIdArb, async (name, eventId) => {
        const mockCreate = vi.mocked(db.category.create)

        // P2025 = Record not found (a different Prisma error code)
        const unrelatedError = new Prisma.PrismaClientKnownRequestError(
          'An operation failed because it depends on one or more records that were required but not found.',
          { code: 'P2025', clientVersion: '5.0.0' },
        )
        mockCreate.mockRejectedValueOnce(unrelatedError)

        await expect(
          createCategory({ name, eventId, description: null }),
        ).rejects.toThrow(Prisma.PrismaClientKnownRequestError)

        await expect(
          // Re-run to check it's NOT wrapped as DuplicateCategoryError
          (() => {
            mockCreate.mockRejectedValueOnce(unrelatedError)
            return createCategory({ name, eventId, description: null })
          })(),
        ).rejects.not.toBeInstanceOf(DuplicateCategoryError)

        vi.clearAllMocks()
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Deterministic edge-case unit tests (complement the property tests)
// ---------------------------------------------------------------------------

describe('Property 3: Category Name Uniqueness — deterministic edge cases', () => {
  const eventId = 'event_alpha001'
  const otherEventId = 'event_beta0001'

  it('creates a category with a single-character name', async () => {
    vi.mocked(db.category.create).mockResolvedValueOnce(
      makeCategoryRecord('A', eventId) as never,
    )
    const result = await createCategory({ name: 'A', eventId, description: null })
    expect(result.name).toBe('A')
  })

  it('creates a category with a 255-character name', async () => {
    const longName = 'x'.repeat(255)
    vi.mocked(db.category.create).mockResolvedValueOnce(
      makeCategoryRecord(longName, eventId) as never,
    )
    const result = await createCategory({ name: longName, eventId, description: null })
    expect(result.name).toBe(longName)
  })

  it('rejects empty string name via CategorySchema (Zod, no DB call)', async () => {
    await expect(
      createCategory({ name: '', eventId, description: null }),
    ).rejects.toThrow()
    expect(vi.mocked(db.category.create)).not.toHaveBeenCalled()
  })

  it('rejects name exceeding 255 characters via CategorySchema (no DB call)', async () => {
    await expect(
      createCategory({ name: 'x'.repeat(256), eventId, description: null }),
    ).rejects.toThrow()
    expect(vi.mocked(db.category.create)).not.toHaveBeenCalled()
  })

  it('duplicate name in same event: first succeeds, second throws DuplicateCategoryError', async () => {
    vi.mocked(db.category.create)
      .mockResolvedValueOnce(makeCategoryRecord('Finals', eventId) as never)
      .mockRejectedValueOnce(makeP2002Error())

    const first = await createCategory({ name: 'Finals', eventId, description: null })
    expect(first.name).toBe('Finals')

    await expect(
      createCategory({ name: 'Finals', eventId, description: null }),
    ).rejects.toBeInstanceOf(DuplicateCategoryError)
  })

  it('same name in two different events both succeed', async () => {
    vi.mocked(db.category.create)
      .mockResolvedValueOnce(makeCategoryRecord('Finals', eventId) as never)
      .mockResolvedValueOnce(makeCategoryRecord('Finals', otherEventId) as never)

    const r1 = await createCategory({ name: 'Finals', eventId, description: null })
    const r2 = await createCategory({ name: 'Finals', eventId: otherEventId, description: null })

    expect(r1.eventId).toBe(eventId)
    expect(r2.eventId).toBe(otherEventId)
    expect(r1.name).toBe('Finals')
    expect(r2.name).toBe('Finals')
  })

  it('DuplicateCategoryError message includes the duplicate name', async () => {
    vi.mocked(db.category.create).mockRejectedValueOnce(makeP2002Error())

    let caught: unknown
    try {
      await createCategory({ name: 'Semifinals', eventId, description: null })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DuplicateCategoryError)
    expect((caught as DuplicateCategoryError).message).toContain('Semifinals')
  })

  it('DuplicateCategoryError code is DUPLICATE_CATEGORY', async () => {
    vi.mocked(db.category.create).mockRejectedValueOnce(makeP2002Error())
    let caught: unknown
    try {
      await createCategory({ name: 'Test', eventId, description: null })
    } catch (err) {
      caught = err
    }
    expect((caught as DuplicateCategoryError).code).toBe('DUPLICATE_CATEGORY')
  })
})
