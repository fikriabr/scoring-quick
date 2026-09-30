// lib/services/source-sync.service.ts
//
// Sync from the external submissions database (SOURCE_DATABASE_URL) into
// scoring-quick projects. The admin picks rows on /admin/sync and maps each
// source theme to a category; this service reads the chosen rows, maps them
// onto the same Project shape a manual/CSV submission produces, and leaves
// them PENDING in the scoring queue — exactly like a CSV import.
//
// The source table is only ever read. Which rows were already synced is
// recorded on our side, in `Project.sourceSubmissionId`.

import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { getSourceSql, SourceDbQueryError } from '@/lib/source-db'
import {
  MAX_IDEA_DOC_LENGTH,
  MAX_SOURCE_CODE_LENGTH,
} from '@/lib/validators/source-code-rules'

/** Rows per sync request. Each one is a separate insert on our side. */
export const MAX_SYNC_BATCH = 200

// -----------------------------------------------------------------------
// Source rows
// -----------------------------------------------------------------------

/** A row of the source `submissions` table, as far as the sync reads it. */
export interface SourceSubmissionRow {
  id: number
  full_name: string | null
  project_title: string | null
  project_theme: string | null
  team_members: string | null
  description: string | null
  md_path: string | null
  md_content: string | null
  html_content: string | null
}

/** What the Sync page lists per source row — no full HTML/markdown bodies. */
export interface SourceSubmissionSummary {
  sourceId: number
  participantName: string | null
  projectTitle: string | null
  /** Trimmed `project_theme`; `''` when the row has none. */
  theme: string
  teamMembers: string | null
  description: string | null
  mdPath: string | null
  submittedAt: string | null
  htmlLength: number
  ideaDocLength: number
  /** The project this row became, if it was synced before. */
  syncedProject: { id: string; categoryName: string; isActive: boolean } | null
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' && value.trim() !== '') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  return null
}

/** `"a, b ,, c"` → `"a, b, c"`; also accepts one member per line. */
export function normaliseTeamMembers(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const members = value
    .split(/[,\n]/)
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
  return members.length > 0 ? members.join(', ') : null
}

// -----------------------------------------------------------------------
// Mapping
// -----------------------------------------------------------------------

export type HtmlReduction = 'none' | 'scripts-emptied' | 'truncated'

/**
 * Fit an HTML page into `Project.sourceCode`'s limit (the same one the form,
 * CSV import and editor enforce, so a synced value can be edited and saved).
 *
 * Plain truncation is the last resort, not the first: source pages that blow
 * the limit are typically a few KB of content plus a bundled `<script>` of a
 * megabyte, and cutting at 100k would keep the script and drop the content.
 * Inline script bodies are emptied first — the tags stay, so structure
 * metrics that count scripts still see them — because the HTML track is judged
 * on visible content and composition, never on JavaScript source.
 */
export function fitHtmlToLimit(
  html: string,
  max: number = MAX_SOURCE_CODE_LENGTH,
): { html: string; reduction: HtmlReduction } {
  if (html.length <= max) return { html, reduction: 'none' }
  const emptied = html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script\s*>)/gi, '$1$2')
  if (emptied.length <= max) return { html: emptied, reduction: 'scripts-emptied' }
  return { html: emptied.slice(0, max), reduction: 'truncated' }
}

export interface MappedSubmission {
  participantName: string
  projectTitle: string | null
  teamMembers: string | null
  description: string | null
  sourceCode: string
  ideaDoc: string | null
  /** Things the admin should know about, but that do not block the sync. */
  warnings: string[]
}

export type MapResult = { ok: true; value: MappedSubmission } | { ok: false; error: string }

const fmt = (n: number) => n.toLocaleString('en-US')

/**
 * Source row → the fields of a Project. Pure, so the rules are testable
 * without either database.
 *
 * - `full_name` → `participantName` (required, like every submission)
 * - `project_title`, `team_members`, `description` → their own columns
 * - `html_content` → `sourceCode` (required: a synced project has no URL, so
 *   the HTML is the only evidence for the HTML track)
 * - `md_content` → `ideaDoc`; a row without it still syncs, with a warning —
 *   the idea document can be pasted later on the detail page
 */
