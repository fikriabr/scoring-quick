/**
 * Property + unit tests for the manual capture pipeline.
 *
 * **Validates: Requirements 4.2, 4.5, 4.6, 5.1**
 *
 * The capture pipeline replaces headless crawling of widget data (blocked by
 * AWS WAF) with data collected from a real browser session. These tests pin
 * down the two things the rest of the system depends on:
 *
 *   1. URL identity — a capture must reach the submission it belongs to even
 *      when PartyRock rewrites the address bar (rename, trailing slug, query).
 *   2. Persistence — captured widgets/prompts land in CrawlMetadata and the
 *      scorer's `sourceCode` input, and AI scoring is re-triggered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fc from 'fast-check'

vi.mock('@/lib/db', () => ({
  db: {
    project: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    crawlMetadata: {
      upsert: vi.fn(),
    },
  },
}))

vi.mock('@/lib/services/scorer.service', () => ({
  ScorerService: { triggerScoring: vi.fn().mockResolvedValue(undefined) },
}))

import { db } from '@/lib/db'
import { ScorerService } from '@/lib/services/scorer.service'
import {
  normalizeUrl,
  extractAppId,
  buildSourceCode,
  findProjectsForUrl,
  ingestCapture,
  NoMatchingProjectError,
} from '@/lib/services/capture.service'

const mockFindMany = vi.mocked(db.project.findMany)
const mockProjectUpdate = vi.mocked(db.project.update)
const mockMetadataUpsert = vi.mocked(db.crawlMetadata.upsert)
const mockTriggerScoring = vi.mocked(ScorerService.triggerScoring)

beforeEach(() => {
  vi.clearAllMocks()
  mockProjectUpdate.mockResolvedValue({} as never)
  mockMetadataUpsert.mockResolvedValue({} as never)
})

// ---------------------------------------------------------------------------
// URL identity
// ---------------------------------------------------------------------------

describe('normalizeUrl', () => {
  it('ignores trailing slashes, query strings, fragments and host casing', () => {
    const variants = [
      'https://partyrock.aws/u/fikri/abc123/My-App',
      'https://partyrock.aws/u/fikri/abc123/My-App/',
      'https://partyrock.aws/u/fikri/abc123/My-App?ref=share',
      'https://PARTYROCK.aws/u/fikri/abc123/My-App#top',
    ]
    const normalized = variants.map(normalizeUrl)
    expect(new Set(normalized).size).toBe(1)
  })

  it('returns unparseable input trimmed rather than throwing', () => {
    expect(normalizeUrl('  not a url  ')).toBe('not a url')
  })
})

describe('extractAppId', () => {
  it('pulls the app id out of a /u/{user}/{appId}/{name} URL', () => {
    expect(extractAppId('https://partyrock.aws/u/fikri/abc123/My-App')).toBe('abc123')
  })

  it('works without the trailing display-name segment', () => {
    expect(extractAppId('https://partyrock.aws/u/fikri/abc123')).toBe('abc123')
  })

  it('returns null for URLs that are not app pages', () => {
    expect(extractAppId('https://partyrock.aws/explore')).toBeNull()
    expect(extractAppId('nonsense')).toBeNull()
  })

  /**
   * The display-name segment changes whenever a participant renames their
   * app, which happens between submission and judging. Matching must survive
   * that, otherwise captures silently fail to find their project.
   */
  it('is stable across app renames [**Validates: Requirements 4.5**]', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-zA-Z0-9]{4,20}$/),
        fc.stringMatching(/^[a-zA-Z0-9-]{1,30}$/),
        fc.stringMatching(/^[a-zA-Z0-9-]{1,30}$/),
        (appId, nameA, nameB) => {
          const urlA = `https://partyrock.aws/u/someone/${appId}/${nameA}`
          const urlB = `https://partyrock.aws/u/someone/${appId}/${nameB}`
          expect(extractAppId(urlA)).toBe(extractAppId(urlB))
        },
      ),
    )
  })
})

