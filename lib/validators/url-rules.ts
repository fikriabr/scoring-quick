// lib/validators/url-rules.ts
//
// Single source of truth for project URL rules.
//
// This module is imported from BOTH the server (zod schemas, API routes) and
// the client (`components/SubmissionForm.tsx`), so it must stay free of any
// server-only dependency: no `@/lib/db`, no `'use server'`, no Node built-ins.

/** Only real web schemes are accepted. */
const ALLOWED_SCHEMES = ['http:', 'https:']

export type UrlValidationResult = { ok: true } | { ok: false; message: string }

/**
 * Validates a project URL: must parse as a URL and use the `http:` or
 * `https:` scheme. Any hostname is accepted.
 */
export function validateProjectUrl(url: string): UrlValidationResult {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, message: 'URL must be a valid URL' }
  }
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return { ok: false, message: 'URL must use http or https' }
  }
  return { ok: true }
}
