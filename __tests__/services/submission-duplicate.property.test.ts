/**
 * Property-Based Tests: Property 6 — Submission Duplicate Prevention
 *
 * **Validates: Requirements 3.3**
 *
 * Property 6 (from design.md):
 *   For any category, submitting the same URL twice to that category should
 *   succeed on the first submission and return a duplicate error on the second,
 *   leaving the project count unchanged.
 *
 * The Prisma db client is mocked so no real database calls are made.
 * `db.project.findFirst` is configured per-call to simulate:
 *   - First submission: no existing project (returns null)
 *   - Second submission: existing project found (returns the created record)
 * `db.project.create` is configured to return a synthetic Project record on
 * the first call and must NOT be called a second time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ---------------------------------------------------------------------------
// Mock lib/db BEFORE importing the service under test.
// ---------------------------------------------------------------------------
vi.mock('@/lib/db', () => ({
  db: {
    project: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}))

import { db } from '@/lib/db'
import { submitProject, DuplicateUrlError } from '@/lib/services/submission.service'

// Typed mock references
const mockFindFirst = vi.mocked(db.project.findFirst)
const mockCreate = vi.mocked(db.project.create)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic Prisma Project record that mirrors what db.project.create
 * would return for the given url + categoryId.
 */
function makeProjectRecord(url: string, categoryId: string, participantName: string) {
  return {
    id: `proj_${Math.random().toString(36).slice(2, 10)}`,
    categoryId,
    url,
    participantName,
    teamName: null,
    crawlStatus: 'PENDING' as const,
    crawlError: null,
    scoreStatus: 'PENDING' as const,
    finalScore: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
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
 * Generates a valid PartyRock URL. Paths are kept simple to stay within
 * URL-valid character space while exercising different path shapes.
 */
const partyRockUrlArb: fc.Arbitrary<string> = fc
  .oneof(
    // exact domain, no path
    fc.constant('https://partyrock.aws'),
    // exact domain with path
    fc.stringMatching(/^[a-z0-9]{3,20}$/).map((slug) => `https://partyrock.aws/app/${slug}`),
    // subdomain
    fc
      .tuple(
        fc.stringMatching(/^[a-z][a-z0-9]{2,10}$/),
        fc.stringMatching(/^[a-z0-9]{3,15}$/),
      )
      .map(([sub, slug]) => `https://${sub}.partyrock.aws/app/${slug}`),
  )

/**
 * Generates a synthetic category ID string (mimics cuid() values).
 */
const categoryIdArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z0-9]{8,20}$/)
  .map((s) => `cat_${s}`)

/**
 * Generates a valid participant name: 1–255 printable characters.
 */
const participantNameArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 255 })
  .filter((s) => s.trim().length > 0)

// ---------------------------------------------------------------------------
// Property 6 — Property-Based Tests
// ---------------------------------------------------------------------------

