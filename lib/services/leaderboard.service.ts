// lib/services/leaderboard.service.ts
// Leaderboard data retrieval and score calculation utilities.
// Requirements: 8.1, 8.2, 8.5

import { db } from '@/lib/db'
import type { ProjectWithScores } from '@/types'

// -----------------------------------------------------------------------
// calculateWeightedScore
// Computes the weighted final score for a project given an array of
// {score, weight} pairs.
// Formula: Σ (score_i × weight_i) / 100
// Returns 0 for an empty array.
// Requirements: 5.9, 6.4
// -----------------------------------------------------------------------
export function calculateWeightedScore(
  scores: { score: number; weight: number }[],
): number {
  if (scores.length === 0) return 0
  return scores.reduce(
    (sum, { score, weight }) => sum + (score * weight) / 100,
    0,
  )
}

// -----------------------------------------------------------------------
// calculateAverageJuryScore
// Computes the arithmetic mean of an array of per-jury weighted scores.
// Returns 0 for an empty array.
// Requirements: 6.7
// -----------------------------------------------------------------------
export function calculateAverageJuryScore(juryScores: number[]): number {
  if (juryScores.length === 0) return 0
  return juryScores.reduce((sum, s) => sum + s, 0) / juryScores.length
}

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

/**
 * Sort comparator implementing leaderboard ordering:
 *   1. Descending by finalScore (non-null first)
 *   2. Null finalScore → pushed to end
 *   3. Tie-break: ascending by createdAt
 */
function leaderboardComparator(
  a: { finalScore: number | null; createdAt: Date },
  b: { finalScore: number | null; createdAt: Date },
): number {
  const aScore = a.finalScore
  const bScore = b.finalScore

  if (aScore === null && bScore === null) {
    return a.createdAt.getTime() - b.createdAt.getTime()
  }
  if (aScore === null) return 1   // a goes after b
  if (bScore === null) return -1  // b goes after a

  if (bScore !== aScore) {
    return bScore - aScore  // descending
  }

  // Tie-break: earlier createdAt ranks higher
  return a.createdAt.getTime() - b.createdAt.getTime()
}

/** Prisma include shape used for both public and private leaderboard. */
const PROJECT_INCLUDE = {
  aiScores: true,
  juryScores: true,
} as const

/** Maps a raw Prisma project row to the ProjectWithScores shape and adds rank. */
function toRankedProjects(
  rows: Array<{
    id: string
    categoryId: string
    url: string
    participantName: string
    teamName: string | null
    crawlStatus: import('@prisma/client').CrawlStatus
    scoreStatus: import('@prisma/client').ScoreStatus
    finalScore: number | null
    createdAt: Date
    updatedAt: Date
    crawlError: string | null
    aiScores: Array<{ parameterId: string; score: number; reasoning: string }>
    juryScores: Array<{
      parameterId: string
      juryId: string
      score: number
      comment: string | null
    }>
  }>,
): ProjectWithScores[] {
  const sorted = [...rows].sort(leaderboardComparator)

  return sorted.map((project, index) => ({
    id: project.id,
    categoryId: project.categoryId,
    url: project.url,
    participantName: project.participantName,
    teamName: project.teamName,
    crawlStatus: project.crawlStatus,
    scoreStatus: project.scoreStatus,
    finalScore: project.finalScore,
    createdAt: project.createdAt,
    aiScores: project.aiScores.map((s) => ({
      parameterId: s.parameterId,
      score: s.score,
      reasoning: s.reasoning,
    })),
    juryScores: project.juryScores.map((s) => ({
      parameterId: s.parameterId,
      juryId: s.juryId,
      score: s.score,
      comment: s.comment,
    })),
    rank: index + 1,
  }))
}

// -----------------------------------------------------------------------
// getLeaderboard
// Fetches all projects in the given category with their AI scores and
// jury scores, then returns them sorted and ranked.
//
// Sort order:
//   • Descending by finalScore
//   • null finalScore → end of list
//   • Tie-break: ascending createdAt
//
// Requirements: 8.1, 8.2
// -----------------------------------------------------------------------
export async function getLeaderboard(
  categoryId: string,
): Promise<ProjectWithScores[]> {
  const projects = await db.project.findMany({
    where: { categoryId },
    include: PROJECT_INCLUDE,
  })

  return toRankedProjects(projects)
}

// -----------------------------------------------------------------------
// getPublicLeaderboard
// Looks up a category by its publicToken.
// Returns null if the token does not exist or isPublished is false.
// Otherwise returns the same ranked leaderboard as getLeaderboard.
//
// Requirements: 8.5
// -----------------------------------------------------------------------
export async function getPublicLeaderboard(
  publicToken: string,
): Promise<ProjectWithScores[] | null> {
  const category = await db.category.findUnique({
    where: { publicToken },
  })

  if (!category || !category.isPublished) {
    return null
  }

  return getLeaderboard(category.id)
}
