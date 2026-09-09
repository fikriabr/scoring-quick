/**
 * Unit Tests: PATCH /api/submissions/[id] — admin Source Code editor
 *
 * Requirements: 5.2, 5.3, 5.4
 *
 * Two things are being pinned here:
 *
 *   1. The happy path writes the new markup, marks the AI score as stale
 *      (`scoreStatus = PENDING`) and kicks off re-scoring asynchronously.
 *   2. Every rejected path — non-admin, over-length body, unknown project —
 *      leaves the row untouched. That is the second half of Property 24, and it
 *      is why the assertions below check `db.project.update` was never called
 *      rather than only checking the status code.
 *
 * Everything below the route is mocked: the route's job is authorization,
 * validation, normalisation and dispatch, so that is what is asserted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// Mock modules BEFORE importing the route under test
// ---------------------------------------------------------------------------

vi.mock('@/lib/auth/config', () => ({
  auth: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    project: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

vi.mock('@/lib/services/scorer.service', () => ({
  ScorerService: { triggerScoring: vi.fn().mockResolvedValue(undefined) },
}))

import { PATCH } from '@/app/api/submissions/[id]/route'
import { auth } from '@/lib/auth/config'
import { db } from '@/lib/db'
import { ScorerService } from '@/lib/services/scorer.service'
import { MAX_SOURCE_CODE_LENGTH } from '@/lib/validators/schemas'

const mockAuth = vi.mocked(auth)
const mockProjectFindUnique = vi.mocked(db.project.findUnique)
const mockProjectUpdate = vi.mocked(db.project.update)
const mockTriggerScoring = vi.mocked(ScorerService.triggerScoring)

// ---------------------------------------------------------------------------
// Fixtures & helpers
// ---------------------------------------------------------------------------

const PROJECT_ID = 'project-1'

/** The route only ever calls `request.json()`. */
function buildRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest
}

function buildContext(id: string = PROJECT_ID) {
  return { params: Promise.resolve({ id }) }
}

/**
 * The rate limiter is real and keys on the user id (10 requests per minute),
 * so every test signs in as a different user and stays clear of it.
 */
let userCounter = 0
function signIn(role: 'ADMIN' | 'JURY') {
  userCounter += 1
  mockAuth.mockResolvedValue({
    user: { id: 'user-' + userCounter, role },
  } as never)
}

