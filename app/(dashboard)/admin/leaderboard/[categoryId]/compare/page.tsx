// app/(dashboard)/admin/leaderboard/[categoryId]/compare/page.tsx
// RSC page for side-by-side project comparison within a category.
// Requirements: 8.4

import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getLeaderboard } from '@/lib/services/leaderboard.service'
import { getCategoryById } from '@/lib/services/category.service'
import ProjectComparison from '@/components/ProjectComparison'

interface ComparePageProps {
  params: Promise<{ categoryId: string }>
}

export default async function ComparePage({ params }: ComparePageProps) {
  const { categoryId } = await params

  const category = await getCategoryById(categoryId)
  if (!category) {
    notFound()
  }

  const leaderboard = await getLeaderboard(categoryId)

  // Map projects for the comparison component
  const projects = leaderboard.map((project) => ({
    id: project.id,
    participantName: project.participantName,
    teamName: project.teamName,
    url: project.url,
    finalScore: project.finalScore,
    rank: project.rank ?? null,
    aiScores: project.aiScores,
    juryScores: project.juryScores,
  }))

  // Map parameters for the comparison component
  const parameters = category.parameters.map((p) => ({
    id: p.id,
    name: p.name,
    weight: p.weight,
    minScore: p.minScore,
    maxScore: p.maxScore,
  }))

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Compare Projects</h1>
          <p className="text-gray-500 text-sm mt-1">
            Category: {category.name}
          </p>
        </div>
        <Link
          href={`/admin/leaderboard/${categoryId}`}
          className="px-4 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
        >
          Back to Leaderboard
        </Link>
      </div>

      <ProjectComparison projects={projects} parameters={parameters} />
    </div>
  )
}
