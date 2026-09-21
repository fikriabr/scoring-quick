// lib/services/scorer.service.ts
// AI scoring orchestrator — two isolated tracks, each run through the
// multi-agent evaluator ⇄ critic loop (lib/services/ai/pipeline.ts).
//
//   IDEA track — evidence: Project.ideaDoc (markdown) only
//   HTML track — evidence: page structure + markup + URL only
//
// The track scores are blended with the category's ideaWeight / htmlWeight
// by `recalculateProjectScores`.

import { revalidatePath } from 'next/cache'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { parseHtmlStructure } from '@/lib/services/html-structure.service'
import { recalculateProjectScores } from '@/lib/services/final-score.service'
import { createGeminiClient, type LlmClient } from '@/lib/services/ai/llm'
import {
  HTML_EVIDENCE_CHAR_BUDGET,
  TRUNCATION_MARKER,
  type TrackEvidence,
} from '@/lib/services/ai/evidence'
import { runTrackEvaluation, type TrackEvaluationResult } from '@/lib/services/ai/pipeline'
import { SCORING_TRACKS, type ScoringTrack } from '@/lib/scoring/tracks'
import type { HtmlStructure } from '@/types'

export { HTML_EVIDENCE_CHAR_BUDGET }
export const HTML_MARKUP_TRUNCATION_MARKER = TRUNCATION_MARKER

/**
 * Logged when the HTML track has no evidence at all: no Source Code, no
 * computed structure and no fetched markup. The track is marked failed and
 * the model is never called — it would only invent a score.
 */
export const HTML_NO_EVIDENCE_MESSAGE =
  'Evidence not available yet: this project has no Source Code, no computed HTML structure, and no fetched markup. Paste the page markup on the project detail page, then re-run scoring.'

export const IDEA_NO_EVIDENCE_MESSAGE =
  'Evidence not available yet: this project has no idea document. Paste or upload the markdown on the project detail page, then re-run scoring.'

/** Whitespace counts as empty — a blank textarea submits `''`, not `null`. */
function hasUsableText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * When markup lives only in `Project.sourceCode` (pasted, or the fetch
 * failed), the structure metrics are derived from it here. Computed rather
 * than persisted: `CrawlMetadata.structure` is owned by the crawler. A parse
 * failure degrades the prompt instead of losing the whole score.
 */
function deriveStructureFromSourceCode(sourceCode: string | null | undefined): HtmlStructure | null {
  if (!hasUsableText(sourceCode)) return null
  try {
    return parseHtmlStructure(sourceCode)
  } catch (error) {
    console.error(
      '[Scorer] Could not derive HTML structure from the pasted Source Code; scoring continues from the raw markup:',
      error,
    )
    return null
  }
}

type TrackOutcome =
  | { track: ScoringTrack; status: 'skipped' }
  | { track: ScoringTrack; status: 'failed'; reason: string; noEvidence?: boolean }
  | { track: ScoringTrack; status: 'scored'; result: TrackEvaluationResult }

let defaultLlm: LlmClient | null = null
function getDefaultLlm(): LlmClient {
  defaultLlm ??= createGeminiClient()
  return defaultLlm
}

