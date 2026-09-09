/**
 * Property-Based Tests: Property 7 — CSV Bulk Import Partial Success
 *
 * **Validates: Requirements 3.4, 3.5**
 *
 * Property 7 (from design.md):
 *   For any CSV file containing a mix of valid and invalid rows, the system
 *   SHALL import all valid rows, reject all invalid rows, and report the exact
 *   row numbers (1-indexed from header) of each invalid row along with the
 *   reason for rejection.
 *
 * Row numbering convention:
 *   - Header row  = row 1
 *   - First data row = row 2
 *   - N-th data row  = row N+1
 *
 * The Prisma db client is mocked so no real database calls are made.
 * `db.project.findFirst` always returns null (no pre-existing duplicates).
 * `db.project.create` always resolves successfully.
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
import { bulkImportFromCsv } from '@/lib/services/submission.service'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a CSV string from an array of row objects.
 * The header is always: url,participant_name,team_name
 *
 * Fields are RFC 4180 quoted: any field containing a comma, double-quote,
 * or newline is wrapped in double quotes, with internal quotes doubled.
 */
function buildCsv(rows: { url: string; participant_name: string; team_name?: string }[]): string {
  const header = 'url,participant_name,team_name'
  // RFC 4180: wrap in quotes if field contains comma, quote, or newline;
  // escape embedded quotes by doubling them.
  const quoteField = (f: string): string => {
    if (f.includes(',') || f.includes('"') || f.includes('\n') || f.includes('\r')) {
      return `"${f.replace(/"/g, '""')}"`
    }
    return f
  }
  const dataRows = rows.map((r) => {
    const teamName = r.team_name ?? ''
    return [quoteField(r.url), quoteField(r.participant_name), quoteField(teamName)].join(',')
  })
  return [header, ...dataRows].join('\n')
}

/** A synthetic Project record returned by db.project.create */
const fakeProjRecord = {
  id: 'proj_abc123',
  categoryId: 'cat_test',
  url: 'https://partyrock.aws/app/test',
  participantName: 'Test',
  teamName: null,
  crawlStatus: 'PENDING' as const,
  scoreStatus: 'PENDING' as const,
  crawlError: null,
  finalScore: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

// ---------------------------------------------------------------------------
// Setup — reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  // No pre-existing duplicates by default
  vi.mocked(db.project.findFirst).mockResolvedValue(null as never)
  // create always succeeds
  vi.mocked(db.project.create).mockResolvedValue(fakeProjRecord as never)
})

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates a valid PartyRock URL (exactly on the partyrock.aws domain).
 * Includes a random path segment to produce distinct URLs.
 */
const validUrlArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z][a-z0-9\-]{2,18}$/)
  .map((slug) => `https://partyrock.aws/app/${slug}`)

/**
 * Generates a non-empty participant name (1–100 printable chars, trimmed).
 * No character exclusions needed — buildCsv handles RFC 4180 quoting.
 */
const validNameArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 100 })
  .filter((s) => s.trim().length > 0 && !s.includes('\n') && !s.includes('\r'))

/**
 * Generates an optional team name: null or a short non-empty string.
 */
const teamNameArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc
    .string({ minLength: 1, maxLength: 50 })
    .filter((s) => s.trim().length > 0 && !s.includes('\n') && !s.includes('\r')),
)

/**
 * A valid CSV row: valid partyrock.aws URL + valid participant name.
 */
const validRowArb: fc.Arbitrary<{ url: string; participant_name: string; team_name?: string }> =
  fc.record({
    url: validUrlArb,
    participant_name: validNameArb,
    team_name: teamNameArb,
  })

/**
 * An invalid CSV row: either bad URL or empty participant name.
 * Produces rows that CsvRowRawSchema.safeParse will reject.
 * All string values exclude newlines/carriage-returns to keep CSV parsing stable
 * (buildCsv handles quotes via RFC 4180 escaping).
 */
