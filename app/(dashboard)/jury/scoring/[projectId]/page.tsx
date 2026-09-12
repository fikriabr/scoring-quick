// app/(dashboard)/jury/scoring/[projectId]/page.tsx
// RSC page for jury scoring: fetches project with metadata, AI scores,
// jury scores, and parameters, then renders the interactive scoring form.
// Requirements: 6.2, 6.3, 6.4, 6.5

import { auth } from '@/lib/auth/config'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { db } from '@/lib/db'
import JuryScoringForm from '@/components/JuryScoringForm'

export default async function JuryScoringPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const session = await auth()
  if (!session) {
    redirect('/login')
  }

  const { projectId } = await params
  const userId = session.user.id

  // Fetch project with full data: metadata, AI scores, jury scores, parameters
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: {
      category: {
        include: {
          parameters: {
            orderBy: { orderIndex: 'asc' },
          },
        },
      },
      metadata: true,
      aiScores: true,
      juryScores: {
        where: { juryId: userId },
      },
    },
  })

  // A deleted (isActive: false) submission is treated as not found for jury
  // — it's still reachable on the admin detail page by direct id, but jury
  // should never see or score something an admin has removed.
  if (!project || !project.isActive) {
    notFound()
  }

  // Verify jury is assigned to this category
  const assignment = await db.categoryJury.findFirst({
    where: {
      userId,
      categoryId: project.categoryId,
    },
  })

  if (!assignment) {
    // Return a forbidden message since jury is not assigned
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">Access Denied</h1>
        <p className="text-red-600">
          You are not assigned to score projects in this category.
        </p>
        <Link
          href="/jury/projects"
          className="mt-4 inline-block text-blue-600 hover:underline"
        >
          &larr; Back to project list
        </Link>
      </div>
    )
  }

  // Prepare data for the client component
  const parameters = project.category.parameters.map((param) => {
    const aiScore = project.aiScores.find((s) => s.parameterId === param.id)
    const juryScore = project.juryScores.find((s) => s.parameterId === param.id)

    return {
      id: param.id,
      name: param.name,
      description: param.description,
      weight: param.weight,
      minScore: param.minScore,
      maxScore: param.maxScore,
      aiScore: aiScore ? aiScore.score : null,
      aiReasoning: aiScore ? aiScore.reasoning : null,
      juryScore: juryScore ? juryScore.score : null,
      juryComment: juryScore ? juryScore.comment : null,
    }
  })

  const metadata = project.metadata
    ? {
        title: project.metadata.title,
        description: project.metadata.description,
        widgets: project.metadata.widgets as Array<{
          type: string
          label: string
        }>,
        prompts: project.metadata.prompts as string[],
        widgetCount: project.metadata.widgetCount,
      }
    : null

  return (
    <div>
      {/* Back link */}
      <Link
        href="/jury/projects"
        className="text-blue-600 hover:underline text-sm"
      >
        &larr; Back to project list
      </Link>

      {/* Project header */}
      <div className="mt-4 mb-6">
        <h1 className="text-2xl font-bold">{project.participantName}</h1>
        {project.teamName && (
          <p className="text-sm text-gray-500">Team: {project.teamName}</p>
        )}
        {project.url ? (
          <a
            href={project.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 hover:underline break-all"
          >
            {project.url}
          </a>
        ) : (
          <p className="text-sm text-gray-400">Source Code only — no URL.</p>
        )}
      </div>

      {/* CrawlMetadata section */}
      {metadata ? (
        <div className="mb-6 p-4 bg-white rounded shadow border border-gray-200">
          <h2 className="text-lg font-semibold mb-3">Crawl Metadata</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-sm font-medium text-gray-700">Title</p>
              <p className="text-sm text-gray-900">{metadata.title ?? 'N/A'}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-gray-700">Widget Count</p>
              <p className="text-sm text-gray-900">{metadata.widgetCount}</p>
            </div>
            <div className="md:col-span-2">
              <p className="text-sm font-medium text-gray-700">Description</p>
              <p className="text-sm text-gray-900">
                {metadata.description ?? 'N/A'}
              </p>
            </div>
          </div>

          {/* Widgets list */}
          {metadata.widgets.length > 0 && (
            <div className="mt-3">
              <p className="text-sm font-medium text-gray-700 mb-1">Widgets</p>
              <div className="flex flex-wrap gap-2">
                {metadata.widgets.map((widget, i) => (
                  <span
                    key={i}
                    className="inline-block px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded border border-gray-200"
                  >
                    {widget.type}
                    {widget.label ? ` — ${widget.label}` : ''}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Prompts list */}
          {metadata.prompts.length > 0 && (
            <div className="mt-3">
              <p className="text-sm font-medium text-gray-700 mb-1">Prompts</p>
              <ul className="list-disc list-inside text-sm text-gray-700 space-y-1">
                {metadata.prompts.map((prompt, i) => (
                  <li key={i} className="break-all">
                    {prompt || (
                      <span className="italic text-gray-400">empty</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded text-yellow-800 text-sm">
          Crawl metadata is not available for this project yet. Crawl status:{' '}
          <span className="font-medium">{project.crawlStatus}</span>
        </div>
      )}

      {/* Scoring form (client component) */}
      <JuryScoringForm projectId={project.id} parameters={parameters} />
    </div>
  )
}
