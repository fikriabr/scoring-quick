// lib/services/crawler.service.ts
//
// Lightweight metadata crawler using plain HTTP fetch, no browser needed.
//
// AWS WAF blocks the internal getLatestAppVersion API call that PartyRock
// needs to render app-specific data (returns 403), so headless browser
// automation such as Playwright or Patchright cannot reliably extract
// widget or prompt data, even with stealth patches applied. PartyRock does
// render static SEO meta tags such as og:title and meta description on the
// server for link preview purposes, and those tags are reachable via a
// plain fetch request with no browser, no WAF challenge, fast execution,
// and compatibility with serverless platforms such as Vercel.
//
// Trade off: widgets and prompts are intentionally left empty here because
// that data requires the blocked internal API or full client side JS
// rendering. They are filled in afterwards by the manual capture pipeline —
// see lib/services/capture.service.ts and docs/CAPTURE.md — which reads them
// from a real, human-driven browser session instead. A project whose
// widgetCount is still 0 has not been captured yet, and its AI score rests on
// title and description alone.
//
// Per project type
// ----------------
// The extraction stage is dispatched on `Project.projectType`; the surrounding
// status machine is shared. PARTYROCK keeps the behaviour described above,
// untouched. HTML does the opposite of throwing the body away: it stores the
// markup in `rawHtml`, derives structure metrics from it via
// lib/services/html-structure.service.ts, and offers the markup as
// `Project.sourceCode` — but only when that column is still empty, because a
// human-pasted Source Code always outranks a fetch (Requirement 3.6).

import { db } from '@/lib/db'
import { parseHtmlStructure } from '@/lib/services/html-structure.service'
import { ScorerService } from '@/lib/services/scorer.service'
import { Prisma, ProjectType } from '@prisma/client'
import type { HtmlStructure, WidgetInfo } from '@/types'

const FETCH_TIMEOUT_MS = 15_000
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * Cap on the markup stored in `CrawlMetadata.rawHtml`.
 *
 * Matched to the Capture Pipeline, which already truncates its own audit blob
 * to 200.000 characters before writing the very same column
 * (`ingestCapture` in lib/services/capture.service.ts). Both writers of
 * `rawHtml` therefore share one bound, so the column's worst case does not
 * depend on which pipeline filled it.
 */
const MAX_RAW_HTML_LENGTH = 200_000

/**
 * Cap on the markup offered as `Project.sourceCode`.
 *
 * Deliberately tighter than `MAX_RAW_HTML_LENGTH`: `sourceCode` is a field an
 * admin can also type into, and both `SubmissionSchema` and `CsvRowSchema`
 * reject anything past 100.000 characters. Crawler-written values stay inside
 * the same bound, so a fetched value can always be re-submitted through those
 * schemas without tripping validation.
 */
const MAX_SOURCE_CODE_LENGTH = 100_000

const DOUBLE_QUOTE = String.fromCharCode(34)

/**
 * Result of the extraction stage, shared by every project type.
 *
 * `rawHtml`, `structure` and `sourceCode` are optional because the PartyRock
 * strategy does not produce them — leaving them `undefined` (rather than
 * `null`) is what lets `triggerCrawl` tell "this strategy has nothing to say
 * about the column" apart from "this strategy wants the column cleared", and
 * so keeps a PartyRock crawl from wiping a `rawHtml` the Capture Pipeline
 * wrote earlier.
 */