/** Resolves whatever the route wrote, as the `select` shape it asks for. */
function updatedRow(sourceCode: string | null) {
  return { id: PROJECT_ID, sourceCode, scoreStatus: 'PENDING' as const }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockTriggerScoring.mockResolvedValue(undefined)
  mockProjectFindUnique.mockResolvedValue({ id: PROJECT_ID } as never)
  signIn('ADMIN')
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('PATCH /api/submissions/[id] — successful update', () => {
  it('stores the markup, sets scoreStatus = PENDING and triggers re-scoring', async () => {
    const markup = '<html><body><h1>Portfolio</h1></body></html>'
    mockProjectUpdate.mockResolvedValueOnce(updatedRow(markup) as never)

    const response = await PATCH(
      buildRequest({ sourceCode: markup }),
      buildContext(),
    )
    const json = await response.json()

    expect(response.status).toBe(200)
    expect(mockProjectUpdate).toHaveBeenCalledTimes(1)
    expect(mockProjectUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: PROJECT_ID },
      data: { sourceCode: markup, scoreStatus: 'PENDING' },
    })
    expect(mockTriggerScoring).toHaveBeenCalledExactlyOnceWith(PROJECT_ID)

    // Shape the detail-page client component consumes — no full row.
    expect(json).toEqual({
      id: PROJECT_ID,
      sourceCode: markup,
      scoreStatus: 'PENDING',
    })
  })

  it('accepts a body exactly at the length limit', async () => {
    const atLimit = 'x'.repeat(MAX_SOURCE_CODE_LENGTH)
    mockProjectUpdate.mockResolvedValueOnce(updatedRow(atLimit) as never)

    const response = await PATCH(
      buildRequest({ sourceCode: atLimit }),
      buildContext(),
    )

    expect(response.status).toBe(200)
    expect(
      (mockProjectUpdate.mock.calls[0][0].data as { sourceCode: string }).sourceCode,
    ).toHaveLength(MAX_SOURCE_CODE_LENGTH)
  })

  it('still returns 200 when the fire-and-forget re-score rejects', async () => {
    // A rejected trigger is logged, never surfaced to the caller, and never
    // left as an unhandled rejection. The row already reads PENDING.
    mockProjectUpdate.mockResolvedValueOnce(updatedRow('<html></html>') as never)
    mockTriggerScoring.mockRejectedValueOnce(new Error('scorer blew up'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { })

    const response = await PATCH(
      buildRequest({ sourceCode: '<html></html>' }),
      buildContext(),
    )

    expect(response.status).toBe(200)

    consoleError.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Normalisation: blank input is cleared, not stored as ''
// ---------------------------------------------------------------------------

describe('PATCH /api/submissions/[id] — blank input normalises to null', () => {
  it.each([
    ['whitespace only', '   \n\t  '],
    ['empty string', ''],
    ['explicit null', null],
  ])('stores null for %s', async (_label, input) => {
    mockProjectUpdate.mockResolvedValueOnce(updatedRow(null) as never)

    const response = await PATCH(
      buildRequest({ sourceCode: input }),
      buildContext(),
    )
    const json = await response.json()

    expect(response.status).toBe(200)
    // `''` would read as a non-null column while satisfying neither
    // `hasUsableText` (scorer) nor `hasUsableSourceCode` (crawler).
    expect(
      (mockProjectUpdate.mock.calls[0][0].data as { sourceCode: string | null }).sourceCode,
    ).toBeNull()
    expect(json.sourceCode).toBeNull()
  })

  it('preserves internal whitespace of otherwise usable markup', async () => {
    const markup = '\n  <html>\n  <body>Hi</body>\n</html>\n'
    mockProjectUpdate.mockResolvedValueOnce(updatedRow(markup) as never)

    await PATCH(buildRequest({ sourceCode: markup }), buildContext())

    expect(
      (mockProjectUpdate.mock.calls[0][0].data as { sourceCode: string }).sourceCode,
    ).toBe(markup)
  })
})

// ---------------------------------------------------------------------------
// Rejected requests leave sourceCode and scoreStatus untouched (Property 24)
// ---------------------------------------------------------------------------

describe('PATCH /api/submissions/[id] — rejected requests write nothing', () => {
  it('returns 403 for a non-admin caller', async () => {
    signIn('JURY')

    const response = await PATCH(
      buildRequest({ sourceCode: '<html></html>' }),
      buildContext(),
    )
    const json = await response.json()

    expect(response.status).toBe(403)
    expect(json.code).toBe('FORBIDDEN')
    expect(mockProjectUpdate).not.toHaveBeenCalled()
    expect(mockTriggerScoring).not.toHaveBeenCalled()
  })

  it('returns 403 for an unauthenticated caller', async () => {
    mockAuth.mockResolvedValueOnce(null as never)

    const response = await PATCH(
      buildRequest({ sourceCode: '<html></html>' }),
      buildContext(),
    )

    expect(response.status).toBe(403)
    expect(mockProjectUpdate).not.toHaveBeenCalled()
    expect(mockTriggerScoring).not.toHaveBeenCalled()
  })

  it('returns 400 VALIDATION_ERROR when the body exceeds the length limit', async () => {
    const tooLong = 'x'.repeat(MAX_SOURCE_CODE_LENGTH + 1)

    const response = await PATCH(
      buildRequest({ sourceCode: tooLong }),
      buildContext(),
    )
    const json = await response.json()

    expect(response.status).toBe(400)
    expect(json.code).toBe('VALIDATION_ERROR')
    expect(mockProjectUpdate).not.toHaveBeenCalled()
    expect(mockTriggerScoring).not.toHaveBeenCalled()
  })

  it('returns 400 VALIDATION_ERROR for a malformed body', async () => {
    const response = await PATCH(buildRequest({ sourceCode: 42 }), buildContext())
    const json = await response.json()

    expect(response.status).toBe(400)
    expect(json.code).toBe('VALIDATION_ERROR')
    expect(mockProjectUpdate).not.toHaveBeenCalled()
    expect(mockTriggerScoring).not.toHaveBeenCalled()
  })

  it('returns 404 NOT_FOUND for an unknown project', async () => {
    mockProjectFindUnique.mockResolvedValueOnce(null as never)

    const response = await PATCH(
      buildRequest({ sourceCode: '<html></html>' }),
      buildContext('does-not-exist'),
    )
    const json = await response.json()

    expect(response.status).toBe(404)
    expect(json.code).toBe('NOT_FOUND')
    expect(mockProjectUpdate).not.toHaveBeenCalled()
    expect(mockTriggerScoring).not.toHaveBeenCalled()
  })
})
