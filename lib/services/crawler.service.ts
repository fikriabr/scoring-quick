// lib/services/crawler.service.ts
//
// Lightweight metadata crawler using plain HTTP fetch, no browser needed.
//
// Fetches the project URL, keeps the markup, and derives structure metrics
// from it via lib/services/html-structure.service.ts. The markup is also
// offered as a `Project.sourceCode` candidate — but only when that column is
// still empty, because a human-pasted Source Code always outranks a fetch.

import { db } from '@/lib/db'
import { parseHtmlStructure } from '@/lib/services/html-structure.service'
import { ScorerService } from '@/lib/services/scorer.service'
import { Prisma } from '@prisma/client'
import type { HtmlStructure, WidgetInfo } from '@/types'

const FETCH_TIMEOUT_MS = 15_000
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Cap on the markup stored in `CrawlMetadata.rawHtml`. */
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

export interface CrawlOutcome {
  title: string | null
  description: string | null
  widgets: WidgetInfo[]
  prompts: string[]
  widgetCount: number
  rawHtml: string
  structure: HtmlStructure | null
  /**
   * Markup offered as `Project.sourceCode`. This is a **candidate only**:
   * `crawl()` receives a URL, not the project record, so it cannot know
   * whether a `sourceCode` already exists. The decision to write it belongs
   * to `triggerCrawl`, which does hold the record and refuses to overwrite a
   * non-empty value.
   */
  sourceCode: string
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/**
 * Whether a project already holds usable Source Code.
 *
 * Whitespace counts as empty because a blank textarea submits `''`, not
 * `null`. Both the "never overwrite a pasted value" rule and the "a failed
 * fetch is still scoreable" rule hinge on the same question, so they ask it
 * the same way.
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
   * the only layer that holds the project record — and, for the same reason,
   * where the "fetch failed but Source Code exists, so score anyway" fallback
   * lives.
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
      console.log('[Crawler] Fetching ' + project.url + '...')
      const metadata = await CrawlerService.crawl(project.url)

      console.log('[Crawler] Crawl succeeded - title: ' + metadata.title)

      const widgetsJson = metadata.widgets as unknown as Prisma.InputJsonValue
      const promptsJson = metadata.prompts as unknown as Prisma.InputJsonValue

      await db.crawlMetadata.upsert({
        where: { projectId },
        create: {
          projectId,
          title: metadata.title,
          description: metadata.description,
          widgets: widgetsJson,
          prompts: promptsJson,
          widgetCount: metadata.widgetCount,
          rawHtml: metadata.rawHtml,
          structure:
            metadata.structure === null
              ? Prisma.DbNull
              : (metadata.structure as unknown as Prisma.InputJsonValue),
        },
        update: {
          title: metadata.title,
          description: metadata.description,
          widgets: widgetsJson,
          prompts: promptsJson,
          widgetCount: metadata.widgetCount,
          rawHtml: metadata.rawHtml,
          structure:
            metadata.structure === null
              ? Prisma.DbNull
              : (metadata.structure as unknown as Prisma.InputJsonValue),
          crawledAt: new Date(),
        },
      })

      /**
       * Pasted Source Code always wins. The fetched markup fills `sourceCode`
       * only when the column is empty — absent, or whitespace only, since a
       * blank textarea submits `''` rather than `null`. Re-running a crawl on
       * a project that already has Source Code therefore leaves it untouched
       * even when the fetch succeeds.
       */
      const hasSourceCode = hasUsableSourceCode(project.sourceCode)
      const shouldWriteSourceCode = !hasSourceCode && metadata.sourceCode.length > 0

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
       * A failed fetch is not the end of the road: the crawl is recorded as
       * `FAILED` with its error — the status machine is untouched — but if
       * Source Code was pasted in beforehand, the evidence needed for scoring
       * is already in the database and scoring proceeds from it.
       *
       * The no-source-code case is intentionally left alone: marking
       * `scoreStatus = FAILED` with an "evidence not available" message is
       * owned by `triggerScoring`.
       */
      if (hasUsableSourceCode(project.sourceCode)) {
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
   * Fetch a URL over plain HTTP and return its body. The 15 second
   * `AbortController` deadline runs in `finally` so an aborted or rejected
   * fetch does not leave a timer behind.
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
   * Fetch the markup, keep it, and measure it.
   *
   * Title and description come from the real parser (`documentTitle` /
   * `metaDescription`) rather than regex, so they agree with the rest of the
   * structure metrics by construction.
   *
   * A parse failure is not fatal: `structure` becomes `null`, the markup is
   * still stored, and title/description fall back to the regex helpers so the
   * scorer keeps something to work with.
   */
  static async crawl(url: string): Promise<CrawlOutcome> {
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
      // Widget/prompt data has no meaning for a plain HTML project.
      widgets: [],
      prompts: [],
      widgetCount: 0,
      rawHtml: truncate(html, MAX_RAW_HTML_LENGTH),
      structure,
      sourceCode: truncate(html, MAX_SOURCE_CODE_LENGTH),
    }
  }
}
