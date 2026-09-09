// app/(dashboard)/jury/projects/page.tsx
// RSC page listing projects assigned to the currently logged-in jury member.
// Shows scoring status badges and allows filtering by category.
// Requirements: 6.1, 7.6

import { auth } from '@/lib/auth/config'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { db } from '@/lib/db'

type ScoringStatus = 'not scored' | 'partial' | 'completed'

export default async function JuryProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>
}) {
  const session = await auth()

  if (!session) {
    redirect('/login')
  }

  const userId = session.user.id
  const params = await searchParams
  const selectedCategoryId = params.category

  // Fetch categories assigned to this jury
  const assignments = await db.categoryJury.findMany({
    where: { userId },
    include: {
      category: {
        select: { id: true, name: true },
      },
    },
  })

  const assignedCategoryIds = assignments.map((a) => a.categoryId)

  // If jury has no category assignments, show empty state
  if (assignedCategoryIds.length === 0) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6">My Projects</h1>
        <p className="text-gray-500">
          You have not been assigned to any category yet. Contact an Admin to
          get an assignment.
        </p>
      </div>
    )
  }

  // Determine which categories to fetch projects from
  const categoriesToFetch =
    selectedCategoryId && assignedCategoryIds.includes(selectedCategoryId)
      ? [selectedCategoryId]
      : assignedCategoryIds

  // Fetch projects in assigned categories with parameters and jury scores
  const projects = await db.project.findMany({
    where: { categoryId: { in: categoriesToFetch } },
    orderBy: { createdAt: 'desc' },
    include: {
      category: {
        select: {
          id: true,
          name: true,
          parameters: { select: { id: true } },
        },
      },
      juryScores: {
        where: { juryId: userId },
        select: { parameterId: true },
      },
    },
  })

  // Compute scoring status for each project
  const projectsWithStatus = projects.map((project) => {
    const totalParameters = project.category.parameters.length
    const scoredParameters = project.juryScores.length

    let status: ScoringStatus
    if (totalParameters === 0 || scoredParameters === 0) {
      status = 'not scored'
    } else if (scoredParameters >= totalParameters) {
      status = 'completed'
    } else {
      status = 'partial'
    }

    return {
      id: project.id,
      url: project.url,
      participantName: project.participantName,
      teamName: project.teamName,
      categoryId: project.category.id,
      categoryName: project.category.name,
      crawlStatus: project.crawlStatus,
      scoreStatus: project.scoreStatus,
      scoringStatus: status,
      totalParameters,
      scoredParameters,
    }
  })

  const categories = assignments.map((a) => a.category)

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">My Projects</h1>

      {/* Category filter */}
      <div className="mb-6 flex items-center gap-3">
        <span className="text-sm font-medium text-gray-700">
          Filter by Category:
        </span>
        <div className="flex gap-2 flex-wrap">
          <Link
            href="/jury/projects"
            className={`px-3 py-1 text-sm rounded border ${
              !selectedCategoryId
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
            }`}
          >
            All
          </Link>
          {categories.map((cat) => (
            <Link
              key={cat.id}
              href={`/jury/projects?category=${cat.id}`}
              className={`px-3 py-1 text-sm rounded border ${
                selectedCategoryId === cat.id
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
              }`}
            >
              {cat.name}
            </Link>
          ))}
        </div>
      </div>

      {/* Projects table */}
      {projectsWithStatus.length === 0 ? (
        <p className="text-gray-500">No projects in the selected category.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-gray-100 text-left">
                <th className="px-3 py-2 border-b font-medium">Participant</th>
                <th className="px-3 py-2 border-b font-medium">URL</th>
                <th className="px-3 py-2 border-b font-medium">Category</th>
                <th className="px-3 py-2 border-b font-medium">
                  Scoring Status
                </th>
                <th className="px-3 py-2 border-b font-medium">Progress</th>
                <th className="px-3 py-2 border-b font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {projectsWithStatus.map((project) => (
                <tr key={project.id} className="border-b hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <div className="font-medium">{project.participantName}</div>
                    {project.teamName && (
                      <div className="text-xs text-gray-500">
                        {project.teamName}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <a
                      href={project.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline text-xs break-all"
                    >
                      {project.url}
                    </a>
                  </td>
                  <td className="px-3 py-2 text-xs">{project.categoryName}</td>
                  <td className="px-3 py-2">
                    <ScoringStatusBadge status={project.scoringStatus} />
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">
                    {project.scoredParameters}/{project.totalParameters}{' '}
                    parameter
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/jury/scoring/${project.id}`}
                      className="inline-block px-3 py-1 text-xs font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700"
                    >
                      Score
                    </Link>
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

// -----------------------------------------------------------------------
// ScoringStatusBadge — renders a colored badge based on scoring status
// -----------------------------------------------------------------------
function ScoringStatusBadge({ status }: { status: ScoringStatus }) {
  const colors: Record<ScoringStatus, string> = {
    'not scored': 'bg-yellow-100 text-yellow-800',
    partial: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
  }

  return (
    <span
      className={`inline-block px-2 py-0.5 text-xs font-medium rounded ${colors[status]}`}
    >
      {status}
    </span>
  )
}
