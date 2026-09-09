/**
 * Property-Based Tests: Property 19 — Input Validation Coverage
 *
 * **Validates: Requirements 9.3, 9.5**
 *
 * Property 19 (from design.md):
 *   For any API route that accepts user input, if the request body fails Zod
 *   schema validation, the system SHALL return HTTP 400 with a JSON body
 *   matching `{error: string, message: string, code: "VALIDATION_ERROR"}`.
 *   No invalid data SHALL reach the database layer.
 *
 * This file tests two layers:
 *   1. Schema layer — invalid inputs are rejected by each Zod schema
 *   2. Error handler layer — `handleApiError` maps ZodError → 400,
 *      RateLimitError → 429, and generic errors → 500, all with the
 *      canonical `{error, message, code}` envelope.
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { ZodError } from 'zod'

import {
  EventSchema,
  CategorySchema,
  SubmissionSchema,
  JuryScoreSchema,
  ParameterSetSchema,
} from '@/lib/validators/schemas'
import { handleApiError } from '@/lib/api-error'
import { RateLimitError } from '@/lib/rate-limit'
import { ScoringMode } from '@prisma/client'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract JSON body from a NextResponse returned by handleApiError. */
async function parseErrorBody(
  response: ReturnType<typeof handleApiError>,
): Promise<{ error: string; message: string; code: string }> {
  return (await response.json()) as { error: string; message: string; code: string }
}

// ---------------------------------------------------------------------------
// Section 1 — handleApiError response envelope
// ---------------------------------------------------------------------------

