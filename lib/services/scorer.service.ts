// lib/services/scorer.service.ts
// AI scoring service using Google Gemini.
// Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9

import { GoogleGenerativeAI } from '@google/generative-ai'
import { ProjectType } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { db } from '@/lib/db'
import {
  formatStructureForPrompt,
  parseHtmlStructure,
} from '@/lib/services/html-structure.service'
import { calculateWeightedScore } from '@/lib/services/leaderboard.service'
import type {
  HtmlStructure,
  ProjectMetadata,
  ScoringParameter,
  ScoringResult,
} from '@/types'

// -----------------------------------------------------------------------
// Gemini client — authenticated via the GEMINI_API_KEY env var. This is a
// free-tier API key (no billing/credit card required), read from
// process.env at module load time.
// Requirements: 9.4
// -----------------------------------------------------------------------
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '')

// -----------------------------------------------------------------------
// buildPartyRockPrompt
// Constructs the evaluation prompt for Gemini with all 5 analysis
// methods described in the design document:
//   1. Semantic similarity   → Creativity & Originality
//   2. NLP extraction        → Problem-Solution Fit
//   3. Widget complexity     → Effective Use of PartyRock Features
//   4. Description completeness → User Experience & Presentation
//   5. Keyword/topic analysis   → Impact & Scalability
//
// This is the pre-existing `buildPrompt`, renamed and otherwise untouched.
// Its output must stay byte-for-byte identical to what PartyRock projects
// were scored against before HTML support existed — Property 25 (P25-e/f in
// `__tests__/services/backward-compatibility.property.test.ts`) compares the
// prompt for legacy metadata against this one directly.
// Requirements: 4.4, 8.2, 8.3
// -----------------------------------------------------------------------
function buildPartyRockPrompt(
  metadata: ProjectMetadata,
  parameter: ScoringParameter,
  contextProjects: ProjectMetadata[],
): string {
  const widgetList = metadata.widgets.map((w) => `${w.type} (${w.label})`).join(', ') || 'none'
  const promptList = metadata.prompts.join(' | ') || 'none'
  const sourceCodeSection = metadata.sourceCode
    ? metadata.sourceCode.slice(0, 20000)
    : '(no source code provided)'

  const contextSection =
    contextProjects.length > 0
      ? contextProjects
        .map(
          (p) =>
            `- Title: ${p.title ?? '(no title)'} | Widgets: ${p.widgetCount} | Description: ${p.description ?? '(no description)'}`,
        )
        .join('\n')
      : '(no other projects in this category)'

  return `
You are an AI judge evaluating applications built on AWS PartyRock.

## Application to Evaluate
Title: ${metadata.title ?? '(no title)'}
Description: ${metadata.description ?? '(no description)'}
Widgets used: ${widgetList}
Widget count: ${metadata.widgetCount}
Prompts detected: ${promptList}

## Source Code
${sourceCodeSection}

## Evaluation Parameter
Name: ${parameter.name}
Description: ${parameter.description ?? '(no description)'}
Score range: ${parameter.minScore} to ${parameter.maxScore}

## Other Projects in This Category (for comparison)
${contextSection}

## Analysis Instructions
Apply the analysis method most appropriate for the parameter being evaluated. The application's SOURCE CODE (shown above) is the primary evidence — use the title, description, widgets and prompts as supporting context only.

1. **Code Quality & Structure** (if relevant to the parameter): Assess the source code for clarity, organization, and correct use of PartyRock/AWS widget configuration.

2. **Semantic Similarity** (Creativity & Originality): Compare this application's concept, source code structure, and prompts against the other projects listed above. A more unique or novel implementation should score higher.

3. **NLP Extraction** (Problem-Solution Fit): Extract the problem being solved and the proposed solution from the title, description, and source code. Rate how clearly and directly the application addresses a real user problem.

4. **Widget Complexity & Diversity** (Effective Use of PartyRock Features): Evaluate the number, variety, and sophistication of widgets configured in the source code. Applications that use multiple widget types in creative ways should score higher.

5. **Description Completeness & Clarity** (User Experience & Presentation): Assess whether the title, description, and source code comments clearly communicate the purpose, target audience, and usage of the application.

6. **Keyword & Topic Analysis** (Impact & Scalability): Identify keywords and topics related to real-world impact, scalability, and broad applicability from the description, prompts, and source code. Applications addressing widespread problems score higher.

## Output Format
Respond with a valid JSON object only — no markdown, no code blocks, no additional text:
{"score": <number between ${parameter.minScore} and ${parameter.maxScore}>, "reasoning": "<concise explanation of the score, 2–4 sentences>"}
`.trim()
}

