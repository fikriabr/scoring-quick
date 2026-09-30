// lib/services/export.service.ts
// Export leaderboard data to Excel (XLSX) or CSV formats.
// Requirements: 8.3

import ExcelJS from 'exceljs'
import type { ProjectWithScores } from '@/types'

/** A parameter column of the export, in the order the category lists them. */
export interface ExportParameter {
  id: string
  name: string
}

/**
 * The parameter columns. The category's own parameters when the caller has
 * them — that gives real names, their order, and a column for MANUAL
 * parameters no AI ever scored. Without them, every parameter id that appears
 * in any score, named by its id.
 */
function resolveParameters(
  projects: ProjectWithScores[],
  parameters?: ExportParameter[],
): ExportParameter[] {
  if (parameters && parameters.length > 0) return parameters
  const seen = new Map<string, string>()
  for (const project of projects) {
    for (const score of [...project.aiScores, ...project.juryScores]) {
      if (!seen.has(score.parameterId)) seen.set(score.parameterId, score.parameterId)
    }
    for (const ps of project.parameterScores ?? []) {
      seen.set(ps.parameterId, ps.parameterName)
    }
  }
  return [...seen].map(([id, name]) => ({ id, name }))
}

/**
 * The jury's verdict on one parameter: the mean over every jury who scored it
 * — the same value the final score uses — and all of their comments. Taking a
 * single row would silently drop every other jury.
 */
function juryVerdict(
  project: ProjectWithScores,
  parameterId: string,
): { score: number | null; comment: string } {
  const rows = project.juryScores.filter((s) => s.parameterId === parameterId)
  if (rows.length === 0) return { score: null, comment: '' }
  const mean = rows.reduce((sum, s) => sum + s.score, 0) / rows.length
  return {
    score: rows.length === 1 ? rows[0].score : Math.round(mean * 100) / 100,
    comment: rows
      .map((s) => s.comment?.trim())
      .filter((c): c is string => Boolean(c))
      .join(' | '),
  }
}

function aiScoreOf(project: ProjectWithScores, parameterId: string): number | null {
  return project.aiScores.find((s) => s.parameterId === parameterId)?.score ?? null
}

const BASE_HEADERS = [
  'Peringkat',
  'Nama Peserta',
  'Tim',
  'Judul Project',
  'URL Project',
  'Skor Final',
  'Skor Idea (MD)',
  'Skor HTML',
]

function parameterHeaders(name: string): [string, string, string] {
  return [`AI: ${name}`, `Juri (rata-rata): ${name}`, `Komentar: ${name}`]
}

// -----------------------------------------------------------------------
// exportToExcel
// Generates an Excel workbook buffer containing the leaderboard data.
// Dynamic columns are added per-parameter (AI score, jury score, comment).
// Requirements: 8.3
// -----------------------------------------------------------------------

export async function exportToExcel(
  projects: ProjectWithScores[],
  parameters?: ExportParameter[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Penilaian')
  const columnsFor = resolveParameters(projects, parameters)

  const baseKeys = [
    'rank',
    'participantName',
    'teamName',
    'projectTitle',
    'url',
    'finalScore',
    'ideaScore',
    'htmlScore',
  ]
  const baseWidths = [10, 25, 20, 30, 40, 12, 14, 12]
  const columns: Partial<ExcelJS.Column>[] = BASE_HEADERS.map((header, i) => ({
    header,
    key: baseKeys[i],
    width: baseWidths[i],
  }))

  for (const param of columnsFor) {
    const [ai, jury, comment] = parameterHeaders(param.name)
    columns.push(
      { header: ai, key: `ai_${param.id}`, width: 15 },
      { header: jury, key: `jury_${param.id}`, width: 15 },
      { header: comment, key: `comment_${param.id}`, width: 25 },
    )
  }

  sheet.columns = columns

  for (const project of projects) {
    const row: Record<string, unknown> = {
      rank: project.rank ?? null,
      participantName: project.participantName,
      teamName: project.teamName ?? '',
      projectTitle: project.projectTitle ?? '',
      url: project.url ?? '',
      finalScore: project.finalScore,
      ideaScore: project.ideaScore ?? null,
      htmlScore: project.htmlScore ?? null,
    }

    for (const param of columnsFor) {
      const verdict = juryVerdict(project, param.id)
      row[`ai_${param.id}`] = aiScoreOf(project, param.id)
      row[`jury_${param.id}`] = verdict.score
      row[`comment_${param.id}`] = verdict.comment
    }

    sheet.addRow(row)
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer)
}

// -----------------------------------------------------------------------
// exportToCsv
// Generates a CSV string with header + rows for the leaderboard data.
// Requirements: 8.3
// -----------------------------------------------------------------------

/**
 * Byte-order mark: without it Excel opens a UTF-8 CSV in the local ANSI code
 * page, and every non-Latin name (Thai, accented Indonesian) turns to mojibake.
 */
const UTF8_BOM = '﻿'

export function exportToCsv(
  projects: ProjectWithScores[],
  parameters?: ExportParameter[],
): string {
  const columnsFor = resolveParameters(projects, parameters)

  const headers = [...BASE_HEADERS, ...columnsFor.flatMap((p) => parameterHeaders(p.name))]
  const lines: string[] = [headers.map((h) => escapeCsvField(neutraliseFormula(h))).join(',')]

  for (const project of projects) {
    const fields: string[] = [
      String(project.rank ?? ''),
      neutraliseFormula(project.participantName),
      neutraliseFormula(project.teamName ?? ''),
      neutraliseFormula(project.projectTitle ?? ''),
      neutraliseFormula(project.url ?? ''),
      project.finalScore != null ? String(project.finalScore) : '',
      project.ideaScore != null ? String(project.ideaScore) : '',
      project.htmlScore != null ? String(project.htmlScore) : '',
    ]

    for (const param of columnsFor) {
      const ai = aiScoreOf(project, param.id)
      const verdict = juryVerdict(project, param.id)
      fields.push(
        ai != null ? String(ai) : '',
        verdict.score != null ? String(verdict.score) : '',
        neutraliseFormula(verdict.comment),
      )
    }

    lines.push(fields.map(escapeCsvField).join(','))
  }

  return UTF8_BOM + lines.join('\n')
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

/**
 * Participant-supplied text that starts like a formula (`=`, `+`, `-`, `@`)
 * is executed by spreadsheet apps when the CSV is opened. A leading apostrophe
 * makes it plain text. Only applied to free text — never to numeric cells.
 */
function neutraliseFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

/**
 * Escapes a CSV field value. Wraps in quotes if the value contains
 * commas, double quotes, or newlines.
 */
function escapeCsvField(value: string): string {
  if (
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
