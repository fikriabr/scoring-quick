/**
 * Unit Tests: sync from the external submissions database.
 *
 * Three layers:
 *   1. `mapSourceSubmission` / `fitHtmlToLimit` — the pure mapping rules from
 *      a source `submissions` row onto Project fields.
 *   2. `syncSourceSubmissions` — which rows become projects, which are skipped
 *      or fail, with both databases mocked.
 *   3. `POST /api/sync/submissions` — auth and error mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'

vi.mock('@/lib/db', () => ({
  db: {
    project: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    category: { findMany: vi.fn() },
  },
}))

const mockSourceSql = vi.fn()
vi.mock('@/lib/source-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/source-db')>()
  return { ...actual, getSourceSql: vi.fn(() => mockSourceSql) }
})

vi.mock('@/lib/auth/config', () => ({ auth: vi.fn() }))

import { db } from '@/lib/db'
import { getSourceSql, SourceDbNotConfiguredError } from '@/lib/source-db'
import { auth } from '@/lib/auth/config'
import {
  fitHtmlToLimit,
  mapSourceSubmission,
  normaliseTeamMembers,
  syncSourceSubmissions,
  type SourceSubmissionRow,
} from '@/lib/services/source-sync.service'
import { MAX_SOURCE_CODE_LENGTH } from '@/lib/validators/source-code-rules'
import { POST } from '@/app/api/sync/submissions/route'

const mockProjectFindMany = vi.mocked(db.project.findMany)
const mockProjectFindUnique = vi.mocked(db.project.findUnique)
const mockProjectCreate = vi.mocked(db.project.create)
const mockProjectUpdate = vi.mocked(db.project.update)
const mockCategoryFindMany = vi.mocked(db.category.findMany)
const mockGetSourceSql = vi.mocked(getSourceSql)
const mockAuth = vi.mocked(auth)

const HTML = '<!DOCTYPE html><html><head><title>FarmLink</title></head><body><h1>FarmLink</h1></body></html>'

function sourceRow(overrides: Partial<SourceSubmissionRow> = {}): SourceSubmissionRow {
  return {
    id: 4,
    full_name: '  Sudarat K.  ',
    project_title: 'FarmLink',
    project_theme: '3. Agriculture & Food',
    team_members: 'john, jame ,, ice',
    description: 'Connects farmers to buyers.',
    md_path: 'FarmLink.md',
    md_content: '# FarmLink\n\nThe idea.',
    html_content: HTML,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. Mapping
// ---------------------------------------------------------------------------

describe('mapSourceSubmission', () => {
  it('maps every source column onto its Project field', () => {
    const result = mapSourceSubmission(sourceRow())
    expect(result).toEqual({
      ok: true,
      value: {
        participantName: 'Sudarat K.',
        projectTitle: 'FarmLink',
        teamMembers: 'john, jame, ice',
        description: 'Connects farmers to buyers.',
        sourceCode: HTML,
        ideaDoc: '# FarmLink\n\nThe idea.',
        warnings: [],
      },
    })
  })

  it('syncs a row without md_content, with a warning naming the file', () => {
    const result = mapSourceSubmission(sourceRow({ md_content: null }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.ideaDoc).toBeNull()
    expect(result.value.warnings).toHaveLength(1)
    expect(result.value.warnings[0]).toContain('No idea document')
    expect(result.value.warnings[0]).toContain('FarmLink.md')
  })

  it('treats a whitespace-only md_content as missing', () => {
    const result = mapSourceSubmission(sourceRow({ md_content: '  \n ' }))
    expect(result.ok && result.value.ideaDoc).toBeNull()
  })

  it('rejects a row without full_name', () => {
    expect(mapSourceSubmission(sourceRow({ full_name: '   ' }))).toEqual({
      ok: false,
      error: 'The source row has no full_name.',
    })
  })

  it('rejects a row without html_content (a synced project has no URL)', () => {
    expect(mapSourceSubmission(sourceRow({ html_content: '' })).ok).toBe(false)
  })

  it('keeps blank optional fields as null', () => {
    const result = mapSourceSubmission(
      sourceRow({ project_title: ' ', team_members: ' , ', description: null }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.projectTitle).toBeNull()
    expect(result.value.teamMembers).toBeNull()
    expect(result.value.description).toBeNull()
  })

  it('reduces oversized HTML and says so', () => {
    const bundle = 'x'.repeat(MAX_SOURCE_CODE_LENGTH)
    const html = `<html><body><h1>Title</h1><script>${bundle}</script><p>After</p></body></html>`
    const result = mapSourceSubmission(sourceRow({ html_content: html }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sourceCode).toBe('<html><body><h1>Title</h1><script></script><p>After</p></body></html>')
    expect(result.value.warnings[0]).toContain('inline <script> contents were removed')
  })
})

describe('normaliseTeamMembers', () => {
  it('accepts comma- and newline-separated lists', () => {
    expect(normaliseTeamMembers('a\nb, c')).toBe('a, b, c')
    expect(normaliseTeamMembers(null)).toBeNull()
  })
})

describe('fitHtmlToLimit', () => {
  it('leaves HTML within the limit untouched', () => {
    expect(fitHtmlToLimit(HTML, 1000)).toEqual({ html: HTML, reduction: 'none' })
  })

  it('empties inline scripts before cutting anything', () => {
    const html = '<p>keep</p><script type="module">' + 'y'.repeat(200) + '</script><p>tail</p>'
    expect(fitHtmlToLimit(html, 100)).toEqual({
      html: '<p>keep</p><script type="module"></script><p>tail</p>',
      reduction: 'scripts-emptied',
    })
  })

  it('truncates only when emptying scripts is not enough', () => {
    const html = '<p>' + 'z'.repeat(200) + '</p>'
    const result = fitHtmlToLimit(html, 50)
    expect(result.reduction).toBe('truncated')
    expect(result.html).toHaveLength(50)
  })
})

// ---------------------------------------------------------------------------
// 2. Syncing
// ---------------------------------------------------------------------------

describe('syncSourceSubmissions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSourceSql.mockImplementation(() => mockSourceSql as never)
    mockSourceSql.mockResolvedValue([sourceRow({ id: 4 }), sourceRow({ id: 5, md_content: null })])
    mockCategoryFindMany.mockResolvedValue([{ id: 'cat-1' }] as never)
    mockProjectFindMany.mockResolvedValue([])
    mockProjectCreate.mockImplementation(
      (async (args: { data: { sourceSubmissionId: number } }) => ({
        id: `project-${args.data.sourceSubmissionId}`,
      })) as never,
    )
    mockProjectUpdate.mockResolvedValue({} as never)
  })

  it('creates a PENDING project per row, linked to its source id', async () => {
    const result = await syncSourceSubmissions({
      items: [
        { sourceId: 4, categoryId: 'cat-1' },
        { sourceId: 5, categoryId: 'cat-1' },
      ],
    })

    expect(result.created.map((c) => c.projectId)).toEqual(['project-4', 'project-5'])
    expect(result.created[1].warnings[0]).toContain('No idea document')
    expect(result.skipped).toEqual([])
    expect(result.failed).toEqual([])

    expect(mockProjectCreate).toHaveBeenCalledWith({
      data: {
        categoryId: 'cat-1',
        url: null,
        teamName: null,
        participantName: 'Sudarat K.',
        projectTitle: 'FarmLink',
        teamMembers: 'john, jame, ice',
        description: 'Connects farmers to buyers.',
        sourceCode: HTML,
        ideaDoc: '# FarmLink\n\nThe idea.',
        sourceSubmissionId: 4,
        crawlStatus: 'PENDING',
        scoreStatus: 'PENDING',
      },
      select: { id: true },
    })
  })

  it('reads content from the source by id, never from the request', async () => {
    await syncSourceSubmissions({ items: [{ sourceId: 4, categoryId: 'cat-1' }] })
    const [, ids] = mockSourceSql.mock.calls[0]
    expect(ids).toEqual([4])
  })

  it('skips a row already synced into an active project', async () => {
    mockProjectFindMany.mockResolvedValue([
      { id: 'existing', sourceSubmissionId: 4, isActive: true },
    ] as never)
    const result = await syncSourceSubmissions({ items: [{ sourceId: 4, categoryId: 'cat-1' }] })
    expect(result.skipped).toEqual([{ sourceId: 4, projectId: 'existing', reason: 'Already synced.' }])
    expect(mockProjectCreate).not.toHaveBeenCalled()
  })

  it('re-syncs a row whose project was deleted, releasing the old link first', async () => {
    mockProjectFindMany.mockResolvedValue([
      { id: 'deleted', sourceSubmissionId: 4, isActive: false },
    ] as never)
    const result = await syncSourceSubmissions({ items: [{ sourceId: 4, categoryId: 'cat-1' }] })
    expect(mockProjectUpdate).toHaveBeenCalledWith({
      where: { id: 'deleted' },
      data: { sourceSubmissionId: null },
    })
    expect(mockProjectUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mockProjectCreate.mock.invocationCallOrder[0],
    )
    expect(result.created).toHaveLength(1)
  })

  it('fails rows with an unknown category or a missing source row, and still syncs the rest', async () => {
    const result = await syncSourceSubmissions({
      items: [
        { sourceId: 4, categoryId: 'nope' },
        { sourceId: 99, categoryId: 'cat-1' },
        { sourceId: 5, categoryId: 'cat-1' },
      ],
    })
    expect(result.failed).toEqual([
      { sourceId: 4, message: 'Target category not found.' },
      { sourceId: 99, message: 'Not found in the source database.' },
    ])
    expect(result.created.map((c) => c.sourceId)).toEqual([5])
  })

  it('reports a concurrent sync of the same row as skipped, not failed', async () => {
    mockProjectCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    )
    mockProjectFindUnique.mockResolvedValue({ id: 'raced' } as never)
    const result = await syncSourceSubmissions({ items: [{ sourceId: 4, categoryId: 'cat-1' }] })
    expect(result.skipped).toEqual([{ sourceId: 4, projectId: 'raced', reason: 'Already synced.' }])
    expect(result.failed).toEqual([])
  })

  it('rejects an empty, duplicated or malformed selection', async () => {
    await expect(syncSourceSubmissions({ items: [] })).rejects.toBeInstanceOf(ZodError)
    await expect(
      syncSourceSubmissions({
        items: [
          { sourceId: 4, categoryId: 'cat-1' },
          { sourceId: 4, categoryId: 'cat-1' },
        ],
      }),
    ).rejects.toBeInstanceOf(ZodError)
    await expect(
      syncSourceSubmissions({ items: [{ sourceId: '4', categoryId: 'cat-1' }] }),
    ).rejects.toBeInstanceOf(ZodError)
    expect(mockSourceSql).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 3. Route
// ---------------------------------------------------------------------------

function postRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest
}

describe('POST /api/sync/submissions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSourceSql.mockImplementation(() => mockSourceSql as never)
    mockSourceSql.mockResolvedValue([sourceRow({ id: 4 })])
    mockCategoryFindMany.mockResolvedValue([{ id: 'cat-1' }] as never)
    mockProjectFindMany.mockResolvedValue([])
    mockProjectCreate.mockResolvedValue({ id: 'project-4' } as never)
  })

  it('requires a session', async () => {
    mockAuth.mockResolvedValue(null as never)
    const res = await POST(postRequest({}))
    expect(res.status).toBe(401)
  })

  it('is admin-only', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u-jury', role: 'JURY' } } as never)
    const res = await POST(postRequest({}))
    expect(res.status).toBe(403)
  })

  it('syncs and reports how many projects were queued', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u-admin-1', role: 'ADMIN' } } as never)
    const res = await POST(postRequest({ items: [{ sourceId: 4, categoryId: 'cat-1' }] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.queued).toBe(1)
    expect(body.created[0].projectId).toBe('project-4')
  })

  it('answers 400 for an invalid body', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u-admin-2', role: 'ADMIN' } } as never)
    const res = await POST(postRequest({ items: [] }))
    expect(res.status).toBe(400)
  })

  it('answers 503 when the source database is not configured', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u-admin-3', role: 'ADMIN' } } as never)
    mockGetSourceSql.mockImplementation(() => {
      throw new SourceDbNotConfiguredError()
    })
    const res = await POST(postRequest({ items: [{ sourceId: 4, categoryId: 'cat-1' }] }))
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('SOURCE_DB_NOT_CONFIGURED')
  })
})
