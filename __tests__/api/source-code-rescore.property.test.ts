/**
 * Property-based tests for Property 24: Source Code Update Triggers Rescore
 *
 * Property 24 states:
 *   _For any_ project whose `sourceCode` is successfully updated through the
 *   admin endpoint, the project's `scoreStatus` SHALL be set to `PENDING` and
 *   AI scoring SHALL be triggered. A request that fails validation or
 *   authorization SHALL leave both `sourceCode` and `scoreStatus` unchanged.
 *
 * ---------------------------------------------------------------------------
 * What this file adds over `submission-source-code-route.test.ts`
 * ---------------------------------------------------------------------------
 * The unit test pins one admin request, three blank inputs and one example per
 * rejection path. This file proves the two halves of Property 24 hold across
 * the whole input space the route actually sees:
 *
 *   1. **Write and trigger are one decision.** Every accepted request writes
 *      `scoreStatus: 'PENDING'` *and* calls `triggerScoring` exactly once —
 *      whatever the markup looks like, however long it is, blank or not. A
 *      route that stored the markup but forgot the status, or set the status
 *      but never dispatched, would leave an AI score that silently describes
 *      evidence nobody can see anymore.
 *
 *   2. **"Unchanged" is asserted as *no write at all*.** Rejections are checked
 *      by `db.project.update` never having been called, not by the status code.
 *      A status code says what the caller was told; only the absence of the
 *      call says what happened to the row. Those come apart exactly in the bug
 *      this property exists to rule out — a partial update followed by an error
 *      response.
 *
 * P24-e is the subtle one: when the write itself rejects, the trigger must not
 * fire. Re-scoring on top of a failed write would grade the *old* evidence and
 * stamp a fresh timestamp on it, while the admin — who saw an error — assumes
 * nothing happened. The mismatch is invisible from the outside.
 *
 * Everything below the route is mocked. The route's contract is authorization,
 * validation, normalisation and dispatch, so that is what is asserted; the
 * scorer and the database have their own tests.
 *
 * **Validates: Requirements 5.2, 5.3, 5.4**
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import * as fc from 'fast-check'
import type { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mock modules BEFORE importing the route under test
// ---------------------------------------------------------------------------

vi.mock('@/lib/auth/config', () => ({
  auth: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    project: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock('@/lib/services/scorer.service', () => ({
  ScorerService: { triggerScoring: vi.fn().mockResolvedValue(undefined) },
}))

import { PATCH } from '@/app/api/submissions/[id]/route'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { ScorerService } from '@/lib/services/scorer.service'
import { MAX_SOURCE_CODE_LENGTH } from '@/lib/validators/schemas'

const mockAuth = vi.mocked(auth)
const mockProjectFindUnique = vi.mocked(db.project.findUnique)
const mockProjectUpdate = vi.mocked(db.project.update)
const mockTriggerScoring = vi.mocked(ScorerService.triggerScoring)

const PROJECT_ID = 'project-rescore-1'

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

/** The route only ever calls `request.json()`. */
function buildRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest
}

function buildContext(id: string = PROJECT_ID) {
  return { params: Promise.resolve({ id }) }
}

/**
 * The rate limiter inside the route is the real one: 10 requests per minute
 * keyed on `session.user.id`. A property test fires hundreds of requests, so
 * every single one signs in as a fresh user id. Reusing one id would start
 * returning 429 from the eleventh run onwards and the suite would go red for a
 * reason that has nothing to do with Property 24 — while *looking* like a
 * genuine "no write happened" failure.
 *
 * The limiter's LRU only tracks 500 tokens, but each token here carries exactly
 * one request, so eviction is harmless.
 */
let userCounter = 0
function nextUserId(): string {
  userCounter += 1
  return `user-${userCounter}`
}

/** Sessions the route must treat as an admin. */
function signInAsAdmin() {
  mockAuth.mockResolvedValue({
    user: { id: nextUserId(), role: 'ADMIN' },
  } as never)
}

/**
 * Session shapes the route must reject. `Role` in the schema is `ADMIN | JURY`,
 * so `JURY` is the only other real role; the missing-session and missing-role
 * shapes cover an expired cookie and a token minted before `role` existed.
 */