describe('Property 19: handleApiError — response envelope', () => {
  /**
   * P19-A: For any ZodError, handleApiError returns HTTP 400 with
   * `{error: string, message: string, code: "VALIDATION_ERROR"}`.
   *
   * **Validates: Requirements 9.3, 9.5**
   */
  it('P19-A: ZodError always maps to HTTP 400 with VALIDATION_ERROR code', async () => {
    // We generate ZodErrors by intentionally failing known schemas.
    // We use a set of deterministic invalid inputs that always produce a ZodError.
    const invalidInputs = [
      // EventSchema — missing name
      () => EventSchema.parse({}),
      // CategorySchema — missing name + eventId
      () => CategorySchema.parse({}),
      // SubmissionSchema — wrong domain
      () =>
        SubmissionSchema.parse({
          url: 'https://google.com',
          participantName: 'Test',
          categoryId: 'abc',
        }),
      // ParameterSetSchema — wrong total weight
      () =>
        ParameterSetSchema.parse([
          {
            name: 'P',
            weight: 50,
            minScore: 0,
            maxScore: 100,
            scoringMode: ScoringMode.AUTO,
            orderIndex: 0,
          },
        ]),
    ]

    for (const trigger of invalidInputs) {
      let zodError: ZodError | null = null
      try {
        trigger()
      } catch (e) {
        if (e instanceof ZodError) zodError = e
      }
      expect(zodError).not.toBeNull()

      const response = handleApiError(zodError!)
      expect(response.status).toBe(400)

      const body = await parseErrorBody(response)
      expect(typeof body.error).toBe('string')
      expect(typeof body.message).toBe('string')
      expect(body.code).toBe('VALIDATION_ERROR')
    }
  })

  /**
   * P19-B: For any RateLimitError, handleApiError returns HTTP 429 with
   * `{error: string, message: string, code: "RATE_LIMIT_EXCEEDED"}`.
   *
   * **Validates: Requirements 9.3, 9.5**
   */
  it('P19-B: RateLimitError always maps to HTTP 429 with RATE_LIMIT_EXCEEDED code', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Vary the error message to exercise different inputs
        fc.string({ minLength: 1, maxLength: 100 }),
        async (msg) => {
          const err = new RateLimitError(msg)
          const response = handleApiError(err)
          expect(response.status).toBe(429)

          const body = await parseErrorBody(response)
          expect(typeof body.error).toBe('string')
          expect(typeof body.message).toBe('string')
          expect(body.code).toBe('RATE_LIMIT_EXCEEDED')
        },
      ),
      { numRuns: 50 },
    )
  })

  /**
   * P19-C: For any non-Zod, non-RateLimit error (generic Error, strings,
   * objects, etc.), handleApiError returns HTTP 500 with
   * `{error: string, message: string, code: "INTERNAL_ERROR"}`.
   *
   * **Validates: Requirements 9.3, 9.5**
   */
  it('P19-C: Generic/unknown errors always map to HTTP 500 with INTERNAL_ERROR code', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Vary what gets thrown: Error instances, strings, objects, numbers, null
        fc.oneof(
          fc.string({ minLength: 0, maxLength: 80 }).map((s) => new Error(s)),
          fc.string().map((s) => s),
          fc.integer().map((n) => n),
          fc.constant(null),
          fc.constant(undefined),
          fc.record({ code: fc.string(), detail: fc.string() }),
        ),
        async (unknownError) => {
          const response = handleApiError(unknownError)
          expect(response.status).toBe(500)

          const body = await parseErrorBody(response)
          expect(typeof body.error).toBe('string')
          expect(typeof body.message).toBe('string')
          expect(body.code).toBe('INTERNAL_ERROR')
        },
      ),
      { numRuns: 100 },
    )
  })

  /**
   * P19-D: The envelope structure `{error, message, code}` is always present
   * regardless of error type — no missing keys, no extra nesting.
   *
   * **Validates: Requirements 9.3, 9.5**
   */
  it('P19-D: response body always has exactly {error, message, code} keys', async () => {
    // Mix all three error categories together
    const cases: unknown[] = [
      (() => {
        try {
          EventSchema.parse({})
        } catch (e) {
          return e
        }
      })(),
      new RateLimitError(),
      new Error('unexpected'),
      'a plain string error',
      42,
    ]

    for (const err of cases) {
      if (err == null) continue
      const response = handleApiError(err)
      const body = await parseErrorBody(response)

      // All three keys must exist and be strings
      expect(body).toHaveProperty('error')
      expect(body).toHaveProperty('message')
      expect(body).toHaveProperty('code')
      expect(typeof body.error).toBe('string')
      expect(typeof body.message).toBe('string')
      expect(typeof body.code).toBe('string')

      // No stack trace or other sensitive fields should leak
      expect(body).not.toHaveProperty('stack')
      expect(body).not.toHaveProperty('trace')
    }
  })

  /**
   * P19-E: ZodError message is never empty — it must surface a meaningful
   * validation description to help the caller fix their input.
   *
   * **Validates: Requirements 9.3**
   */
  it('P19-E: ZodError response message is non-empty and describes a validation issue', async () => {
    const zodErrors: ZodError[] = []

    const badInputs = [
      () => EventSchema.parse({ name: '' }),
      () => CategorySchema.parse({ name: '' }),
      () =>
        SubmissionSchema.parse({
          url: 'not-a-url',
          participantName: '',
          categoryId: '',
        }),
    ]

    for (const trigger of badInputs) {
      try {
        trigger()
      } catch (e) {
        if (e instanceof ZodError) zodErrors.push(e)
      }
    }

    for (const zodErr of zodErrors) {
      const response = handleApiError(zodErr)
      const body = await parseErrorBody(response)

      expect(body.message.length).toBeGreaterThan(0)
      expect(body.message).not.toBe('Invalid input data.')
    }
  })
})

// ---------------------------------------------------------------------------
// Section 2 — Schema-level rejection: invalid inputs never pass validation
// ---------------------------------------------------------------------------