export class ScorerService {
  /**
   * Score every AUTO parameter of a project, track by track.
   *
   * Status:
   *   - every track with AUTO parameters scored → SUCCESS
   *   - some tracks failed                      → PARTIAL
   *   - all such tracks failed                  → FAILED
   *   - no AUTO parameters at all               → SUCCESS (nothing to do)
   */
  static async triggerScoring(projectId: string, llm: LlmClient = getDefaultLlm()): Promise<void> {
    const project = await db.project.findUniqueOrThrow({
      where: { id: projectId },
      include: {
        category: { include: { parameters: { orderBy: { orderIndex: 'asc' } } } },
        metadata: true,
      },
    })
    const { category } = project

    await db.project.update({ where: { id: projectId }, data: { scoreStatus: 'PROCESSING' } })

    const crawledStructure = (project.metadata?.structure ?? null) as unknown as HtmlStructure | null

    const evidenceFor = (track: ScoringTrack): TrackEvidence | string => {
      if (track === 'IDEA') {
        return hasUsableText(project.ideaDoc)
          ? { track: 'IDEA', ideaDoc: project.ideaDoc }
          : IDEA_NO_EVIDENCE_MESSAGE
      }
      const hasEvidence =
        hasUsableText(project.sourceCode) ||
        crawledStructure !== null ||
        hasUsableText(project.metadata?.rawHtml)
      if (!hasEvidence) return HTML_NO_EVIDENCE_MESSAGE
      return {
        track: 'HTML',
        url: project.url,
        // Pasted/crawl-filled source first; the raw fetch is the fallback.
        sourceCode: hasUsableText(project.sourceCode)
          ? project.sourceCode
          : project.metadata?.rawHtml ?? null,
        // The crawl-computed structure wins; sourceCode only fills a gap.
        structure: crawledStructure ?? deriveStructureFromSourceCode(project.sourceCode),
      }
    }

    const outcomes: TrackOutcome[] = await Promise.all(
      SCORING_TRACKS.map(async (track): Promise<TrackOutcome> => {
        const parameters = category.parameters.filter(
          (p) => p.track === track && p.scoringMode === 'AUTO',
        )
        if (parameters.length === 0) return { track, status: 'skipped' }

        const evidence = evidenceFor(track)
        if (typeof evidence === 'string') {
          console.error(`[Scorer] ${track}: ${evidence} (project ${projectId})`)
          return { track, status: 'failed', reason: evidence, noEvidence: true }
        }

        console.log(`[Scorer] ${track}: evaluating ${parameters.length} parameter(s) for project ${projectId}`)
        try {
          const result = await runTrackEvaluation({
            evidence,
            parameters: parameters.map((p) => ({
              id: p.id,
              name: p.name,
              description: p.description,
              minScore: p.minScore,
              maxScore: p.maxScore,
            })),
            llm,
            criticEnabled: category.criticEnabled,
            maxCriticRounds: category.maxCriticRounds,
          })
          return { track, status: 'scored', result }
        } catch (error) {
          console.error(`[Scorer] ${track} evaluation failed for project ${projectId}:`, error)
          return {
            track,
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )

    // Persist each scored track: its AI scores and its audit trail (the
    // previous run's rounds are replaced — they described older evidence).
    for (const outcome of outcomes) {
      if (outcome.status === 'failed' && outcome.noEvidence) {
        // The evidence was removed: earlier AI scores for this track no longer
        // describe anything the participant submitted.
        await db.aIScore.deleteMany({
          where: { projectId, parameter: { track: outcome.track } },
        })
        await db.aIEvaluationRun.deleteMany({ where: { projectId, track: outcome.track } })
      }
      if (outcome.status !== 'scored') continue
      const { result, track } = outcome

      await Promise.all(
        result.scores.map((s) => {
          const data = {
            score: s.score,
            reasoning: s.evidence ? `${s.reasoning}\nEvidence: ${s.evidence}` : s.reasoning,
            criticApproved: result.approved,
          }
          return db.aIScore.upsert({
            where: { projectId_parameterId: { projectId, parameterId: s.parameterId } },
            create: { projectId, parameterId: s.parameterId, ...data },
            update: { ...data, scoredAt: new Date() },
          })
        }),
      )

      await db.aIEvaluationRun.deleteMany({ where: { projectId, track } })
      for (const round of result.rounds) {
        await db.aIEvaluationRun.create({
          data: {
            projectId,
            track,
            round: round.round,
            evaluation: round.evaluation as unknown as Prisma.InputJsonValue,
            critique: round.critique
              ? ({
                ...round.critique,
                ...(round.oscillation && {
                  oscillationParameterIds: round.oscillation.parameterIds,
                }),
              } as unknown as Prisma.InputJsonValue)
              : round.criticError
                ? ({ error: round.criticError } as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            approved: round.approved,
          },
        })
      }
    }

    const attempted = outcomes.filter((o) => o.status !== 'skipped')
    const failed = attempted.filter((o) => o.status === 'failed')
    const scoreStatus =
      failed.length === 0 ? 'SUCCESS' : failed.length === attempted.length ? 'FAILED' : 'PARTIAL'

    await db.project.update({ where: { id: projectId }, data: { scoreStatus } })
    const scores = await recalculateProjectScores(projectId)

    revalidatePath(`/admin/leaderboard/${project.categoryId}`)
    revalidatePath(`/public/leaderboard`)

    console.log(
      `[Scorer] Scoring complete for project ${projectId} — status: ${scoreStatus}, idea: ${scores.ideaScore}, html: ${scores.htmlScore}, final: ${scores.finalScore}`,
    )
  }
}