type UnauthorizedSession = 'no-session' | 'undefined-session' | 'jury' | 'role-missing'

const unauthorizedSessionArbitrary: fc.Arbitrary<UnauthorizedSession> =
  fc.constantFrom('no-session', 'undefined-session', 'jury', 'role-missing')

function signInAs(kind: UnauthorizedSession) {
  switch (kind) {
    case 'no-session':
      mockAuth.mockResolvedValue(null as never)
      return
    case 'undefined-session':
      mockAuth.mockResolvedValue(undefined as never)
      return
    case 'jury':
      mockAuth.mockResolvedValue({
        user: { id: nextUserId(), role: 'JURY' },
      } as never)
      return
    case 'role-missing':
      mockAuth.mockResolvedValue({ user: { id: nextUserId() } } as never)
      return
  }
}

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

/**
 * Re-arm every mock for one property run.
 *
 * The implementations are re-installed on each run rather than once in
 * `beforeEach`, so a run's setup is self-contained and independent of the order
 * fast-check happens to shrink in.
 */
function resetMocks(options: { projectExists?: boolean } = {}) {
  const { projectExists = true } = options

  vi.clearAllMocks()
  mockTriggerScoring.mockResolvedValue(undefined)
  mockProjectFindUnique.mockResolvedValue(
    (projectExists ? { id: PROJECT_ID } : null) as never,
  )
  // Echo back whatever was written, in the `select` shape the route asks for.
  mockProjectUpdate.mockImplementation((async (args: unknown) => {
    const data = (args as { data: { sourceCode: string | null; scoreStatus: string } }).data
    return {
      id: PROJECT_ID,
      sourceCode: data.sourceCode,
      scoreStatus: data.scoreStatus,
    }
  }) as never)
}

/** The `data` payload of the single `db.project.update` call. */
function updateData(): { sourceCode: string | null; scoreStatus: string } {
  return mockProjectUpdate.mock.calls[0][0].data as {
    sourceCode: string | null
    scoreStatus: string
  }
}

/**
 * The core assertion of every rejection sub-property: the row was not touched.
 *
 * Checked as "update was never called" rather than "the response was 4xx",
 * because those two only disagree in the failure mode worth catching.
 */
function expectNothingHappened() {
  expect(mockProjectUpdate).not.toHaveBeenCalled()
  expect(mockTriggerScoring).not.toHaveBeenCalled()
}

// ---------------------------------------------------------------------------
// Arbitraries — valid bodies
// ---------------------------------------------------------------------------

/** Simple, varied HTML documents. Structural depth is Property 22's job. */
const markupArbitrary: fc.Arbitrary<string> = fc
  .record({
    lang: fc.constantFrom('', ' lang="id"', ' lang="en-US"'),
    title: fc.constantFrom('Portofolio', 'Landing Page', 'Tugas Akhir', ''),
    body: fc.array(
      fc.constantFrom(
        '<h1>Judul</h1>',
        '<main><p>Isi halaman</p></main>',
        '<img src="a.png" alt="Tangkapan layar">',
        '<nav><a href="#main">Skip to main content</a></nav>',
        '<form><label for="n">Nama</label><input id="n"></form>',
        '<footer>2024</footer>',
        '<section aria-label="ringkasan">teks</section>',
      ),
      { maxLength: 6 },
    ),
  })
  .map(({ lang, title, body }) => {
    const head = title === '' ? '' : `<title>${title}</title>`
    return (
      `<!DOCTYPE html><html${lang}><head>${head}</head>` +
      `<body>${body.join('')}</body></html>`
    )
  })

/**
 * Short values that all survive normalisation unchanged: markup, plain prose,
 * RTL and astral-plane unicode, and values with padding that must be preserved
 * because the *content* is not blank.
 */
const textSourceCodeArbitrary: fc.Arbitrary<string> = fc.oneof(
  markupArbitrary,
  fc.constantFrom(
    'teks biasa tanpa tag',
    'Widget: Chatbot\nPrompt: hello',
    'א<div>ב</div>ג',
    '𝕳𝖊𝖑𝖑𝖔 <p>perayaan 🎉</p>',
    '<',
    'x',
    '  <p>berspasi di tepi</p>  ',
    '\n<div>diawali newline</div>\n',
    '<script>alert("xss")</script>',
    '{"not":"html"}',
  ),
  fc.string({ minLength: 1, maxLength: 400 }).filter((s) => s.trim().length > 0),
)