export function mapSourceSubmission(row: SourceSubmissionRow): MapResult {
  const participantName = clean(row.full_name)
  if (!participantName) return { ok: false, error: 'The source row has no full_name.' }

  if (typeof row.html_content !== 'string' || row.html_content.trim() === '') {
    return { ok: false, error: 'The source row has no html_content.' }
  }

  const warnings: string[] = []

  const html = fitHtmlToLimit(row.html_content)
  if (html.reduction === 'scripts-emptied') {
    warnings.push(
      `HTML was ${fmt(row.html_content.length)} characters (limit ${fmt(MAX_SOURCE_CODE_LENGTH)}); ` +
        'inline <script> contents were removed to fit. Page text and markup are kept.',
    )
  } else if (html.reduction === 'truncated') {
    warnings.push(
      `HTML was ${fmt(row.html_content.length)} characters and still over the ` +
        `${fmt(MAX_SOURCE_CODE_LENGTH)} limit without inline scripts; it was cut to the first ` +
        `${fmt(MAX_SOURCE_CODE_LENGTH)} characters.`,
    )
  }

  let ideaDoc = clean(row.md_content)
  if (!ideaDoc) {
    const file = clean(row.md_path)
    warnings.push(
      `No idea document (md_content is empty${file ? `; file "${file}" was not uploaded as content` : ''}). ` +
        'The IDEA track fails until one is added on the detail page.',
    )
  } else if (ideaDoc.length > MAX_IDEA_DOC_LENGTH) {
    warnings.push(
      `Idea document was ${fmt(ideaDoc.length)} characters; cut to the first ${fmt(MAX_IDEA_DOC_LENGTH)}.`,
    )
    ideaDoc = ideaDoc.slice(0, MAX_IDEA_DOC_LENGTH)
  }

  return {
    ok: true,
    value: {
      participantName,
      projectTitle: clean(row.project_title),
      teamMembers: normaliseTeamMembers(row.team_members),
      description: clean(row.description),
      sourceCode: html.html,
      ideaDoc,
      warnings,
    },
  }
}

// -----------------------------------------------------------------------
// Listing
// -----------------------------------------------------------------------

interface SourceSummaryRow {
  id: number
  full_name: string | null
  project_title: string | null
  project_theme: string | null
  team_members: string | null
  description: string | null
  md_path: string | null
  created_at: unknown
  html_length: number | null
  idea_doc_length: number | null
}

/** Every source row, newest first, with whether (and where) it was synced. */
export async function listSourceSubmissions(): Promise<SourceSubmissionSummary[]> {
  const sql = getSourceSql()
  let rows: SourceSummaryRow[]
  try {
    // Lengths instead of bodies: a single page can be a megabyte of HTML.
    rows = (await sql`
      SELECT id, full_name, project_title, project_theme, team_members, description,
        md_path, created_at,
        coalesce(length(html_content), 0)::int AS html_length,
        coalesce(length(btrim(md_content)), 0)::int AS idea_doc_length
      FROM submissions
      ORDER BY created_at DESC NULLS LAST, id DESC
    `) as SourceSummaryRow[]
  } catch (error) {
    throw new SourceDbQueryError(error)
  }

  const linked =
    rows.length === 0
      ? []
      : await db.project.findMany({
          where: { sourceSubmissionId: { in: rows.map((r) => r.id) } },
          select: {
            id: true,
            sourceSubmissionId: true,
            isActive: true,
            category: { select: { name: true } },
          },
        })
  const bySourceId = new Map(linked.map((p) => [p.sourceSubmissionId, p]))

  return rows.map((row) => {
    const project = bySourceId.get(row.id)
    return {
      sourceId: row.id,
      participantName: clean(row.full_name),
      projectTitle: clean(row.project_title),
      theme: clean(row.project_theme) ?? '',
      teamMembers: normaliseTeamMembers(row.team_members),
      description: clean(row.description),
      mdPath: clean(row.md_path),
      submittedAt: toIso(row.created_at),
      htmlLength: row.html_length ?? 0,
      ideaDocLength: row.idea_doc_length ?? 0,
      syncedProject: project
        ? { id: project.id, categoryName: project.category.name, isActive: project.isActive }
        : null,
    }
  })
}

// -----------------------------------------------------------------------
// Syncing
// -----------------------------------------------------------------------

