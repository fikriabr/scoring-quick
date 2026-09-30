// lib/source-db.ts
// Read-only connection to the external submissions database the Sync menu
// imports from. Plain SQL over Neon's HTTP driver rather than a second Prisma
// client: we only ever SELECT from one table there, and a generated client for
// a schema this app does not own would drift the moment that schema changes.

import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

export class SourceDbNotConfiguredError extends Error {
  readonly code = 'SOURCE_DB_NOT_CONFIGURED'
  readonly status = 503

  constructor() {
    super('SOURCE_DATABASE_URL is not set — the sync source database is not configured.')
    this.name = 'SourceDbNotConfiguredError'
  }
}

/**
 * A query against the source database failed (unreachable, bad credentials,
 * table changed). Kept distinct from errors of our own database so the admin
 * is pointed at the right one.
 */
export class SourceDbQueryError extends Error {
  readonly code = 'SOURCE_DB_QUERY_FAILED'
  readonly status = 502

  constructor(cause: unknown) {
    super(
      `Could not read the source database: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'SourceDbQueryError'
  }
}

let cached: { url: string; sql: NeonQueryFunction<false, false> } | undefined

export function getSourceSql(): NeonQueryFunction<false, false> {
  const url = process.env.SOURCE_DATABASE_URL
  if (!url || url.trim() === '') throw new SourceDbNotConfiguredError()
  if (cached?.url !== url) cached = { url, sql: neon(url) }
  return cached.sql
}
