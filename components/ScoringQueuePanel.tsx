// components/ScoringQueuePanel.tsx
// Admin control for the scoring queue: shows what is waiting and drives the
// worker endpoint from the browser.
//
// The browser is the scheduler here on purpose. The deployment's platform caps
// functions at ~60 seconds and (on the free plan) allows one cron run per day,
// so one request can only ever process a slice. This component keeps calling
// `POST /api/scoring/queue` until nothing is left, which makes an open tab a
// perfectly good worker for a few dozen projects. For a bulk run of thousands,
// `npm run score:queue` is the right tool — it has no timeout to work around.

'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface QueueStats {
  pending: number
  processing: number
  stuck: number
  failed: number
  scored: number
}

/**
 * `initialStats` is read on the server so the panel renders its counts with
 * the page — no fetch on mount, and no flash of an empty panel.
 */
export default function ScoringQueuePanel({ initialStats }: { initialStats: QueueStats }) {
  const router = useRouter()
  const [stats, setStats] = useState<QueueStats>(initialStats)
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch('/api/scoring/queue')
      if (!res.ok) return
      setStats((await res.json()) as QueueStats)
    } catch {
      // A failed poll is not worth an error banner; the next one may work.
    }
  }, [])

  // Poll while work is in flight — including work started by the CLI worker or
  // another admin, which is why this polls the server rather than tracking its
  // own counters.
  useEffect(() => {
    if (!running && stats.processing === 0) return
    const timer = setInterval(loadStats, 5000)
    return () => clearInterval(timer)
  }, [running, stats, loadStats])

  async function processQueue(retryFailed = false) {
    setRunning(true)
    setError(null)
    setMessage(null)
    let succeeded = 0
    let failed = 0

    try {
      for (;;) {
        const res = await fetch('/api/scoring/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ retryFailed }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(body?.message ?? `Request failed (HTTP ${res.status})`)
        }
        const result = await res.json()
        succeeded += result.succeeded
        failed += result.failed
        setMessage(
          `Scored ${succeeded}, failed ${failed}, ${result.remaining} still waiting...`,
        )
        await loadStats()
        // `claimed === 0` means the queue is empty; anything else means the
        // slice ended on its time budget and there is more to do.
        if (result.claimed === 0 || result.remaining === 0) break
        retryFailed = false // only the first slice resets failed projects
      }
      setMessage(`Finished. Scored ${succeeded}, failed ${failed}.`)
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not process the queue.')
    } finally {
      setRunning(false)
      loadStats()
    }
  }

  const waiting = stats.pending + stats.processing

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm ring-1 ring-gray-100">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Scoring Queue</h2>
          <p className="mt-1 text-xs text-gray-500">
            Imported submissions wait here. Single submissions are scored immediately.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => processQueue(false)}
            disabled={running || waiting === 0}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? 'Processing...' : 'Process Queue'}
          </button>
          {stats.failed > 0 && (
            <button
              type="button"
              onClick={() => processQueue(true)}
              disabled={running}
              className="rounded-lg bg-amber-50 px-4 py-2 text-sm font-medium text-amber-700 ring-1 ring-amber-200 transition-colors hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Retry {stats.failed} failed
            </button>
          )}
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Stat label="Waiting" value={stats.pending} tone={stats.pending > 0 ? 'amber' : 'gray'} />
          <Stat label="In flight" value={stats.processing} tone={stats.processing > 0 ? 'blue' : 'gray'} />
          <Stat label="Scored" value={stats.scored} tone="emerald" />
          <Stat label="Failed" value={stats.failed} tone={stats.failed > 0 ? 'red' : 'gray'} />
        <Stat label="Parked" value={stats.stuck} tone={stats.stuck > 0 ? 'red' : 'gray'} />
      </dl>

      {stats.stuck > 0 && (
        <p className="mt-3 text-xs text-red-600">
          {stats.stuck} project(s) used all their attempts and are no longer picked up.
          &quot;Retry failed&quot; resets them.
        </p>
      )}

      {stats.pending > 50 && (
        <p className="mt-3 text-xs text-gray-500">
          For a run this size, <code>npm run score:queue</code> is faster and does not
          depend on this tab staying open.
        </p>
      )}

      {message && <p className="mt-3 text-sm text-gray-700">{message}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'gray' | 'amber' | 'blue' | 'emerald' | 'red'
}) {
  const tones = {
    gray: 'text-gray-500',
    amber: 'text-amber-700',
    blue: 'text-blue-700',
    emerald: 'text-emerald-700',
    red: 'text-red-700',
  }
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2">
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className={`text-lg font-semibold tabular-nums ${tones[tone]}`}>{value}</dd>
    </div>
  )
}
