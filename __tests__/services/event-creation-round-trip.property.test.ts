/**
 * Property-Based Tests: Property 2 — Event Creation Round Trip
 *
 * **Validates: Requirements 1.2**
 *
 * Property 2 (from design.md):
 *   For any valid event data object (name, optional description, optional dates),
 *   creating an event and then fetching it by its ID should return an object with
 *   equivalent field values.
 *
 * The Prisma db client is mocked so no real database calls are made.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'

// ---------------------------------------------------------------------------
// Mock the Prisma db client BEFORE importing the service under test.
// Each test configures what db.event.create and db.event.findUnique return.
// ---------------------------------------------------------------------------

vi.mock('@/lib/db', () => ({
  db: {
    event: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
    },
  },
}))

import { db } from '@/lib/db'
import { createEvent, getEventById } from '@/lib/services/event.service'
import type { EventInput } from '@/lib/validators/schemas'

// Typed references to the mocked functions
const mockCreate = vi.mocked(db.event.create)
const mockFindUnique = vi.mocked(db.event.findUnique)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a simulated DB record from EventInput — mirrors what Prisma would
 * return after a successful `create` call.
 */
function buildEventRecord(id: string, input: EventInput) {
  const toDate = (v: string | Date | null | undefined): Date | null => {
    if (v == null) return null
    return v instanceof Date ? v : new Date(v)
  }
  return {
    id,
    name: input.name,
    description: input.description ?? null,
    startDate: toDate(input.startDate),
    endDate: toDate(input.endDate),
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Valid event name: 1–255 non-empty printable characters. */
const eventNameArb = fc
  .string({ minLength: 1, maxLength: 255 })
  .filter((s) => s.trim().length > 0)

/** Optional description: null or a string up to 1000 chars. */
const descriptionArb: fc.Arbitrary<string | null | undefined> = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.string({ minLength: 0, maxLength: 1000 }),
)

/** Optional ISO-8601 datetime string, or null/undefined. */
const isoDatesArb: fc.Arbitrary<string | null | undefined> = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc
    .date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
    .filter((d) => !isNaN(d.getTime()))
    .map((d) => d.toISOString()),
)

/** Full EventInput arbitrary with all combinations of optional fields. */
const eventInputArb: fc.Arbitrary<EventInput> = fc
  .tuple(eventNameArb, descriptionArb, isoDatesArb, isoDatesArb)
  .map(([name, description, startDate, endDate]) => ({
    name,
    description,
    startDate,
    endDate,
  }))

/** Arbitrary for a CUID-like event ID. */
const eventIdArb = fc
  .stringMatching(/^[a-z0-9]{20,25}$/)
  .map((s) => `cl${s}`)

// ---------------------------------------------------------------------------
// Property 2: Event Creation Round Trip
// ---------------------------------------------------------------------------

describe('Property 2: Event Creation Round Trip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /**
   * P2-A (core round-trip): For any valid EventInput, calling createEvent
   * and then getEventById with the returned ID should yield an object with
   * the same name, description, startDate, and endDate.
   *
   * **Validates: Requirements 1.2**
   */
  it('P2-A — createEvent then getEventById returns equivalent field values [**Validates: Requirements 1.2**]', async () => {
    await fc.assert(
      fc.asyncProperty(eventInputArb, eventIdArb, async (input, id) => {
        const createdRecord = buildEventRecord(id, input)

        // Stub create to return the simulated DB record
        mockCreate.mockResolvedValueOnce(createdRecord as never)
        // Stub findUnique to return the same record (including categories)
        mockFindUnique.mockResolvedValueOnce({
          ...createdRecord,
          categories: [],
        } as never)

        const created = await createEvent(input)
        const fetched = await getEventById(created.id)

        // Fetched record must exist
        expect(fetched).not.toBeNull()

        // Name must match exactly
        expect(fetched!.name).toBe(created.name)

        // Description round-trip: undefined and null both normalise to null in Prisma
        const expectedDescription = input.description ?? null
        expect(fetched!.description).toBe(expectedDescription)

        // Date round-trip: compare by value (getTime) when non-null
        if (input.startDate != null) {
          expect(fetched!.startDate).not.toBeNull()
          expect(new Date(fetched!.startDate!).getTime()).toBe(
            new Date(input.startDate).getTime(),
          )
        } else {
          expect(fetched!.startDate).toBeNull()
        }

        if (input.endDate != null) {
          expect(fetched!.endDate).not.toBeNull()
          expect(new Date(fetched!.endDate!).getTime()).toBe(
            new Date(input.endDate).getTime(),
          )
        } else {
          expect(fetched!.endDate).toBeNull()
        }
      }),
      { numRuns: 200 },
    )
  })

  /**
   * P2-B (ID consistency): The ID returned by createEvent must be the same
   * as the ID used to fetch the event via getEventById.
   *
   * **Validates: Requirements 1.2**
   */
  it('P2-B — getEventById is called with the ID returned by createEvent [**Validates: Requirements 1.2**]', async () => {
    await fc.assert(
      fc.asyncProperty(eventInputArb, eventIdArb, async (input, id) => {
        const createdRecord = buildEventRecord(id, input)
        mockCreate.mockResolvedValueOnce(createdRecord as never)
        mockFindUnique.mockResolvedValueOnce({
          ...createdRecord,
          categories: [],
        } as never)

        const created = await createEvent(input)
        await getEventById(created.id)

        // findUnique must have been called with exactly the ID from create
        expect(mockFindUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: created.id } }),
        )
      }),
      { numRuns: 100 },
    )
  })

  /**
   * P2-C (null-return on missing ID): getEventById should return null when
   * Prisma findUnique resolves to null (event not found).
   *
   * **Validates: Requirements 1.2**
   */
  it('P2-C — getEventById returns null when the event does not exist [**Validates: Requirements 1.2**]', async () => {
    await fc.assert(
      fc.asyncProperty(eventIdArb, async (id) => {
        mockFindUnique.mockResolvedValueOnce(null as never)
        const result = await getEventById(id)
        expect(result).toBeNull()
      }),
      { numRuns: 50 },
    )
  })

  /**
   * P2-D (Zod validation): createEvent must invoke db.event.create with
   * the validated/coerced field values, not the raw input. In particular,
   * description undefined becomes null, and date strings become Date objects.
   *
   * **Validates: Requirements 1.2**
   */
  it('P2-D — createEvent passes Zod-validated data to db.event.create [**Validates: Requirements 1.2**]', async () => {
    await fc.assert(
      fc.asyncProperty(eventInputArb, eventIdArb, async (input, id) => {
        // Reset mock before each property iteration so call counts don't accumulate
        vi.clearAllMocks()

        const createdRecord = buildEventRecord(id, input)
        mockCreate.mockResolvedValueOnce(createdRecord as never)

        await createEvent(input)

        // db.event.create must have been called exactly once per iteration
        expect(mockCreate).toHaveBeenCalledOnce()
        const callArg = mockCreate.mock.calls[0][0] as {
          data: {
            name: string
            description: string | null
            startDate: Date | null | undefined
            endDate: Date | null | undefined
          }
        }

        // name is always present
        expect(callArg.data.name).toBe(input.name)

        // description must be coerced: undefined → null, string → string
        const expectedDesc = input.description ?? null
        expect(callArg.data.description).toBe(expectedDesc)

        // startDate when provided must be a Date object (coerced by toDate helper)
        if (input.startDate != null) {
          expect(callArg.data.startDate).toBeInstanceOf(Date)
        }
        if (input.endDate != null) {
          expect(callArg.data.endDate).toBeInstanceOf(Date)
        }
      }),
      { numRuns: 150 },
    )
  })
})

