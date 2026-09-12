// app/(dashboard)/admin/submissions/[projectId]/page.tsx
// RSC page displaying full detail for a single submission/project:
// crawl metadata, AI scores, and jury scores, plus retry actions and the
// per-type evidence panels.
// Requirements: 1.7, 3.1, 3.2, 3.3, 3.4, 3.5, 4.3, 4.4, 5.1, 5.5, 5.6

import { notFound } from 'next/navigation'
import Link from 'next/link'
import { db } from '@/lib/db'
import { RetryButton } from '@/components/SubmissionForm'
import SourceCodeEditor from '@/components/SourceCodeEditor'
import ProcessingBanner from '@/components/ProcessingBanner'
import DeleteSubmissionButton from '@/components/DeleteSubmissionButton'

interface PageProps {
  params: Promise<{ projectId: string }>
}

export default async function ProjectDetailPage({ params }: PageProps) {
  const { projectId } = await params

  // No explicit `select` here, so every Project column — projectType
  // included — comes back with the row. Requirements: 1.7
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: {
      category: true,
      metadata: true,
      aiScores: { include: { parameter: true } },
      juryScores: { include: { parameter: true } },
    },
  })

  if (!project) {
    notFound()
  }

  return (
    <div className="space-y-8">
      {/* Back link */}
      <Link
        href="/admin/submissions"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 transition-colors hover:text-blue-600"
      >
        <span>←</span>
        Back to Submissions
      </Link>

      {!project.isActive && (
        <div className="rounded-xl bg-red-50 p-4 text-sm font-medium text-red-700 ring-1 ring-red-200">
          This submission has been deleted. It is hidden from the submissions
          list, leaderboards, and jury queue — this detail page is still
          reachable by direct link.
        </div>
      )}

      {/* Live status while crawling/scoring is still running */}
      <ProcessingBanner
        projectId={project.id}
        crawlStatus={project.crawlStatus}
        crawlError={project.crawlError}
        scoreStatus={project.scoreStatus}
      />

      {/* Header card */}
      <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">
              {project.participantName}
            </h1>
            {project.teamName && (
              <p className="mt-1 text-sm text-gray-500">{project.teamName}</p>
            )}
            {project.url ? (
              <a
                href={project.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-sm text-blue-600 hover:text-blue-700 hover:underline break-all transition-colors"
              >
                {project.url}
              </a>
            ) : (
              <p className="mt-2 text-sm text-gray-400">
                No URL — evaluated from uploaded Source Code only.
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-500">
              <span className="rounded-md bg-gray-50 px-2 py-1">
                Category: {project.category.name}
              </span>
              <StatusBadge status={project.crawlStatus} />
              <StatusBadge status={project.scoreStatus} />
              {!project.isActive && (
                <span className="inline-flex items-center rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-700 ring-1 ring-red-200">
                  DELETED
                </span>
              )}
            </div>
          </div>

          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-gray-400">
              Final Score
            </div>
            <div className="text-3xl font-bold text-gray-900">
              {project.finalScore != null ? project.finalScore.toFixed(2) : '—'}
            </div>
          </div>
        </div>

        {/* Retry + delete actions */}
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-gray-50 pt-4">
          <RetryButton
            projectId={project.id}
            type="crawl"
            disabled={
              !project.isActive ||
              project.crawlStatus === 'PROCESSING' ||
              !project.url
            }
            title={!project.url ? 'No URL to crawl — this project was submitted with Source Code only.' : undefined}
          />
          <RetryButton
            projectId={project.id}
            type="score"
            disabled={!project.isActive || project.scoreStatus === 'PROCESSING'}
          />
          {project.isActive && (
            <DeleteSubmissionButton
              projectId={project.id}
              participantName={project.participantName}
              redirectTo="/admin/submissions"
            />
          )}
        </div>
      </div>

      {/* Crawl Metadata section */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Crawl Metadata
        </h2>
        <div className="rounded-xl bg-white p-6 shadow-sm ring-1 ring-gray-100">
          {!project.metadata ? (
            <p className="text-sm text-gray-500">
              No crawl metadata available yet. Crawl status:{' '}
              <span className="font-medium">{project.crawlStatus}</span>
            </p>
          ) : (
            <div className="space-y-5">
              <div>
                <div className="text-xs uppercase tracking-wide text-gray-400">
                  Title
                </div>
                <div className="mt-1 text-sm font-medium text-gray-900">
                  {project.metadata.title ?? '—'}
                </div>
              </div>

              {project.metadata.description && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-gray-400">
                    Description
                  </div>
                  <p className="mt-1 text-sm text-gray-700">
                    {project.metadata.description}
                  </p>
                </div>
              )}

              <div>
                <div className="text-xs uppercase tracking-wide text-gray-400">
                  Fetched HTML
                </div>
                {project.metadata.rawHtml ? (
                  <p className="mt-1 text-sm text-gray-700">
                    {project.metadata.rawHtml.length.toLocaleString()}{' '}
                    characters fetched.
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-amber-600">
                    No markup fetched yet. Paste Source Code below, or retry
                    the crawl.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Evidence section — the editor owns the Source Code availability and
          size indicator. */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Evidence</h2>
        <div className="space-y-4">
          <SourceCodeEditor
            projectId={project.id}
            sourceCode={project.sourceCode}
          />
        </div>
      </section>

      {/* AI Scores section */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">AI Scores</h2>
        <div className="rounded-xl bg-white shadow-sm ring-1 ring-gray-100 overflow-hidden">
          {project.aiScores.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">No AI scores yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Parameter
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Weight
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Score
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Reasoning
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {project.aiScores.map((aiScore) => (
                    <tr
                      key={aiScore.id}
                      className="hover:bg-gray-50/50 transition-colors"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {aiScore.parameter.name}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {aiScore.parameter.weight}%
                      </td>
                      <td className="px-4 py-3 font-semibold text-gray-900">
                        {aiScore.score.toFixed(1)}
                      </td>
                      <td className="px-4 py-3 text-gray-600 max-w-md">
                        {aiScore.reasoning}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Jury Scores section */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Jury Scores
        </h2>
        <div className="rounded-xl bg-white shadow-sm ring-1 ring-gray-100 overflow-hidden">
          {project.juryScores.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">No jury scores yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-100">
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Parameter
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Score
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Comment
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Jury
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {project.juryScores.map((juryScore) => (
                    <tr
                      key={juryScore.id}
                      className="hover:bg-gray-50/50 transition-colors"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {juryScore.parameter.name}
                      </td>
                      <td className="px-4 py-3 font-semibold text-gray-900">
                        {juryScore.score.toFixed(1)}
                      </td>
                      <td className="px-4 py-3 text-gray-600 max-w-md">
                        {juryScore.comment ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-400">
                        {juryScore.juryId}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

// -----------------------------------------------------------------------
// StatusBadge — renders a colored pill badge based on status enum value
// (kept in sync with the badge on the submissions list page)
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
      className={`inline-flex items-center px-2.5 py-0.5 text-xs font-medium rounded-full ${colorClass}`}
    >
      {status}
    </span>
  )
}
