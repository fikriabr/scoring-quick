// lib/api-error.ts
// Centralised API error handler for Next.js Route Handlers.
//
// Responsibilities:
//  - ZodError          → HTTP 400  (VALIDATION_ERROR)   — returns flattened field errors
//  - RateLimitError    → HTTP 429  (RATE_LIMIT_EXCEEDED) — surfaced from lib/rate-limit.ts
//  - Prisma P2002/P2003/P2025 → 409 / 409 / 404 (duplicate, still referenced, missing)
//  - Everything else   → HTTP 500  (INTERNAL_ERROR)      — no stack trace exposed to client
//
// Response envelope: { error: string, message: string, code: string }
// Requirements: 9.3, 9.5

import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { RateLimitError } from '@/lib/rate-limit'

/** Field names Prisma reports for a unique-constraint violation, if any. */
function uniqueTarget(error: Prisma.PrismaClientKnownRequestError): string {
  const target = (error.meta as { target?: unknown } | undefined)?.target
  if (Array.isArray(target)) return target.join(', ')
  return typeof target === 'string' ? target : ''
}

const PRISMA_ERRORS: Record<
  string,
  {
    status: number
    error: string
    code: string
    message: (error: Prisma.PrismaClientKnownRequestError) => string
  }
> = {
  P2002: {
    status: 409,
    error: 'Conflict',
    code: 'DUPLICATE',
    message: (e) => {
      const field = uniqueTarget(e)
      return field
        ? `A record with this ${field} already exists.`
        : 'A record with these values already exists.'
    },
  },
  P2003: {
    status: 409,
    error: 'Conflict',
    code: 'IN_USE',
    message: () =>
      'This record is still referenced by other data (for example scores or assignments) and cannot be changed or removed.',
  },
  P2025: {
    status: 404,
    error: 'Not Found',
    code: 'NOT_FOUND',
    message: () => 'The requested record does not exist.',
  },
}

// ------------------------------------------------------------------
// Public response type
// ------------------------------------------------------------------

export interface ApiErrorResponse {
  /** Short, human-readable error category (e.g. "Validation Error") */
  error: string
  /** Detailed message safe to expose to the client — no stack traces */
  message: string
  /** Machine-readable error code (e.g. "VALIDATION_ERROR") */
  code: string
}

// ------------------------------------------------------------------
// handleApiError
// ------------------------------------------------------------------

/**
 * Converts a caught error into a well-typed `NextResponse` with the
 * canonical `{ error, message, code }` envelope.
 *
 * Usage inside an API Route Handler:
 * ```ts
 * try {
 *   // ...
 * } catch (err) {
 *   return handleApiError(err)
 * }
 * ```
 */
export function handleApiError(error: unknown): NextResponse<ApiErrorResponse> {
  // ----------------------------------------------------------------
  // 1. Zod validation errors → 400 Bad Request
  // ----------------------------------------------------------------
  if (error instanceof ZodError) {
    const flattened = error.flatten()

    // Build a readable summary:
    //   - global form-level errors first
    //   - then field-level errors, prefixed with the field name
    const parts: string[] = []

    if (flattened.formErrors.length > 0) {
      parts.push(...flattened.formErrors)
    }

    // fieldErrors values are string[] in runtime; cast for TS compatibility
    const fieldErrors = flattened.fieldErrors as Record<string, string[] | undefined>
    for (const [field, msgs] of Object.entries(fieldErrors)) {
      if (Array.isArray(msgs) && msgs.length > 0) {
        parts.push(`${field}: ${msgs.join(', ')}`)
      }
    }

    const message =
      parts.length > 0 ? parts.join('; ') : 'Invalid input data.'

    return NextResponse.json<ApiErrorResponse>(
      {
        error: 'Validation Error',
        message,
        code: 'VALIDATION_ERROR',
      },
      { status: 400 },
    )
  }

  // ----------------------------------------------------------------
  // 2. Rate limit exceeded → 429 Too Many Requests
  // ----------------------------------------------------------------
  if (error instanceof RateLimitError) {
    return NextResponse.json<ApiErrorResponse>(
      {
        error: 'Too Many Requests',
        message: error.message,
        code: 'RATE_LIMIT_EXCEEDED',
      },
      { status: 429 },
    )
  }

  // ----------------------------------------------------------------
  // 3. Known database constraint errors → 4xx with a message the admin can
  //    act on, instead of an opaque 500 (duplicate email, assigning the same
  //    jury twice, deleting a row something still references...).
  // ----------------------------------------------------------------
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = PRISMA_ERRORS[error.code]
    if (mapped) {
      return NextResponse.json<ApiErrorResponse>(
        { error: mapped.error, message: mapped.message(error), code: mapped.code },
        { status: mapped.status },
      )
    }
  }

  // ----------------------------------------------------------------
  // 4. Unhandled / unexpected errors → 500 Internal Server Error
  //    Log full details server-side; never send stack trace to client.
  // ----------------------------------------------------------------
  console.error('[API Error]', error)

  return NextResponse.json<ApiErrorResponse>(
    {
      error: 'Internal Server Error',
      message: 'An unexpected error occurred. Please try again later.',
      code: 'INTERNAL_ERROR',
    },
    { status: 500 },
  )
}