describe('findProjectsForUrl', () => {
  const projects = [
    { id: 'p1', url: 'https://partyrock.aws/u/a/app111/Alpha', participantName: 'A', categoryId: 'c1' },
    { id: 'p2', url: 'https://partyrock.aws/u/b/app222/Beta', participantName: 'B', categoryId: 'c1' },
    { id: 'p3', url: 'https://partyrock.aws/u/a/app111/Alpha', participantName: 'A', categoryId: 'c2' },
  ]

  it('matches every submission of the same app across categories', async () => {
    mockFindMany.mockResolvedValueOnce(projects as never)
    const found = await findProjectsForUrl('https://partyrock.aws/u/a/app111/Alpha')
    expect(found.map((p) => p.id)).toEqual(['p1', 'p3'])
  })

  it('falls back to app-id matching when the display name changed', async () => {
    mockFindMany.mockResolvedValueOnce(projects as never)
    const found = await findProjectsForUrl('https://partyrock.aws/u/a/app111/Alpha-Renamed-v2')
    expect(found.map((p) => p.id)).toEqual(['p1', 'p3'])
  })

  it('returns nothing when no submission matches', async () => {
    mockFindMany.mockResolvedValueOnce(projects as never)
    const found = await findProjectsForUrl('https://partyrock.aws/u/z/app999/Ghost')
    expect(found).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Scorer input
// ---------------------------------------------------------------------------

describe('buildSourceCode', () => {
  /**
   * `ScorerService` reads `Project.sourceCode` as its primary evidence, so
   * every captured widget and prompt must survive into that string — anything
   * dropped here is invisible to the AI judge.
   */
  it('carries every widget and prompt into the scorer input [**Validates: Requirements 5.1**]', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.stringMatching(/^[a-z-]{3,15}$/),
            label: fc.stringMatching(/^[A-Za-z ]{3,25}$/),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        fc.array(fc.stringMatching(/^[A-Za-z0-9 {}]{5,60}$/), { minLength: 1, maxLength: 8 }),
        (widgets, prompts) => {
          const source = buildSourceCode({
            url: 'https://partyrock.aws/u/a/app1/X',
            title: 'T',
            description: 'D',
            widgets,
            prompts,
            outputs: [],
            appDefinition: null,
            source: 'mixed',
            capturedAt: null,
            categoryId: null,
          })

          for (const widget of widgets) {
            expect(source).toContain(widget.type)
            expect(source).toContain(widget.label)
          }
          for (const prompt of prompts) {
            expect(source).toContain(prompt)
          }
        },
      ),
    )
  })

  it('omits empty sections instead of emitting blank headings', () => {
    const source = buildSourceCode({
      url: 'https://partyrock.aws/u/a/app1/X',
      title: null,
      description: null,
      widgets: [],
      prompts: [],
      outputs: [],
      appDefinition: null,
      source: 'dom',
      capturedAt: null,
      categoryId: null,
    })
    expect(source).not.toContain('## Widgets')
    expect(source).not.toContain('## Prompts')
    expect(source).toContain('https://partyrock.aws/u/a/app1/X')
  })
})

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

describe('ingestCapture', () => {
  const validPayload = {
    url: 'https://partyrock.aws/u/a/app111/Alpha',
    title: 'Alpha App',
    description: 'Does alpha things',
    widgets: [
      { type: 'text-input', label: 'Topic' },
      { type: 'ai-text', label: 'Story' },
    ],
    prompts: ['Write a story about {{Topic}}'],
    outputs: ['Once upon a time...'],
  }

  it('persists metadata, source code and re-triggers scoring [**Validates: Requirements 4.2, 4.5, 5.1**]', async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: 'p1', url: validPayload.url, participantName: 'A', categoryId: 'c1' },
    ] as never)

    const result = await ingestCapture(validPayload)

    expect(result.matched).toBe(1)
    expect(result.widgetCount).toBe(2)

    expect(mockMetadataUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: 'p1' },
        create: expect.objectContaining({
          projectId: 'p1',
          title: 'Alpha App',
          widgetCount: 2,
        }),
      }),
    )

    expect(mockProjectUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1' },
        data: expect.objectContaining({
          crawlStatus: 'SUCCESS',
          crawlError: null,
          scoreStatus: 'PENDING',
          sourceCode: expect.stringContaining('text-input'),
        }),
      }),
    )

    expect(mockTriggerScoring).toHaveBeenCalledWith('p1')
  })

  it('updates every matching submission when an app spans categories [**Validates: Requirements 4.5**]', async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: 'p1', url: validPayload.url, participantName: 'A', categoryId: 'c1' },
      { id: 'p3', url: validPayload.url, participantName: 'A', categoryId: 'c2' },
    ] as never)

    const result = await ingestCapture(validPayload)

    expect(result.matched).toBe(2)
    expect(mockTriggerScoring).toHaveBeenCalledTimes(2)
  })

  it('throws NoMatchingProjectError when the URL was never submitted', async () => {
    mockFindMany.mockResolvedValueOnce([] as never)
    await expect(ingestCapture(validPayload)).rejects.toBeInstanceOf(NoMatchingProjectError)
    expect(mockProjectUpdate).not.toHaveBeenCalled()
  })

  it('rejects a non-PartyRock URL before touching the database [**Validates: Requirements 9.3**]', async () => {
    await expect(
      ingestCapture({ ...validPayload, url: 'https://evil.example.com/app' }),
    ).rejects.toThrow()
    expect(mockFindMany).not.toHaveBeenCalled()
  })

  it('accepts a minimal payload, defaulting the collection fields to empty', async () => {
    mockFindMany.mockResolvedValueOnce([
      { id: 'p1', url: validPayload.url, participantName: 'A', categoryId: 'c1' },
    ] as never)

    const result = await ingestCapture({ url: validPayload.url })

    expect(result.widgetCount).toBe(0)
    expect(result.promptCount).toBe(0)
    expect(mockMetadataUpsert).toHaveBeenCalled()
  })
})