export interface CrawlOutcome {
  title: string | null
  description: string | null
  widgets: WidgetInfo[]
  prompts: string[]
  widgetCount: number
  rawHtml?: string | null
  structure?: HtmlStructure | null
  /**
   * Markup offered as `Project.sourceCode`. This is a **candidate only**:
   * `crawl()` receives a URL and a project type, not the project record, so it
   * cannot know whether a `sourceCode` already exists. The decision to write it
   * belongs to `triggerCrawl`, which does hold the record and refuses to
   * overwrite a non-empty value (Requirement 3.6, Property 26).
   */
  sourceCode?: string | null
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/**
 * Whether a project already holds usable Source Code.
 *
 * Whitespace counts as empty because a blank textarea submits `''`, not
 * `null`. Both the "never overwrite a pasted value" rule (Requirement 3.6) and
 * the "a failed fetch is still scoreable" rule (Requirement 3.5) hinge on the
 * same question, so they ask it the same way.
 */
function hasUsableSourceCode(sourceCode: string | null | undefined): boolean {
  return typeof sourceCode === 'string' && sourceCode.trim().length > 0
}

function buildMetaRegex(attr: string, key: string, contentFirst: boolean): RegExp {
  const q = DOUBLE_QUOTE
  const pair = contentFirst
    ? 'content=' + q + '([^' + q + ']*)' + q + '[^>]*' + attr + '=' + q + key + q
    : attr + '=' + q + key + q + '[^>]*content=' + q + '([^' + q + ']*)' + q
  return new RegExp('<meta[^>]*' + pair + '[^>]*>', 'i')
}

export class CrawlerService {
  /**
   * Fetch project, run crawl, persist CrawlMetadata, and update crawl status.
   *
   * This is also where the `sourceCode` write decision lives, because this is
   * the only layer that holds the project record (Requirement 3.6,
   * Property 26) — and, for the same reason, where the "fetch failed but
   * Source Code exists, so score anyway" fallback lives (Requirement 3.5).
   *
   * Requirements: 3.2, 3.5, 3.6, 4.3, 4.4, 4.5
   */
  static async triggerCrawl(projectId: string): Promise<void> {
    const project = await db.project.findUniqueOrThrow({
      where: { id: projectId },
      include: { category: true },
    })

    console.log('[Crawler] Starting crawl for project ' + projectId + ' (' + project.url + ')')

    await db.project.update({
      where: { id: projectId },
      data: { crawlStatus: 'PROCESSING', crawlError: null },
    })

    console.log('[Crawler] Status set to PROCESSING')

    try {
      console.log('[Crawler] Fetching ' + project.url + ' as ' + project.projectType + '...')
      const metadata = await CrawlerService.crawl(project.url, project.projectType)

      console.log('[Crawler] Crawl succeeded - title: ' + metadata.title + ', widgets: ' + metadata.widgetCount + ', prompts: ' + metadata.prompts.length)

      const widgetsJson = metadata.widgets as unknown as Prisma.InputJsonValue
      const promptsJson = metadata.prompts as unknown as Prisma.InputJsonValue

      /**
       * `rawHtml` is only included when the strategy actually produced one.
       * The Capture Pipeline writes this same column for PartyRock projects,
       * so spreading an `undefined` in — rather than passing `null` — is what
       * stops a PartyRock crawl from clearing a capture blob it never owned.
       */
      const rawHtmlField =
        metadata.rawHtml === undefined ? {} : { rawHtml: metadata.rawHtml }

      /**
       * `structure` follows the same conditional-spread shape as `rawHtml`, and
       * for the same reason: the PartyRock strategy leaves it `undefined`, so a
       * PartyRock crawl must not write the column at all.
       *
       * The three states are distinct and all meaningful:
       *
       *   `undefined` → strategy has no opinion; key omitted, column untouched.
       *   `null`      → parse failed on markup we did fetch; column cleared.
       *   object      → metrics, cast to `Prisma.InputJsonValue` the same way
       *                 `widgetsJson`/`promptsJson` are.
       *
       * `Prisma.DbNull` is the right null here, not `Prisma.JsonNull`: the
       * column is `Json?`, and "we could not derive metrics" means the column
       * has no value (SQL NULL), not that its value is the JSON literal
       * `null`. Readers can then treat `structure == null` as "absent" without
       * having to distinguish the two flavours, and a later successful crawl
       * overwrites it cleanly.
       */
      const structureField =
        metadata.structure === undefined
          ? {}
          : {
            structure:
              metadata.structure === null
                ? Prisma.DbNull
                : (metadata.structure as unknown as Prisma.InputJsonValue),
          }

      await db.crawlMetadata.upsert({
        where: { projectId },
        create: {
          projectId,
          title: metadata.title,
          description: metadata.description,
          widgets: widgetsJson,
          prompts: promptsJson,
          widgetCount: metadata.widgetCount,
          ...rawHtmlField,
          ...structureField,
        },
        update: {
          title: metadata.title,
          description: metadata.description,
          widgets: widgetsJson,
          prompts: promptsJson,
          widgetCount: metadata.widgetCount,
          ...rawHtmlField,
          ...structureField,
          crawledAt: new Date(),
        },
      })

      /**
       * Pasted Source Code always wins (Requirement 3.6, Property 26).
       * The fetched markup fills `sourceCode` only when the column is empty —
       * absent, or whitespace only, since a blank textarea submits `''` rather
       * than `null`. Re-running a crawl on a project that already has Source
       * Code therefore leaves it untouched even when the fetch succeeds.
       */
      const hasSourceCode = hasUsableSourceCode(project.sourceCode)
      const shouldWriteSourceCode =
        !hasSourceCode &&
        typeof metadata.sourceCode === 'string' &&
        metadata.sourceCode.length > 0

      if (hasSourceCode && metadata.sourceCode) {
        console.log(
          '[Crawler] Keeping existing sourceCode for project ' +
          projectId +
          ' - fetched markup not written',
        )
      }

      await db.project.update({
        where: { id: projectId },
        data: {
          crawlStatus: 'SUCCESS',
          crawlError: null,
          ...(shouldWriteSourceCode ? { sourceCode: metadata.sourceCode } : {}),
        },
      })

      console.log('[Crawler] Metadata saved. Status set to SUCCESS.')

      console.log('[Crawler] Triggering AI scoring for project ' + projectId + '...')
      ScorerService.triggerScoring(projectId).catch(console.error)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown crawl error'
      console.error('[Crawler] Crawl FAILED for project ' + projectId + ': ' + message)
      await db.project.update({
        where: { id: projectId },
        data: { crawlStatus: 'FAILED', crawlError: message },
      })

      /**
       * A failed fetch is not the end of the road for an HTML project
       * (Requirement 3.5): the crawl is recorded as `FAILED` with its error —
       * the status machine is untouched — but if Source Code was pasted in
       * beforehand, the evidence needed for scoring is already in the database
       * and scoring proceeds from it.
       *
       * Deliberately scoped to HTML only. Requirement 3.5 sits under
       * Requirement 3 (HTML structure extraction), and Requirement 8.2 pins
       * PartyRock behaviour as-is: today a failed PartyRock crawl does not
       * trigger scoring, and `sourceCode` on a PartyRock project is a
       * Capture Pipeline artefact whose arrival already schedules its own
       * scoring run. Firing here would score PartyRock projects on a path
       * they have never taken.
       *
       * The no-source-code case is intentionally left alone: marking
       * `scoreStatus = FAILED` with an "evidence not available" message is
       * Requirement 4.6, owned by task 7.3 inside `triggerScoring`.
       */
      if (
        project.projectType === ProjectType.HTML &&
        hasUsableSourceCode(project.sourceCode)
      ) {
        console.log(
          '[Crawler] Fetch failed but sourceCode is present - continuing to AI scoring for project ' +
          projectId,
        )
        ScorerService.triggerScoring(projectId).catch(console.error)
      }
    }
  }

