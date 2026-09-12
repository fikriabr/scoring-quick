// app/public/leaderboard/[token]/page.tsx
// Public leaderboard RSC page — no auth required.
// Fetches leaderboard by publicToken; returns 404 if token invalid or unpublished.
// Requirements: 8.5, 9.1

import { notFound } from 'next/navigation'
import { getPublicLeaderboard } from '@/lib/services/leaderboard.service'

// Time-based ISR: revalidate every 30 seconds as a fallback
export const revalidate = 30

interface PageProps {
  params: Promise<{ token: string }>
}

export default async function PublicLeaderboardPage({ params }: PageProps) {
  const { token } = await params
  const projects = await getPublicLeaderboard(token)

  if (!projects) {
    notFound()
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Leaderboard</h1>

      {projects.length === 0 ? (
        <p className="text-gray-500">No scored projects yet.</p>
      ) : (
        <div className="overflow-x-auto bg-white rounded shadow">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Rank
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Participant
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  URL
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                  Final Score
                </th>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
