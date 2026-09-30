// lib/services/final-score.service.ts
// Single place where a project's ideaScore / htmlScore / finalScore are
// derived. Called after AI scoring and after every jury action, so the two
// paths can never disagree about the formula.

import { db } from '@/lib/db'
import {
  calculateTrackedFinalScore,
  type ScoringTrack,
  type TrackedScore,
} from '@/lib/scoring/tracks'

interface ParameterRow {
  id: string
  weight: number
  track: ScoringTrack
  /** Score range; absent means the default 0–100. */
  minScore?: number
  maxScore?: number
}

/**
 * A raw score on the parameter's own range, as a 0–100 value. Parameters may
 * use any range (1–5, 0–10…); weighting raw values would let a 0–100
 * parameter swamp a 1–5 one and push the final score off the 0–100 scale. On
 * the default 0–100 range this is the identity.
 */
export function normaliseScore(score: number, minScore = 0, maxScore = 100): number {
  if (minScore === 0 && maxScore === 100) return score
  const span = maxScore - minScore
  if (!(span > 0)) return score
  return ((score - minScore) / span) * 100
}

/**
 * Effective score per parameter, on a 0–100 scale:
 *   - the mean of the jury scores for that parameter, when any jury scored it;
 *   - otherwise the AI score, when there is one;
 *   - otherwise the parameter is left out (the track averages what is scored).
 *
 * With every jury scoring every parameter this equals the old "average of
 * each jury's weighted score" (the weighted sum is linear), but a jury who has
 * only reviewed the IDEA track no longer zeroes out the HTML track.
 */
export function effectiveParameterScores(
  parameters: ParameterRow[],
  aiScores: { parameterId: string; score: number }[],
  juryScores: { parameterId: string; score: number }[],
): TrackedScore[] {
  const result: TrackedScore[] = []
  for (const param of parameters) {
    const jury = juryScores.filter((s) => s.parameterId === param.id)
    const ai = aiScores.find((s) => s.parameterId === param.id)
    const score =
      jury.length > 0
        ? jury.reduce((sum, s) => sum + s.score, 0) / jury.length
        : ai?.score
    if (score !== undefined) {
      result.push({
        score: normaliseScore(score, param.minScore, param.maxScore),
        weight: param.weight,
        track: param.track,
      })
    }
  }
  return result
}

export async function recalculateProjectScores(projectId: string): Promise<{
  ideaScore: number | null
  htmlScore: number | null
  finalScore: number | null
}> {
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      categoryId: true,
      category: { select: { ideaWeight: true, htmlWeight: true } },
    },
  })

  const [parameters, aiScores, juryScores] = await Promise.all([
    db.parameter.findMany({
      where: { categoryId: project.categoryId },
      select: { id: true, weight: true, track: true, minScore: true, maxScore: true },
    }),
    db.aIScore.findMany({
      where: { projectId },
      select: { parameterId: true, score: true },
    }),
    db.juryScore.findMany({
      where: { projectId },
      select: { parameterId: true, score: true },
    }),
  ])

  const scores = effectiveParameterScores(parameters, aiScores, juryScores)
  const computed =
    scores.length > 0
      ? calculateTrackedFinalScore(scores, project.category)
      : { ideaScore: null, htmlScore: null, finalScore: null }

  await db.project.update({ where: { id: projectId }, data: computed })
  return computed
}

/** Recalculate every project in a category — after weights or parameters change. */
export async function recalculateCategoryScores(categoryId: string): Promise<void> {
  const projects = await db.project.findMany({
    where: { categoryId },
    select: { id: true },
  })
  for (const project of projects) {
    await recalculateProjectScores(project.id)
  }
}