// -----------------------------------------------------------------------
// buildHtmlPrompt
//
// Prompt for web projects, where the evidence is the page markup rather than
// a PartyRock app definition. Two evidence blocks are handed to the model,
// in this order and for this reason:
//
//   1. `## HTML Structure` — the computed metrics from
//      `formatStructureForPrompt`. Small, bounded, and the most informative
//      view of the project, so it goes first and goes in whole.
//   2. `## HTML Source (excerpt)` — the raw markup, truncated. This is the
//      part that is allowed to lose characters.
//
// The budget below (task 7.2, Requirement 4.3) is what makes that ordering
// matter: the structure summary is rendered in full and its length subtracted
// from the budget first, and only what is left over is spent on markup.
//
// Requirements: 4.1, 4.2, 4.3
// -----------------------------------------------------------------------

/**
 * Total character budget for the two evidence blocks of the HTML prompt — the
 * structure summary and the markup excerpt *combined*.
 *
 * Why 20.000, and why "combined": `buildPartyRockPrompt` caps `sourceCode` at
 * 20.000 characters, and that cap covers one block only. Applying the same
 * number to the whole evidence region means an HTML prompt is never larger
 * than the PartyRock prompt it is modelled on — the known-good prompt size
 * for this model — no matter how large the fetched page is.
 *
 * Spending it is strictly ordered (Requirement 4.3, Property 23): the
 * structure summary is bounded and is the most informative evidence, so it is
 * never truncated. `formatStructureForPrompt` truncates its own inputs and
 * caps its own line count (pinned at ≤2500 characters by P22-i in
 * `__tests__/services/html-structure.property.test.ts`), which leaves at least
 * 17.500 characters of markup in the worst case.
 */
export const HTML_EVIDENCE_CHAR_BUDGET = 20000

/**
 * Appended when the markup excerpt is cut, so the model reads the excerpt as
 * an excerpt rather than as a complete document (an unmarked cut invites it to
 * penalise a missing `</body>`). Its own length is charged to the budget.
 */
export const HTML_MARKUP_TRUNCATION_MARKER = '\n... [truncated]'

const HTML_STRUCTURE_UNAVAILABLE_NOTICE =
  '(HTML structure unavailable — the markup could not be retrieved or parsed. Judge from the source excerpt below.)'

const HTML_SOURCE_UNAVAILABLE_NOTICE = '(no HTML source provided)'

/**
 * Renders the markup block within whatever budget the structure summary left
 * behind. `budget` is a character allowance, not a slice index — an empty
 * result is the correct answer when the allowance is exhausted, because the
 * alternative would be truncating the structure summary.
 */
function renderMarkupExcerpt(
  sourceCode: string | null | undefined,
  budget: number,
): string {
  if (!sourceCode) {
    return budget >= HTML_SOURCE_UNAVAILABLE_NOTICE.length
      ? HTML_SOURCE_UNAVAILABLE_NOTICE
      : ''
  }

  if (sourceCode.length <= budget) return sourceCode

  const keep = budget - HTML_MARKUP_TRUNCATION_MARKER.length
  return keep > 0
    ? sourceCode.slice(0, keep) + HTML_MARKUP_TRUNCATION_MARKER
    : ''
}

