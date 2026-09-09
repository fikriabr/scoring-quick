// lib/services/jury.service.ts
// Jury scoring operations: submit scores, accept AI scores, recalculate finals.
// Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  calculateWeightedScore,
  calculateAverageJuryScore,
} from '@/lib/services/leaderboard.service'
import { revalidatePath } from 'next/cache'

// -----------------------------------------------------------------------
// Error classes
// -----------------------------------------------------------------------

export class JuryAccessError extends Error {
  readonly statusCode = 403
  constructor(message = 'Jury is not assigned to this category') {
    super(message)
    this.name = 'JuryAccessError'
  }
}

export class ScoreValidationError extends Error {
  readonly statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'ScoreValidationError'
  }
}

// -----------------------------------------------------------------------
// submitJuryScore
// Validates jury access, score range, override threshold, then upserts
// the jury score, creates an audit log, and recalculates the project's
// final score.
//
// Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
// -----------------------------------------------------------------------
export async function submitJuryScore(
  projectId: string,
  parameterId: string,
  juryId: string,
  score: number,
  comment: string | null,
): Promise<void> {
  // 1. Check jury access — jury must be assigned to the category that owns this project
  const assignment = await db.categoryJury.findFirst({
    where: {
      userId: juryId,
      category: {
        projects: {
          some: { id: projectId },
        },
      },
    },
  })

  if (!assignment) {
    throw new JuryAccessError()
  }

  // 2. Fetch parameter to get score range
  const parameter = await db.parameter.findUniqueOrThrow({
    where: { id: parameterId },
  })

  // 3. Validate score is within configured range
  if (score < parameter.minScore || score > parameter.maxScore) {
    throw new ScoreValidationError(
      `Score must be between ${parameter.minScore} and ${parameter.maxScore}`,
    )
  }

  // 4. Check override threshold: if deviation from AI score > 20% of range, comment is required
  const aiScore = await db.aIScore.findFirst({
    where: { projectId, parameterId },
  })

  if (aiScore) {
    const range = parameter.maxScore - parameter.minScore
    const threshold = 0.2 * range
    const deviation = Math.abs(score - aiScore.score)

    if (deviation > threshold && (!comment || comment.trim() === '')) {
      throw new ScoreValidationError(
        `Comment is required when score deviates more than 20% from AI score (deviation: ${deviation.toFixed(2)}, threshold: ${threshold.toFixed(2)})`,
      )
    }
  }

  // 5. Fetch existing jury score for audit trail
  const existingScore = await db.juryScore.findFirst({
    where: { projectId, parameterId, juryId },
  })

  // 6. Upsert JuryScore
  await db.juryScore.upsert({
    where: {
      projectId_parameterId_juryId: {
        projectId,
        parameterId,
        juryId,
      },
    },
    create: {
      projectId,
      parameterId,
      juryId,
      score,
      comment,
      isOverride: true,
    },
    update: {
      score,
      comment,
      isOverride: true,
    },
  })

  // 7. Create AuditLog
  await db.auditLog.create({
    data: {
      projectId,
      userId: juryId,
      parameterId,
      action: 'JURY_SCORE',
      oldValue: existingScore
        ? existingScore.score
        : Prisma.JsonNull,
      newValue: score,
    },
  })

  // 8-9. Recalculate finalScore and update project
  await recalculateFinalScore(projectId)

  // 10. Revalidate leaderboard pages
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { categoryId: true },
  })
  revalidatePath(`/admin/leaderboard/${project.categoryId}`)
  revalidatePath(`/public/leaderboard`)
}

// -----------------------------------------------------------------------
// acceptAiScore
// Copies an AI score to JuryScore with isOverride = false, creates an
// audit log, and recalculates the project's final score.
//
// Requirements: 6.5, 6.6, 6.7
// -----------------------------------------------------------------------
export async function acceptAiScore(
  projectId: string,
  parameterId: string,
  juryId: string,
): Promise<void> {
  // 1. Fetch AI score for this project+parameter
  const aiScore = await db.aIScore.findFirst({
    where: { projectId, parameterId },
  })

  if (!aiScore) {
    throw new ScoreValidationError(
      'No AI score found for this project and parameter',
    )
  }

  // Check jury access
  const assignment = await db.categoryJury.findFirst({
    where: {
      userId: juryId,
      category: {
        projects: {
          some: { id: projectId },
        },
      },
    },
  })

  if (!assignment) {
    throw new JuryAccessError()
  }

  // Fetch existing jury score for audit trail
  const existingScore = await db.juryScore.findFirst({
    where: { projectId, parameterId, juryId },
  })

  // 2. Copy AI score to JuryScore with isOverride = false
  await db.juryScore.upsert({
    where: {
      projectId_parameterId_juryId: {
        projectId,
        parameterId,
        juryId,
      },
    },
    create: {
      projectId,
      parameterId,
      juryId,
      score: aiScore.score,
      comment: null,
      isOverride: false,
    },
    update: {
      score: aiScore.score,
      comment: null,
      isOverride: false,
    },
  })

  // 3. Create AuditLog
  await db.auditLog.create({
    data: {
      projectId,
      userId: juryId,
      parameterId,
      action: 'JURY_SCORE',
      oldValue: existingScore
        ? existingScore.score
        : Prisma.JsonNull,
      newValue: aiScore.score,
    },
  })

  // 4. Recalculate finalScore
  await recalculateFinalScore(projectId)

  // Revalidate leaderboard pages
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { categoryId: true },
  })
  revalidatePath(`/admin/leaderboard/${project.categoryId}`)
  revalidatePath(`/public/leaderboard`)
}

// -----------------------------------------------------------------------
// recalculateFinalScore
// Fetches all jury scores for a project, groups by juryId, computes
// each jury's weighted score, then averages across juries for the final.
//
// Requirements: 6.4, 6.7
// -----------------------------------------------------------------------
async function recalculateFinalScore(projectId: string): Promise<void> {
  // Fetch all jury scores for this project, joined with parameter weights
  const juryScores = await db.juryScore.findMany({
    where: { projectId },
    include: {
      parameter: {
        select: { weight: true },
      },
    },
  })

  if (juryScores.length === 0) {
    // No jury scores yet — leave finalScore unchanged
    return
  }

  // Group scores by juryId
  const scoresByJury = new Map<
    string,
    Array<{ score: number; weight: number }>
  >()

  for (const js of juryScores) {
    const existing = scoresByJury.get(js.juryId) ?? []
    existing.push({ score: js.score, weight: js.parameter.weight })
    scoresByJury.set(js.juryId, existing)
  }

  // Calculate each jury's individual weighted score
  const perJuryWeightedScores: number[] = []
  for (const scores of scoresByJury.values()) {
    perJuryWeightedScores.push(calculateWeightedScore(scores))
  }

  // Final score: average of all jury weighted scores
  let finalScore: number
  if (perJuryWeightedScores.length === 1) {
    finalScore = perJuryWeightedScores[0]
  } else {
    finalScore = calculateAverageJuryScore(perJuryWeightedScores)
  }

  // Update project's finalScore
  await db.project.update({
    where: { id: projectId },
    data: { finalScore },
  })
}