describe('Property 6: Submission Duplicate Prevention', () => {
  // -------------------------------------------------------------------------
  // P6-a: First submission always succeeds
  // -------------------------------------------------------------------------
  it('P6-a — first submitProject SHALL succeed for any valid URL, categoryId, and participant name [**Validates: Requirements 3.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        partyRockUrlArb,
        categoryIdArb,
        participantNameArb,
        async (url, categoryId, participantName) => {
          vi.clearAllMocks()

          const record = makeProjectRecord(url, categoryId, participantName)

          // No existing project → create succeeds
          mockFindFirst.mockResolvedValueOnce(null as never)
          mockCreate.mockResolvedValueOnce(record as never)

          const result = await submitProject({ url, categoryId, participantName })

          expect(result).toBeDefined()
          expect(result.url).toBe(url)
          expect(result.categoryId).toBe(categoryId)
          expect(result.participantName).toBe(participantName)
          expect(result.crawlStatus).toBe('PENDING')
          expect(result.scoreStatus).toBe('PENDING')
        },
      ),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P6-b: Second submission with same URL + categoryId throws DuplicateUrlError
  // -------------------------------------------------------------------------
  it('P6-b — second submitProject with same URL+categoryId SHALL throw DuplicateUrlError [**Validates: Requirements 3.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        partyRockUrlArb,
        categoryIdArb,
        participantNameArb,
        async (url, categoryId, participantName) => {
          vi.clearAllMocks()

          const record = makeProjectRecord(url, categoryId, participantName)

          // First call: no duplicate
          mockFindFirst.mockResolvedValueOnce(null as never)
          mockCreate.mockResolvedValueOnce(record as never)

          // Second call: duplicate found
          mockFindFirst.mockResolvedValueOnce(record as never)

          // First submission succeeds
          const first = await submitProject({ url, categoryId, participantName })
          expect(first).toBeDefined()

          // Second submission throws DuplicateUrlError
          await expect(
            submitProject({ url, categoryId, participantName }),
          ).rejects.toThrow(DuplicateUrlError)
        },
      ),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P6-c: db.project.create is called exactly once (project count unchanged)
  // -------------------------------------------------------------------------
  it('P6-c — db.project.create SHALL be called exactly once; the second call is blocked before reaching create [**Validates: Requirements 3.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        partyRockUrlArb,
        categoryIdArb,
        participantNameArb,
        async (url, categoryId, participantName) => {
          vi.clearAllMocks()

          const record = makeProjectRecord(url, categoryId, participantName)

          // First findFirst: no existing project
          mockFindFirst.mockResolvedValueOnce(null as never)
          mockCreate.mockResolvedValueOnce(record as never)

          // Second findFirst: existing project
          mockFindFirst.mockResolvedValueOnce(record as never)

          // First submission succeeds
          await submitProject({ url, categoryId, participantName })

          // Second submission fails
          await submitProject({ url, categoryId, participantName }).catch(() => {})

          // create must have been called only once — the duplicate was caught
          // before ever reaching the create call
          expect(mockCreate).toHaveBeenCalledTimes(1)
        },
      ),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P6-d: DuplicateUrlError has code "DUPLICATE_URL" and status 409
  // -------------------------------------------------------------------------
  it('P6-d — DuplicateUrlError SHALL carry code "DUPLICATE_URL", status 409, and mention the URL [**Validates: Requirements 3.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        partyRockUrlArb,
        categoryIdArb,
        participantNameArb,
        async (url, categoryId, participantName) => {
          vi.clearAllMocks()

          const record = makeProjectRecord(url, categoryId, participantName)

          // Simulate already-existing project on first findFirst
          mockFindFirst.mockResolvedValueOnce(record as never)

          let caught: unknown
          try {
            await submitProject({ url, categoryId, participantName })
          } catch (err) {
            caught = err
          }

          expect(caught).toBeInstanceOf(DuplicateUrlError)
          expect((caught as DuplicateUrlError).code).toBe('DUPLICATE_URL')
          expect((caught as DuplicateUrlError).status).toBe(409)
          expect((caught as DuplicateUrlError).name).toBe('DuplicateUrlError')
          expect((caught as DuplicateUrlError).message).toContain(url)
          expect((caught as DuplicateUrlError).message).toContain(categoryId)
        },
      ),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P6-e: Same URL in a DIFFERENT category succeeds (uniqueness is per-category)
  // -------------------------------------------------------------------------
  it('P6-e — same URL submitted to two different categories SHALL both succeed [**Validates: Requirements 3.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        partyRockUrlArb,
        categoryIdArb,
        categoryIdArb,
        participantNameArb,
        async (url, catId1, catId2, participantName) => {
          fc.pre(catId1 !== catId2)
          vi.clearAllMocks()

          const record1 = makeProjectRecord(url, catId1, participantName)
          const record2 = makeProjectRecord(url, catId2, participantName)

          // Both findFirst calls return null (no duplicate in either category)
          mockFindFirst.mockResolvedValueOnce(null as never)
          mockCreate.mockResolvedValueOnce(record1 as never)

          mockFindFirst.mockResolvedValueOnce(null as never)
          mockCreate.mockResolvedValueOnce(record2 as never)

          const first = await submitProject({ url, categoryId: catId1, participantName })
          const second = await submitProject({ url, categoryId: catId2, participantName })

          expect(first.categoryId).toBe(catId1)
          expect(second.categoryId).toBe(catId2)
          expect(first.url).toBe(url)
          expect(second.url).toBe(url)

          // Both creates were called
          expect(mockCreate).toHaveBeenCalledTimes(2)
        },
      ),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Deterministic edge-case unit tests (complement the property tests)
// ---------------------------------------------------------------------------

describe('Property 6: Submission Duplicate Prevention — deterministic edge cases', () => {
  const url = 'https://partyrock.aws/app/my-app'
  const categoryId = 'cat_abc123'
  const participantName = 'Alice'

  it('first submission creates a project with PENDING statuses', async () => {
    const record = makeProjectRecord(url, categoryId, participantName)
    mockFindFirst.mockResolvedValueOnce(null as never)
    mockCreate.mockResolvedValueOnce(record as never)

    const result = await submitProject({ url, categoryId, participantName })

    expect(result.url).toBe(url)
    expect(result.categoryId).toBe(categoryId)
    expect(result.crawlStatus).toBe('PENDING')
    expect(result.scoreStatus).toBe('PENDING')
    expect(mockCreate).toHaveBeenCalledOnce()
  })

  it('second submission with same URL+categoryId throws DuplicateUrlError', async () => {
    const record = makeProjectRecord(url, categoryId, participantName)

    // First: no duplicate
    mockFindFirst.mockResolvedValueOnce(null as never)
    mockCreate.mockResolvedValueOnce(record as never)

    // Second: duplicate exists
    mockFindFirst.mockResolvedValueOnce(record as never)

    await submitProject({ url, categoryId, participantName })

    await expect(
      submitProject({ url, categoryId, participantName }),
    ).rejects.toBeInstanceOf(DuplicateUrlError)
  })

  it('db.project.create is called only once even after duplicate rejection', async () => {
    const record = makeProjectRecord(url, categoryId, participantName)

    mockFindFirst.mockResolvedValueOnce(null as never)
    mockCreate.mockResolvedValueOnce(record as never)
    mockFindFirst.mockResolvedValueOnce(record as never)

    await submitProject({ url, categoryId, participantName })
    await submitProject({ url, categoryId, participantName }).catch(() => {})

    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('DuplicateUrlError.code is "DUPLICATE_URL"', async () => {
    const record = makeProjectRecord(url, categoryId, participantName)
    mockFindFirst.mockResolvedValueOnce(record as never)

    let caught: unknown
    try {
      await submitProject({ url, categoryId, participantName })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(DuplicateUrlError)
    expect((caught as DuplicateUrlError).code).toBe('DUPLICATE_URL')
    expect((caught as DuplicateUrlError).status).toBe(409)
  })

  it('DuplicateUrlError message contains the URL and categoryId', async () => {
    const record = makeProjectRecord(url, categoryId, participantName)
    mockFindFirst.mockResolvedValueOnce(record as never)

    let caught: DuplicateUrlError | undefined
    try {
      await submitProject({ url, categoryId, participantName })
    } catch (err) {
      caught = err as DuplicateUrlError
    }

    expect(caught!.message).toContain(url)
    expect(caught!.message).toContain(categoryId)
  })

  it('same URL in a different category succeeds — uniqueness is per-category', async () => {
    const otherCategoryId = 'cat_xyz999'
    const record1 = makeProjectRecord(url, categoryId, participantName)
    const record2 = makeProjectRecord(url, otherCategoryId, participantName)

    mockFindFirst.mockResolvedValueOnce(null as never)
    mockCreate.mockResolvedValueOnce(record1 as never)

    mockFindFirst.mockResolvedValueOnce(null as never)
    mockCreate.mockResolvedValueOnce(record2 as never)

    const r1 = await submitProject({ url, categoryId, participantName })
    const r2 = await submitProject({ url, categoryId: otherCategoryId, participantName })

    expect(r1.categoryId).toBe(categoryId)
    expect(r2.categoryId).toBe(otherCategoryId)
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('invalid URL (non-partyrock domain) is rejected by Zod before any DB call', async () => {
    await expect(
      submitProject({ url: 'https://evil.com/app', categoryId, participantName }),
    ).rejects.toThrow()

    expect(mockFindFirst).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('missing participantName is rejected by Zod before any DB call', async () => {
    await expect(
      submitProject({ url, categoryId, participantName: '' }),
    ).rejects.toThrow()

    expect(mockFindFirst).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
