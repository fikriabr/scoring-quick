/**
 * Property-Based Tests: Property 17 — Export Data Completeness
 *
 * **Validates: Requirements 8.3**
 *
 * Property 17 (from design.md):
 *   For any category export, every project SHALL appear exactly once. Each row
 *   SHALL contain: participant name, team name, URL, final score, AI score per
 *   parameter, jury score per parameter, and comments. No data omitted or
 *   duplicated.
 */

import { describe, it, expect, vi } from 'vitest'
import * as fc from 'fast-check'
import type { ProjectWithScores } from '../../types'

// ---------------------------------------------------------------------------
// Mock exceljs before importing the service.
// export.service.ts does `import ExcelJS from 'exceljs'` which causes issues
// in the Vitest module transform. We only test exportToCsv (pure function).
// ---------------------------------------------------------------------------
vi.mock('exceljs', () => {
  class MockWorkbook {
    addWorksheet() {
      return {
        columns: null,
        addRow: () => { },
      }
    }
    get xlsx() {
      return {
        writeBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }
    }
  }
  return {
    __esModule: true,
    default: { Workbook: MockWorkbook },
    Workbook: MockWorkbook,
  }
})

// Also mock @prisma/client since types/index.ts imports enums from it
vi.mock('@prisma/client', () => ({
  CrawlStatus: { PENDING: 'PENDING', PROCESSING: 'PROCESSING', SUCCESS: 'SUCCESS', FAILED: 'FAILED' },
  ScoreStatus: { PENDING: 'PENDING', PROCESSING: 'PROCESSING', PARTIAL: 'PARTIAL', SUCCESS: 'SUCCESS', FAILED: 'FAILED' },
  ScoringMode: { AUTO: 'AUTO', MANUAL: 'MANUAL' },
}))

import { exportToCsv } from '../../lib/services/export.service'

// ---------------------------------------------------------------------------
// Helpers & Arbitraries
// ---------------------------------------------------------------------------

/** Fixed set of parameter IDs used for all tests */
const PARAM_IDS = ['param-creativity', 'param-problem', 'param-features']

/**
 * Generates an array of 1-6 projects with unique URLs.
 * Uses fc.array on a single arbitrary and then assigns unique indexes.
 */
const exportDataArb = fc
  .array(
    fc.record({
      participantName: fc.stringMatching(/^[A-Za-z]{4,12}$/),
      teamName: fc.oneof(fc.constant(null), fc.stringMatching(/^[A-Za-z]{4,10}$/)),
      finalScore: fc.oneof(
        fc.constant(null),
        fc.integer({ min: 1, max: 9999 }).map((n) => n / 100),
      ),
      aiScore0: fc.integer({ min: 1, max: 9999 }).map((n) => n / 100),
      aiScore1: fc.integer({ min: 1, max: 9999 }).map((n) => n / 100),
      aiScore2: fc.integer({ min: 1, max: 9999 }).map((n) => n / 100),
      juryScore0: fc.integer({ min: 1, max: 9999 }).map((n) => n / 100),
      juryScore1: fc.integer({ min: 1, max: 9999 }).map((n) => n / 100),
      juryScore2: fc.integer({ min: 1, max: 9999 }).map((n) => n / 100),
    }),
    { minLength: 1, maxLength: 6 },
  )
  .map((items) =>
    items.map(
      (d, index) =>
        ({
          id: `id-${index}`,
          categoryId: 'cat-1',
          url: `https://partyrock.aws/u/unique/${index}`,
          participantName: d.participantName,
          teamName: d.teamName,
          crawlStatus: 'SUCCESS',
          scoreStatus: 'SUCCESS',
          finalScore: d.finalScore,
          createdAt: new Date('2024-06-01'),
          aiScores: [
            { parameterId: PARAM_IDS[0], score: d.aiScore0, reasoning: 'r' },
            { parameterId: PARAM_IDS[1], score: d.aiScore1, reasoning: 'r' },
            { parameterId: PARAM_IDS[2], score: d.aiScore2, reasoning: 'r' },
          ],
          juryScores: [
            { parameterId: PARAM_IDS[0], juryId: 'j1', score: d.juryScore0, comment: null },
            { parameterId: PARAM_IDS[1], juryId: 'j1', score: d.juryScore1, comment: null },
            { parameterId: PARAM_IDS[2], juryId: 'j1', score: d.juryScore2, comment: null },
          ],
          rank: index + 1,
        }) as unknown as ProjectWithScores,
    ),
  )

