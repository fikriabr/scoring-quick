// lib/services/capture.service.ts
//
// Ingests PartyRock app data captured from a real, human-driven browser
// session and feeds it into the same CrawlMetadata → AI scoring pipeline
// that `CrawlerService` writes to.
//
// Why this exists
// ---------------
// AWS WAF blocks PartyRock's internal `getLatestAppVersion` call whenever the
// request comes from an automated browser, so `CrawlerService` can only read
// the static SEO meta tags (title + description). Widgets, prompts and the
// generated output — the evidence the AI scorer actually needs — only exist
// in a logged-in, human-driven session.
//
// So instead of fighting the WAF, the widget data is collected *from* such a
// session: `public/partyrock-capture.js` runs inside the page, and either the
// Playwright navigator (`scripts/partyrock-navigate.js`) or the human posts
// the result here. Nothing in this path touches a protected endpoint.
//
// Requirements: 4.2, 4.5, 4.6, 5.1

import { db } from '@/lib/db'
import { ScorerService } from '@/lib/services/scorer.service'
import { CaptureSchema, type CaptureData } from '@/lib/validators/schemas'
import type { Prisma } from '@prisma/client'

export class NoMatchingProjectError extends Error {
  readonly code = 'NO_MATCHING_PROJECT'
  readonly status = 404

  constructor(url: string) {
    super(
      `No submitted project matches "${url}". Submit the URL on the Submissions page first, then capture it.`,
    )
    this.name = 'NoMatchingProjectError'
  }
}

export type CaptureResult = {
  matched: number
  projects: { id: string; url: string; participantName: string; categoryId: string }[]
  widgetCount: number
  promptCount: number
  outputCount: number
}

/**
 * Normalise a PartyRock URL for comparison: lowercase host, no query string,
 * no hash, no trailing slash. Returns the input unchanged if it will not parse.
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url.trim())
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${path}`
  } catch {
    return url.trim().replace(/\/+$/, '')
  }
}

/**
 * Extract the stable app identifier from a PartyRock URL.
 *
 * PartyRock app URLs look like:
 *   https://partyrock.aws/u/{user}/{appId}/{App-Display-Name}
 *
 * The display-name segment changes whenever the participant renames the app,
 * and the `/u/{user}` prefix changes if the app is re-shared, so `{appId}` is
 * the only part safe to match on. Returns null when the URL has no such shape.
 */
export function extractAppId(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    const segments = parsed.pathname.split('/').filter(Boolean)
    const uIndex = segments.indexOf('u')
    // Need at least `u/{user}/{appId}`
    if (uIndex !== -1 && segments.length >= uIndex + 3) {
      return segments[uIndex + 2]
    }
    return null
  } catch {
    return null
  }
}

/**
 * Find every submitted Project the captured URL refers to.
 *
 * The same app can legitimately be submitted to more than one category, and
 * all of those submissions should receive the captured data — so this returns
 * a list, not a single record.
 *
 * Matching is two-pass: exact normalised URL first, then app-id, so a rename
 * of the app on PartyRock's side does not break the link to the submission.
 */
export async function findProjectsForUrl(
  url: string,
  categoryId?: string | null,
) {
  const scope = categoryId ? { categoryId } : {}
  const candidates = await db.project.findMany({
    where: scope,
    select: { id: true, url: true, participantName: true, categoryId: true },
  })

  const normalized = normalizeUrl(url)
  const exact = candidates.filter((p) => normalizeUrl(p.url) === normalized)
  if (exact.length > 0) return exact

  const appId = extractAppId(url)
  if (!appId) return []

  return candidates.filter((p) => extractAppId(p.url) === appId)
}

/**
 * Build the `sourceCode` blob handed to the AI scorer.
 *
 * `ScorerService` treats `Project.sourceCode` as its primary evidence, so the
 * captured widget configuration, prompts and generated output are serialised
 * into a single readable document rather than left in separate columns.
 */