  /**
   * Delete existing CrawlMetadata, reset scoreStatus to PENDING, then re-crawl.
   * Requirements: 4.6
   */
  static async retriggerCrawl(projectId: string): Promise<void> {
    console.log('[Crawler] Re-triggering crawl for project ' + projectId + ' - deleting old metadata')

    await db.crawlMetadata.deleteMany({ where: { projectId } })

    await db.project.update({
      where: { id: projectId },
      data: { scoreStatus: 'PENDING' },
    })

    await CrawlerService.triggerCrawl(projectId)
  }

  static decodeHtmlEntities(text: string): string {
    return text
      .replace(/&quot;/g, DOUBLE_QUOTE)
      .replace(/&#39;/g, String.fromCharCode(39))
      .replace(/&apos;/g, String.fromCharCode(39))
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
  }

  static extractMetaTag(html: string, key: string, attr?: string): string | null {
    const a = attr || 'name'
    const regexAttrFirst = buildMetaRegex(a, key, false)
    const regexContentFirst = buildMetaRegex(a, key, true)
    const match = html.match(regexAttrFirst) || html.match(regexContentFirst)
    if (!match) return null
    return CrawlerService.decodeHtmlEntities(match[1])
  }

  /**
   * Fetch a URL over plain HTTP and return its body.
   *
   * Shared by both strategies so the timeout budget, User-Agent and non-2xx
   * handling stay identical across project types — the 15 second
   * `AbortController` deadline is the same one the PartyRock path has always
   * used, and `clearTimeout` runs in `finally` so an aborted or rejected fetch
   * does not leave a timer behind.
   */
  private static async fetchHtml(url: string): Promise<string> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error('Failed to fetch ' + url + ': HTTP ' + response.status)
      }