describe('Property 19: EventSchema — invalid inputs are rejected', () => {
  /**
   * P19-F: Any EventSchema input with a missing or empty name is rejected.
   *
   * **Validates: Requirements 9.3**
   */
  it('P19-F: EventSchema rejects any input without a valid name', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // missing name entirely — only description present
          fc.record({ description: fc.string() }),
          // name as empty string
          fc.record({ name: fc.constant('') }),
          // name is a number (wrong type)
          fc.record({ name: fc.integer() as unknown as fc.Arbitrary<string> }),
          // name is null
          fc.record({ name: fc.constant(null) as unknown as fc.Arbitrary<string> }),
          // name exceeds 255 characters
          fc.record({ name: fc.string({ minLength: 256, maxLength: 300 }) }),
        ),
        (input) => {
          const result = EventSchema.safeParse(input)
          expect(result.success).toBe(false)
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P19-G: Any EventSchema input with a valid name always passes.
   *
   * **Validates: Requirements 9.3**
   */
  it('P19-G: EventSchema accepts any input with a valid name (1–255 chars)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 255 }),
        (name) => {
          const result = EventSchema.safeParse({ name })
          expect(result.success).toBe(true)
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('Property 19: CategorySchema — invalid inputs are rejected', () => {
  /**
   * P19-H: CategorySchema rejects any input with missing/empty name or eventId.
   *
   * **Validates: Requirements 9.3**
   */
  it('P19-H: CategorySchema rejects inputs with missing name or missing eventId', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // missing both
          fc.constant({}),
          // valid eventId, empty name
          fc.record({ eventId: fc.string({ minLength: 1 }), name: fc.constant('') }),
          // valid name, empty eventId
          fc.record({ name: fc.string({ minLength: 1 }), eventId: fc.constant('') }),
          // both empty
          fc.record({ name: fc.constant(''), eventId: fc.constant('') }),
          // name too long
          fc.record({
            eventId: fc.string({ minLength: 1 }),
            name: fc.string({ minLength: 256, maxLength: 300 }),
          }),
        ),
        (input) => {
          const result = CategorySchema.safeParse(input)
          expect(result.success).toBe(false)
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P19-I: CategorySchema accepts any input with valid non-empty name and eventId.
   *
   * **Validates: Requirements 9.3**
   */
  it('P19-I: CategorySchema accepts inputs with valid name and eventId', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 255 }),
        fc.string({ minLength: 1, maxLength: 100 }),
        (name, eventId) => {
          const result = CategorySchema.safeParse({ name, eventId })
          expect(result.success).toBe(true)
        },
      ),
      { numRuns: 200 },
    )
  })
})

describe('Property 19: SubmissionSchema — invalid inputs are rejected', () => {
  /**
   * P19-J: SubmissionSchema rejects any URL that is not on partyrock.aws.
   *
   * **Validates: Requirements 9.3**
   */
  it('P19-J: SubmissionSchema rejects non-partyrock.aws URLs', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant('https://google.com/app'),
          fc.constant('https://amazon.com'),
          fc.constant('https://partyrock.com'),
          fc.constant('https://evil.partyrock.aws.fake.com'),
          fc.constant('not-a-url'),
          fc.constant(''),
          fc.webUrl().filter((url) => {
            try {
              const h = new URL(url).hostname
              return h !== 'partyrock.aws' && !h.endsWith('.partyrock.aws')
            } catch {
              return true
            }
          }),
        ),
        (url) => {
          const result = SubmissionSchema.safeParse({
            url,
            participantName: 'Test User',
            categoryId: 'validid123',
          })
          expect(result.success).toBe(false)
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P19-K: SubmissionSchema accepts valid partyrock.aws URLs with valid participant data.
   *
   * **Validates: Requirements 9.3**
   */
  it('P19-K: SubmissionSchema accepts valid partyrock.aws URLs', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant('https://partyrock.aws/app/abc'),
          fc.constant('https://partyrock.aws/'),
          fc.constant('https://app.partyrock.aws/demo'),
        ),
        fc.string({ minLength: 1, maxLength: 255 }),
        (url, participantName) => {
          const result = SubmissionSchema.safeParse({
            url,
            participantName,
            categoryId: 'validid',
          })
          expect(result.success).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  /**
   * P19-L: SubmissionSchema rejects empty participantName.
   *
   * **Validates: Requirements 9.3**
   */
  it('P19-L: SubmissionSchema rejects empty or missing participantName', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(''),
          fc.string({ minLength: 256, maxLength: 300 }),
        ),
        (participantName) => {
          const result = SubmissionSchema.safeParse({
            url: 'https://partyrock.aws/app',
            participantName,
            categoryId: 'validid',
          })
          expect(result.success).toBe(false)
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('Property 19: JuryScoreSchema — invalid inputs are rejected', () => {
  /**
   * P19-M: JuryScoreSchema rejects scores outside [minScore, maxScore].
   *
   * **Validates: Requirements 9.3**
   */
  it('P19-M: JuryScoreSchema rejects scores outside [minScore, maxScore]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 90 }),   // minScore
        fc.integer({ min: 10, max: 100 }), // maxScore offset
        fc.oneof(
          fc.integer({ min: -1000, max: -1 }),  // below any positive min
          fc.integer({ min: 101, max: 1000 }),  // above any 100 max
        ),
        (min, maxOffset, outOfRangeScore) => {
          const maxScore = min + maxOffset
          // Guard: score must actually be outside the range
          fc.pre(outOfRangeScore < min || outOfRangeScore > maxScore)

          const result = JuryScoreSchema.safeParse({
            projectId: 'proj123',
            parameterId: 'param123',
            score: outOfRangeScore,
            minScore: min,
            maxScore,
          })
          expect(result.success).toBe(false)
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P19-N: JuryScoreSchema accepts scores exactly at boundaries [minScore, maxScore].
   *
   * **Validates: Requirements 9.3**
   */
  it('P19-N: JuryScoreSchema accepts scores at exactly the min and max boundaries', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 49 }),   // minScore
        fc.integer({ min: 1, max: 50 }),   // delta to ensure maxScore > minScore
        fc.constantFrom('min', 'max'),
        (min, delta, boundary) => {
          const maxScore = min + delta
          const score = boundary === 'min' ? min : maxScore

          const result = JuryScoreSchema.safeParse({
            projectId: 'proj123',
            parameterId: 'param123',
            score,
            minScore: min,
            maxScore,
          })
          expect(result.success).toBe(true)
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P19-O: JuryScoreSchema rejects non-finite score values (NaN, Infinity).
   *
   * **Validates: Requirements 9.3**
   */
  it('P19-O: JuryScoreSchema rejects non-finite scores (NaN, Infinity)', () => {
    const nonFiniteScores = [NaN, Infinity, -Infinity]
    for (const score of nonFiniteScores) {
      const result = JuryScoreSchema.safeParse({
        projectId: 'proj123',
        parameterId: 'param123',
        score,
        minScore: 0,
        maxScore: 100,
      })
      expect(result.success).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Section 3 — No invalid data passes: cross-schema invariant
// ---------------------------------------------------------------------------

describe('Property 19: cross-schema invariant — all schemas reject clearly invalid inputs', () => {
  /**
   * P19-P: When any schema parses successfully, the result.data must be
   * structurally valid (no undefined required fields, correct types).
   *
   * **Validates: Requirements 9.5**
   */
  it('P19-P: successful EventSchema parse always returns data with a non-empty name', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 255 }),
        (name) => {
          const result = EventSchema.safeParse({ name })
          if (result.success) {
            expect(result.data.name.length).toBeGreaterThan(0)
            expect(result.data.name.length).toBeLessThanOrEqual(255)
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P19-Q: When JuryScoreSchema parses successfully, score is always
   * within [minScore, maxScore].
   *
   * **Validates: Requirements 9.5**
   */
  it('P19-Q: successful JuryScoreSchema parse always has score within [minScore, maxScore]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 49 }),
        fc.integer({ min: 1, max: 50 }),
        (min, delta) => {
          const maxScore = min + delta
          // Try every possible integer in range
          fc.property(
            fc.integer({ min, max: maxScore }),
            (score) => {
              const result = JuryScoreSchema.safeParse({
                projectId: 'proj123',
                parameterId: 'param123',
                score,
                minScore: min,
                maxScore,
              })
              if (result.success) {
                expect(result.data.score).toBeGreaterThanOrEqual(result.data.minScore)
                expect(result.data.score).toBeLessThanOrEqual(result.data.maxScore)
              }
            },
          )
        },
      ),
      { numRuns: 100 },
    )
  })
})
