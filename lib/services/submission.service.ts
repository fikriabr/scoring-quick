// lib/services/submission.service.ts
// Requirements: 3.1, 3.2, 3.3, 3.4, 3.5

import { parse } from 'csv-parse/sync'
import { db } from '@/lib/db'
import {
  SubmissionSchema,
  CsvRowRawSchema,
  type SubmissionInput,
} from '@/lib/validators/schemas'
import type { Project, ProjectType } from '@prisma/client'

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export class DuplicateUrlError extends Error {
  readonly code = 'DUPLICATE_URL'
  readonly status = 409

  constructor(url: string, categoryId: string) {
    super(`URL "${url}" has already been submitted to category "${categoryId}".`)
    this.name = 'DuplicateUrlError'
  }
}

/**
 * A project this import actually created, identified well enough for the caller
 * to start the right pipeline for it.
 *
 * The bulk route needs this because "start a crawl for the HTML rows" is
 * otherwise unanswerable: a count tells you how many rows landed but not which
 * projects they became. Re-deriving the set with a query (recent PENDING rows
 * in the category, newest first, limited to the count) sweeps up unrelated
 * projects that happen to still be PENDING from an earlier import.
 * Requirements: 3.1
 */
export type CsvImportedProject = {
  id: string
  projectType: ProjectType
}

export type CsvImportResult = {
  /**
   * Kept as a plain count alongside `created` because it is what the client
   * renders ("Successfully imported N project(s)") and what the existing tests
   * assert on. It is always `created.length`.
   */
  imported: number
  created: CsvImportedProject[]
  errors: { row: number; message: string }[]
}

// -----------------------------------------------------------------------
// CSV header / delimiter normalisation
//
// Real-world CSVs rarely arrive with the exact lowercase snake_case headers
// the schema expects. Excel in a non-en locale (id-ID among them) writes
// semicolon-separated files, hand-made files use "URL" or "Participant Name",
// and files exported from Windows tools carry a UTF-8 BOM. Without this
// normalisation every row fails with a bare "expected string, received
// undefined" because the `url` key simply is not there.
// Requirements: 3.4, 3.5
// -----------------------------------------------------------------------

/**
 * Reduce a raw header cell to a comparable key: strip BOM and surrounding
 * quotes, lowercase, and collapse spaces/dashes/dots into underscores.
 * `" Participant Name "` and `participant-name` both become `participant_name`.
 */
