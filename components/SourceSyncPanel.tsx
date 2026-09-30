// components/SourceSyncPanel.tsx
// Client side of /admin/sync: map each source theme to a category, tick the
// rows to import (one by one or all at once), and sync them.
//
// Only rows that can actually be synced are selectable: not synced yet (or
// synced and since deleted), with a participant name and HTML, and with a
// category chosen for their theme. The server re-checks all of it.

'use client'

import Link from 'next/link'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { useRouter } from 'next/navigation'
import { MAX_SOURCE_CODE_LENGTH } from '@/lib/validators/source-code-rules'
import type { SourceSubmissionSummary } from '@/lib/services/source-sync.service'

export interface SyncCategoryOption {
  id: string
  name: string
  eventName: string
}

interface SyncResponse {
  created: { sourceId: number; projectId: string; warnings: string[] }[]
  skipped: { sourceId: number; projectId: string; reason: string }[]
  failed: { sourceId: number; message: string }[]
  queued: number
}

/** Per-viewer convenience only: the theme → category choice survives a reload. */
const MAPPING_STORAGE_KEY = 'scoring-quick:sync-theme-categories'

// The mapping lives in localStorage, read through useSyncExternalStore so the
// server render and hydration both see `{}` and the stored value follows right
// after. `memoryRaw` keeps the mapping working when storage is unavailable
// (private mode, blocked site data) — it just is not remembered then.
const mappingListeners = new Set<() => void>()
let memoryRaw: string | null = null

function subscribeMapping(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== MAPPING_STORAGE_KEY) return
    memoryRaw = null
    listener()
  }
  mappingListeners.add(listener)
  window.addEventListener('storage', onStorage)
  return () => {
    mappingListeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

function readMappingRaw(): string {
  if (memoryRaw !== null) return memoryRaw
  try {
    return localStorage.getItem(MAPPING_STORAGE_KEY) ?? '{}'
  } catch {
    return '{}'
  }
}

function writeMapping(next: Record<string, string>) {
  memoryRaw = JSON.stringify(next)
  try {
    localStorage.setItem(MAPPING_STORAGE_KEY, memoryRaw)
  } catch {
    // Not persisted; `memoryRaw` still applies it for this visit.
  }
  mappingListeners.forEach((listener) => listener())
}

/** Stored JSON → mapping, keeping only categories that still exist. */
function parseMapping(raw: string, categoryIds: Set<string>): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(raw)
    if (!stored || typeof stored !== 'object') return {}
    return Object.fromEntries(
      Object.entries(stored as Record<string, unknown>).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && categoryIds.has(entry[1]),
      ),
    )
  } catch {
    return {}
  }
}

const NO_THEME_LABEL = '(No theme)'

const fmt = (n: number) => n.toLocaleString('en-US')