export const SyncRequestSchema = z
  .object({
    items: z
      .array(
        z.object({
          sourceId: z.number().int().positive(),
          categoryId: z.string().trim().min(1, 'Category is required.'),
        }),
      )
      .min(1, 'Select at least one submission to sync.')
      .max(MAX_SYNC_BATCH, `Sync at most ${MAX_SYNC_BATCH} submissions at a time.`),
  })
  .refine((body) => new Set(body.items.map((i) => i.sourceId)).size === body.items.length, {
    message: 'Each submission can be selected only once.',
    path: ['items'],
  })

export type SyncRequest = z.infer<typeof SyncRequestSchema>

export interface SyncResult {
  created: { sourceId: number; projectId: string; warnings: string[] }[]
  skipped: { sourceId: number; projectId: string; reason: string }[]
  failed: { sourceId: number; message: string }[]
}

const ALREADY_SYNCED = 'Already synced.'

async function readSourceRows(sourceIds: number[]): Promise<SourceSubmissionRow[]> {
  const sql = getSourceSql()
  try {
    const rows = await sql`
      SELECT id, full_name, project_title, project_theme, team_members, description,
        md_path, md_content, html_content
      FROM submissions
      WHERE id = ANY(${sourceIds})
    `
    return rows as SourceSubmissionRow[]
  } catch (error) {
    throw new SourceDbQueryError(error)
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

/**
 * Create one project per selected source row. Rows are handled one by one and
 * each outcome is reported, so one bad row never blocks the rest.
 *
 * Content is re-read from the source here rather than taken from the request:
 * the browser only says *which* rows and *where*, never what they contain.
 */
export async function syncSourceSubmissions(input: unknown): Promise<SyncResult> {
  const { items } = SyncRequestSchema.parse(input)
  const sourceIds = items.map((i) => i.sourceId)

  const [rows, categories, linked] = await Promise.all([
    readSourceRows(sourceIds),
    db.category.findMany({
      where: { id: { in: [...new Set(items.map((i) => i.categoryId))] } },
      select: { id: true },
    }),
    db.project.findMany({
      where: { sourceSubmissionId: { in: sourceIds } },
      select: { id: true, sourceSubmissionId: true, isActive: true },
    }),
  ])

  const rowById = new Map(rows.map((r) => [r.id, r]))
  const categoryIds = new Set(categories.map((c) => c.id))
  const linkBySourceId = new Map(linked.map((p) => [p.sourceSubmissionId, p]))

  const result: SyncResult = { created: [], skipped: [], failed: [] }

  for (const { sourceId, categoryId } of items) {
    const row = rowById.get(sourceId)
    if (!row) {
      result.failed.push({ sourceId, message: 'Not found in the source database.' })
      continue
    }
    if (!categoryIds.has(categoryId)) {
      result.failed.push({ sourceId, message: 'Target category not found.' })
      continue
    }

    const link = linkBySourceId.get(sourceId)
    if (link?.isActive) {
      result.skipped.push({ sourceId, projectId: link.id, reason: ALREADY_SYNCED })
      continue
    }

    const mapped = mapSourceSubmission(row)
    if (!mapped.ok) {
      result.failed.push({ sourceId, message: mapped.error })
      continue
    }
    const { warnings, ...fields } = mapped.value

    try {
      // A synced project that was soft-deleted still holds the source id (the
      // column is unique). Syncing the row again is the admin asking for it
      // back, so the deleted project lets go of the link; its history stays.
      if (link) {
        await db.project.update({
          where: { id: link.id },
          data: { sourceSubmissionId: null },
        })
      }

      const project = await db.project.create({
        data: {
          categoryId,
          url: null,
          teamName: null,
          ...fields,
          sourceSubmissionId: sourceId,
          // Left for the scoring queue, exactly like a CSV import. With no
          // URL the queue's crawl step is a no-op that goes straight to scoring.
          crawlStatus: 'PENDING',
          scoreStatus: 'PENDING',
        },
        select: { id: true },
      })
      result.created.push({ sourceId, projectId: project.id, warnings })
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Another admin synced the same row between our read and this insert.
        const existing = await db.project
          .findUnique({ where: { sourceSubmissionId: sourceId }, select: { id: true } })
          .catch(() => null)
        result.skipped.push({ sourceId, projectId: existing?.id ?? '', reason: ALREADY_SYNCED })
        continue
      }
      const message = error instanceof Error ? error.message : 'Could not create the project.'
      console.error(`[Sync] Source submission ${sourceId} failed:`, error)
      result.failed.push({ sourceId, message })
    }
  }

  return result
}
