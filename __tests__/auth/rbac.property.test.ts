/**
 * Property-Based Tests: RBAC Access Control
 *
 * **Validates: Requirements 1.1, 7.2, 7.3, 7.4**
 *
 * Property 1: RBAC Access Control
 * For any HTTP request to an Admin-only route, if the requesting user does not
 * have the ADMIN role (including unauthenticated users), the system SHALL deny
 * access — returning HTTP 403 (authenticated non-admin) or redirecting to login
 * (unauthenticated).
 */

import { describe, expect, it } from 'vitest'
import * as fc from 'fast-check'
import {
  checkAccess,
  isAdminPath,
  homePathForRole,
  ADMIN_PATHS,
  ROLE_HOME,
  type Role,
} from '@/lib/auth/rbac'

// ---------------------------------------------------------------------------
// Arbitraries (generators)
// ---------------------------------------------------------------------------

/** Generates a random valid role. */
const roleArb = fc.constantFrom<Role>('ADMIN', 'JURY')

/** Generates a random role OR null (unauthenticated). */
const roleOrNullArb = fc.option(roleArb, { nil: null })

/**
 * Generates paths under the known admin-only prefixes.
 * Uses stringMatching to build URL-safe path segments (word chars + hyphens).
 */
const adminPathArb = fc
  .record({
    prefix: fc.constantFrom(...ADMIN_PATHS),
    suffix: fc.oneof(
      fc.constant(''),
      fc.constant('/'),
      fc.stringMatching(/^[a-z0-9-]{1,20}$/).map((s) => `/${s}`),
    ),
  })
  .map(({ prefix, suffix }) => `${prefix}${suffix}`)

/**
 * Generates paths that are clearly NOT admin-only:
 * - /jury/* (jury-specific dashboard)
 * - /public/* (unauthenticated pages)
 * - /login
 * - /
 */
const nonAdminPathArb = fc.oneof(
  fc.constant('/jury/projects'),
  fc.constant('/jury/scoring/cuid123'),
  fc.constant('/public/leaderboard/some-token'),
  fc.constant('/login'),
  fc.constant('/'),
  fc.stringMatching(/^[a-z0-9-]{1,15}$/).map((s) => `/jury/${s}`),
)

// ---------------------------------------------------------------------------
// Property 1a: ADMIN can always access admin paths
// ---------------------------------------------------------------------------