function normaliseHeaderName(raw: string): string {
  return raw
    .replace(/^﻿/, '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .toLowerCase()
    .replace(/[\s\-.]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
}

/**
 * Maps normalised header keys onto the canonical field names that
 * `CsvRowRawSchema` reads. Indonesian column names are included because the
 * admin UI and docs are in Indonesian. Unrecognised headers pass through
 * unchanged and are simply ignored by the schema.
 */
const HEADER_ALIASES: Record<string, string> = {
  // url
  url: 'url',
  app_url: 'url',
  appurl: 'url',
  partyrock_url: 'url',
  partyrockurl: 'url',
  link: 'url',
  tautan: 'url',
  // participantName
  participant_name: 'participantName',
  participantname: 'participantName',
  participant: 'participantName',
  nama_peserta: 'participantName',
  namapeserta: 'participantName',
  peserta: 'participantName',
  // teamName
  team_name: 'teamName',
  teamname: 'teamName',
  team: 'teamName',
  nama_tim: 'teamName',
  namatim: 'teamName',
  tim: 'teamName',
  kelompok: 'teamName',
  // sourceCode
  source_code: 'sourceCode',
  sourcecode: 'sourceCode',
  source: 'sourceCode',
  kode_sumber: 'sourceCode',
  kodesumber: 'sourceCode',
  // categoryId
  category_id: 'categoryId',
  categoryid: 'categoryId',
  category: 'categoryId',
  kategori: 'categoryId',
  // projectType — `project_type` and `projectType` are the header names the
  // requirement names explicitly; the rest follow the same aliasing pattern as
  // the fields above (`Project Type`, `project-type` and `PROJECT_TYPE` all
  // normalise to `project_type`, and `projectType` to `projecttype`).
  // An absent column, or a blank cell, falls back to PARTYROCK in the schema.
  // Requirements: 1.5
  project_type: 'projectType',
  projecttype: 'projectType',
  type: 'projectType',
  tipe_project: 'projectType',
  tipeproject: 'projectType',
  tipe_proyek: 'projectType',
  tipeproyek: 'projectType',
  tipe: 'projectType',
}

function canonicalHeader(raw: string): string {
  const key = normaliseHeaderName(raw)
  return HEADER_ALIASES[key] ?? key
}

/**
 * Guess the field separator from the header line. Excel writes `;` under
 * locales that use `,` as the decimal separator, which otherwise parses the
 * whole header as one single column.
 */
function detectDelimiter(csvContent: string): string {
  const headerLine =
    csvContent.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''

  let best = ','
  let bestCount = 0
  for (const candidate of [',']) {
    const count = headerLine.split(candidate).length - 1
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

// -----------------------------------------------------------------------
// submitProject
// Validates input, checks for duplicates, creates Project with
// crawlStatus = PENDING and scoreStatus = PENDING.
// Requirements: 3.1, 3.2, 3.3
// -----------------------------------------------------------------------

export async function submitProject(input: unknown): Promise<Project> {
  // Validate via Zod — throws ZodError on invalid input
  const data: SubmissionInput = SubmissionSchema.parse(input)

  // Duplicate check: same URL within the same category
  const existing = await db.project.findFirst({
    where: {
      categoryId: data.categoryId,
      url: data.url,
    },
  })

  if (existing) {
    throw new DuplicateUrlError(data.url, data.categoryId)
  }

  // Create Project record — crawlStatus and scoreStatus default to PENDING
  // in the Prisma schema, so we don't need to specify them explicitly.
  const project = await db.project.create({
    data: {
      categoryId: data.categoryId,
      url: data.url,
      // Always present on parsed data — SubmissionSchema defaults it to
      // PARTYROCK when the caller omits the field.
      projectType: data.projectType,
      participantName: data.participantName,
      teamName: data.teamName ?? null,
      sourceCode: data.sourceCode ?? null,
      // Explicit defaults for clarity
      crawlStatus: 'PENDING',
      scoreStatus: 'PENDING',
    },
  })

  return project
}

// -----------------------------------------------------------------------
// bulkImportFromCsv
// Parses CSV content, validates each row via CsvRowRawSchema (which
// normalises snake_case headers and then pipes through CsvRowSchema),
// imports valid rows, and returns a summary with row-level errors.
//
// Row numbering is 1-indexed from the header (header = row 1, first
// data row = row 2).
//
// Requirements: 3.4, 3.5
// -----------------------------------------------------------------------

export async function bulkImportFromCsv(
  csvContent: string,
  categoryId: string,
): Promise<CsvImportResult> {
  // Parse raw CSV — produces an array of plain objects keyed by the
  // normalised header row, so header casing/spacing and the delimiter used
  // by the exporting tool do not matter.
  let headers: string[] = []
  let rows: Record<string, string>[]

  try {
    rows = parse(csvContent, {
      columns: (header: string[]) => {
        headers = header.map(canonicalHeader)
        return headers
      },
      delimiter: detectDelimiter(csvContent),
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as Record<string, string>[]
  } catch (err) {
    // Malformed quoting etc. — report it against the file rather than
    // bubbling up as a generic 500.
    const message = err instanceof Error ? err.message : 'Unknown parse error'
    return {
      imported: 0,
      created: [],
      errors: [{ row: 1, message: `Could not parse CSV file: ${message}` }],
    }
  }

  // Fail fast with one actionable message when a required column is absent,
  // instead of repeating the same per-row error for every line in the file.
  const missingColumns = (['url', 'participantName'] as const).filter(
    (column) => !headers.includes(column),
  )

  if (rows.length > 0 && missingColumns.length > 0) {
    return {
      imported: 0,
      created: [],
      errors: [
        {
          row: 1,
          message:
            `CSV is missing required column(s): ${missingColumns.join(', ')}. ` +
            `Detected columns: ${headers.join(', ') || '(none)'}. ` +
            `Expected a header row such as: url, participant_name, team_name, source_code.`,
        },
      ],
    }
  }

  const errors: { row: number; message: string }[] = []
  const created: CsvImportedProject[] = []

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 2 // header is row 1; first data row is row 2

    // Inject the categoryId from the caller so CsvRowSchema can validate it.
    // A per-row value wins, but an empty/blank cell falls back to the caller's
    // category rather than failing validation with "Category ID is required".
    const rowCategoryId = rows[i].categoryId?.trim()
    const rawRow = {
      ...rows[i],
      categoryId: rowCategoryId || categoryId,
    }

    // Normalise snake_case headers and validate via CsvRowSchema
    const parsed = CsvRowRawSchema.safeParse(rawRow)

    if (!parsed.success) {
      // Zod v4 uses .issues; fall back to .errors for v3 compatibility
      type Issue = { message: string; path?: (string | number)[] }
      const issueList =
        (parsed.error as { issues?: Issue[] }).issues ??
        (parsed.error as { errors?: Issue[] }).errors ??
        []
      const firstIssue = issueList[0]
      // Prefix with the offending field name — a bare "expected string,
      // received undefined" gives the admin nothing to act on.
      const fieldPath = firstIssue?.path?.join('.') ?? ''
      const firstMessage = firstIssue
        ? fieldPath
          ? `${fieldPath}: ${firstIssue.message}`
          : firstIssue.message
        : 'Validation failed.'
      errors.push({
        row: rowNumber,
        message: firstMessage,
      })
      continue
    }

    // `projectType` is always present on parsed data — CsvRowSchema defaults it
    // to PARTYROCK when the column is absent or the cell is blank.
    const { url, projectType, participantName, teamName, sourceCode } =
      parsed.data

    try {
      // Skip silently if exact duplicate (same URL + categoryId) already exists
      const existing = await db.project.findFirst({
        where: { categoryId, url },
      })

      if (existing) {
        errors.push({
          row: rowNumber,
          message: `URL "${url}" already exists in this category.`,
        })
        continue
      }

      const project = await db.project.create({
        data: {
          categoryId,
          url,
          projectType,
          participantName,
          teamName: teamName ?? null,
          sourceCode: sourceCode ?? null,
          crawlStatus: 'PENDING',
          scoreStatus: 'PENDING',
        },
      })

      // `id` comes from the row the write returned; `projectType` comes from the
      // validated input rather than from that row, because it is the same value
      // and reading it back adds a dependency on the shape of the returned
      // record for no gain.
      created.push({ id: project.id, projectType })
    } catch (err) {
      // Catch unexpected DB errors per-row so other rows still process
      const message =
        err instanceof Error ? err.message : 'Failed to import row.'
      errors.push({ row: rowNumber, message })
    }
  }

  return { imported: created.length, created, errors }
}
