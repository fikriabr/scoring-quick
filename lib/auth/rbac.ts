// lib/auth/rbac.ts
// Testable RBAC access-control decision functions.
// These are pure functions extracted from the proxy logic so they can be
// property-tested without spinning up a Next.js request context.

/**
 * Paths that are restricted to ADMIN users only.
 * Matches via startsWith — any sub-path under these prefixes is also admin-only.
 */
export const ADMIN_PATHS = [
  '/admin',
  '/api/events',
  '/api/categories',
  '/api/parameters',
  '/api/users',
] as const

export type Role = 'ADMIN' | 'JURY'

/**
 * The landing page each role is sent to after signing in.
 *
 * A jury has no access to `/admin` — the proxy answers those paths with 403 —
 * so the post-login destination has to follow the role rather than being
 * hardcoded. Every value here must be a path `checkAccess` allows for its own
 * role; the property tests assert exactly that.
 */
export const ROLE_HOME: Record<Role, string> = {
  ADMIN: '/admin',
  JURY: '/jury/projects',
}

/**
 * Landing path for `role`, or `/login` when the role is missing or unknown
 * (e.g. a stale token issued before a role was renamed).
 */
export function homePathForRole(role: Role | null | undefined): string {
  if (!role) return '/login'
  return ROLE_HOME[role] ?? '/login'
}

export type AccessDecision =
  | { allowed: true }
  | { allowed: false; reason: 'unauthenticated' }
  | { allowed: false; reason: 'forbidden' }

/**
 * Determines whether `pathname` is guarded under an admin-only prefix.
 */
export function isAdminPath(pathname: string): boolean {
  return ADMIN_PATHS.some((prefix) => pathname.startsWith(prefix))
}

/**
 * Core RBAC access-control decision function.
 *
 * Rules (in priority order):
 *  1. Unauthenticated users → denied (reason: 'unauthenticated')
 *  2. ADMIN users           → always allowed
 *  3. JURY on admin path    → denied (reason: 'forbidden')
 *  4. JURY elsewhere        → allowed
 *
 * @param pathname  The URL pathname being requested (e.g. '/admin/events')
 * @param role      The role from the JWT token, or null if unauthenticated
 */
export function checkAccess(
  pathname: string,
  role: Role | null,
): AccessDecision {
  // Rule 1: unauthenticated
  if (role === null) {
    return { allowed: false, reason: 'unauthenticated' }
  }

  // Rule 2: ADMIN can access everything
  if (role === 'ADMIN') {
    return { allowed: true }
  }

  // Rules 3 & 4: JURY
  if (isAdminPath(pathname)) {
    return { allowed: false, reason: 'forbidden' }
  }

  return { allowed: true }
}
