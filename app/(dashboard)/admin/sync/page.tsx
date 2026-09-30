// app/(dashboard)/admin/sync/page.tsx
// RSC page for syncing submissions from the external source database
// (SOURCE_DATABASE_URL). Lists every source row with its sync status; the
// admin maps each theme to a category, ticks rows, and syncs them into the
// scoring queue. Admin-only via the admin layout and the RBAC proxy.

import Link from 'next/link'
import { db } from '@/lib/db'
import { Prisma } from '@prisma/client'
import { SourceDbNotConfiguredError, SourceDbQueryError } from '@/lib/source-db'
import {
  listSourceSubmissions,
  type SourceSubmissionSummary,
} from '@/lib/services/source-sync.service'
import SourceSyncPanel from '@/components/SourceSyncPanel'

// Always read both databases at request time — never at build time, where the
// external source may be unreachable and its rows would go stale anyway.
export const dynamic = 'force-dynamic'

/**
 * The listing touches two databases; the message has to name the one that
 * failed. A missing column in ours means the Prisma schema was not applied.
 */
function describeLoadError(error: unknown): string {
  if (error instanceof SourceDbNotConfiguredError) {
    return 'The source database is not configured. Set SOURCE_DATABASE_URL in the environment and reload.'
  }
  if (error instanceof SourceDbQueryError) return error.message
  const message = error instanceof Error ? error.message : String(error)
  const missingColumn =
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2022') ||
    /column .+ does not exist/i.test(message)
  if (missingColumn) {
    return (
      'The scoring-quick database schema is out of date (a column the sync needs is missing). ' +
      'Run `npx prisma db push` against DATABASE_URL, then reload.'
    )
  }
  return `Could not load sync status from the scoring-quick database: ${message}`
}

export default async function AdminSyncPage() {
  const categories = await db.category.findMany({
    orderBy: [{ event: { name: 'asc' } }, { name: 'asc' }],
    select: { id: true, name: true, event: { select: { name: true } } },
  })

  let rows: SourceSubmissionSummary[] = []
  let loadError: string | null = null
  try {
    rows = await listSourceSubmissions()
  } catch (error) {
    loadError = describeLoadError(error)
    console.error('[Sync] Listing source submissions failed:', error)
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Sync Submissions</h1>
          <p className="mt-1 text-sm text-gray-500">
            Import submissions from the external submission database. Synced projects wait in
            the scoring queue on the{' '}
            <Link href="/admin/submissions" className="text-blue-600 hover:underline">
              Submissions
            </Link>{' '}
            page.
          </p>
        </div>
      </div>

      {loadError ? (
        <div className="rounded-xl bg-red-50 p-4 text-sm text-red-700 ring-1 ring-red-200">
          {loadError}
        </div>
      ) : categories.length === 0 ? (
        <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
          There are no categories yet. Create an event and its categories first, then come back
          to map source themes onto them.{' '}
          <Link href="/admin/events" className="font-medium underline">
            Go to Events
          </Link>
        </div>
      ) : (
        <SourceSyncPanel
          rows={rows}
          categories={categories.map((c) => ({
            id: c.id,
            name: c.name,
            eventName: c.event.name,
          }))}
        />
      )}
    </div>
  )
}