/**
 * Values the schema normalises to `null`. `''` is what an emptied textarea
 * actually submits; the whitespace forms cover the `trim()` semantics
 * (including NBSP, which JavaScript's `trim` does remove).
 */
const blankSourceCodeArbitrary: fc.Arbitrary<string | null> = fc.constantFrom(
  null,
  '',
  ' ',
  '   ',
  '\n',
  '\t',
  '\r\n',
  '\t\r\n ',
  '\n\n\n',
  '  \u00a0  ',
)

/**
 * Repeating units used to build a string of an exact code-unit length. `🎉` is
 * two code units, so filling can split it — deliberately, since `.max()` counts
 * code units and a lone surrogate is a legitimate thing for the route to be
 * handed.
 */
const paddingUnitArbitrary: fc.Arbitrary<string> = fc.constantFrom(
  'x',
  'ab',
  '<p>a</p>',
  '<!-- c -->',
  'é',
  '🎉',
  '\n<span>s</span>',
  ' a ',
)

/** Exactly `length` code units, built by repeating `unit`. */
function fillTo(unit: string, length: number): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
}

/** Long-but-accepted bodies, including the boundary value itself. */
const longSourceCodeArbitrary: fc.Arbitrary<string> = fc
  .record({
    unit: paddingUnitArbitrary,
    length: fc.constantFrom(
      1_000,
      20_000,
      MAX_SOURCE_CODE_LENGTH - 1,
      MAX_SOURCE_CODE_LENGTH,
    ),
  })
  .map(({ unit, length }) => fillTo(unit, length))

/**
 * The full space of bodies the route must accept. Long values are weighted
 * down: each one allocates ~100 KB and the axis they vary (length) is far
 * narrower than the axis the short ones vary (content).
 */
const validSourceCodeArbitrary: fc.Arbitrary<string | null> = fc.oneof(
  { arbitrary: textSourceCodeArbitrary, weight: 5 },
  { arbitrary: blankSourceCodeArbitrary, weight: 3 },
  { arbitrary: longSourceCodeArbitrary, weight: 2 },
)

/** What the schema's transform is expected to persist for a given input. */
function normalise(value: string | null): string | null {
  if (value == null) return null
  return value.trim().length > 0 ? value : null
}

// ---------------------------------------------------------------------------
// Arbitraries — invalid bodies
// ---------------------------------------------------------------------------

/**
 * Bodies that must fail `SourceCodeUpdateSchema`. Three failure modes, all of
 * which have to be caught *before* the write:
 *
 *   - over the length cap (Requirement 5.3),
 *   - `sourceCode` present but not a string,
 *   - `sourceCode` absent — the field is `.nullable()` but not `.optional()`,
 *     so `undefined` is a validation error rather than "leave it alone".
 */
const invalidBodyArbitrary: fc.Arbitrary<unknown> = fc.oneof(
  // Over-length, by a varying amount and with varying content.
  fc
    .record({
      unit: paddingUnitArbitrary,
      excess: fc.constantFrom(1, 2, 17, 1_000, 60_000),
    })
    .map(({ unit, excess }) => ({
      sourceCode: fillTo(unit, MAX_SOURCE_CODE_LENGTH + excess),
    })),
  // Wrong type.
  fc
    .oneof(
      fc.integer(),
      fc.double({ noNaN: true }),
      fc.boolean(),
      fc.constantFrom<unknown>(
        {},
        { nested: '<html></html>' },
        [],
        ['<html></html>'],
      ),
    )
    .map((sourceCode) => ({ sourceCode })),
  // Missing field, with and without unrelated keys alongside it.
  fc.constantFrom<unknown>(
    {},
    { sourceCode: undefined },
    { source_code: '<html></html>' },
    { scoreStatus: 'SCORED' },
  ),
)

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * `handleApiError` logs every 500 it produces, and P24-e produces hundreds of
 * them on purpose. Silenced for this file only.
 */
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => { })
})