function buildHtmlPrompt(
  metadata: ProjectMetadata,
  parameter: ScoringParameter,
  contextProjects: ProjectMetadata[],
): string {
  // A parse failure (or a project whose markup never arrived) still gets the
  // `## HTML Structure` section — Property 23 makes the section's presence a
  // function of the project type alone, so what varies is its contents, not
  // whether it exists. Saying so explicitly also stops the model from reading
  // an empty block as "no structure at all", which would be a silent penalty.
  const structureSection = metadata.structure
    ? formatStructureForPrompt(metadata.structure)
    : HTML_STRUCTURE_UNAVAILABLE_NOTICE

  // Structure first, in full; markup gets the remainder.
  const remainingBudget = Math.max(
    0,
    HTML_EVIDENCE_CHAR_BUDGET - structureSection.length,
  )
  const sourceCodeSection = renderMarkupExcerpt(metadata.sourceCode, remainingBudget)

  const contextSection =
    contextProjects.length > 0
      ? contextProjects
        .map((p) => {
          const size = p.structure
            ? ` | Elements: ${p.structure.totalElementCount} | Semantic ratio: ${p.structure.semanticRatio.toFixed(2)}`
            : ''
          return `- Title: ${p.title ?? '(no title)'} | Description: ${p.description ?? '(no description)'}${size}`
        })
        .join('\n')
      : '(no other projects in this category)'

  return `
You are an AI judge evaluating web projects based on their HTML structure.

## Project to Evaluate
Title: ${metadata.title ?? '(no title)'}
Description: ${metadata.description ?? '(no description)'}
URL: ${metadata.url ?? '(no url)'}

## HTML Structure
${structureSection}

## HTML Source (excerpt)
${sourceCodeSection}

## Evaluation Parameter
Name: ${parameter.name}
Description: ${parameter.description ?? '(no description)'}
Score range: ${parameter.minScore} to ${parameter.maxScore}

## Other Projects in This Category (for comparison)
${contextSection}

## Analysis Instructions
The HTML STRUCTURE section above is the primary evidence — it holds metrics computed from the actual markup. Use the source excerpt to judge craftsmanship that metrics cannot capture, and the title, description and URL as supporting context only.

1. **Semantic HTML**: Assess whether meaning is carried by the right elements. Weigh the semantic ratio, landmark coverage, and whether the heading hierarchy is coherent — a page built from nested divs should score lower than one using header, nav, main, article and footer for the same layout.

2. **Accessibility**: Evaluate alt text coverage on images, label coverage on form fields, ARIA usage, the presence of a skip link, and a declared document language. Judge intent and consistency, not just raw counts — a page with no images cannot earn credit for alt text it never needed.

3. **Structural Quality & SEO**: Consider document metadata (title, meta description, viewport), separation of concerns (inline styles versus external stylesheets), and whether the DOM depth and element count suggest deliberate structure rather than accidental nesting.

4. **Clarity of Presentation**: Assess how clearly the markup, headings, and copy communicate the project's purpose, audience, and usage.

5. **Relative Complexity**: Compare this project against the other projects in the same category listed above. Judge ambition and completeness relative to its peers, not against an absolute ideal.

## Output Format
Respond with a valid JSON object only — no markdown, no code blocks, no additional text:
{"score": <number between ${parameter.minScore} and ${parameter.maxScore}>, "reasoning": "<concise explanation of the score, 2–4 sentences>"}
`.trim()
}

// -----------------------------------------------------------------------
// buildPrompt
//
// Dispatch on project type (Requirement 4.1). The HTML template is selected
// if and only if the type is `HTML`; every other value — including an absent
// one, which is what legacy call sites and pre-feature rows produce — falls
// through to the PartyRock template (Requirement 4.4, Property 25).
// -----------------------------------------------------------------------
function buildPrompt(
  metadata: ProjectMetadata,
  parameter: ScoringParameter,
  contextProjects: ProjectMetadata[],
): string {
  return metadata.projectType === 'HTML'
    ? buildHtmlPrompt(metadata, parameter, contextProjects)
    : buildPartyRockPrompt(metadata, parameter, contextProjects)
}