/** Deterministic on server and client alike (no locale or time zone). */
function formatUtc(iso: string | null): string {
  if (!iso) return '—'
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

function blockedReason(
  row: SourceSubmissionSummary,
  mapping: Record<string, string>,
): string | null {
  if (row.syncedProject?.isActive) return 'Already synced'
  if (!row.participantName) return 'Source row has no full_name'
  if (row.htmlLength === 0) return 'Source row has no HTML'
  if (!mapping[row.theme]) return 'Choose a category for this theme first'
  return null
}

export default function SourceSyncPanel({
  rows,
  categories,
}: {
  rows: SourceSubmissionSummary[]
  categories: SyncCategoryOption[]
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [syncing, setSyncing] = useState(false)
  const [result, setResult] = useState<SyncResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])

  const mappingRaw = useSyncExternalStore(subscribeMapping, readMappingRaw, () => '{}')
  const mapping = useMemo(
    () => parseMapping(mappingRaw, new Set(categoryById.keys())),
    [mappingRaw, categoryById],
  )

  function updateMapping(theme: string, categoryId: string) {
    const next = { ...mapping }
    if (categoryId) next[theme] = categoryId
    else delete next[theme]
    writeMapping(next)
  }

  const themes = useMemo(() => {
    const byTheme = new Map<string, { total: number; open: number }>()
    for (const row of rows) {
      const entry = byTheme.get(row.theme) ?? { total: 0, open: 0 }
      entry.total++
      if (!row.syncedProject?.isActive) entry.open++
      byTheme.set(row.theme, entry)
    }
    return [...byTheme.entries()]
      .map(([theme, counts]) => ({ theme, ...counts }))
      .sort((a, b) =>
        a.theme === '' ? 1 : b.theme === '' ? -1 : a.theme.localeCompare(b.theme),
      )
  }, [rows])

  const selectableIds = useMemo(
    () => rows.filter((r) => blockedReason(r, mapping) === null).map((r) => r.sourceId),
    [rows, mapping],
  )
  const selectableSet = useMemo(() => new Set(selectableIds), [selectableIds])

  // A row that stops being selectable (its theme was unmapped, or it was just
  // synced) silently leaves the selection instead of being sent anyway.
  const effectiveSelected = useMemo(
    () => [...selected].filter((id) => selectableSet.has(id)),
    [selected, selectableSet],
  )

  const allSelected =
    selectableIds.length > 0 && effectiveSelected.length === selectableIds.length
  const someSelected = effectiveSelected.length > 0 && !allSelected

  const selectAllRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected
  }, [someSelected])

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(selectableIds))
  }

  function toggleOne(sourceId: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(sourceId)) next.delete(sourceId)
      else next.add(sourceId)
      return next
    })
  }

  async function sync() {
    const rowById = new Map(rows.map((r) => [r.sourceId, r]))
    const items = effectiveSelected.map((sourceId) => ({
      sourceId,
      categoryId: mapping[rowById.get(sourceId)!.theme],
    }))
    if (items.length === 0) return

    setSyncing(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch('/api/sync/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(body?.message ?? `Sync failed (HTTP ${res.status}).`)
      }
      setResult(body as SyncResponse)
      setSelected(new Set())
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed.')
    } finally {
      setSyncing(false)
    }
  }

  const syncedCount = rows.filter((r) => r.syncedProject?.isActive).length

  return (
    <div className="space-y-6">
      {/* Theme → category mapping */}
      <section className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
        <h2 className="text-sm font-semibold text-gray-900">Theme → Category</h2>
        <p className="mt-1 text-xs text-gray-500">
          Choose where each source theme is imported. Rows whose theme has no category cannot be
          selected.
        </p>
        {themes.length === 0 ? (
          <p className="mt-4 text-sm text-gray-500">The source database has no submissions.</p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {themes.map(({ theme, total, open }) => (
              <label key={theme || '__none__'} className="block">
                <span className="flex items-baseline justify-between gap-2 text-xs font-medium text-gray-700">
                  <span className="truncate">{theme || NO_THEME_LABEL}</span>
                  <span className="shrink-0 font-normal text-gray-400">
                    {open} of {total} not synced
                  </span>
                </span>
                <select
                  value={mapping[theme] ?? ''}
                  onChange={(e) => updateMapping(theme, e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">— Select category —</option>
                  {groupByEvent(categories).map(([eventName, options]) => (
                    <optgroup key={eventName} label={eventName}>
                      {options.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
      </section>

      {/* Rows */}
      <section className="rounded-xl bg-white shadow-sm ring-1 ring-gray-100 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
          <p className="text-sm text-gray-600">
            <span className="font-semibold text-gray-900">{rows.length}</span> in source ·{' '}
            {syncedCount} synced · {effectiveSelected.length} selected
          </p>
          <button
            type="button"
            onClick={sync}
            disabled={syncing || effectiveSelected.length === 0}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {syncing
              ? 'Syncing...'
              : effectiveSelected.length > 0
                ? `Sync ${effectiveSelected.length} selected`
                : 'Sync selected'}
          </button>
        </div>

        {(result || error) && (
          <div className="border-b border-gray-100 px-4 py-3">
            {error && <p className="text-sm text-red-600">{error}</p>}
            {result && <SyncResultSummary result={result} />}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="w-10 px-4 py-3 text-left">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    aria-label="Select all syncable submissions"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={selectableIds.length === 0 || syncing}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-40"
                  />
                </th>
                {['#', 'Participant', 'Project', 'Theme → Category', 'Evidence', 'Status'].map(
                  (label) => (
                    <th
                      key={label}
                      className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500"
                    >
                      {label}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {rows.map((row) => {
                const reason = blockedReason(row, mapping)
                const category = categoryById.get(mapping[row.theme] ?? '')
                const checked = reason === null && selected.has(row.sourceId)
                return (
                  <tr
                    key={row.sourceId}
                    className={`align-top transition-colors ${checked ? 'bg-blue-50/40' : 'hover:bg-gray-50/50'}`}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select submission ${row.sourceId}`}
                        checked={checked}
                        onChange={() => toggleOne(row.sourceId)}
                        disabled={reason !== null || syncing}
                        title={reason ?? undefined}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-40"
                      />
                    </td>
                    <td className="px-4 py-3 text-xs tabular-nums text-gray-400">{row.sourceId}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">
                        {row.participantName ?? <span className="text-red-600">No name</span>}
                      </div>
                      <div className="mt-0.5 whitespace-nowrap text-xs text-gray-400">
                        {formatUtc(row.submittedAt)}
                      </div>
                    </td>
                    <td className="px-4 py-3 min-w-56 max-w-sm">
                      <div className="font-medium text-gray-900">{row.projectTitle ?? '—'}</div>
                      {row.teamMembers && (
                        <div className="mt-0.5 text-xs text-gray-500">Team: {row.teamMembers}</div>
                      )}
                      {row.description && (
                        <p className="mt-1 line-clamp-2 text-xs text-gray-500" title={row.description}>
                          {row.description}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 min-w-44">
                      <div className="text-xs text-gray-700">{row.theme || NO_THEME_LABEL}</div>
                      {category ? (
                        <div className="mt-0.5 text-xs font-medium text-blue-700">
                          → {category.name}
                        </div>
                      ) : (
                        <div className="mt-0.5 text-xs text-amber-600">No category chosen</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        {row.ideaDocLength > 0 ? (
                          <Pill tone="emerald">Idea · {fmt(row.ideaDocLength)} chars</Pill>
                        ) : (
                          <Pill
                            tone="amber"
                            title={row.mdPath ? `Only the file name was stored: ${row.mdPath}` : undefined}
                          >
                            No idea doc
                          </Pill>
                        )}
                        {row.htmlLength === 0 ? (
                          <Pill tone="red">No HTML</Pill>
                        ) : row.htmlLength > MAX_SOURCE_CODE_LENGTH ? (
                          <Pill
                            tone="amber"
                            title="Over the Source Code limit: inline scripts are removed on sync (and the rest cut if still too long)."
                          >
                            HTML · {fmt(row.htmlLength)} chars · will be reduced
                          </Pill>
                        ) : (
                          <Pill tone="emerald">HTML · {fmt(row.htmlLength)} chars</Pill>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {row.syncedProject?.isActive ? (
                        <div>
                          <Pill tone="blue">Synced</Pill>
                          <div className="mt-1 text-xs">
                            <Link
                              href={`/admin/submissions/${row.syncedProject.id}`}
                              className="text-blue-600 hover:underline"
                            >
                              View in {row.syncedProject.categoryName}
                            </Link>
                          </div>
                        </div>
                      ) : row.syncedProject ? (
                        <div title="The synced project was deleted. Syncing again creates a new one.">
                          <Pill tone="gray">Deleted · can re-sync</Pill>
                        </div>
                      ) : (
                        <Pill tone="gray">Not synced</Pill>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function groupByEvent(categories: SyncCategoryOption[]): [string, SyncCategoryOption[]][] {
  const groups = new Map<string, SyncCategoryOption[]>()
  for (const c of categories) {
    const list = groups.get(c.eventName) ?? []
    list.push(c)
    groups.set(c.eventName, list)
  }
  return [...groups.entries()]
}

function SyncResultSummary({ result }: { result: SyncResponse }) {
  const withWarnings = result.created.filter((c) => c.warnings.length > 0)
  return (
    <div className="space-y-2 text-sm">
      <p className="text-gray-800">
        <span className="font-semibold text-emerald-700">{result.created.length} synced</span>
        {result.skipped.length > 0 && <> · {result.skipped.length} already synced</>}
        {result.failed.length > 0 && (
          <span className="text-red-700"> · {result.failed.length} failed</span>
        )}
        {result.queued > 0 && (
          <>
            {' '}
            — waiting in the scoring queue.{' '}
            <Link href="/admin/submissions" className="font-medium text-blue-600 hover:underline">
              Open Submissions to process it
            </Link>
          </>
        )}
      </p>
      {result.failed.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-red-700">
          {result.failed.map((f) => (
            <li key={f.sourceId}>
              #{f.sourceId}: {f.message}
            </li>
          ))}
        </ul>
      )}
      {withWarnings.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-700">
          {withWarnings.flatMap((c) =>
            c.warnings.map((w, i) => (
              <li key={`${c.sourceId}-${i}`}>
                <Link
                  href={`/admin/submissions/${c.projectId}`}
                  className="font-medium underline"
                >
                  #{c.sourceId}
                </Link>
                : {w}
              </li>
            )),
          )}
        </ul>
      )}
    </div>
  )
}

function Pill({
  tone,
  title,
  children,
}: {
  tone: 'gray' | 'amber' | 'blue' | 'emerald' | 'red'
  title?: string
  children: ReactNode
}) {
  const tones = {
    gray: 'bg-gray-50 text-gray-600 ring-gray-200',
    amber: 'bg-amber-50 text-amber-700 ring-amber-200',
    blue: 'bg-blue-50 text-blue-700 ring-blue-200',
    emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    red: 'bg-red-50 text-red-700 ring-red-200',
  }
  return (
    <span
      title={title}
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${tones[tone]}`}
    >
      {children}
    </span>
  )
}
