// app/(dashboard)/admin/submissions/page.tsx
// RSC page listing all submissions/projects with status badges. The submission
// form and CSV upload live on a separate page (./new); this page links to it.
// Requirements: 1.7, 3.1, 3.2, 3.3, 3.4, 3.5, 4.3, 4.4

import Link from 'next/link'
import { db } from '@/lib/db'
import { groupProjectsByCategory } from '@/lib/submission-grouping'
import ProjectsTable from '@/components/ProjectsTable'

export default async function AdminSubmissionsPage() {
  // Fetch all projects with category info
  const projects = await db.project.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      category: {
        select: {
          id: true,
          name: true,
          createdAt: true,
          event: { select: { name: true } },
        },
      },
    },
  })

  const serializedProjects = projects.map((p) => ({
    id: p.id,
    url: p.url,
    participantName: p.participantName,
    teamName: p.teamName,
    crawlStatus: p.crawlStatus,
    scoreStatus: p.scoreStatus,
    categoryId: p.categoryId,
    categoryName: p.category.name,
    categoryCreatedAt: p.category.createdAt.toISOString(),
    eventName: p.category.event.name,
    createdAt: p.createdAt.toISOString(),
  }))

  // Group projects into one section per category (event + category name),
  // sorted by event then category. Empty categories never appear here.
  const groups = groupProjectsByCategory(serializedProjects)

  return (
    <div className="space-y-8">
      {/* Page header with a link to the add-submission page */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Submissions</h1>
          <p className="mt-1 text-sm text-gray-500">
            Browse and manage existing submissions
          </p>
        </div>
        <Link
          href="/admin/submissions/new"
          className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-blue-700"
        >
          <span aria-hidden="true">+</span> Add Submission
        </Link>
      </div>

      {/* Project list table */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Projects ({serializedProjects.length})
        </h2>

        {serializedProjects.length === 0 ? (
          <div className="rounded-xl bg-white p-8 shadow-sm ring-1 ring-gray-100 text-center">
            <p className="text-gray-500 text-sm">No projects submitted yet.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <section key={group.categoryId}>
                <h3 className="text-base font-semibold text-gray-800 mb-3">
                  {group.heading} ({group.projects.length})
                </h3>
                <ProjectsTable projects={group.projects} />
              </section>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
