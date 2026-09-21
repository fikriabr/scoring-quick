// app/(dashboard)/admin/leaderboard/[categoryId]/page.tsx
// RSC page displaying the leaderboard for a specific category with export and publish actions.
// Requirements: 8.1, 8.2, 8.3, 8.4, 8.5

import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getLeaderboard } from '@/lib/services/leaderboard.service'
import { getCategoryById } from '@/lib/services/category.service'
import PublishButton from './PublishButton'
import { SCORING_TRACKS, TRACK_LABELS } from '@/lib/scoring/tracks'

interface PageProps {
  params: Promise<{ categoryId: string }>
}

export default async function AdminLeaderboardPage({ params }: PageProps) {
  const { categoryId } = await params
  const category = await getCategoryById(categoryId)

  if (!category) {
    notFound()
  }

  const projects = await getLeaderboard(categoryId)
  // IDEA parameters first, then HTML, each in its configured order.
  const parameters = SCORING_TRACKS.flatMap((track) =>
    category.parameters
      .filter((p) => p.track === track)
      .sort((a, b) => a.orderIndex - b.orderIndex),
  )

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Leaderboard: {category.name}</h1>
          {category.description && (
            <p className="text-gray-600 mt-1">{category.description}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <a
            href={`/api/export/${categoryId}?format=csv`}
            className="px-4 py-2 bg-gray-100 text-gray-800 border border-gray-300 rounded hover:bg-gray-200"
          >
            Export CSV
          </a>
          <a
            href={`/api/export/${categoryId}?format=excel`}
            className="px-4 py-2 bg-gray-100 text-gray-800 border border-gray-300 rounded hover:bg-gray-200"
          >
            Export Excel
          </a>
          <Link
            href={`/admin/leaderboard/${categoryId}/compare`}
            className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700"
          >
            Compare Projects
          </Link>
        </div>
      </div>

      {/* Publish section */}
      <div className="mb-6 p-4 bg-white rounded shadow">
        <h2 className="text-lg font-semibold mb-2">Public Access</h2>
        <PublishButton
          categoryId={categoryId}
          isPublished={category.isPublished}
          publicToken={category.publicToken}
        />
      </div>

      {/* Leaderboard table */}
      {projects.length === 0 ? (
        <p className="text-gray-500">
          No scored projects in this category yet.
        </p>
      ) : (
        <div className="overflow-x-auto bg-white rounded shadow">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Rank
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Participant / Team
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  URL
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                  Final Score
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                  {TRACK_LABELS.IDEA}
                  <span className="block text-[10px] text-gray-400 normal-case">
                    ({category.ideaWeight}%)
                  </span>
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                  {TRACK_LABELS.HTML}
                  <span className="block text-[10px] text-gray-400 normal-case">
                    ({category.htmlWeight}%)
                  </span>
                </th>
                {parameters.map((param) => (
                  <th
                    key={param.id}
                    className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase"
                    title={param.description ?? undefined}
                  >
                    {param.name}
                    <span className="block text-[10px] text-gray-400 normal-case">
                      ({param.track === 'IDEA' ? 'Idea' : 'HTML'} · w: {param.weight}%)
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {projects.map((project) => (
                <tr key={project.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    {project.rank}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900">
                    <div>{project.participantName}</div>
                    {project.teamName && (
                      <div className="text-xs text-gray-500">
                        {project.teamName}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {project.url ? (
                      <a
                        href={project.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline truncate block max-w-[200px]"
                      >
                        {project.url}
                      </a>
                    ) : (
                      <span className="text-xs text-gray-400">Source Code only</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900">
                    {project.finalScore != null
                      ? project.finalScore.toFixed(2)
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-700">
                    {project.ideaScore != null ? project.ideaScore.toFixed(2) : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-700">
                    {project.htmlScore != null ? project.htmlScore.toFixed(2) : '—'}
                  </td>
                  {parameters.map((param) => {
                    const aiScore = project.aiScores.find(
                      (s) => s.parameterId === param.id,
                    )
                    const juryScore = project.juryScores.find(
                      (s) => s.parameterId === param.id,
                    )
                    const displayScore = juryScore?.score ?? aiScore?.score
                    return (
                      <td
                        key={param.id}
                        className="px-4 py-3 text-sm text-right text-gray-700"
                      >
                        {displayScore != null ? (
                          <div>
                            <span>{displayScore.toFixed(1)}</span>
                            {juryScore && aiScore && (
                              <span className="block text-[10px] text-gray-400">
                                AI: {aiScore.score.toFixed(1)}
                              </span>
                            )}
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
