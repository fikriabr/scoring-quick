// lib/rate-limit.ts
// Sliding window rate limiter using lru-cache.
// Limits each unique token (user ID or IP) to a maximum number of requests
// within a rolling time window.

import { LRUCache } from 'lru-cache'

/**
 * Custom error thrown when a user exceeds the rate limit.
 * Caught by `handleApiError` to return HTTP 429.
 */
export class RateLimitError extends Error {
  readonly code = 'RATE_LIMIT_EXCEEDED'

  constructor(message = 'Rate limit exceeded') {
    super(message)
    this.name = 'RateLimitError'
    // Maintains proper prototype chain in transpiled environments
    Object.setPrototypeOf(this, RateLimitError.prototype)
  }
}

export interface RateLimiterOptions {
  /**
   * Length of the sliding window in milliseconds.
   * @default 60_000 (60 seconds)
   */
  interval?: number

  /**
   * Maximum number of unique tokens (users) tracked simultaneously.
   * Oldest entries are evicted when this limit is reached.
   * @default 500
   */
  uniqueTokenPerInterval?: number
}

export interface RateLimiter {
  /**
   * Check whether `token` has exceeded `limit` requests in the current window.
   *
   * @param limit - Maximum allowed requests per window (e.g. 10)
   * @param token - Unique identifier for the caller (user ID or IP address)
   * @throws {RateLimitError} when the request count for `token` exceeds `limit`
   */
  check: (limit: number, token: string) => void
}

/**
 * Creates a sliding-window rate limiter.
 *
 * Each unique `token` is allowed at most `limit` requests within the
 * configured `interval` milliseconds. The window slides with each request —
 * only calls made within the last `interval` ms are counted.
 *
 * @example
 * ```ts
 * const limiter = rateLimit({ interval: 60_000, uniqueTokenPerInterval: 500 })
 *
 * // In an API route:
 * limiter.check(10, userId) // throws RateLimitError if > 10 req/min
 * ```
 */
export function rateLimit(options?: RateLimiterOptions): RateLimiter {
  const interval = options?.interval ?? 60_000
  const maxUniqueTokens = options?.uniqueTokenPerInterval ?? 500

  // Store an array of request timestamps (ms) per token.
  // TTL is set to `interval` so entries auto-expire after the window passes.
  const tokenCache = new LRUCache<string, number[]>({
    max: maxUniqueTokens,
    ttl: interval,
  })

  return {
    check(limit: number, token: string): void {
      const now = Date.now()
      const windowStart = now - interval

      // Retrieve existing timestamps and drop those outside the current window
      const previous = tokenCache.get(token) ?? []
      const windowTimestamps = previous.filter((ts) => ts > windowStart)

      if (windowTimestamps.length >= limit) {
        throw new RateLimitError(
          `Rate limit exceeded: maximum ${limit} requests per ${interval / 1_000} seconds.`,
        )
      }

      // Record this request and persist back to cache
      tokenCache.set(token, [...windowTimestamps, now])
    },
  }
}