// ---------------------------------------------------------------------------
// Deterministic edge-case unit tests (complement the property tests)
// ---------------------------------------------------------------------------

describe('Property 2: Event Creation Round Trip — deterministic edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates and fetches event with only a name (no optional fields)', async () => {
    const input: EventInput = { name: 'Solo Name Event' }
    const record = buildEventRecord('cl_test_001', input)
    mockCreate.mockResolvedValueOnce(record as never)
    mockFindUnique.mockResolvedValueOnce({ ...record, categories: [] } as never)

    const created = await createEvent(input)
    const fetched = await getEventById(created.id)

    expect(fetched).not.toBeNull()
    expect(fetched!.name).toBe('Solo Name Event')
    expect(fetched!.description).toBeNull()
    expect(fetched!.startDate).toBeNull()
    expect(fetched!.endDate).toBeNull()
  })

  it('creates and fetches event with all optional fields populated', async () => {
    const input: EventInput = {
      name: 'Full Event',
      description: 'A detailed description',
      startDate: '2025-01-01T00:00:00.000Z',
      endDate: '2025-12-31T23:59:59.000Z',
    }
    const record = buildEventRecord('cl_test_002', input)
    mockCreate.mockResolvedValueOnce(record as never)
    mockFindUnique.mockResolvedValueOnce({ ...record, categories: [] } as never)

    const created = await createEvent(input)
    const fetched = await getEventById(created.id)

    expect(fetched!.name).toBe('Full Event')
    expect(fetched!.description).toBe('A detailed description')
    expect(new Date(fetched!.startDate!).toISOString()).toBe(
      '2025-01-01T00:00:00.000Z',
    )
    expect(new Date(fetched!.endDate!).toISOString()).toBe(
      '2025-12-31T23:59:59.000Z',
    )
  })

  it('name at maximum length (255 chars) round-trips correctly', async () => {
    const longName = 'A'.repeat(255)
    const input: EventInput = { name: longName }
    const record = buildEventRecord('cl_test_003', input)
    mockCreate.mockResolvedValueOnce(record as never)
    mockFindUnique.mockResolvedValueOnce({ ...record, categories: [] } as never)

    const created = await createEvent(input)
    const fetched = await getEventById(created.id)

    expect(fetched!.name).toBe(longName)
    expect(fetched!.name).toHaveLength(255)
  })

  it('description set to null round-trips as null', async () => {
    const input: EventInput = { name: 'Test', description: null }
    const record = buildEventRecord('cl_test_004', input)
    mockCreate.mockResolvedValueOnce(record as never)
    mockFindUnique.mockResolvedValueOnce({ ...record, categories: [] } as never)

    await createEvent(input)
    const fetched = await getEventById('cl_test_004')

    expect(fetched!.description).toBeNull()
  })

  it('getEventById returns null for an unknown ID', async () => {
    mockFindUnique.mockResolvedValueOnce(null as never)
    const result = await getEventById('non-existent-id')
    expect(result).toBeNull()
  })

  it('includes categories array when fetching by ID', async () => {
    const input: EventInput = { name: 'Event with Categories' }
    const record = buildEventRecord('cl_test_005', input)
    const categories = [{ id: 'cat1', name: 'Category A' }]
    mockCreate.mockResolvedValueOnce(record as never)
    mockFindUnique.mockResolvedValueOnce({ ...record, categories } as never)

    const created = await createEvent(input)
    const fetched = await getEventById(created.id) as typeof record & { categories: typeof categories }

    expect(fetched!.categories).toEqual(categories)
  })
})
