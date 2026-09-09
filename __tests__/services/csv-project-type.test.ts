/**
 * Unit tests: Project Type support in bulk CSV import
 *
 * Covers Requirement 1.5 (accept `project_type` / `projectType` headers,
 * default to PARTYROCK when absent or blank) and Requirement 1.6 (an
 * unrecognised value rejects only that row, with its row number, while the
 * remaining valid rows are still imported).
 *
 * Follows the mocking pattern of `csv-bulk-import.property.test.ts`: the Prisma
 * client is mocked, `findFirst` reports no duplicates, and `create` resolves.
 * The assertions read the arguments handed to `db.project.create`, because a
 * `projectType` that validates but never reaches the write is indistinguishable
 * from the feature not existing at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock lib/db BEFORE importing the service under test.
// ---------------------------------------------------------------------------
vi.mock('@/lib/db', () => ({
  db: {
    project: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}))

import { db } from '@/lib/db'
import { bulkImportFromCsv } from '@/lib/services/submission.service'

const CATEGORY_ID = 'cat_project_type'
const PR_URL = 'https://partyrock.aws/app/demo'
const WEB_URL = 'https://example.com/portfolio'

const fakeProjRecord = {
  id: 'proj_pt_1',
  categoryId: CATEGORY_ID,
  url: PR_URL,
  projectType: 'PARTYROCK' as const,
  participantName: 'Test',
  teamName: null,
  crawlStatus: 'PENDING' as const,
  scoreStatus: 'PENDING' as const,
  crawlError: null,
  finalScore: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.project.findFirst).mockResolvedValue(null as never)
  vi.mocked(db.project.create).mockResolvedValue(fakeProjRecord as never)
})

/** The `projectType` values handed to `db.project.create`, in call order. */
function createdProjectTypes(): unknown[] {
  return vi
    .mocked(db.project.create)
    .mock.calls.map((call) => (call[0] as { data: { projectType?: unknown } }).data.projectType)
}

/** The `url` values handed to `db.project.create`, in call order. */
function createdUrls(): unknown[] {
  return vi
    .mocked(db.project.create)
    .mock.calls.map((call) => (call[0] as { data: { url?: unknown } }).data.url)
}

describe('bulk CSV import — Project Type column (Requirement 1.5)', () => {
  it('stores PARTYROCK when the project_type column is absent entirely', async () => {
    const csv = ['url,participant_name', `${PR_URL},Alice`].join('\n')

    const result = await bulkImportFromCsv(csv, CATEGORY_ID)

    expect(result.errors).toHaveLength(0)
    expect(result.imported).toBe(1)
    expect(createdProjectTypes()).toEqual(['PARTYROCK'])
  })

  it('stores PARTYROCK when the project_type cell is blank or whitespace-only', async () => {
    const csv = [
      'url,participant_name,project_type',
      `${PR_URL},Alice,`,
      `https://partyrock.aws/app/two,Bob,"   "`,
    ].join('\n')

    const result = await bulkImportFromCsv(csv, CATEGORY_ID)

    expect(result.errors).toHaveLength(0)
    expect(result.imported).toBe(2)
    expect(createdProjectTypes()).toEqual(['PARTYROCK', 'PARTYROCK'])
  })

  it('stores HTML when the project_type cell says HTML', async () => {
    const csv = ['url,participant_name,project_type', `${WEB_URL},Alice,HTML`].join('\n')

    const result = await bulkImportFromCsv(csv, CATEGORY_ID)

    expect(result.errors).toHaveLength(0)
    expect(result.imported).toBe(1)
    expect(createdProjectTypes()).toEqual(['HTML'])
  })

  it('accepts lowercase and space-padded values by normalising them', async () => {
    const csv = [
      'url,participant_name,project_type',
      `${WEB_URL},Alice,html`,
      `https://example.org/site,Bob,"  Html  "`,
      `https://partyrock.aws/app/three,Carol,partyrock`,
    ].join('\n')

    const result = await bulkImportFromCsv(csv, CATEGORY_ID)

    expect(result.errors).toHaveLength(0)
    expect(result.imported).toBe(3)
    expect(createdProjectTypes()).toEqual(['HTML', 'HTML', 'PARTYROCK'])
  })

  it('recognises the projectType header alias', async () => {
    const csv = ['url,participant_name,projectType', `${WEB_URL},Alice,HTML`].join('\n')

    const result = await bulkImportFromCsv(csv, CATEGORY_ID)

    expect(result.errors).toHaveLength(0)
    expect(createdProjectTypes()).toEqual(['HTML'])
  })

  it('recognises the "Project Type" header alias', async () => {
    const csv = ['url,participant_name,Project Type', `${WEB_URL},Alice,HTML`].join('\n')

    const result = await bulkImportFromCsv(csv, CATEGORY_ID)

    expect(result.errors).toHaveLength(0)
    expect(createdProjectTypes()).toEqual(['HTML'])
  })
})

describe('bulk CSV import — Project Type drives URL validation', () => {
  it('accepts a non-PartyRock URL on an HTML row but rejects it on a PARTYROCK row', async () => {
    const csv = [
      'url,participant_name,project_type',
      `${WEB_URL},Alice,HTML`, // row 2 — allowed for HTML
      `https://example.org/other,Bob,PARTYROCK`, // row 3 — host rule violated
    ].join('\n')

    const result = await bulkImportFromCsv(csv, CATEGORY_ID)

    expect(result.imported).toBe(1)
    expect(createdUrls()).toEqual([WEB_URL])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].row).toBe(3)
    expect(result.errors[0].message).toContain('url')
  })
})

describe('bulk CSV import — unrecognised Project Type (Requirement 1.6)', () => {
  it('rejects only the offending row, reports its row number, and imports the rest', async () => {
    const csv = [
      'url,participant_name,project_type',
      `${PR_URL},Alice,PARTYROCK`, // row 2 — valid
      `${WEB_URL},Bob,WORDPRESS`, // row 3 — unknown project type
      `https://example.org/site,Carol,HTML`, // row 4 — valid
    ].join('\n')

    const result = await bulkImportFromCsv(csv, CATEGORY_ID)

    expect(result.imported).toBe(2)
    expect(createdProjectTypes()).toEqual(['PARTYROCK', 'HTML'])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].row).toBe(3)
    expect(result.errors[0].message).toContain('projectType')
    expect(result.errors[0].message.trim().length).toBeGreaterThan(0)
  })
})