// -----------------------------------------------------------------------
// Evidence availability (Requirement 4.6)
//
// An HTML project is judged from its markup. If none of the three places that
// markup can live holds anything usable, there is nothing to send to Gemini and
// calling it would only produce a confidently invented score.
// -----------------------------------------------------------------------

/**
 * Whether a text column holds usable evidence.
 *
 * Whitespace counts as empty for the same reason it does in
 * `CrawlerService` — a blank textarea submits `''`, not `null`.
 */
function hasUsableText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Requirement 3.6, second clause — Source Code *is* a source of HTML Structure.
 *
 * The first clause of 3.6 ("do not overwrite pasted Source Code with the fetch
 * result") is the crawler's job and is already met there. The second clause is
 * this: when markup lives in `Project.sourceCode`, the structure metrics must be
 * derived from it. Without this the metrics only ever existed as a side effect of
 * a *successful* fetch — so the exact case Requirement 3.5 exists to rescue, a
 * failed fetch with pasted markup, lost its primary evidence block and fell back
 * to `HTML_STRUCTURE_UNAVAILABLE_NOTICE` despite holding perfectly good markup.
 *
 * Computed here rather than persisted, on purpose. `CrawlMetadata.structure` is
 * owned by `CrawlerService` — it is written alongside `rawHtml` from the same
 * fetch, and a second writer would make "which markup produced this row?"
 * unanswerable. `parseHtmlStructure` is a pure function with no I/O, so paying
 * for it once per scoring run is cheap and keeps ownership intact.
 *
 * A parse failure yields `null`, matching the design.md error table row "HTML
 * fetched but failed to parse → structure = null, scoring continues from the raw
 * markup, error logged". Losing the metrics is a degraded prompt; throwing here
 * would lose the whole score.
 */
function deriveStructureFromSourceCode(
  sourceCode: string | null | undefined,
): HtmlStructure | null {
  if (!hasUsableText(sourceCode)) return null

  try {
    return parseHtmlStructure(sourceCode as string)
  } catch (error) {
    console.error(
      '[Scorer] Could not derive HTML structure from the pasted Source Code; scoring continues from the raw markup:',
      error,
    )
    return null
  }
}

/**
 * Recorded when an HTML project reaches the scorer with no evidence at all.
 *
 * Where this message goes: to the logs, and nowhere else. The schema has no
 * `scoreError` column, and adding one is out of scope for this task. The
 * available column, `Project.crawlError`, is deliberately left alone:
 *
 *   - it is not rendered on the project detail page (which shows only the two
 *     `StatusBadge`s), so writing to it would not reach the Admin anyway;
 *   - it *is* returned by `POST /api/crawl/[projectId]`, where a scoring
 *     message would read as a crawl failure — and for an HTML project whose
 *     fetch succeeded but produced no usable markup, that would be false.
 *
 * So the honest signal is `scoreStatus = FAILED` plus a log line. Surfacing the
 * reason in the UI needs a column of its own and belongs to its own task.
 */
export const HTML_NO_EVIDENCE_MESSAGE =
  'Evidence not available yet: this HTML project has no Source Code, no computed HTML structure, and no fetched markup. Paste the page markup on the project detail page, then re-run scoring.'

// -----------------------------------------------------------------------
// parseGeminiResponse
// Extracts score and reasoning from a Google Gemini API response.
// `rawText` is the raw text returned by `result.response.text()` and is
// expected to be a JSON object { score, reasoning } (optionally wrapped
// in markdown code fences).
//
// Clamping: if the model returns a score outside [minScore, maxScore],
// it is clamped to the nearest boundary and a warning is appended to
// the reasoning. ScoringResult.clamped is set to true.
// Requirements: 5.2–5.6, 10 (AI Score Range Invariant)
// -----------------------------------------------------------------------
function parseGeminiResponse(
  rawText: string,
  parameter: ScoringParameter,
): ScoringResult {
  const textContent: string = rawText ?? ''

  if (!textContent) {
    throw new Error('Empty response body from Gemini')
  }

  // Strip potential markdown code fences that the model may include
  const cleaned = textContent
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  let parsed: { score: unknown; reasoning: unknown }
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new Error(`Gemini response is not valid JSON: ${cleaned.slice(0, 200)}`)
  }

  const rawScore = Number(parsed.score)
  const reasoning = String(parsed.reasoning ?? '')

  if (!Number.isFinite(rawScore)) {
    throw new Error(
      `Gemini returned non-numeric score: ${String(parsed.score)}`,
    )
  }

  const { minScore, maxScore } = parameter

  // Clamp score to configured parameter range
  let score = rawScore
  let clamped = false
  let clampedReasoning = reasoning

  if (rawScore < minScore) {
    score = minScore
    clamped = true
    clampedReasoning = `${reasoning} [WARNING: score ${rawScore} was out of range, clamped to ${minScore}]`
  } else if (rawScore > maxScore) {
    score = maxScore
    clamped = true
    clampedReasoning = `${reasoning} [WARNING: score ${rawScore} was out of range, clamped to ${maxScore}]`
  }

  return {
    score,
    reasoning: clampedReasoning,
    ...(clamped && { clamped: true }),
  }
}

