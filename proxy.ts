// proxy.ts
// RBAC proxy for Next.js App Router (formerly middleware.ts — renamed in Next 16).
// Uses the testable `checkAccess` function from lib/auth/rbac.ts so that
// access-control logic can be property-tested independently of Next.js internals.

import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { checkAccess } from '@/lib/auth/rbac'
import type { Role } from '@/lib/auth/rbac'

const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET

/**
 * Reads the session JWT regardless of which cookie name Auth.js used.
 *
 * Over HTTPS (Vercel) the cookie is `__Secure-authjs.session-token`; over plain
 * HTTP it is `authjs.session-token`. The name is not just a lookup key — it is
 * also the HKDF salt for decrypting the JWT — so guessing wrong yields a null
 * token and an endless redirect back to /login even with valid credentials.
 * We try the name implied by the request protocol first, then the other one, so
 * the proxy also survives proxies that rewrite the scheme.
 */
async function readSessionToken(request: NextRequest) {
  const isHttps =
    request.nextUrl.protocol === 'https:' ||
    request.headers.get('x-forwarded-proto') === 'https'

  return (
    (await getToken({ req: request, secret, secureCookie: isHttps })) ??
    (await getToken({ req: request, secret, secureCookie: !isHttps }))
  )
}

export default async function proxy(request: NextRequest) {
  const token = await readSessionToken(request)

  const role = token?.role as Role | undefined
  const decision = checkAccess(request.nextUrl.pathname, role ?? null)

  if (!decision.allowed) {
    if (decision.reason === 'unauthenticated') {
      // Redirect unauthenticated users to the sign-in page
      return NextResponse.redirect(new URL('/login', request.url))
    }

    if (decision.reason === 'forbidden') {
      // Authenticated but insufficient role — return 403 JSON
      return NextResponse.json(
        { error: 'Forbidden', message: 'Akses ditolak.', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * Match /admin/:path*, /jury/:path*, and /api/:path* but exclude:
     *   - /api/auth/...     (NextAuth internal endpoints — must stay public)
     *   - /public/...       (public leaderboard pages — no auth required)
     *   - /api/capture/...  (shared-token auth, enforced in the route itself
     *                        via lib/capture-auth.ts — the Playwright
     *                        navigator and the in-page panel have no session
     *                        cookie to present)
     */
    '/admin/:path*',
    '/jury/:path*',
    '/api/((?!auth/|public/|capture).*)',
  ],
}
