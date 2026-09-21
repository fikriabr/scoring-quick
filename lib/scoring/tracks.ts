// lib/scoring/tracks.ts
//
// Two-track scoring model. A submission carries two files, each judged on its
// own parameter set:
//
//   IDEA — the idea document (markdown): problem, originality, feasibility…
//   HTML — the built page: structure, accessibility, code quality…
//
// Parameter weights are normalised *within* a track (each track's weights
// total 100%), and the category decides how the two track scores are blended
// into the final score (`ideaWeight + htmlWeight = 100`, e.g. 60/40).
//
// Kept free of `@/lib/db` and of value imports from `@prisma/client` so client
// components (ParameterBuilder, JuryScoringForm) can import it.

export type ScoringTrack = 'IDEA' | 'HTML'

export const SCORING_TRACKS: readonly ScoringTrack[] = ['IDEA', 'HTML']

export const TRACK_LABELS: Record<ScoringTrack, string> = {
  IDEA: 'Idea (Markdown)',
  HTML: 'HTML',
}

export const DEFAULT_TRACK_WEIGHTS = { ideaWeight: 60, htmlWeight: 40 } as const

export const MAX_CRITIC_ROUNDS_LIMIT = 5

export interface TrackWeights {
  ideaWeight: number
  htmlWeight: number
}

export function trackWeightOf(track: ScoringTrack, weights: TrackWeights): number {
  return track === 'IDEA' ? weights.ideaWeight : weights.htmlWeight
}

/**
 * Weighted score of one track: Σ(score × weight) / Σ(weight).
 *
 * Divided by the weight actually present rather than a fixed 100 so a track
 * that is only partly scored (a MANUAL parameter the jury has not filled in
 * yet) reports the average of what *is* scored instead of being dragged
 * towards zero. With a full track the two are identical, because the track's
 * weights total 100.
 */
export function calculateTrackScore(
  scores: { score: number; weight: number }[],
): number | null {
  const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0)
  if (scores.length === 0 || totalWeight <= 0) return null
  return scores.reduce((sum, s) => sum + s.score * s.weight, 0) / totalWeight
}

/**
 * Blend the two track scores into the final score.
 *
 * Both files are mandatory, so a track without a score means scoring is not
 * finished; that track contributes 0 — it is never silently re-weighted onto
 * the other track, which would let a missing idea be carried by a pretty page.
 */
export function combineTrackScores(
  trackScores: Partial<Record<ScoringTrack, number | null>>,
  weights: TrackWeights,
): number {
  return SCORING_TRACKS.reduce((sum, track) => {
    const score = trackScores[track]
    return sum + (score ?? 0) * (trackWeightOf(track, weights) / 100)
  }, 0)
}

export interface TrackedScore {
  score: number
  weight: number
  track: ScoringTrack
}

/** Group per-parameter scores by track and compute each track + the final. */
export function calculateTrackedFinalScore(
  scores: TrackedScore[],
  weights: TrackWeights,
): { ideaScore: number | null; htmlScore: number | null; finalScore: number } {
  const ideaScore = calculateTrackScore(scores.filter((s) => s.track === 'IDEA'))
  const htmlScore = calculateTrackScore(scores.filter((s) => s.track === 'HTML'))
  return {
    ideaScore,
    htmlScore,
    finalScore: combineTrackScores({ IDEA: ideaScore, HTML: htmlScore }, weights),
  }
}