const invalidRowArb: fc.Arbitrary<{
  url: string
  participant_name: string
  team_name?: string
  _invalidReason: 'bad_url' | 'empty_name'
}> = fc.oneof(
  // Bad URL (unparseable, or a non-http(s) scheme — any hostname is otherwise valid)
  fc
    .oneof(
      fc.constantFrom(
        'not-a-url-at-all',
        'ftp://example.com/app',
        '//example.com/app',
        'http://',
        '',
      ),
      fc
        .string({ minLength: 5, maxLength: 60 })
        .filter((s) => {
          if (s.includes('\n') || s.includes('\r')) return false
          try {
            const u = new URL(s)
            return u.protocol !== 'http:' && u.protocol !== 'https:'
          } catch {
            return true // unparseable => invalid
          }
        }),
    )
    .map((badUrl) => ({
      url: badUrl,
      participant_name: 'Valid Name',
      team_name: undefined,
      _invalidReason: 'bad_url' as const,
    })),
  // Empty participant name
  fc.constant({
    url: 'https://partyrock.aws/app/someapp',
    participant_name: '',
    team_name: undefined,
    _invalidReason: 'empty_name' as const,
  }),
)

// ---------------------------------------------------------------------------
// Property 7 — Property-Based Tests
// ---------------------------------------------------------------------------

