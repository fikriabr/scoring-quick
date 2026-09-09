/**
 * Unit Tests: POST /api/submissions — pipeline entry point
 *
 * The route creates the Project and then kicks off exactly one asynchronous
 * entry point: `CrawlerService.triggerCrawl`, which fetches the live URL,
 * stores `rawHtml`/`structure`, and calls `triggerScoring` itself. The route
 * must never also call `triggerScoring` directly — that would score the
 * project twice.
 *
 * Everything below the route is mocked — the route's only job is dispatch, so
 * the assertions are about which entry point was called, not about what it
 * does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mock modules BEFORE importing the route under test
// ---------------------------------------------------------------------------

vi.mock('@/lib/auth/config', () => ({
  auth: vi.fn(),
}))

// `DuplicateUrlError` is re-thrown by the route through an `instanceof` check,
// so the mock has to expose a real class rather than a stub.
vi.mock('@/lib/services/submission.service', () => {
  class DuplicateUrlError extends Error {
    constructor(url: string, categoryId: string) {
      super('Project with URL ' + url + ' already exists in category ' + categoryId)
      this.name = 'DuplicateUrlError'
      Object.setPrototypeOf(this, DuplicateUrlError.prototype)
    }
  }
  return { submitProject: vi.fn(), DuplicateUrlError }
})

vi.mock('@/lib/services/crawler.service', () => ({
  CrawlerService: { triggerCrawl: vi.fn().mockResolvedValue(undefined) },
}))

vi.mock('@/lib/services/scorer.service', () => ({
  ScorerService: { triggerScoring: vi.fn().mockResolvedValue(undefined) },
}))

import { POST } from '@/app/api/submissions/route'
import { auth } from '@/lib/auth/config'
import { submitProject, DuplicateUrlError } from '@/lib/services/submission.service'
import { CrawlerService } from '@/lib/services/crawler.service'
import { ScorerService } from '@/lib/services/scorer.service'

const mockAuth = vi.mocked(auth)
const mockSubmitProject = vi.mocked(submitProject)
const mockTriggerCrawl = vi.mocked(CrawlerService.triggerCrawl)
const mockTriggerScoring = vi.mocked(ScorerService.triggerScoring)

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

/**
 * The route only ever calls `request.json()`, so a minimal stand-in keeps the
 * test free of `NextRequest` construction details.
 */
function buildRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest
}

/**
 * The rate limiter is real and keys on the user id (10 requests per minute),
 * so every test signs in as a different user and stays clear of it.
 */
let userCounter = 0
function signInAsAdmin() {
  userCounter += 1
  mockAuth.mockResolvedValue({
    user: { id: 'user-' + userCounter, role: 'ADMIN' },
  } as never)
}

function buildProjectRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-1',
    categoryId: 'category-1',
    url: 'https://example.com/portfolio',
    participantName: 'Test User',
    teamName: null,
    projectType: 'HTML' as const,
    sourceCode: null as string | null,
    crawlStatus: 'PENDING' as const,
    crawlError: null,
    scoreStatus: 'PENDING' as const,
    finalScore: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  }
}

const HTML_BODY = {
  url: 'https://example.com/portfolio',
  participantName: 'Test User',
  categoryId: 'clabcdef0001',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockTriggerCrawl.mockResolvedValue(undefined)
  mockTriggerScoring.mockResolvedValue(undefined)
  signInAsAdmin()
})

// ---------------------------------------------------------------------------
// HTML → crawl path
// ---------------------------------------------------------------------------

describe('POST /api/submissions — HTML projects take the crawl path', () => {
  it('triggers the crawl and does not call triggerScoring from the route', async () => {
    mockSubmitProject.mockResolvedValueOnce(
      buildProjectRecord({ projectType: 'HTML' }) as never,
    )

    const response = await POST(buildRequest(HTML_BODY))

    expect(response.status).toBe(201)
    expect(mockTriggerCrawl).toHaveBeenCalledExactlyOnceWith('project-1')
    // triggerCrawl already ends in a triggerScoring call; a second one here
    // would score the project twice.
    expect(mockTriggerScoring).not.toHaveBeenCalled()
  })

  it('still crawls when Source Code was pasted at submission time', async () => {
    // The live URL is worth fetching even so — it is the only source of
    // `rawHtml` and `structure` — and the crawler refuses to overwrite a
    // pasted `sourceCode` (Requirement 3.6).
    mockSubmitProject.mockResolvedValueOnce(
      buildProjectRecord({
        projectType: 'HTML',
        sourceCode: '<html><body><h1>Pasted</h1></body></html>',
      }) as never,
    )

    await POST(buildRequest({ ...HTML_BODY, sourceCode: '<html></html>' }))

    expect(mockTriggerCrawl).toHaveBeenCalledExactlyOnceWith('project-1')
    expect(mockTriggerScoring).not.toHaveBeenCalled()
  })

  it('returns 201 with the created project even when the crawl rejects', async () => {
    // Fire-and-forget: a rejected crawl is logged, never surfaced to the
    // caller, and never left as an unhandled rejection.
    mockSubmitProject.mockResolvedValueOnce(
      buildProjectRecord({ projectType: 'HTML' }) as never,
    )
    mockTriggerCrawl.mockRejectedValueOnce(new Error('crawl blew up'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { })

    const response = await POST(buildRequest(HTML_BODY))
    const json = await response.json()

    expect(response.status).toBe(201)
    expect(json.id).toBe('project-1')

    consoleError.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Nothing is triggered when the submission never happens
// ---------------------------------------------------------------------------

describe('POST /api/submissions — no pipeline entry point without a project', () => {
  it('returns 401 and triggers nothing for an unauthenticated caller', async () => {
    mockAuth.mockResolvedValueOnce(null as never)

    const response = await POST(buildRequest(HTML_BODY))

    expect(response.status).toBe(401)
    expect(mockSubmitProject).not.toHaveBeenCalled()
    expect(mockTriggerCrawl).not.toHaveBeenCalled()
    expect(mockTriggerScoring).not.toHaveBeenCalled()
  })

  it('returns 409 and triggers nothing on a duplicate URL', async () => {
    mockSubmitProject.mockRejectedValueOnce(
      new DuplicateUrlError('https://example.com/portfolio', 'clabcdef0001'),
    )

    const response = await POST(buildRequest(HTML_BODY))
    const json = await response.json()

    expect(response.status).toBe(409)
    expect(json.code).toBe('DUPLICATE_URL')
    expect(mockTriggerCrawl).not.toHaveBeenCalled()
    expect(mockTriggerScoring).not.toHaveBeenCalled()
  })
})