// ---------------------------------------------------------------------------
// Property 17: Export Data Completeness
// ---------------------------------------------------------------------------

describe('Property 17: Export Data Completeness', () => {
  /**
   * P17-A: CSV export has exactly `projects.length` data rows (excluding header).
   *
   * **Validates: Requirements 8.3**
   */
  it('P17-A: CSV export has exactly projects.length data rows [**Validates: Requirements 8.3**]', () => {
    fc.assert(
      fc.property(exportDataArb, (projects) => {
        const csv = exportToCsv(projects)
        const lines = csv.split('\n').filter((line) => line.trim().length > 0)
        // First line is header, rest are data
        const dataRows = lines.length - 1
        expect(dataRows).toBe(projects.length)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * P17-B: Each project's participantName, URL, and finalScore appear in the CSV output.
   *
   * **Validates: Requirements 8.3**
   */
  it('P17-B: each project participantName, URL, and finalScore appear in output [**Validates: Requirements 8.3**]', () => {
    fc.assert(
      fc.property(exportDataArb, (projects) => {
        const csv = exportToCsv(projects)

        for (const project of projects) {
          expect(csv).toContain(project.participantName)
          expect(csv).toContain(project.url)
          if (project.finalScore != null) {
            expect(csv).toContain(String(project.finalScore))
          }
        }
      }),
      { numRuns: 200 },
    )
  })

  /**
   * P17-C: No project appears twice (no duplicate rows).
   *
   * **Validates: Requirements 8.3**
   */
  it('P17-C: no project appears twice in CSV output [**Validates: Requirements 8.3**]', () => {
    fc.assert(
      fc.property(exportDataArb, (projects) => {
        const csv = exportToCsv(projects)
        const lines = csv.split('\n').filter((line) => line.trim().length > 0)
        const dataRows = lines.slice(1) // skip header

        // Each project's unique URL should appear in exactly one data row
        for (const project of projects) {
          const matchingRows = dataRows.filter((row) => row.includes(project.url))
          expect(matchingRows.length).toBe(1)
        }
      }),
      { numRuns: 200 },
    )
  })

  /**
   * P17-D: All AI scores and jury scores from each project are present in the CSV output.
   *
   * **Validates: Requirements 8.3**
   */
  it('P17-D: all AI and jury scores are present in output [**Validates: Requirements 8.3**]', () => {
    fc.assert(
      fc.property(exportDataArb, (projects) => {
        const csv = exportToCsv(projects)
        const lines = csv.split('\n').filter((line) => line.trim().length > 0)
        const dataRows = lines.slice(1) // skip header

        for (const project of projects) {
          // Find the row for this project
          const row = dataRows.find((r) => r.includes(project.url))
          expect(row).toBeDefined()

          // Parse the row into fields respecting CSV quoting
          const fields = parseCsvRow(row!)

          // Check AI scores are present in the row fields
          for (const aiScore of project.aiScores) {
            expect(fields).toContain(String(aiScore.score))
          }

          // Check jury scores are present in the row fields
          for (const juryScore of project.juryScores) {
            expect(fields).toContain(String(juryScore.score))
          }
        }
      }),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Simple CSV row parser that handles quoted fields.
 */
function parseCsvRow(row: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < row.length; i++) {
    const ch = row[i]
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}
