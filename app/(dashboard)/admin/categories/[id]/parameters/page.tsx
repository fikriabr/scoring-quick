// app/(dashboard)/admin/categories/[id]/parameters/page.tsx
// RSC page for managing scoring parameters within a category.
// Fetches category + parameters, renders the ParameterBuilder client component.
// Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6

import { getCategoryById } from '@/lib/services/category.service'
import { listParametersByCategory } from '@/lib/services/parameter.service'
import { notFound } from 'next/navigation'
import ParameterBuilder from '@/components/ParameterBuilder'
import { db } from '@/lib/db'

interface Props {
  params: Promise<{ id: string }>
}

export default async function AdminCategoryParametersPage({ params }: Props) {
  const { id } = await params
  const category = await getCategoryById(id)

  if (!category) {
    notFound()
  }

  const parameters = await listParametersByCategory(id)

  // Check if there are existing scores for any parameter in this category
  const parameterIds = parameters.map((p) => p.id)
  let hasExistingScores = false
  if (parameterIds.length > 0) {
    const scoreCount = await db.aIScore.count({
      where: { parameterId: { in: parameterIds } },
    })
    const juryScoreCount = await db.juryScore.count({
      where: { parameterId: { in: parameterIds } },
    })
    hasExistingScores = scoreCount + juryScoreCount > 0
  }

  return (
    <ParameterBuilder
      categoryId={id}
      categoryName={category.name}
      initialParameters={parameters.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        weight: p.weight,
        minScore: p.minScore,
        maxScore: p.maxScore,
        scoringMode: p.scoringMode,
        orderIndex: p.orderIndex,
      }))}
      hasExistingScores={hasExistingScores}
    />
  )
}