      return await response.text()
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * PartyRock strategy — unchanged behaviour.
   *
   * Reads the static SEO meta tags (og:title, description) with the same
   * regex helpers as before. No browser automation is used because headless
   * browsers are blocked by AWS WAF at the internal API level.
   * widgets/prompts are always empty - that data is not present in the
   * static HTML and would require the blocked API or full JS rendering.
   *
   * `rawHtml`, `structure` and `sourceCode` are intentionally left
   * `undefined`: this path has never written them, and the Capture Pipeline
   * owns `rawHtml`/`sourceCode` for PartyRock projects.
   */
  private static async crawlPartyRock(url: string): Promise<CrawlOutcome> {
    const html = await CrawlerService.fetchHtml(url)

    const ogTitle =
      CrawlerService.extractMetaTag(html, 'og:title', 'property') ||
      CrawlerService.extractMetaTag(html, 'og:title', 'name')
    const titleTagMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
    const htmlTitle = titleTagMatch ? CrawlerService.decodeHtmlEntities(titleTagMatch[1].trim()) : null

    const title = ogTitle || htmlTitle

    const description =
      CrawlerService.extractMetaTag(html, 'description', 'name') ||
      CrawlerService.extractMetaTag(html, 'og:description', 'property')

    console.log('[Crawler] Extracted title: ' + title + ', description present: ' + (description !== null))

    return {
      title,
      description,
      widgets: [],
      prompts: [],
      widgetCount: 0,
    }
  }

  /**
   * HTML strategy — fetch the markup, keep it, and measure it.
   *
   * Requirements: 3.1, 3.2, 3.3, 3.6
   *
   * Unlike the PartyRock path this one does not throw the fetched body away:
   * the markup is the evidence. Title and description come from the real
   * parser (`documentTitle` / `metaDescription`) rather than regex, so they
   * agree with the rest of the structure metrics by construction.
   *
   * A parse failure is not fatal (design.md error table): `structure` becomes
   * `null`, the markup is still stored, and title/description fall back to the
   * regex helpers so the scorer keeps something to work with.
   */
  private static async crawlHtml(url: string): Promise<CrawlOutcome> {
    const html = await CrawlerService.fetchHtml(url)

    let structure: HtmlStructure | null = null
    try {
      structure = parseHtmlStructure(html)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown parse error'
      console.error('[Crawler] parseHtmlStructure failed for ' + url + ': ' + message)
    }

    const title = structure
      ? structure.documentTitle
      : CrawlerService.extractMetaTag(html, 'og:title', 'property')
    const description = structure
      ? structure.metaDescription
      : CrawlerService.extractMetaTag(html, 'description', 'name')

    console.log(
      '[Crawler] HTML crawl - title: ' +
      title +
      ', description present: ' +
      (description !== null) +
      ', markup: ' +
      html.length +
      ' chars, structure: ' +
      (structure !== null ? 'parsed' : 'unavailable'),
    )

    return {
      title,
      description,
      // Widget/prompt data is a PartyRock concept; an HTML project has none.
      widgets: [],
      prompts: [],
      widgetCount: 0,
      rawHtml: truncate(html, MAX_RAW_HTML_LENGTH),
      structure,
      // Candidate only — see CrawlOutcome.sourceCode.
      sourceCode: truncate(html, MAX_SOURCE_CODE_LENGTH),
    }
  }

  /**
   * Extraction stage, dispatched on project type.
   *
   * `projectType` defaults to `PARTYROCK` so every existing caller —
   * `POST /api/crawl/[projectId]` via `triggerCrawl`, and the test suites that
   * spy on `crawl(url)` — keeps its current behaviour without being touched.
   */
  static async crawl(
    url: string,
    projectType: ProjectType = ProjectType.PARTYROCK,
  ): Promise<CrawlOutcome> {
    return projectType === ProjectType.HTML
      ? CrawlerService.crawlHtml(url)
      : CrawlerService.crawlPartyRock(url)
  }
}
