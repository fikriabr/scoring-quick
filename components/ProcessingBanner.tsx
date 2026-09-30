// components/ProcessingBanner.tsx
// Live status banner for the project detail page. Crawling and AI scoring
// both run in the background after a submission — this polls
// `GET /api/submissions/[id]` every 1 second while either is still
// PENDING/PROCESSING, so an admin watching the page sees the pipeline
// actually moving instead of a static badge that looks stuck.

'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

const ACTIVE_STATUSES = new Set(['PENDING', 'PROCESSING'])
// Poll and elapsed-time tick share one cadence now, so a single interval
// drives both.
const POLL_INTERVAL_MS = 1_000

interface ProcessingBannerProps {
  projectId: string
  /** Whether there is a page to fetch at all; synced/pasted projects have none. */
  hasUrl: boolean
  crawlStatus: string
  crawlError: string | null
  scoreStatus: string
}

/**
 * What the pipeline is doing right now, in words. PENDING means *nothing is
 * running yet*: a single submission leaves it within a second, but an imported
 * or synced project stays there until a queue worker claims it — so it reads
 * as queued, with where to start it, rather than as work in progress.
 */
function describeStage(hasUrl: boolean, crawlStatus: string, scoreStatus: string) {
  if (crawlStatus === 'PROCESSING') {
    return { queued: false, text: 'Fetching page markup and analyzing HTML structure...' }
  }
  if (scoreStatus === 'PROCESSING') {
    return { queued: false, text: 'Running AI scoring on each parameter...' }
  }
  return {
    queued: true,
    text:
      crawlStatus === 'PENDING' && hasUrl
        ? 'Queued — waiting to fetch the page and run AI scoring.'
        : 'Queued — waiting for AI scoring to start.',
  }
}

type Status = {
  crawlStatus: string
  crawlError: string | null
  scoreStatus: string
}

export default function ProcessingBanner({
  projectId,
  hasUrl,
  crawlStatus: initialCrawlStatus,
  crawlError: initialCrawlError,
  scoreStatus: initialScoreStatus,
}: ProcessingBannerProps) {
  const router = useRouter()
  const [status, setStatus] = useState<Status>({
    crawlStatus: initialCrawlStatus,
    crawlError: initialCrawlError,
    scoreStatus: initialScoreStatus,
  })
  // Remembers the props last synced into `status`, so a change in the
  // *incoming* props (the parent's server component re-fetched, e.g. after
  // router.refresh() below or a Retry button click) can be applied during
  // render — React's documented pattern for adjusting state from props —
  // instead of via an effect that would trigger an extra render pass.
  const [syncedFrom, setSyncedFrom] = useState({
    crawlStatus: initialCrawlStatus,
    crawlError: initialCrawlError,
    scoreStatus: initialScoreStatus,
  })
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [pollError, setPollError] = useState<string | null>(null)

  if (
    syncedFrom.crawlStatus !== initialCrawlStatus ||
    syncedFrom.crawlError !== initialCrawlError ||
    syncedFrom.scoreStatus !== initialScoreStatus
  ) {
    // A new run started (e.g. Retry Score after a finished one): count its
    // time from zero, not on top of the previous run's.
    const wasRunning =
      ACTIVE_STATUSES.has(status.crawlStatus) || ACTIVE_STATUSES.has(status.scoreStatus)
    const nowRunning =
      ACTIVE_STATUSES.has(initialCrawlStatus) || ACTIVE_STATUSES.has(initialScoreStatus)
    if (!wasRunning && nowRunning) setElapsedSeconds(0)

    setSyncedFrom({
      crawlStatus: initialCrawlStatus,
      crawlError: initialCrawlError,
      scoreStatus: initialScoreStatus,
    })
    setStatus({
      crawlStatus: initialCrawlStatus,
      crawlError: initialCrawlError,
      scoreStatus: initialScoreStatus,
    })
  }

  const { crawlStatus, crawlError, scoreStatus } = status

  const isActive =
    ACTIVE_STATUSES.has(crawlStatus) || ACTIVE_STATUSES.has(scoreStatus)

  // Tracks whether the *previous* poll still saw the pipeline active, purely
  // to decide whether the transition into "done" deserves one extra
  // router.refresh() (metadata/AI score tables are server-rendered and need
  // it to pick up the finished result).
  const wasActiveRef = useRef(isActive)

  useEffect(() => {
    if (!isActive) return
    // Became active from props (Retry button + refresh) rather than from a
    // poll: mark it, so the poll that sees the run finish still refreshes.
    wasActiveRef.current = true

    const poll = setInterval(async () => {
      setElapsedSeconds((s) => s + 1)

      try {
        const res = await fetch(`/api/submissions/${projectId}`, {
          cache: 'no-store',
        })
        if (!res.ok) {
          setPollError(`Status check failed (HTTP ${res.status}).`)
          return
        }
        const data = await res.json()
        setPollError(null)
        setStatus({
          crawlStatus: data.crawlStatus,
          crawlError: data.crawlError ?? null,
          scoreStatus: data.scoreStatus,
        })

        const stillActive =
          ACTIVE_STATUSES.has(data.crawlStatus) ||
          ACTIVE_STATUSES.has(data.scoreStatus)

        if (wasActiveRef.current && !stillActive) {
          // Just finished — pull the fresh crawl metadata / AI scores that
          // the rest of this (server-rendered) page depends on.
          router.refresh()
        }
        wasActiveRef.current = stillActive
      } catch {
        setPollError('Network error while checking status.')
      }
    }, POLL_INTERVAL_MS)

    return () => clearInterval(poll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, projectId])

  if (!isActive) return null

  const stage = describeStage(hasUrl, crawlStatus, scoreStatus)

  return (
    <div className="rounded-xl bg-blue-50 p-4 ring-1 ring-blue-200">
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-blue-500 animate-pulse"
          aria-hidden="true"
        />
        <p className="text-sm font-medium text-blue-900">{stage.text}</p>
      </div>
      {stage.queued && (
        <p className="mt-1 text-xs text-blue-800">
          Imported and synced submissions are scored by the queue: use{' '}
          <Link href="/admin/submissions" className="font-medium underline">
            Process Queue on the Submissions page
          </Link>{' '}
          or run <code>npm run score:queue</code>.
        </p>
      )}

      {/* Indeterminate progress bar — there's no real percentage to report,
          this just signals "still moving" while polling continues. */}
      <div className="relative mt-3 h-1.5 w-full overflow-hidden rounded-full bg-blue-100">
        <div className="absolute inset-y-0 rounded-full bg-blue-500 animate-progress-indeterminate" />
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-blue-700">
        <span>
          {stage.queued ? 'Waiting' : 'Elapsed'}: {elapsedSeconds}s · checking again every 1s
        </span>
        {crawlError && (
          <span className="text-amber-700">Last crawl error: {crawlError}</span>
        )}
      </div>

      {pollError && (
        <p className="mt-2 text-xs text-red-600">{pollError}</p>
      )}
    </div>
  )
}