export function buildSourceCode(data: CaptureData): string {
  const sections: string[] = []

  sections.push(`# PartyRock App Capture\nURL: ${data.url}`)
  if (data.title) sections.push(`## Title\n${data.title}`)
  if (data.description) sections.push(`## Description\n${data.description}`)

  if (data.widgets.length > 0) {
    const list = data.widgets
      .map((w, i) => `${i + 1}. [${w.type}] ${w.label}`)
      .join('\n')
    sections.push(`## Widgets (${data.widgets.length})\n${list}`)
  }

  if (data.prompts.length > 0) {
    const list = data.prompts.map((p, i) => `### Prompt ${i + 1}\n${p}`).join('\n\n')
    sections.push(`## Prompts (${data.prompts.length})\n${list}`)
  }

  if (data.outputs.length > 0) {
    const list = data.outputs
      .map((o, i) => `### Output ${i + 1}\n${o}`)
      .join('\n\n')
    sections.push(`## Generated Output (${data.outputs.length})\n${list}`)
  }

  if (data.appDefinition != null) {
    let serialized: string
    try {
      serialized = JSON.stringify(data.appDefinition, null, 2)
    } catch {
      serialized = '(app definition could not be serialised)'
    }
    sections.push(`## Raw App Definition\n${serialized.slice(0, 60_000)}`)
  }

  return sections.join('\n\n')
}

/**
 * Validate a capture payload, persist it against every matching project, and
 * kick off AI scoring for each.
 *
 * Persisted fields mirror what a successful crawl would have written, so the
 * rest of the app (project detail page, scorer, leaderboard) needs no special
 * case for captured-vs-crawled data:
 *   - CrawlMetadata.title / description / widgets / prompts / widgetCount
 *   - CrawlMetadata.rawHtml       ← the full raw capture JSON, for auditing
 *   - Project.sourceCode          ← the scorer's primary evidence
 *   - Project.crawlStatus         ← SUCCESS
 *
 * Requirements: 4.2, 4.5, 4.6, 5.1
 */
export async function ingestCapture(input: unknown): Promise<CaptureResult> {
  const data = CaptureSchema.parse(input)

  const projects = await findProjectsForUrl(data.url, data.categoryId)
  if (projects.length === 0) {
    throw new NoMatchingProjectError(data.url)
  }

  const sourceCode = buildSourceCode(data)
  const widgetsJson = data.widgets as unknown as Prisma.InputJsonValue
  const promptsJson = data.prompts as unknown as Prisma.InputJsonValue

  let rawCapture: string
  try {
    rawCapture = JSON.stringify(data).slice(0, 200_000)
  } catch {
    rawCapture = ''
  }

  for (const project of projects) {
    await db.crawlMetadata.upsert({
      where: { projectId: project.id },
      create: {
        projectId: project.id,
        title: data.title ?? null,
        description: data.description ?? null,
        widgets: widgetsJson,
        prompts: promptsJson,
        widgetCount: data.widgets.length,
        rawHtml: rawCapture,
      },
      update: {
        title: data.title ?? null,
        description: data.description ?? null,
        widgets: widgetsJson,
        prompts: promptsJson,
        widgetCount: data.widgets.length,
        rawHtml: rawCapture,
        crawledAt: new Date(),
      },
    })

    await db.project.update({
      where: { id: project.id },
      data: {
        sourceCode,
        crawlStatus: 'SUCCESS',
        crawlError: null,
        // Re-scoring is about to run against fresh evidence, so the old
        // AI score status no longer describes this project.
        scoreStatus: 'PENDING',
      },
    })

    console.log(
      `[Capture] Stored capture for project ${project.id} (${project.participantName}) — ` +
        `${data.widgets.length} widget(s), ${data.prompts.length} prompt(s), ${data.outputs.length} output(s)`,
    )

    // Fire-and-forget: the caller should not wait on Gemini.
    ScorerService.triggerScoring(project.id).catch(console.error)
  }

  return {
    matched: projects.length,
    projects,
    widgetCount: data.widgets.length,
    promptCount: data.prompts.length,
    outputCount: data.outputs.length,
  }
}