describe('Property 1: RBAC Access Control', () => {
  it('1a — ADMIN SHALL always be allowed to access any admin path', () => {
    fc.assert(
      fc.property(adminPathArb, (pathname) => {
        const decision = checkAccess(pathname, 'ADMIN')
        expect(decision.allowed).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  // ---------------------------------------------------------------------------
  // Property 1b: ADMIN can always access non-admin paths
  // ---------------------------------------------------------------------------

  it('1b — ADMIN SHALL always be allowed to access any path', () => {
    fc.assert(
      fc.property(nonAdminPathArb, (pathname) => {
        const decision = checkAccess(pathname, 'ADMIN')
        expect(decision.allowed).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  // ---------------------------------------------------------------------------
  // Property 1c: JURY is denied access to every admin path (HTTP 403 equivalent)
  // ---------------------------------------------------------------------------

  it('1c — JURY SHALL be denied (forbidden) on every admin-only path', () => {
    fc.assert(
      fc.property(adminPathArb, (pathname) => {
        const decision = checkAccess(pathname, 'JURY')
        expect(decision.allowed).toBe(false)
        if (!decision.allowed) {
          expect(decision.reason).toBe('forbidden')
        }
      }),
      { numRuns: 200 },
    )
  })

  // ---------------------------------------------------------------------------
  // Property 1d: JURY is allowed to access non-admin paths
  // ---------------------------------------------------------------------------

  it('1d — JURY SHALL be allowed to access non-admin paths', () => {
    fc.assert(
      fc.property(nonAdminPathArb, (pathname) => {
        const decision = checkAccess(pathname, 'JURY')
        expect(decision.allowed).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  // ---------------------------------------------------------------------------
  // Property 1e: Unauthenticated users (null role) are always denied
  // ---------------------------------------------------------------------------

  it('1e — Unauthenticated users SHALL always be denied with reason "unauthenticated"', () => {
    const anyPathArb = fc.oneof(adminPathArb, nonAdminPathArb)
    fc.assert(
      fc.property(anyPathArb, (pathname) => {
        const decision = checkAccess(pathname, null)
        expect(decision.allowed).toBe(false)
        if (!decision.allowed) {
          expect(decision.reason).toBe('unauthenticated')
        }
      }),
      { numRuns: 200 },
    )
  })

  // ---------------------------------------------------------------------------
  // Property 1f: Access decisions are deterministic (same inputs → same output)
  // ---------------------------------------------------------------------------

  it('1f — Access decisions SHALL be deterministic for the same path and role', () => {
    const anyPathArb = fc.oneof(adminPathArb, nonAdminPathArb)
    fc.assert(
      fc.property(anyPathArb, roleOrNullArb, (pathname, role) => {
        const first = checkAccess(pathname, role)
        const second = checkAccess(pathname, role)
        expect(first).toEqual(second)
      }),
      { numRuns: 300 },
    )
  })

  // ---------------------------------------------------------------------------
  // Property 1g: Every known ADMIN_PATH prefix is correctly classified
  // ---------------------------------------------------------------------------

  it('1g — Every ADMIN_PATHS prefix SHALL be identified as an admin path', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ADMIN_PATHS), (prefix) => {
        expect(isAdminPath(prefix)).toBe(true)
        // Sub-paths under admin prefix are also admin
        expect(isAdminPath(`${prefix}/sub-resource`)).toBe(true)
        expect(isAdminPath(`${prefix}/123`)).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  // ---------------------------------------------------------------------------
  // Property 1h: Non-admin paths are NOT classified as admin paths
  // ---------------------------------------------------------------------------

  it('1h — Non-admin paths SHALL NOT be classified as admin paths', () => {
    fc.assert(
      fc.property(nonAdminPathArb, (pathname) => {
        expect(isAdminPath(pathname)).toBe(false)
      }),
      { numRuns: 200 },
    )
  })

  // ---------------------------------------------------------------------------
  // Property 1i: JURY and unauthenticated produce distinct denial reasons
  // ---------------------------------------------------------------------------

  it('1i — JURY denial reason is "forbidden"; unauthenticated denial reason is "unauthenticated"', () => {
    fc.assert(
      fc.property(adminPathArb, (pathname) => {
        const juryDecision = checkAccess(pathname, 'JURY')
        const unauthDecision = checkAccess(pathname, null)

        expect(juryDecision.allowed).toBe(false)
        expect(unauthDecision.allowed).toBe(false)

        if (!juryDecision.allowed) {
          expect(juryDecision.reason).toBe('forbidden')
        }
        if (!unauthDecision.allowed) {
          expect(unauthDecision.reason).toBe('unauthenticated')
        }
      }),
      { numRuns: 200 },
    )
  })
  // ---------------------------------------------------------------------------
  // Property 1j: The post-login landing page is always reachable by its own role
  // ---------------------------------------------------------------------------

  it('1j — homePathForRole SHALL return a path that checkAccess allows for that role', () => {
    fc.assert(
      fc.property(roleArb, (role) => {
        const home = homePathForRole(role)
        expect(home).toBe(ROLE_HOME[role])
        expect(checkAccess(home, role).allowed).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it('1k — A JURY SHALL NOT be sent to an admin-only path after signing in', () => {
    const juryHome = homePathForRole('JURY')
    expect(isAdminPath(juryHome)).toBe(false)
    expect(checkAccess(juryHome, 'JURY')).toEqual({ allowed: true })
  })

  it('1l — A missing or unknown role SHALL land on /login', () => {
    expect(homePathForRole(null)).toBe('/login')
    expect(homePathForRole(undefined)).toBe('/login')
    // A stale token carrying a role that no longer exists must not fall through
    // to an admin page.
    expect(homePathForRole('SUPERUSER' as Role)).toBe('/login')
  })
})
