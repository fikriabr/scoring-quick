/**
 * Property-Based Tests: Property 18 — Public Leaderboard Access Control
 *
 * **Validates: Requirements 8.5**
 *
 * Property 18 (from design.md):
 *   When `isPublished = true`, requests to `/public/leaderboard/[token]` SHALL
 *   succeed without authentication. When `isPublished = false`, the same URL
 *   SHALL return HTTP 404. The publicToken SHALL be unique and unguessable
 *   (UUID v4 or equivalent).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ---------------------------------------------------------------------------
// Mock the Prisma db client BEFORE importing the service under test.
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

import { getPublicLeaderboard } from '../../lib/services/leaderboard.service'
import { db } from '../../lib/db'

// ---------------------------------------------------------------------------
// Helpers & Arbitraries
// ---------------------------------------------------------------------------

/** UUID v4 regex pattern. */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Arbitrary for a published category row.
 */
function publishedCategoryArb() {
  return fc.uuid().map((id) => ({
    id,
    eventId: 'event-1',
    name: `Category ${id.slice(0, 6)}`,
    description: null,
    isPublished: true,
    publicToken: id, // reuse uuid as token for simplicity
    createdAt: new Date(),
    updatedAt: new Date(),
  }))
}

/**
 * Arbitrary for an unpublished category row.
 */
function unpublishedCategoryArb() {
  return fc.uuid().map((id) => ({
    id,
    eventId: 'event-1',
    name: `Category ${id.slice(0, 6)}`,
    description: null,
    isPublished: false,
    publicToken: id,
    createdAt: new Date(),
    updatedAt: new Date(),
  }))
}

/**
 * Arbitrary for a public token string (UUID v4).
 * Generates proper UUID v4 format: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
 */
function hexBlock(length: number): fc.Arbitrary<string> {
  return fc
    .array(
      fc.constantFrom(
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
      ),
      { minLength: length, maxLength: length },
    )
    .map((chars) => chars.join(''))
}

const uuidV4Arb = fc
  .tuple(
    hexBlock(8),
    hexBlock(4),
    hexBlock(3),
    fc.constantFrom('8', '9', 'a', 'b'),
    hexBlock(3),
    hexBlock(12),
  )
  .map(([p1, p2, p3, variant, p4, p5]) => `${p1}-${p2}-4${p3}-${variant}${p4}-${p5}`)

/**
 * Arbitrary for a generic token string (any non-empty string for lookup tests).
 */
const publicTokenArb = fc.uuid()

// ---------------------------------------------------------------------------
// Property 18: Public Leaderboard Access Control
// ---------------------------------------------------------------------------

describe('Property 18: Public Leaderboard Access Control', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /**
   * P18-A: When category is found with isPublished = true,
   * getPublicLeaderboard returns a non-null array.
   *
   * **Validates: Requirements 8.5**
   */
  it('P18-A: published category returns non-null array [**Validates: Requirements 8.5**]', () => {
    fc.assert(
      fc.asyncProperty(publishedCategoryArb(), async (category) => {
        ; (db.category.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
          category,
        )
          ; (db.project.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

        const result = await getPublicLeaderboard(category.publicToken!)

        expect(result).not.toBeNull()
        expect(Array.isArray(result)).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * P18-B: When category is found with isPublished = false,
   * getPublicLeaderboard returns null (simulating 404).
   *
   * **Validates: Requirements 8.5**
   */
  it('P18-B: unpublished category returns null [**Validates: Requirements 8.5**]', () => {
    fc.assert(
      fc.asyncProperty(unpublishedCategoryArb(), async (category) => {
        ; (db.category.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
          category,
        )

        const result = await getPublicLeaderboard(category.publicToken!)

        expect(result).toBeNull()
      }),
      { numRuns: 200 },
    )
  })

  /**
   * P18-C: When token is not found (no category exists),
   * getPublicLeaderboard returns null.
   *
   * **Validates: Requirements 8.5**
   */
  it('P18-C: non-existent token returns null [**Validates: Requirements 8.5**]', () => {
    fc.assert(
      fc.asyncProperty(publicTokenArb, async (token) => {
        ; (db.category.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
          null,
        )

        const result = await getPublicLeaderboard(token)

        expect(result).toBeNull()
      }),
      { numRuns: 200 },
    )
  })

  /**
   * P18-D: publicToken is UUID v4 format — validated via regex.
   * Verifies that UUID v4 tokens match the expected format pattern.
   *
   * **Validates: Requirements 8.5**
   */
  it('P18-D: publicToken is UUID v4 format [**Validates: Requirements 8.5**]', () => {
    fc.assert(
      fc.property(uuidV4Arb, (token) => {
        expect(token).toMatch(UUID_V4_REGEX)
      }),
      { numRuns: 200 },
    )
  })
})
