// lib/services/export.service.ts
// Export leaderboard data to Excel (XLSX) or CSV formats.
// Requirements: 8.3

import ExcelJS from 'exceljs'
import type { ProjectWithScores } from '@/types'

// -----------------------------------------------------------------------
// exportToExcel
// Generates an Excel workbook buffer containing the leaderboard data.
// Dynamic columns are added per-parameter (AI score, jury score, comment).
// Requirements: 8.3
// -----------------------------------------------------------------------

export async function exportToExcel(
  projects: ProjectWithScores[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Penilaian')

  // Collect all unique parameter IDs from the projects' scores
  const parameterMap = new Map<string, string>()
  for (const project of projects) {
    for (const score of project.aiScores) {
      if (!parameterMap.has(score.parameterId)) {
        parameterMap.set(score.parameterId, score.parameterId)
      }
    }
    if (project.parameterScores) {
      for (const ps of project.parameterScores) {
        if (!parameterMap.has(ps.parameterId)) {
          parameterMap.set(ps.parameterId, ps.parameterName)
        } else if (parameterMap.get(ps.parameterId) === ps.parameterId) {
          // Replace ID with actual name if available
          parameterMap.set(ps.parameterId, ps.parameterName)
        }
      }
    }
  }

  // Base columns
  const columns: Partial<ExcelJS.Column>[] = [
    { header: 'Peringkat', key: 'rank', width: 10 },
    { header: 'Nama Peserta', key: 'participantName', width: 25 },
    { header: 'Tim', key: 'teamName', width: 20 },
    { header: 'URL Project', key: 'url', width: 40 },
    { header: 'Skor Final', key: 'finalScore', width: 12 },
    { header: 'Skor Idea (MD)', key: 'ideaScore', width: 14 },
    { header: 'Skor HTML', key: 'htmlScore', width: 12 },
  ]

  // Dynamic columns per parameter
  const parameterIds = Array.from(parameterMap.keys())
  for (const paramId of parameterIds) {
    const name = parameterMap.get(paramId) ?? paramId
    columns.push(
      { header: `AI: ${name}`, key: `ai_${paramId}`, width: 15 },
      { header: `Juri: ${name}`, key: `jury_${paramId}`, width: 15 },
      { header: `Komentar: ${name}`, key: `comment_${paramId}`, width: 25 },
    )
  }

  sheet.columns = columns

  // Add rows
  for (const project of projects) {
    const row: Record<string, unknown> = {
      rank: project.rank ?? null,
      participantName: project.participantName,
      teamName: project.teamName ?? '',
      url: project.url,
      finalScore: project.finalScore,
      ideaScore: project.ideaScore ?? null,
      htmlScore: project.htmlScore ?? null,
    }

    // Populate AI scores
    for (const score of project.aiScores) {
      row[`ai_${score.parameterId}`] = score.score
    }

    // Populate jury scores and comments
    for (const score of project.juryScores) {
      row[`jury_${score.parameterId}`] = score.score
      if (score.comment) {
        row[`comment_${score.parameterId}`] = score.comment
      }
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

export function exportToCsv(projects: ProjectWithScores[]): string {
  // Collect all unique parameter IDs
  const parameterMap = new Map<string, string>()
  for (const project of projects) {
    for (const score of project.aiScores) {
      if (!parameterMap.has(score.parameterId)) {
        parameterMap.set(score.parameterId, score.parameterId)
      }
    }
    if (project.parameterScores) {
      for (const ps of project.parameterScores) {
        if (!parameterMap.has(ps.parameterId)) {
          parameterMap.set(ps.parameterId, ps.parameterName)
        } else if (parameterMap.get(ps.parameterId) === ps.parameterId) {
          parameterMap.set(ps.parameterId, ps.parameterName)
        }
      }
    }
  }

  const parameterIds = Array.from(parameterMap.keys())

  // Build header
  const headers: string[] = [
    'Peringkat',
    'Nama Peserta',
    'Tim',
    'URL Project',
    'Skor Final',
    'Skor Idea (MD)',
    'Skor HTML',
  ]

  for (const paramId of parameterIds) {
    const name = parameterMap.get(paramId) ?? paramId
    headers.push(`AI: ${name}`, `Juri: ${name}`, `Komentar: ${name}`)
  }

  const lines: string[] = [headers.map(escapeCsvField).join(',')]

  // Build data rows
  for (const project of projects) {
    const fields: string[] = [
      String(project.rank ?? ''),
      project.participantName,
      project.teamName ?? '',
      project.url ?? '',
      project.finalScore != null ? String(project.finalScore) : '',
      project.ideaScore != null ? String(project.ideaScore) : '',
      project.htmlScore != null ? String(project.htmlScore) : '',
    ]

    for (const paramId of parameterIds) {
      const aiScore = project.aiScores.find((s) => s.parameterId === paramId)
      const juryScore = project.juryScores.find(
        (s) => s.parameterId === paramId,
      )

      fields.push(
        aiScore ? String(aiScore.score) : '',
        juryScore ? String(juryScore.score) : '',
        juryScore?.comment ?? '',
      )
    }

    lines.push(fields.map(escapeCsvField).join(','))
  }

  return lines.join('\n')
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

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