// -----------------------------------------------------------------------
// ScorerService
// Main service class for AI-based parameter scoring via Google Gemini.
// Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
// -----------------------------------------------------------------------
export class ScorerService {
  /**
   * Trigger AI scoring for all AUTO parameters of a project.
   *
   * Fetches the project with its category parameters and CrawlMetadata,
   * fetches other projects' metadata in the same category as context,
   * then scores each AUTO parameter via Google Gemini.
   *
   * Score status transitions:
   *   - All parameters succeeded → scoreStatus = 'SUCCESS'
   *   - Some failed              → scoreStatus = 'PARTIAL'
   *   - All failed               → scoreStatus = 'FAILED'
   *
   * Also calculates and saves a provisional finalScore from successful
   * AI scores using calculateWeightedScore.
   *
   * Status determination, AI score persistence, range clamping and final score
   * calculation are identical for both project types (Requirement 4.5). The one
   * type-specific rule is Requirement 4.6: an HTML project with no evidence at
   * all is marked FAILED without calling Gemini.
   *
   * Requirements: 4.5, 4.6, 5.1, 5.7, 5.8, 5.9
   */
  static async triggerScoring(projectId: string): Promise<void> {
    // 1. Fetch project with category parameters and crawl metadata
    const project = await db.project.findUniqueOrThrow({
      where: { id: projectId },
      include: {
        category: { include: { parameters: true } },
        metadata: true,
      },
    })

    // 2. Filter to AUTO-mode parameters only
    const autoParameters = project.category.parameters.filter(
      (p) => p.scoringMode === 'AUTO',
    )

    console.log(`[Scorer] Starting AI scoring for project ${projectId} — ${autoParameters.length} AUTO parameter(s)`)

    if (autoParameters.length === 0) {
      // Nothing to score — mark as SUCCESS with no AI scores.
      //
      // Checked before the evidence guard below on purpose: with no AUTO
      // parameters there is no AI score to produce, so missing evidence cannot
      // have failed anything. Reporting FAILED here would ask the Admin to fix
      // evidence that nothing in this category consumes.
      await db.project.update({
        where: { id: projectId },
        data: { scoreStatus: 'SUCCESS' },
      })
      return
    }

    /**
     * Requirement 4.6 — an HTML project with no evidence at all is marked
     * FAILED and Gemini is never called.
     *
     * "No evidence at all" means all three of the places markup can live are
     * empty: no usable `sourceCode` (pasted or crawl-filled), no computed
     * `structure`, and no `rawHtml`. Any one of them is enough to score from,
     * which is why the crawl outcome itself is irrelevant here — `crawlError`
     * is set on a failed fetch, but a project whose Source Code was pasted
     * beforehand is perfectly scoreable (Requirement 3.5).
     *
     * Scoped to HTML by design. Requirement 4.6 is an HTML rule, and
     * Requirement 8.2 pins PartyRock behaviour as-is: a PartyRock project with
     * no evidence still goes to Gemini and still succeeds or fails on its own
     * terms, exactly as before this feature.
     */
    const crawledStructure = (project.metadata?.structure ?? null) as unknown as HtmlStructure | null

    if (project.projectType === ProjectType.HTML) {
      const hasEvidence =
        hasUsableText(project.sourceCode) ||
        crawledStructure !== null ||
        hasUsableText(project.metadata?.rawHtml)

      if (!hasEvidence) {
        console.error(`[Scorer] ${HTML_NO_EVIDENCE_MESSAGE} (project ${projectId})`)

        // Only `scoreStatus` is written. `finalScore` is left as it stands —
        // it can carry a jury-derived value, and nothing was scored here that
        // would justify clearing it.
        await db.project.update({
          where: { id: projectId },
          data: { scoreStatus: 'FAILED' },
        })
        return
      }
    }

    /**
     * Requirement 3.6 — the crawl-computed structure wins whenever it exists;
     * `sourceCode` is only parsed to fill a gap, never to overwrite. The two are
     * not in competition: the crawler already refuses to overwrite pasted
     * Source Code, so a row that has both was populated from that same markup.
     *
     * HTML only. A PARTYROCK project's `sourceCode` is a serialised capture, not
     * markup, and `buildPartyRockPrompt` never reads `structure` — parsing it
     * would burn cycles to produce metrics about a JSON blob that nothing looks
     * at. (P25-e compares PartyRock prompts byte-for-byte; keeping this branch
     * out of that path is what keeps that true by construction.)
     */
    const structure =
      crawledStructure ??
      (project.projectType === ProjectType.HTML
        ? deriveStructureFromSourceCode(project.sourceCode)
        : null)

    // Build this project's metadata for the scorer. Title/description/widgets
    // come from the (optional, unused-by-default) crawl metadata; sourceCode is
    // the participant-pasted code, which is now the primary scoring input.
    // `url`, `projectType` and `structure` are only read by the HTML prompt —
    // the PartyRock prompt ignores all three (pinned by P25-e/f and the
    // dispatch unit tests), so passing them cannot change existing prompts.
    const metadata: ProjectMetadata = project.metadata
      ? {
        title: project.metadata.title,
        description: project.metadata.description,
        widgets: project.metadata.widgets as unknown as ProjectMetadata['widgets'],
        prompts: project.metadata.prompts as unknown as string[],
        widgetCount: project.metadata.widgetCount,
        sourceCode: project.sourceCode,
        url: project.url,
        projectType: project.projectType,
        structure,
      }
      : {
        title: null,
        description: null,
        widgets: [],
        prompts: [],
        widgetCount: 0,
        sourceCode: project.sourceCode,
        url: project.url,
        projectType: project.projectType,
        // Not hardcoded `null`: with no CrawlMetadata row there is certainly no
        // crawled structure, but `sourceCode` may still supply one (Req 3.6).
        structure,
      }

    // 3. Fetch other projects' metadata in the same category as context
    const siblingMetadataRows = await db.crawlMetadata.findMany({
      where: {
        project: {
          categoryId: project.categoryId,
          id: { not: projectId },
        },
      },
    })

    // `structure` is carried across so the HTML prompt's comparison section can
    // render each peer's element count and semantic ratio — without it that
    // section is always blank, and "judge this relative to its peers" has
    // nothing to stand on.
    //
    // What is deliberately *not* carried across: `sourceCode`. It lives on
    // Project, not CrawlMetadata, so this query cannot reach it — and it must
    // stay that way. Every sibling's markup would be pulled into every prompt,
    // once per parameter, which is the token-cost blow-up recorded in
    // design.md. The bounded `structure` summary is the cheap substitute.
    const contextProjects: ProjectMetadata[] = siblingMetadataRows.map((m) => ({
      title: m.title,
      description: m.description,
      widgets: m.widgets as unknown as ProjectMetadata['widgets'],
      prompts: m.prompts as unknown as string[],
      widgetCount: m.widgetCount,
      structure: (m.structure ?? null) as unknown as HtmlStructure | null,
    }))

    // 4. Score each AUTO parameter, collecting results and errors
    type ParameterOutcome =
      | { success: true; parameterId: string; result: ScoringResult; weight: number }
      | { success: false; parameterId: string; error: unknown }

    const outcomes: ParameterOutcome[] = await Promise.all(
      autoParameters.map(async (param) => {
        const scoringParam: ScoringParameter = {
          id: param.id,
          name: param.name,
          description: param.description,
          weight: param.weight,
          minScore: param.minScore,
          maxScore: param.maxScore,
          scoringMode: param.scoringMode,
        }
        try {
          const result = await ScorerService.scoreParameter(
            metadata,
            scoringParam,
            contextProjects,
          )
          console.log(`[Scorer] Parameter "${param.name}" scored: ${result.score}`)
          return { success: true as const, parameterId: param.id, result, weight: param.weight }
        } catch (error) {
          console.error(`[ScorerService] Failed to score parameter ${param.id} for project ${projectId}:`, error)
          return { success: false as const, parameterId: param.id, error }
        }
      }),
    )

    // 5. Upsert each successful AIScore to DB
    const successful = outcomes.filter((o) => o.success === true) as Extract<ParameterOutcome, { success: true }>[]
    const failed = outcomes.filter((o) => o.success === false)

    await Promise.all(
      successful.map((o) =>
        db.aIScore.upsert({
          where: {
            projectId_parameterId: {
              projectId,
              parameterId: o.parameterId,
            },
          },
          create: {
            projectId,
            parameterId: o.parameterId,
            score: o.result.score,
            reasoning: o.result.reasoning,
          },
          update: {
            score: o.result.score,
            reasoning: o.result.reasoning,
            scoredAt: new Date(),
          },
        }),
      ),
    )

    // 6. Determine final score status
    let scoreStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED'
    if (failed.length === 0) {
      scoreStatus = 'SUCCESS'
    } else if (successful.length === 0) {
      scoreStatus = 'FAILED'
    } else {
      scoreStatus = 'PARTIAL'
    }

    // 7. Calculate provisional finalScore from successful scores
    const weightedInputs = successful.map((o) => ({
      score: o.result.score,
      weight: o.weight,
    }))
    const finalScore = successful.length > 0
      ? calculateWeightedScore(weightedInputs)
      : null

    // 8. Update project with new status and provisional finalScore
    await db.project.update({
      where: { id: projectId },
      data: { scoreStatus, finalScore },
    })

    // 9. Revalidate leaderboard pages so updated scores are visible
    revalidatePath(`/admin/leaderboard/${project.categoryId}`)
    revalidatePath(`/public/leaderboard`)

    console.log(`[Scorer] Scoring complete for project ${projectId} — status: ${scoreStatus}, finalScore: ${finalScore}`)
  }

  /**
   * Score a single parameter for a project using Google Gemini.
   *
   * @param metadata       - Crawled metadata for the project being scored.
   * @param parameter      - The scoring parameter (name, weight, range, mode).
   * @param contextProjects - Other projects in the same category for comparison.
   * @returns ScoringResult with score (clamped to range), reasoning, and
   *          optional `clamped` flag if the raw model value was out of range.
   *
   * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
   */
  static async scoreParameter(
    metadata: ProjectMetadata,
    parameter: ScoringParameter,
    contextProjects: ProjectMetadata[],
  ): Promise<ScoringResult> {
    const prompt = buildPrompt(metadata, parameter, contextProjects)

    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL_ID ?? 'gemini-flash-lite-latest',
    })

    const result = await model.generateContent(prompt)
    const text = result.response.text()

    return parseGeminiResponse(text, parameter)
  }
}
