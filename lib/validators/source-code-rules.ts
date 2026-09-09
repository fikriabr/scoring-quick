// lib/validators/source-code-rules.ts
//
// Single source of truth for the `Project.sourceCode` length rule.
//
// This lived in `lib/validators/schemas.ts`, which cannot be imported from a
// client component: `schemas.ts` imports `{ ScoringMode }` from
// `@prisma/client` as a *value* (used with `z.nativeEnum`), so pulling
// the constant from there would drag the Prisma runtime into the browser
// bundle. This module therefore stays free of any server-only dependency — no
// `@prisma/client`, no `zod`, no `@/lib/db`, no Node built-ins — so the zod
// schemas, the admin PATCH route and the client-side character counters can
// all read the same number.
//
// `schemas.ts` re-exports both values, so existing imports keep working.
//
// Requirements: 5.3

/**
 * Maximum accepted length of a pasted `Project.sourceCode`, in characters.
 *
 * Part of the contract rather than an internal detail of one schema:
 * `SubmissionSchema`, `CsvRowSchema`, `PATCH /api/submissions/[id]` and every
 * character counter in the UI have to enforce the same number.
 */
export const MAX_SOURCE_CODE_LENGTH = 100_000

/** Locale pinned to `en-US` so the message is identical on every runtime. */
export const SOURCE_CODE_TOO_LONG_MESSAGE =
  `Source code must not exceed ${MAX_SOURCE_CODE_LENGTH.toLocaleString('en-US')} characters`
