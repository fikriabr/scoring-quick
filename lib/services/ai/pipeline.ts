// lib/services/ai/pipeline.ts
// The evaluator ⇄ critic loop for one track.
//
//   round 1:  Evaluator scores → Critic audits
//   rejected: Evaluator re-scores with the critic's findings → Critic audits
//   …         up to `maxCriticRounds` re-evaluations
//
// If the critic still rejects after the last allowed round, the last
// evaluation is kept but marked `approved: false`, so the UI can flag it for
// the jury instead of silently trusting (or silently discarding) it.

import type { LlmClient } from './llm'
import type { TrackEvidence } from './evidence'
import {
  buildEvaluatorPrompt,
  parseEvaluatorResponse,
  type EvaluatedParameter,
  type ParameterEvaluation,
} from './evaluator'
import { buildCriticPrompt, parseCriticResponse, type CriticVerdict } from './critic'

export interface EvaluationRound {
  round: number
  evaluation: ParameterEvaluation[]
  /** null when the critic is disabled or the critic call failed. */
  critique: CriticVerdict | null
  /** Set when the critic call failed; the evaluation is kept un-audited. */
  criticError?: string
  /**
   * Set when the critic reversed its own previous finding on a parameter
   * (e.g. "too high" then "too low"). The loop stops there: more rounds would
   * only swing the score back and forth. It usually means the parameter's
   * criterion is ambiguous and should be rewritten.
   */
  oscillation?: { parameterIds: string[] }
  approved: boolean
}

export interface TrackEvaluationResult {
  scores: ParameterEvaluation[]
  /**
   * true  — the critic approved the final evaluation;
   * false — the critic still found bias after the last allowed round;
   * null  — not audited (critic disabled, or the critic call failed).
   */
  approved: boolean | null
  rounds: EvaluationRound[]
}

export interface TrackEvaluationOptions {
  evidence: TrackEvidence
  parameters: EvaluatedParameter[]
  llm: LlmClient
  criticEnabled: boolean
  /** Number of re-evaluations allowed after a rejection (0 = audit only). */
  maxCriticRounds: number
}

/**
 * Parameters the critic flagged in opposite directions in two consecutive
 * rounds (too_high → too_low or the reverse).
 */
export function findReversals(
  previous: CriticVerdict | null,
  current: CriticVerdict,
): string[] {
  if (!previous) return []
  const before = new Map<string, string>()
  for (const f of previous.findings) {
    if (f.parameterId && f.direction) before.set(f.parameterId, f.direction)
  }
  const reversed = new Set<string>()
  for (const f of current.findings) {
    const prior = f.parameterId ? before.get(f.parameterId) : undefined
    if (prior && f.direction && prior !== f.direction) reversed.add(f.parameterId!)
  }
  return [...reversed]
}

export async function runTrackEvaluation({
  evidence,
  parameters,
  llm,
  criticEnabled,
  maxCriticRounds,
}: TrackEvaluationOptions): Promise<TrackEvaluationResult> {
  const rounds: EvaluationRound[] = []
  let retry: { previous: ParameterEvaluation[]; critique: CriticVerdict } | undefined

  for (let round = 1; ; round++) {
    // An evaluator failure propagates: with no scores there is nothing to keep.
    const evaluation = parseEvaluatorResponse(
      await llm.generate(buildEvaluatorPrompt(evidence, parameters, retry), 'evaluator'),
      parameters,
    )

    if (!criticEnabled) {
      rounds.push({ round, evaluation, critique: null, approved: true })
      return { scores: evaluation, approved: null, rounds }
    }

    let critique: CriticVerdict
    try {
      critique = parseCriticResponse(
        await llm.generate(buildCriticPrompt(evidence, parameters, evaluation), 'critic'),
        parameters,
      )
    } catch (error) {
      // A broken audit must not throw away a valid evaluation — keep the
      // scores, record that they were not audited.
      const criticError = error instanceof Error ? error.message : String(error)
      console.error(`[Critic] ${evidence.track} audit failed in round ${round}:`, error)
      rounds.push({ round, evaluation, critique: null, criticError, approved: false })
      return { scores: evaluation, approved: null, rounds }
    }

    const oscillating = findReversals(rounds.at(-1)?.critique ?? null, critique)
    rounds.push({
      round,
      evaluation,
      critique,
      approved: critique.approved,
      ...(oscillating.length > 0 && { oscillation: { parameterIds: oscillating } }),
    })

    if (critique.approved) return { scores: evaluation, approved: true, rounds }
    if (oscillating.length > 0) {
      console.warn(
        `[Critic] ${evidence.track} critic reversed its own finding in round ${round} — stopping; the parameter criterion is likely ambiguous`,
      )
      return { scores: evaluation, approved: false, rounds }
    }
    if (round > maxCriticRounds) return { scores: evaluation, approved: false, rounds }

    console.log(
      `[Critic] ${evidence.track} evaluation rejected in round ${round} (${critique.findings.map((f) => f.biasType).join(', ') || 'no specific findings'}) — re-evaluating`,
    )
    retry = { previous: evaluation, critique }
  }
}
