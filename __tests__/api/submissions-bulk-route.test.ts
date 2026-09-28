/**
 * Unit Tests: POST /api/submissions/bulk — crawl triggering per imported row
 *
 * Requirements: 3.1, 8.2
 *
 * The route imports the CSV and then starts the crawl pipeline for every
 * project the import created, using the ids `bulkImportFromCsv` reports rather
 * than a follow-up query for "recent PENDING projects in this category". That
 * distinction is the point of these tests: the id list is the only way to
 * avoid re-crawling a project left PENDING by an earlier import.
 *
 * Everything below the route is mocked; the route's only job here is dispatch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mock modules BEFORE importing the route under test
// ---------------------------------------------------------------------------

vi.mock('@/lib/auth/config', () => ({
  auth: vi.fn(),
}))

vi.mock('@/lib/services/submission.service', () => ({
  bulkImportFromCsv: vi.fn(),
}))

vi.mock('@/lib/services/crawler.service', () => ({
  CrawlerService: { triggerCrawl: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('@/lib/services/scorer.service', () => ({
  ScorerService: { triggerScoring: vi.fn().mockResolvedValue(undefined) },
}))

import { POST } from '@/app/api/submissions/bulk/route'
import { auth } from '@/lib/auth/config'
import { bulkImportFromCsv } from '@/lib/services/submission.service'
import { CrawlerService } from '@/lib/services/crawler.service'
import { ScorerService } from '@/lib/services/scorer.service'

const mockAuth = vi.mocked(auth)
const mockBulkImport = vi.mocked(bulkImportFromCsv)
const mockTriggerCrawl = vi.mocked(CrawlerService.triggerCrawl)
const mockTriggerScoring = vi.mocked(ScorerService.triggerScoring)

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const CATEGORY_ID = 'clabcdef0001'

/**
 * The route reads `file` and `categoryId` off the form data and calls
 * `file.text()`, so a real FormData with a real File keeps the stand-in honest
 * without constructing a full `NextRequest`.
 */
function buildRequest(
  csv = 'url,participant_name,project_type\nhttps://example.com/a,Alice,HTML',
  categoryId: string | null = CATEGORY_ID,
): NextRequest {
  const formData = new FormData()
  formData.set('file', new File([csv], 'submissions.csv', { type: 'text/csv' }))
  if (categoryId !== null) formData.set('categoryId', categoryId)
  return { formData: async () => formData } as unknown as NextRequest
}

/**
 * The crawl loop is fire-and-forget and awaits each crawl in turn, so the
 * assertions have to let the microtask queue drain first. A macrotask boundary
 * does that for the whole chain, however many projects it covers.
 */
async function flushPendingCrawls() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function importResult(
  created: { id: string }[],
  errors: { row: number; message: string }[] = [],
) {
  return { imported: created.length, created, errors }
}

/**
 * The rate limiter is real and keys on the user id (10 requests per minute),
 * so every test signs in as a different admin and stays clear of it.
 */
let userCounter = 0
function signInAsAdmin() {
  userCounter += 1
  mockAuth.mockResolvedValue({
    user: { id: 'admin-' + userCounter, role: 'ADMIN' },
  } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockTriggerCrawl.mockResolvedValue(undefined)
  mockTriggerScoring.mockResolvedValue(undefined)
  signInAsAdmin()
})

// ---------------------------------------------------------------------------
// HTML rows → crawl
// ---------------------------------------------------------------------------

describe('POST /api/submissions/bulk — rows start a crawl', () => {
  // Imported rows are queued, not crawled here: a 3000-row import would open
  // thousands of outbound fetches and model calls from one invocation, which
  // the platform's function timeout and the providers' rate limits both end
  // badly. A queue worker (`npm run score:queue`, or the admin panel) claims
  // them instead — see lib/services/scoring-queue.service.ts.
  it('does not crawl or score during the import', async () => {
    mockBulkImport.mockResolvedValueOnce(
      importResult([
        { id: 'project-html-1' },
        { id: 'project-html-2' },
        { id: 'project-html-3' },
      ]) as never,
    )

    const response = await POST(buildRequest())
    await flushPendingCrawls()

    expect(response.status).toBe(200)
    expect(mockTriggerCrawl).not.toHaveBeenCalled()
  })

  it('reports how many rows were queued', async () => {
    mockBulkImport.mockResolvedValueOnce(
      importResult([{ id: 'project-html-1' }, { id: 'project-html-2' }]) as never,
    )

    const response = await POST(buildRequest())
    const body = await response.json()

    expect(body.queued).toBe(2)
    expect(body.imported).toBe(2)
  })

  it('queues nothing when the import created nothing', async () => {
    mockBulkImport.mockResolvedValueOnce(importResult([]) as never)

    const response = await POST(buildRequest())
    const body = await response.json()

    expect(body.queued).toBe(0)
    expect(mockTriggerCrawl).not.toHaveBeenCalled()
  })

  it('returns the import summary, including the created ids', async () => {
    mockBulkImport.mockResolvedValueOnce(
      importResult([{ id: 'project-html-1' }]) as never,
    )

    const response = await POST(buildRequest())
    await flushPendingCrawls()
    const json = await response.json()

    expect(json.imported).toBe(1)
    expect(json.created).toEqual([{ id: 'project-html-1' }])
    expect(json.errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Nothing created → nothing triggered
// ---------------------------------------------------------------------------

describe('POST /api/submissions/bulk — nothing triggered without a created project', () => {
  it('triggers nothing when every row failed validation', async () => {
    mockBulkImport.mockResolvedValueOnce(
      importResult([], [
        { row: 2, message: 'url: Invalid URL' },
        { row: 3, message: 'participantName: Required' },
      ]) as never,
    )

    const response = await POST(buildRequest())
    await flushPendingCrawls()
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(json.imported).toBe(0)
    expect(json.errors).toHaveLength(2)
    expect(mockTriggerCrawl).not.toHaveBeenCalled()
    expect(mockTriggerScoring).not.toHaveBeenCalled()
  })

  it('returns 403 and triggers nothing for a non-admin caller', async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: 'juror-1', role: 'JUROR' },
    } as never)

    const response = await POST(buildRequest())
    await flushPendingCrawls()

    expect(response.status).toBe(403)
    expect(mockBulkImport).not.toHaveBeenCalled()
    expect(mockTriggerCrawl).not.toHaveBeenCalled()
  })

  it('returns 401 and triggers nothing for an unauthenticated caller', async () => {
    mockAuth.mockResolvedValueOnce(null as never)

    const response = await POST(buildRequest())
    await flushPendingCrawls()

    expect(response.status).toBe(401)
    expect(mockBulkImport).not.toHaveBeenCalled()
    expect(mockTriggerCrawl).not.toHaveBeenCalled()
  })

  it('returns 400 and triggers nothing when the CSV body is blank', async () => {
    const response = await POST(buildRequest('   \n  '))
    await flushPendingCrawls()

    expect(response.status).toBe(400)
    expect(mockBulkImport).not.toHaveBeenCalled()
    expect(mockTriggerCrawl).not.toHaveBeenCalled()
  })
})
