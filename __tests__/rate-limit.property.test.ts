/**
 * Property-Based Tests: Property 20 — Rate Limiting Enforcement
 *
 * Validates: Requirements 9.6
 *
 * Property 20: For any authenticated user making requests to crawling or AI
 * scoring API routes, after 10 requests within a 60-second sliding window,
 * every subsequent request within that window SHALL be rejected with
 * HTTP 429 and `{code: "RATE_LIMIT_EXCEEDED"}`. The counter SHALL reset
 * after the window expires.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fc from 'fast-check'
import { rateLimit, RateLimitError } from '../lib/rate-limit'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `n` requests for `token` against `limiter` and return an array of
 * results: `true` if the call succeeded, `false` if it threw RateLimitError.
 */
function runRequests(
  limiter: ReturnType<typeof rateLimit>,
  token: string,
  limit: number,
  count: number,
): boolean[] {
  const results: boolean[] = []
  for (let i = 0; i < count; i++) {
    try {
      limiter.check(limit, token)
      results.push(true)
    } catch (err) {
      if (err instanceof RateLimitError) {
        results.push(false)
      } else {
        throw err
      }
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property 20: Rate Limiting Enforcement', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // Property 20a: First N requests always succeed, (N+1)th always throws
  // -------------------------------------------------------------------------
  it('Property 20a — first N requests succeed and (N+1)th is rejected [**Validates: Requirements 9.6**]', () => {
    fc.assert(
      fc.property(
        // limit: 1..20 (keep small for speed)
        fc.integer({ min: 1, max: 20 }),
        // token: non-empty alphanumeric string
        fc.stringMatching(/^[a-z0-9]{1,32}$/),
        (limit, token) => {
          // Use a very long interval so no requests expire during the test
          const limiter = rateLimit({ interval: 60_000, uniqueTokenPerInterval: 500 })

          const results = runRequests(limiter, token, limit, limit + 1)

          // First `limit` requests should all succeed
          const successes = results.slice(0, limit)
          expect(successes.every(Boolean)).toBe(true)

          // The (limit+1)th request should fail
          expect(results[limit]).toBe(false)
        },
      ),
      { numRuns: 100 },
    )
  })

  // -------------------------------------------------------------------------
  // Property 20b: Token isolation — exhausting one token does not affect another
  // -------------------------------------------------------------------------
  it('Property 20b — different tokens are isolated [**Validates: Requirements 9.6**]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 15 }),
        // Two distinct tokens
        fc
          .tuple(
            fc.stringMatching(/^[a-z]{1,16}$/),
            fc.stringMatching(/^[A-Z]{1,16}$/),
          )
          .filter(([a, b]) => a !== b),
        (limit, [tokenA, tokenB]) => {
          const limiter = rateLimit({ interval: 60_000, uniqueTokenPerInterval: 500 })

          // Exhaust tokenA (limit requests + 1 over-limit)
          const resultsA = runRequests(limiter, tokenA, limit, limit + 1)

          // tokenA: first `limit` succeed, then fail
          expect(resultsA.slice(0, limit).every(Boolean)).toBe(true)
          expect(resultsA[limit]).toBe(false)

          // tokenB should still succeed for its first request (completely unaffected)
          const resultsB = runRequests(limiter, tokenB, limit, 1)
          expect(resultsB[0]).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  // -------------------------------------------------------------------------
  // Property 20c: RateLimitError shape — code and instanceof
  // -------------------------------------------------------------------------
  it('Property 20c — RateLimitError has code RATE_LIMIT_EXCEEDED and correct instanceof [**Validates: Requirements 9.6**]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.stringMatching(/^[a-z0-9]{1,32}$/),
        (limit, token) => {
          const limiter = rateLimit({ interval: 60_000, uniqueTokenPerInterval: 500 })

          // Use up exactly `limit` requests
          for (let i = 0; i < limit; i++) {
            limiter.check(limit, token)
          }

          // The next call must throw RateLimitError with the expected shape
          let caught: unknown
          try {
            limiter.check(limit, token)
          } catch (err) {
            caught = err
          }

          expect(caught).toBeDefined()
          expect(caught).toBeInstanceOf(RateLimitError)
          expect(caught).toBeInstanceOf(Error)
          expect((caught as RateLimitError).code).toBe('RATE_LIMIT_EXCEEDED')
          expect((caught as RateLimitError).name).toBe('RateLimitError')
          expect(typeof (caught as RateLimitError).message).toBe('string')
          expect((caught as RateLimitError).message.length).toBeGreaterThan(0)
        },
      ),
      { numRuns: 100 },
    )
  })

  // -------------------------------------------------------------------------
  // Property 20d: Monotonicity — limit L succeeds, L+1 fails
  // -------------------------------------------------------------------------
  it('Property 20d — monotonicity: exactly L requests pass and L+1 is rejected [**Validates: Requirements 9.6**]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.stringMatching(/^[a-z0-9]{1,32}$/),
        (limit, token) => {
          const limiter = rateLimit({ interval: 60_000, uniqueTokenPerInterval: 500 })

          // Exactly limit requests should all pass — no exception
          expect(() => {
            for (let i = 0; i < limit; i++) {
              limiter.check(limit, token)
            }
          }).not.toThrow()

          // The very next request (limit+1) must throw
          expect(() => limiter.check(limit, token)).toThrow(RateLimitError)
        },
      ),
      { numRuns: 100 },
    )
  })

  // -------------------------------------------------------------------------
  // Property 20e: Window reset — requests after window expiry are accepted again
  // -------------------------------------------------------------------------
  it('Property 20e — counter resets after the sliding window expires [**Validates: Requirements 9.6**]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.stringMatching(/^[a-z0-9]{1,32}$/),
        (limit, token) => {
          vi.useFakeTimers()
          try {
            const interval = 1_000 // 1-second window for speed
            const limiter = rateLimit({ interval, uniqueTokenPerInterval: 500 })

            // Exhaust the window
            for (let i = 0; i < limit; i++) {
              limiter.check(limit, token)
            }
            // Over-limit request must fail
            expect(() => limiter.check(limit, token)).toThrow(RateLimitError)

            // Advance time past the window
            vi.advanceTimersByTime(interval + 1)

            // After the window expires all old timestamps are outside the window;
            // a fresh batch of `limit` requests must succeed again
            expect(() => {
              for (let i = 0; i < limit; i++) {
                limiter.check(limit, token)
              }
            }).not.toThrow()
          } finally {
            vi.useRealTimers()
          }
        },
      ),
      { numRuns: 50 },
    )
  })
})