afterAll(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  resetMocks()
  signInAsAdmin()
})

// ---------------------------------------------------------------------------

describe('Property 24: Source Code Update Triggers Rescore', () => {
  // -------------------------------------------------------------------------
  // P24-a: every accepted request marks the score stale and dispatches
  // -------------------------------------------------------------------------

  it('P24-a — an accepted admin update SHALL write scoreStatus = PENDING and trigger scoring exactly once, for any valid sourceCode [**Validates: Requirements 5.2, 5.3, 5.4**]', async () => {
    await fc.assert(
      fc.asyncProperty(validSourceCodeArbitrary, async (sourceCode) => {
        resetMocks()
        signInAsAdmin()

        const response = await PATCH(
          buildRequest({ sourceCode }),
          buildContext(),
        )

        // Accepted — not a 429 from the shared limiter, not a 500.
        expect(response.status).toBe(200)

        // One write, carrying both halves of the state change together.
        expect(mockProjectUpdate).toHaveBeenCalledTimes(1)
        expect(mockProjectUpdate.mock.calls[0][0]).toMatchObject({
          where: { id: PROJECT_ID },
        })
        expect(updateData().scoreStatus).toBe('PENDING')

        // The persisted value is the normalised one: blank in, `null` out;
        // anything else verbatim, internal and edge whitespace intact.
        expect(updateData().sourceCode).toBe(normalise(sourceCode))

        // ...and re-scoring was dispatched for this project, once.
        expect(mockTriggerScoring).toHaveBeenCalledExactlyOnceWith(PROJECT_ID)
      }),
      { numRuns: 200 },
    )
  })

  it('P24-a — the response mirrors what was written, so the detail page never shows a stale status [**Validates: Requirements 5.2, 5.4**]', async () => {
    await fc.assert(
      fc.asyncProperty(validSourceCodeArbitrary, async (sourceCode) => {
        resetMocks()
        signInAsAdmin()

        const response = await PATCH(
          buildRequest({ sourceCode }),
          buildContext(),
        )
        const json = await response.json()

        expect(json).toEqual({
          id: PROJECT_ID,
          sourceCode: normalise(sourceCode),
          scoreStatus: 'PENDING',
        })
      }),
      { numRuns: 100 },
    )
  })

  // -------------------------------------------------------------------------
  // P24-b: an unauthorized caller changes nothing
  // -------------------------------------------------------------------------

  it('P24-b — a non-admin caller SHALL cause no write and no trigger, for any valid body [**Validates: Requirements 5.2**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        validSourceCodeArbitrary,
        unauthorizedSessionArbitrary,
        async (sourceCode, session) => {
          resetMocks()
          signInAs(session)

          const response = await PATCH(
            buildRequest({ sourceCode }),
            buildContext(),
          )
          const json = await response.json()

          expect(response.status).toBe(403)
          expect(json.code).toBe('FORBIDDEN')

          // The point of the sub-property: `sourceCode` and `scoreStatus` are
          // untouched because nothing was written, not because the write wrote
          // the same values back.
          expectNothingHappened()
        },
      ),
      { numRuns: 200 },
    )
  })

  it('P24-b — authorization is checked before the row is even read [**Validates: Requirements 5.2**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(validSourceCodeArbitrary, invalidBodyArbitrary),
        unauthorizedSessionArbitrary,
        async (body, session) => {
          resetMocks()
          signInAs(session)

          const response = await PATCH(buildRequest(body), buildContext())

          // A non-admin cannot probe which project ids exist, and an invalid
          // body from a non-admin is still a 403 rather than a 400.
          expect(response.status).toBe(403)
          expect(mockProjectFindUnique).not.toHaveBeenCalled()
          expectNothingHappened()
        },
      ),
      { numRuns: 150 },
    )
  })

  // -------------------------------------------------------------------------
  // P24-c: an invalid body changes nothing
  // -------------------------------------------------------------------------

  it('P24-c — an invalid body SHALL cause no write and no trigger [**Validates: Requirements 5.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(invalidBodyArbitrary, async (body) => {
        resetMocks()
        signInAsAdmin()

        const response = await PATCH(buildRequest(body), buildContext())
        const json = await response.json()

        expect(response.status).toBe(400)
        expect(json.code).toBe('VALIDATION_ERROR')
        expectNothingHappened()
      }),
      { numRuns: 200 },
    )
  })

  // -------------------------------------------------------------------------
  // P24-d: an unknown project changes nothing
  // -------------------------------------------------------------------------

  it('P24-d — an unknown project SHALL cause no write and no trigger, for any valid body [**Validates: Requirements 5.2, 5.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        validSourceCodeArbitrary,
        fc.constantFrom(
          'does-not-exist',
          'cuid-shaped-but-absent',
          '00000000-0000-0000-0000-000000000000',
        ),
        async (sourceCode, missingId) => {
          resetMocks({ projectExists: false })
          signInAsAdmin()

          const response = await PATCH(
            buildRequest({ sourceCode }),
            buildContext(missingId),
          )
          const json = await response.json()

          expect(response.status).toBe(404)
          expect(json.code).toBe('NOT_FOUND')
          expectNothingHappened()
        },
      ),
      { numRuns: 150 },
    )
  })

  // -------------------------------------------------------------------------
  // P24-e: a failed write never dispatches a rescore
  // -------------------------------------------------------------------------

  it('P24-e — when the write itself fails, scoring SHALL NOT be triggered [**Validates: Requirements 5.4**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        validSourceCodeArbitrary,
        fc.constantFrom(
          'Timed out fetching a new connection from the connection pool',
          'Unique constraint failed',
          'Transaction already closed',
          'Connection terminated unexpectedly',
        ),
        async (sourceCode, dbFailure) => {
          resetMocks()
          signInAsAdmin()
          mockProjectUpdate.mockRejectedValueOnce(new Error(dbFailure) as never)

          const response = await PATCH(
            buildRequest({ sourceCode }),
            buildContext(),
          )
          const json = await response.json()

          // The write was attempted and it failed.
          expect(mockProjectUpdate).toHaveBeenCalledTimes(1)
          expect(response.status).toBe(500)
          expect(json.code).toBe('INTERNAL_ERROR')

          // Nothing landed in the column, so there is no new evidence to
          // score. Dispatching here would re-grade the *old* markup and stamp
          // a fresh score on it while the admin is looking at an error.
          expect(mockTriggerScoring).not.toHaveBeenCalled()
        },
      ),
      { numRuns: 150 },
    )
  })

  // -------------------------------------------------------------------------
  // The length boundary, as a property over content rather than one example
  // -------------------------------------------------------------------------

  it('P24-f — a body of exactly MAX_SOURCE_CODE_LENGTH SHALL be accepted and one character more SHALL be rejected, whatever the content [**Validates: Requirements 5.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(paddingUnitArbitrary, async (unit) => {
        const atLimit = fillTo(unit, MAX_SOURCE_CODE_LENGTH)
        const overLimit = fillTo(unit, MAX_SOURCE_CODE_LENGTH + 1)
        expect(atLimit).toHaveLength(MAX_SOURCE_CODE_LENGTH)
        expect(overLimit).toHaveLength(MAX_SOURCE_CODE_LENGTH + 1)

        // Exactly at the limit: stored whole, not truncated, and re-scored.
        resetMocks()
        signInAsAdmin()
        const accepted = await PATCH(
          buildRequest({ sourceCode: atLimit }),
          buildContext(),
        )

        expect(accepted.status).toBe(200)
        expect(updateData().sourceCode).toBe(atLimit)
        expect(updateData().scoreStatus).toBe('PENDING')
        expect(mockTriggerScoring).toHaveBeenCalledExactlyOnceWith(PROJECT_ID)

        // One character past it: rejected before the write, so the value the
        // previous request stored survives.
        resetMocks()
        signInAsAdmin()
        const rejected = await PATCH(
          buildRequest({ sourceCode: overLimit }),
          buildContext(),
        )

        expect(rejected.status).toBe(400)
        expectNothingHappened()
      }),
      // Fewer runs than the other sub-properties: each run builds two ~100 KB
      // strings and the generated axis (the repeating unit) is small.
      { numRuns: 40 },
    )
  })
})
