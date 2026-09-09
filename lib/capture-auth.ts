// lib/capture-auth.ts
// Shared auth + CORS helpers for the capture endpoints.
//
// The capture endpoints are reachable two ways, and neither can rely on the
// normal NextAuth session cookie:
//
//   1. `scripts/partyrock-navigate.js` posts from Node, which has no cookie
//      jar and no browser session.
//   2. The in-page panel in `public/partyrock-capture.js` posts from the
//      partyrock.aws origin, where the app's SameSite cookie is not sent.
//
// So they authenticate with a shared secret (`CAPTURE_TOKEN`) instead. An
// admin session is still accepted, which is what the admin UI's paste-JSON
// fallback uses.
// Requirements: 9.4

import type { NextRequest } from 'next/server'
import { auth } from '@/lib/auth/config'

/** Origin allowed to POST captures from inside a PartyRock page. */
const PARTYROCK_ORIGIN = 'https://partyrock.aws'

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': PARTYROCK_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Capture-Token',
  'Access-Control-Max-Age': '86400',
}

export type CaptureAuthResult =
  | { ok: true; via: 'token' | 'session' }
  | { ok: false; reason: 'not_configured' | 'unauthorized' }

/**
 * Authorise a capture request via the shared token or an admin session.
 *
 * Returns `not_configured` when CAPTURE_TOKEN is unset, so the operator gets
 * a setup hint rather than a bare 401. A blank/whitespace token is treated as
 * unset — otherwise an empty env var would silently accept every request.
 */
export async function authorizeCapture(
  request: NextRequest,
): Promise<CaptureAuthResult> {
  const configured = (process.env.CAPTURE_TOKEN ?? '').trim()

  const presented =
    request.headers.get('x-capture-token')?.trim() ??
    request.nextUrl.searchParams.get('token')?.trim() ??
    ''

  if (presented) {
    if (!configured) return { ok: false, reason: 'not_configured' }
    if (presented === configured) return { ok: true, via: 'token' }
    return { ok: false, reason: 'unauthorized' }
  }

  const session = await auth()
  if (session?.user.role === 'ADMIN') return { ok: true, via: 'session' }

  return { ok: false, reason: 'unauthorized' }
}

/** JSON body for a failed `authorizeCapture`, matching the app's error shape. */
export function captureAuthErrorBody(
  reason: 'not_configured' | 'unauthorized',
): { error: string; message: string; code: string } {
  if (reason === 'not_configured') {
    return {
      error: 'Unauthorized',
      message:
        'CAPTURE_TOKEN is not set on the server. Add it to .env and restart the dev server.',
      code: 'CAPTURE_TOKEN_NOT_CONFIGURED',
    }
  }
  return {
    error: 'Unauthorized',
    message: 'Invalid capture token, and no admin session was present.',
    code: 'UNAUTHORIZED',
  }
}
