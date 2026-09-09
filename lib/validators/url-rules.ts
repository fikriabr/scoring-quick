// lib/validators/url-rules.ts
//
// Single source of truth for project URL rules.
//
// This module is imported from BOTH the server (zod schemas, API routes) and
// the client (`components/SubmissionForm.tsx`), so it must stay free of any
// server-only dependency: no `@/lib/db`, no `'use server'`, no Node built-ins.
// `ProjectType` is imported as a *type* only so the Prisma runtime never ends
// up in the client bundle.
//
// Requirements: 2.1, 2.2, 2.3, 2.5

import type { ProjectType } from '@prisma/client'

/** Only real web schemes are accepted, for every project type. */
const ALLOWED_SCHEMES = ['http:', 'https:']

/**
 * True when `hostname` is the PartyRock domain itself or one of its
 * subdomains. Compares the parsed hostname, never the raw URL string, so
 * `partyrock.aws.evil.com` and `https://evil.com/partyrock.aws` do not match.
 */
export function isPartyRockHost(hostname: string): boolean {
  return hostname === 'partyrock.aws' || hostname.endsWith('.partyrock.aws')
}

export type UrlValidationResult = { ok: true } | { ok: false; message: string }

/**
 * Validates a project URL against the rules of its project type.
 *
 * - Any type: must parse as a URL and use the `http:` or `https:` scheme.
 * - `PARTYROCK`: hostname must be `partyrock.aws` or `*.partyrock.aws`.
 * - `HTML`: any hostname is accepted.
 */
export function validateProjectUrl(
  url: string,
  projectType: ProjectType,
): UrlValidationResult {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, message: 'URL must be a valid URL' }
  }
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return { ok: false, message: 'URL must use http or https' }
  }
  if (projectType === 'PARTYROCK' && !isPartyRockHost(parsed.hostname)) {
    return {
      ok: false,
      message: 'URL must be a valid PartyRock URL (domain: partyrock.aws)',
    }
  }
  return { ok: true }
}
