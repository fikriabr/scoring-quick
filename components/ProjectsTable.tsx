'use client'

// app/(dashboard)/admin/submissions/ProjectsTable.tsx
// Client component: card-wrapped, horizontally scrollable table of projects
// with an expand/collapse toggle. By default only the first COLLAPSED_ROWS
// rows are shown; a footer button reveals the rest ("Show all N") or hides
// them again ("Show less"). The toggle only appears when a table has more
// rows than the collapsed limit.

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

// -----------------------------------------------------------------------
// SerializedProject — shape of a project row as rendered by this table
// -----------------------------------------------------------------------
export type SerializedProject = {
  id: string
  url: string
  participantName: string
  teamName: string | null
  crawlStatus: string
  scoreStatus: string
  categoryId: string
  categoryName: string
  categoryCreatedAt: string
  eventName: string
  createdAt: string
}

// Number of rows shown while collapsed.
const COLLAPSED_ROWS = 5

const ACTIVE_STATUSES = new Set(['PENDING', 'PROCESSING'])
const AUTO_REFRESH_INTERVAL_MS = 5 * 60_000

function isProjectProcessing(project: SerializedProject): boolean {
  return (
    ACTIVE_STATUSES.has(project.crawlStatus) ||
    ACTIVE_STATUSES.has(project.scoreStatus)
  )
}

// -----------------------------------------------------------------------
// ProjectsTable — card-wrapped, horizontally scrollable table of projects.
// Used per section so the header markup isn't duplicated.
// -----------------------------------------------------------------------
export default function ProjectsTable({
  projects,
}: {
  projects: SerializedProject[]
}) {
  const router = useRouter()
  const [isExpanded, setIsExpanded] = useState(false)

  const hasOverflow = projects.length > COLLAPSED_ROWS
  const visibleProjects =
    isExpanded || !hasOverflow ? projects : projects.slice(0, COLLAPSED_ROWS)
  const hiddenCount = projects.length - COLLAPSED_ROWS

  // While any project in this section is still crawling/scoring, refresh the
  // page's server data every 5 minutes so the status badges below move on
  // their own instead of looking stuck until a manual reload. Deliberately
  // coarser than ProcessingBanner's 1s poll — this refresh re-fetches the
  // whole list from the database, so a tight interval would scale badly with
  // many admins on this page at once.
  const isProcessing = projects.some(isProjectProcessing)

  useEffect(() => {
    if (!isProcessing) return
    const id = setInterval(() => router.refresh(), AUTO_REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [isProcessing, router])

  return (
    <div className="rounded-xl bg-white shadow-sm ring-1 ring-gray-100 overflow-hidden">
      {isProcessing && (
        <div className="flex items-center gap-2 border-b border-blue-100 bg-blue-50 px-4 py-2 text-xs font-medium text-blue-700">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 animate-pulse"
            aria-hidden="true"
          />
          Some submissions are still crawling/scoring — refreshing every 5 minutes.
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Participant
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                URL
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Crawl
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Score
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {visibleProjects.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
          </tbody>
        </table>
      </div>

      {hasOverflow && (
        <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-2 text-center">
          <button
            type="button"
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-expanded={isExpanded}
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors"
          >
            {isExpanded ? 'Show less' : `Show all ${projects.length}`}
            <span aria-hidden="true">{isExpanded ? '▲' : '▼'}</span>
          </button>
          {!isExpanded && (
            <span className="ml-2 text-xs text-gray-400">
              ({hiddenCount} hidden)
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------
// StatusBadge — renders a colored pill badge based on status enum value
// -----------------------------------------------------------------------
function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    PENDING: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200',
    PROCESSING: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200',
    SUCCESS: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200',
    FAILED: 'bg-red-50 text-red-700 ring-1 ring-red-200',
    PARTIAL: 'bg-orange-50 text-orange-700 ring-1 ring-orange-200',
  }

  const colorClass =
    colors[status] ?? 'bg-gray-50 text-gray-700 ring-1 ring-gray-200'

  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-medium rounded-full ${colorClass}`}
    >
      {status === 'PROCESSING' && (
        <span
          className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse"
          aria-hidden="true"
        />
      )}
      {status}
    </span>
  )
}

// -----------------------------------------------------------------------
// ProjectRow — renders a table row for a single project with action buttons
// -----------------------------------------------------------------------
function ProjectRow({ project }: { project: SerializedProject }) {
  return (
    <tr className="hover:bg-gray-50/50 transition-colors">
      <td className="px-4 py-3">
        <div className="font-medium text-gray-900">
          {project.participantName}
        </div>
        {project.teamName && (
          <div className="text-xs text-gray-500 mt-0.5">{project.teamName}</div>
        )}
      </td>
      <td className="px-4 py-3">
        <a
          href={project.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-700 hover:underline text-xs break-all transition-colors"
        >
          {project.url}
        </a>
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={project.crawlStatus} />
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={project.scoreStatus} />
      </td>
      {/*
        Actions cell — only "View" is exposed here; the retry crawl/score
        buttons are hidden on this list and remain available on the
        submission detail page (/admin/submissions/[projectId]).
      */}
      <td className="px-4 py-3 text-center align-middle">
        <div className="flex items-center justify-center">
          <Link
            href={`/admin/submissions/${project.id}`}
            className="px-2.5 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
          >
            View
          </Link>
        </div>
      </td>
    </tr>
  )
}
