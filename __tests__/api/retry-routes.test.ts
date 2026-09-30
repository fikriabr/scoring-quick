/**
 * Unit Tests: POST /api/score/[projectId] and POST /api/crawl/[projectId]
 *
 * The Retry buttons refresh the page as soon as these routes respond, while
 * the work itself only starts in `after()`. The routes therefore have to mark
 * the run as started *before* responding, or the refresh reads the old status
 * and the processing banner never appears.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const scheduled: (() => Promise<unknown>)[] = []
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: vi.fn((task: () => Promise<unknown>) => scheduled.push(task)) }
})

vi.mock('@/lib/auth/config', () => ({ auth: vi.fn() }))

vi.mock('@/lib/db', () => ({
  db: { project: { findUnique: vi.fn(), update: vi.fn() } },
}))

vi.mock('@/lib/services/scorer.service', () => ({
  ScorerService: { triggerScoring: vi.fn() },
}))

vi.mock('@/lib/services/crawler.service', () => ({
  CrawlerService: { triggerCrawl: vi.fn(), retriggerCrawl: vi.fn() },
}))

import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { ScorerService } from '@/lib/services/scorer.service'
import { CrawlerService } from '@/lib/services/crawler.service'
import { POST as scorePost } from '@/app/api/score/[projectId]/route'
import { POST as crawlPost } from '@/app/api/crawl/[projectId]/route'

const mockAuth = vi.mocked(auth)
const mockFindUnique = vi.mocked(db.project.findUnique)
const mockUpdate = vi.mocked(db.project.update)
const mockTriggerScoring = vi.mocked(ScorerService.triggerScoring)
const mockRetriggerCrawl = vi.mocked(CrawlerService.retriggerCrawl)

let adminCounter = 0
function signInAdmin() {
  // A fresh user id per test keeps the routes' per-user rate limiter out of the way.
  mockAuth.mockResolvedValue({ user: { id: `admin-${++adminCounter}`, role: 'ADMIN' } } as never)
}

const scoreParams = { params: Promise.resolve({ projectId: 'p1' }) }
const crawlParams = { params: Promise.resolve({ projectId: 'p1' }) }
const crawlRequest = {
  nextUrl: new URL('http://localhost/api/crawl/p1?action=retrigger'),
} as unknown as NextRequest

beforeEach(() => {
  vi.clearAllMocks()
  scheduled.length = 0
  mockUpdate.mockResolvedValue({} as never)
  signInAdmin()
})

describe('POST /api/score/[projectId]', () => {
  it('marks the project PROCESSING before responding, then scores in after()', async () => {
    mockFindUnique.mockResolvedValue({ id: 'p1', scoreStatus: 'FAILED' } as never)
    mockTriggerScoring.mockResolvedValue(undefined)

    const res = await scorePost({} as NextRequest, scoreParams)

    expect(res.status).toBe(200)
    expect((await res.json()).scoreStatus).toBe('PROCESSING')
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: expect.objectContaining({ scoreStatus: 'PROCESSING', scoreError: null }),
    })
    // Scoring has not started yet — it runs after the response.
    expect(mockTriggerScoring).not.toHaveBeenCalled()
    await scheduled[0]()
    expect(mockTriggerScoring).toHaveBeenCalledWith('p1')
  })

  it('refuses a second run while one is in progress', async () => {
    mockFindUnique.mockResolvedValue({ id: 'p1', scoreStatus: 'PROCESSING' } as never)
    const res = await scorePost({} as NextRequest, scoreParams)
    expect(res.status).toBe(409)
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(0)
  })

  it('records FAILED when scoring throws before writing its own status', async () => {
    mockFindUnique.mockResolvedValue({ id: 'p1', scoreStatus: 'SUCCESS' } as never)
    mockTriggerScoring.mockRejectedValue(new Error('project lookup failed'))

    await scorePost({} as NextRequest, scoreParams)
    await scheduled[0]()

    expect(mockUpdate).toHaveBeenLastCalledWith({
      where: { id: 'p1' },
      data: { scoreStatus: 'FAILED', scoreError: 'project lookup failed', scoreStartedAt: null },
    })
  })
})

describe('POST /api/crawl/[projectId]?action=retrigger', () => {
  it('marks the crawl PROCESSING (and the score PENDING) before responding', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'p1',
      url: 'https://example.com',
      crawlStatus: 'FAILED',
    } as never)
    mockRetriggerCrawl.mockResolvedValue(undefined)

    const res = await crawlPost(crawlRequest, crawlParams)

    expect(res.status).toBe(200)
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { crawlStatus: 'PROCESSING', crawlError: null, scoreStatus: 'PENDING' },
    })
    expect(mockRetriggerCrawl).not.toHaveBeenCalled()
    await scheduled[0]()
    expect(mockRetriggerCrawl).toHaveBeenCalledWith('p1')
  })

  it('refuses a second crawl while one is in progress', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'p1',
      url: 'https://example.com',
      crawlStatus: 'PROCESSING',
    } as never)
    const res = await crawlPost(crawlRequest, crawlParams)
    expect(res.status).toBe(409)
    expect(scheduled).toHaveLength(0)
  })

  it('records FAILED when the retrigger throws before the pipeline runs', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'p1',
      url: 'https://example.com',
      crawlStatus: 'SUCCESS',
    } as never)
    mockRetriggerCrawl.mockRejectedValue(new Error('delete failed'))

    await crawlPost(crawlRequest, crawlParams)
    await scheduled[0]()

    expect(mockUpdate).toHaveBeenLastCalledWith({
      where: { id: 'p1' },
      data: { crawlStatus: 'FAILED', crawlError: 'delete failed' },
    })
  })
})