describe('Property 7: CSV Bulk Import Partial Success', () => {
  /**
   * P7-A (core property): For any mix of valid and invalid rows, the number
   * of imported entries equals the count of valid rows, and the number of
   * error entries equals the count of invalid rows.
   *
   * **Validates: Requirements 3.4, 3.5**
   */
  it('P7-A — result.imported equals valid row count, result.errors.length equals invalid row count [**Validates: Requirements 3.4, 3.5**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(
          // `_invalidReason: undefined` keeps both union branches structurally
          // compatible so the `_invalidReason` rest-destructure below typechecks.
          validRowArb.map((r) => ({ ...r, _valid: true as const, _invalidReason: undefined })),
          invalidRowArb.map((r) => ({ ...r, _valid: false as const })),
        ), { minLength: 1, maxLength: 15 }),
        async (rows) => {
          vi.clearAllMocks()
          vi.mocked(db.project.findFirst).mockResolvedValue(null as never)
          vi.mocked(db.project.create).mockResolvedValue(fakeProjRecord as never)

          const validCount = rows.filter((r) => r._valid).length
          const invalidCount = rows.filter((r) => !r._valid).length

          const csvRows = rows.map(({ _valid: _v, _invalidReason: _ir, ...rest }) => rest as {
            url: string
            participant_name: string
            team_name?: string
          })
          const csv = buildCsv(csvRows)
          const categoryId = 'cat_test_property'

          const result = await bulkImportFromCsv(csv, categoryId)

          expect(result.imported).toBe(validCount)
          expect(result.errors.length).toBe(invalidCount)
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P7-B (row number correctness): Every error entry must carry a `row`
   * number ≥ 2 (data rows start at row 2 after the header), and must
   * correspond exactly to the 1-indexed position of the invalid row in
   * the original data (header = row 1, first data row = row 2).
   *
   * **Validates: Requirements 3.4, 3.5**
   */
  it('P7-B — each error.row is ≥ 2 and maps to the correct 1-indexed data position [**Validates: Requirements 3.4, 3.5**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(
          // `_invalidReason: undefined` keeps both union branches structurally
          // compatible so the `_invalidReason` rest-destructure below typechecks.
          validRowArb.map((r) => ({ ...r, _valid: true as const, _invalidReason: undefined })),
          invalidRowArb.map((r) => ({ ...r, _valid: false as const })),
        ), { minLength: 1, maxLength: 15 }),
        async (rows) => {
          vi.clearAllMocks()
          vi.mocked(db.project.findFirst).mockResolvedValue(null as never)
          vi.mocked(db.project.create).mockResolvedValue(fakeProjRecord as never)

          // Build the expected error row numbers (1-indexed: header = row 1, data starts at row 2)
          const expectedErrorRows = rows
            .map((r, i) => ({ isValid: r._valid, rowNumber: i + 2 }))
            .filter((x) => !x.isValid)
            .map((x) => x.rowNumber)

          const csvRows = rows.map(({ _valid: _v, _invalidReason: _ir, ...rest }) => rest as {
            url: string
            participant_name: string
            team_name?: string
          })
          const csv = buildCsv(csvRows)

          const result = await bulkImportFromCsv(csv, 'cat_test_rows')

          // Every error row number must be ≥ 2
          for (const e of result.errors) {
            expect(e.row).toBeGreaterThanOrEqual(2)
          }

          // The set of reported error row numbers must match exactly
          const reportedRows = result.errors.map((e) => e.row).sort((a, b) => a - b)
          expect(reportedRows).toEqual(expectedErrorRows.sort((a, b) => a - b))
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P7-C (non-empty message): Every error entry must carry a non-empty
   * message string explaining the reason for rejection.
   *
   * **Validates: Requirements 3.4, 3.5**
   */
  it('P7-C — each error entry has a non-empty message string [**Validates: Requirements 3.4, 3.5**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          invalidRowArb.map((r) => ({ ...r, _valid: false as const })),
          { minLength: 1, maxLength: 10 },
        ),
        async (rows) => {
          vi.clearAllMocks()
          vi.mocked(db.project.findFirst).mockResolvedValue(null as never)
          vi.mocked(db.project.create).mockResolvedValue(fakeProjRecord as never)

          const csvRows = rows.map(({ _valid: _v, _invalidReason: _ir, ...rest }) => rest as {
            url: string
            participant_name: string
            team_name?: string
          })
          const csv = buildCsv(csvRows)

          const result = await bulkImportFromCsv(csv, 'cat_test_msg')

          expect(result.errors.length).toBe(rows.length)
          for (const e of result.errors) {
            expect(typeof e.message).toBe('string')
            expect(e.message.trim().length).toBeGreaterThan(0)
          }
        },
      ),
      { numRuns: 150 },
    )
  })

  /**
   * P7-D (all-valid CSV): When every row is valid, imported equals the total
   * row count and errors is empty.
   *
   * **Validates: Requirements 3.4**
   */
  it('P7-D — all-valid CSV imports every row with zero errors [**Validates: Requirements 3.4**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(validRowArb, { minLength: 1, maxLength: 15 }),
        async (rows) => {
          vi.clearAllMocks()
          vi.mocked(db.project.findFirst).mockResolvedValue(null as never)
          vi.mocked(db.project.create).mockResolvedValue(fakeProjRecord as never)

          const csv = buildCsv(rows)
          const result = await bulkImportFromCsv(csv, 'cat_all_valid')

          expect(result.imported).toBe(rows.length)
          expect(result.errors).toHaveLength(0)
        },
      ),
      { numRuns: 150 },
    )
  })

  /**
   * P7-E (all-invalid CSV): When every row is invalid, imported is zero and
   * error count equals the total row count.
   *
   * **Validates: Requirements 3.5**
   */
  it('P7-E — all-invalid CSV imports zero rows and reports all rows as errors [**Validates: Requirements 3.5**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(invalidRowArb, { minLength: 1, maxLength: 10 }),
        async (rows) => {
          vi.clearAllMocks()
          vi.mocked(db.project.findFirst).mockResolvedValue(null as never)
          vi.mocked(db.project.create).mockResolvedValue(fakeProjRecord as never)

          const csvRows = rows.map(({ _invalidReason: _ir, ...rest }) => rest as {
            url: string
            participant_name: string
            team_name?: string
          })
          const csv = buildCsv(csvRows)

          const result = await bulkImportFromCsv(csv, 'cat_all_invalid')

          expect(result.imported).toBe(0)
          expect(result.errors.length).toBe(rows.length)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Deterministic edge-case unit tests (complement the property tests)
// ---------------------------------------------------------------------------

describe('Property 7: CSV Bulk Import Partial Success — deterministic edge cases', () => {
  const CATEGORY_ID = 'cat_det_001'

  it('single valid row: imported=1, errors=[]', async () => {
    const csv = buildCsv([
      { url: 'https://partyrock.aws/app/hello', participant_name: 'Alice' },
    ])
    const result = await bulkImportFromCsv(csv, CATEGORY_ID)
    expect(result.imported).toBe(1)
    expect(result.errors).toHaveLength(0)
  })

  it('single invalid row (bad URL): imported=0, errors has row=2', async () => {
    const csv = buildCsv([
      { url: 'not-a-valid-url', participant_name: 'Alice' },
    ])
    const result = await bulkImportFromCsv(csv, CATEGORY_ID)
    expect(result.imported).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].row).toBe(2)
    expect(result.errors[0].message).toBeTruthy()
  })

  it('single invalid row (empty name): imported=0, errors has row=2', async () => {
    const csv = buildCsv([
      { url: 'https://partyrock.aws/app/test', participant_name: '' },
    ])
    const result = await bulkImportFromCsv(csv, CATEGORY_ID)
    expect(result.imported).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].row).toBe(2)
  })

  it('mixed: valid-invalid-valid-invalid — row numbers are 3 and 5', async () => {
    const csv = buildCsv([
      { url: 'https://partyrock.aws/app/one', participant_name: 'Alice' },  // row 2 — valid
      { url: 'not-a-valid-url', participant_name: 'Bob' },    // row 3 — invalid
      { url: 'https://partyrock.aws/app/three', participant_name: 'Carol' },  // row 4 — valid
      { url: 'https://partyrock.aws/app/four', participant_name: '' },       // row 5 — invalid (empty name)
    ])
    const result = await bulkImportFromCsv(csv, CATEGORY_ID)
    expect(result.imported).toBe(2)
    expect(result.errors).toHaveLength(2)
    expect(result.errors.map((e) => e.row).sort((a, b) => a - b)).toEqual([3, 5])
  })

  it('all 3 rows valid: imported=3, errors=[]', async () => {
    const csv = buildCsv([
      { url: 'https://partyrock.aws/app/a', participant_name: 'Alice' },
      { url: 'https://partyrock.aws/app/b', participant_name: 'Bob' },
      { url: 'https://partyrock.aws/app/c', participant_name: 'Carol' },
    ])
    const result = await bulkImportFromCsv(csv, CATEGORY_ID)
    expect(result.imported).toBe(3)
    expect(result.errors).toHaveLength(0)
  })

  it('all 3 rows invalid: imported=0, errors has rows [2,3,4]', async () => {
    const csv = buildCsv([
      { url: 'not-a-valid-url', participant_name: 'Alice' },
      { url: 'https://partyrock.aws/app/b', participant_name: '' },
      { url: 'not-a-url', participant_name: 'Carol' },
    ])
    const result = await bulkImportFromCsv(csv, CATEGORY_ID)
    expect(result.imported).toBe(0)
    expect(result.errors).toHaveLength(3)
    expect(result.errors.map((e) => e.row).sort((a, b) => a - b)).toEqual([2, 3, 4])
  })

  it('empty CSV (header only): imported=0, errors=[]', async () => {
    const csv = 'url,participant_name,team_name'
    const result = await bulkImportFromCsv(csv, CATEGORY_ID)
    expect(result.imported).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it('valid row with a team name is imported successfully', async () => {
    const csv = buildCsv([
      { url: 'https://partyrock.aws/app/team', participant_name: 'Dave', team_name: 'Team Alpha' },
    ])
    const result = await bulkImportFromCsv(csv, CATEGORY_ID)
    expect(result.imported).toBe(1)
    expect(result.errors).toHaveLength(0)
  })

  it('error messages are non-empty strings for every rejection type', async () => {
    const csv = buildCsv([
      { url: 'not-a-valid-url', participant_name: 'X' },   // bad URL
      { url: 'https://partyrock.aws/app/x', participant_name: '' },    // empty name
    ])
    const result = await bulkImportFromCsv(csv, CATEGORY_ID)
    expect(result.errors).toHaveLength(2)
    for (const e of result.errors) {
      expect(e.message.trim().length).toBeGreaterThan(0)
    }
  })
})
