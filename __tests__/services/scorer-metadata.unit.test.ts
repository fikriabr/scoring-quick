/**
 * Unit Tests: what `ScorerService.triggerScoring` hands to the prompt builder
 *
 * Requirements: 4.5, 4.6
 *
 * Task 7.1/7.2 built the HTML prompt; this file covers the wiring that makes it
 * reachable. `projectType` and `structure` are read off the Project and its
 * CrawlMetadata inside `triggerScoring`, so the only way to observe them is
 * end-to-end: fake the database rows, mock Gemini, and read the prompt that
 * came out — the same pattern as `scorer-prompt.unit.test.ts`.
 *
 * What is pinned down here:
 *   - `projectType = HTML` on the row selects the web template, and the
 *     `structure` column reaches the prompt as computed metrics.
 *   - Requirement 3.6: when no crawled `structure` exists, the pasted
 *     `sourceCode` is parsed into one; a crawled `structure` always wins; a
 *     parse failure degrades the prompt instead of failing the score; and a
 *     PARTYROCK `sourceCode` is never parsed.
 *   - Requirement 4.6: an HTML project with no evidence anywhere is marked
 *     FAILED and Gemini is never called.
 *   - Any single piece of evidence is enough — sourceCode alone, or rawHtml
 *     alone, or a stored structure alone.
 *   - Sibling `structure` reaches the comparison section, and no sibling markup
 *     ever reaches the prompt (the token-cost rule from design.md).
 *   - PartyRock projects are untouched, including the no-evidence case.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProjectType } from '@prisma/client'
import type { HtmlStructure } from '@/types'

// ---------------------------------------------------------------------------
// Mock modules BEFORE importing the service under test
// ---------------------------------------------------------------------------

const { mockGenerateContent } = vi.hoisted(() => ({
  mockGenerateContent: vi.fn(),
}))

vi.mock('@google/generative-ai', () => {
  class MockGoogleGenerativeAI {
    constructor(_apiKey: string) { }
    getGenerativeModel(_config: unknown) {
      return { generateContent: mockGenerateContent }
    }
  }
  return { GoogleGenerativeAI: MockGoogleGenerativeAI }
})

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

/**
 * `parseHtmlStructure` is documented as never throwing, so the scorer's
 * try/catch around it cannot be reached through any input. This switch reaches
 * it: everything stays the real implementation until a test opts in, so the
 * fallback path is covered without faking the metrics themselves.
 */
const { forcedParseError } = vi.hoisted(() => ({
  forcedParseError: { message: null as string | null },
}))

vi.mock('@/lib/services/html-structure.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/html-structure.service')>()
  return {
    ...actual,
    parseHtmlStructure: (html: string) => {
      if (forcedParseError.message !== null) {
        throw new Error(forcedParseError.message)
      }
      return actual.parseHtmlStructure(html)
    },
  }
})

vi.mock('@/lib/db', () => ({
  db: {
    project: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    crawlMetadata: { findMany: vi.fn() },
    aIScore: { upsert: vi.fn() },
  },
}))

import { db } from '@/lib/db'
import {
  ScorerService,
  HTML_NO_EVIDENCE_MESSAGE,
} from '@/lib/services/scorer.service'
import {
  formatStructureForPrompt,
  parseHtmlStructure,
} from '@/lib/services/html-structure.service'

const mockProjectFindUniqueOrThrow = vi.mocked(db.project.findUniqueOrThrow)
const mockProjectUpdate = vi.mocked(db.project.update)
const mockCrawlMetadataFindMany = vi.mocked(db.crawlMetadata.findMany)
const mockAIScoreUpsert = vi.mocked(db.aIScore.upsert)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STRUCTURE: HtmlStructure = {
  headings: [{ level: 1, text: 'Recycling Tracker' }],
  headingCount: 1,
  hasSingleH1: true,
  headingHierarchyValid: true,
  semanticElementCount: 6,
  genericElementCount: 10,
  semanticRatio: 6 / 16,
  landmarks: ['header', 'main', 'footer'],
  ariaAttributeCount: 2,
  hasSkipLink: false,
  imageCount: 2,
  imagesWithAlt: 2,
  altTextRatio: 1,
  formFieldCount: 1,
  labelledFormFields: 1,
  formLabelRatio: 1,
  totalElementCount: 77,
  maxDomDepth: 8,
  scriptCount: 1,
  inlineStyleCount: 0,
  externalStylesheetCount: 1,
  documentTitle: 'Recycling Tracker',
  metaDescription: 'Track what you recycle',
  langAttribute: 'en',
  hasViewportMeta: true,
}

const PARAMETER = {
  id: 'param-1',
  categoryId: 'category-1',
  name: 'Semantic HTML & Structure',
  description: 'Correct use of semantic elements',
  weight: 100,
  minScore: 0,
  maxScore: 100,
  scoringMode: 'AUTO' as const,
  orderIndex: 0,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
}

type MetadataOverrides = {
  title?: string | null
  description?: string | null
  rawHtml?: string | null
  structure?: unknown
}

function buildMetadataRow(overrides: MetadataOverrides = {}) {
  return {
    id: 'metadata-1',
    projectId: 'project-1',
    title: 'Recycling Tracker',
    description: 'A small web app for logging recycled items',
    widgets: [],
    prompts: [],
    widgetCount: 0,
    rawHtml: null,
    structure: null,
    crawledAt: new Date('2024-01-01'),
    ...overrides,
  }
}

type ProjectOverrides = {
  projectType?: ProjectType
  sourceCode?: string | null
  metadata?: ReturnType<typeof buildMetadataRow> | null
  parameters?: (typeof PARAMETER)[]
}

function buildProjectRow(overrides: ProjectOverrides = {}) {
  const {
    projectType = ProjectType.HTML,
    sourceCode = null,
    metadata = buildMetadataRow(),
    parameters = [PARAMETER],
  } = overrides

  return {
    id: 'project-1',
    categoryId: 'category-1',
    url: 'https://recycling.example.com',
    projectType,
    participantName: 'Test User',
    teamName: null,
    sourceCode,
    crawlStatus: 'SUCCESS' as const,
    crawlError: null,
    scoreStatus: 'PENDING' as const,
    finalScore: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    category: {
      id: 'category-1',
      eventId: 'event-1',
      name: 'Web Projects',
      description: null,
      isPublished: false,
      publicToken: null,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
      parameters,
    },
    metadata,
  }
}

/**
 * Runs `triggerScoring` against the given Project row and returns the prompt
 * Gemini was handed, or `null` when it was never called.
 */
async function scoreAndCapturePrompt(
  project: ReturnType<typeof buildProjectRow>,
  siblings: ReturnType<typeof buildMetadataRow>[] = [],
): Promise<string | null> {
  // `mockResolvedValue`, not `...Once`: the no-evidence tests return before the
  // sibling query runs, and a queued one-shot value would survive
  // `clearAllMocks` and be picked up by a later test.
  mockProjectFindUniqueOrThrow.mockResolvedValue(project as never)
  mockCrawlMetadataFindMany.mockResolvedValue(siblings as never)
  mockGenerateContent.mockResolvedValue({
    response: { text: () => JSON.stringify({ score: 70, reasoning: 'ok' }) },
  })

  await ScorerService.triggerScoring('project-1')

  const lastCall = mockGenerateContent.mock.calls.at(-1)
  return lastCall ? String(lastCall[0]) : null
}

/** The `scoreStatus` values written to the Project row, in order. */
function writtenScoreStatuses(): string[] {
  return mockProjectUpdate.mock.calls
    .map((call) => (call[0] as { data: { scoreStatus?: string } }).data.scoreStatus)
    .filter((status): status is string => typeof status === 'string')
}

beforeEach(() => {
  vi.clearAllMocks()
  forcedParseError.message = null
  mockProjectUpdate.mockResolvedValue({} as never)
  mockAIScoreUpsert.mockResolvedValue({} as never)
})

// ---------------------------------------------------------------------------
// projectType and structure reach the prompt
// ---------------------------------------------------------------------------

describe('triggerScoring: HTML metadata wiring', () => {
  it('selects the web template from the stored projectType', async () => {
    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({ sourceCode: '<main><h1>Hi</h1></main>' }),
    )

    expect(prompt).toContain('evaluating web projects based on their HTML structure')
    expect(prompt).not.toContain('built on AWS PartyRock')
  })

  it('carries the stored structure column into the prompt as computed metrics', async () => {
    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({
        sourceCode: '<main><h1>Hi</h1></main>',
        metadata: buildMetadataRow({ structure: STRUCTURE }),
      }),
    )

    // The whole rendered summary, not a probe for one metric — the structure
    // block is the primary evidence and must arrive intact.
    expect(prompt).toContain(formatStructureForPrompt(STRUCTURE))
    expect(prompt).not.toContain('HTML structure unavailable')
  })

  it('scores from the structure column alone, with no sourceCode and no rawHtml', async () => {
    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({
        sourceCode: null,
        metadata: buildMetadataRow({ structure: STRUCTURE }),
      }),
    )

    expect(prompt).toContain(formatStructureForPrompt(STRUCTURE))
    expect(prompt).toContain('(no HTML source provided)')
    expect(writtenScoreStatuses()).toEqual(['SUCCESS'])
  })

  it('derives the structure from sourceCode when the crawl computed none', async () => {
    const markup = '<html lang="en"><body><main><h1>Pasted</h1></main></body></html>'

    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({ sourceCode: markup, metadata: buildMetadataRow() }),
    )

    // Requirement 3.6: markup in `sourceCode` is a source of HTML Structure, so
    // the metrics are computed here rather than the section reading "unavailable"
    // while perfectly good markup sits in the block right below it.
    expect(prompt).toContain(formatStructureForPrompt(parseHtmlStructure(markup)))
    expect(prompt).not.toContain('HTML structure unavailable')
    expect(prompt).toContain(markup)
    expect(writtenScoreStatuses()).toEqual(['SUCCESS'])
  })

  it('keeps scoring when only rawHtml was stored', async () => {
    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({
        sourceCode: null,
        metadata: buildMetadataRow({ rawHtml: '<html><body>fetched</body></html>' }),
      }),
    )

    expect(prompt).toContain('evaluating web projects')
    expect(writtenScoreStatuses()).toEqual(['SUCCESS'])
  })

  it('works for an HTML project that has no CrawlMetadata row at all', async () => {
    const markup = '<main>only pasted code</main>'

    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({ sourceCode: markup, metadata: null }),
    )

    expect(prompt).toContain('evaluating web projects')
    expect(prompt).toContain('only pasted code')
    // No crawl row means no crawled structure, but `sourceCode` still supplies
    // one — the metadata row's absence is not evidence's absence.
    expect(prompt).toContain(formatStructureForPrompt(parseHtmlStructure(markup)))
    expect(prompt).not.toContain('HTML structure unavailable')
  })
})

// ---------------------------------------------------------------------------
// Requirement 3.6 — Source Code as a source of HTML Structure
// ---------------------------------------------------------------------------

describe('triggerScoring: structure derived from Source Code (Requirement 3.6)', () => {
  it('prefers the crawled structure over anything sourceCode would yield', async () => {
    // The pasted markup would parse to something very different from STRUCTURE —
    // one h1 versus none, three landmarks versus none — so whichever value
    // reached the prompt is unambiguous.
    const markup = '<div><span>no headings, no landmarks here</span></div>'

    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({
        sourceCode: markup,
        metadata: buildMetadataRow({ structure: STRUCTURE }),
      }),
    )

    expect(prompt).toContain(formatStructureForPrompt(STRUCTURE))
    expect(prompt).not.toContain(
      formatStructureForPrompt(parseHtmlStructure(markup)),
    )
  })

  it('keeps scoring when the sourceCode cannot be parsed', async () => {
    forcedParseError.message = 'parser blew up'
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => { })

    const markup = '<html lang="en"><body><main><h1>Pasted</h1></main></body></html>'
    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({ sourceCode: markup, metadata: buildMetadataRow() }),
    )

    // Losing the metrics is a degraded prompt; it must not cost the score.
    expect(prompt).toContain('## HTML Structure')
    expect(prompt).toContain('HTML structure unavailable')
    expect(prompt).toContain(markup)
    expect(writtenScoreStatuses()).toEqual(['SUCCESS'])
    expect(errorLog.mock.calls.flat().join(' ')).toContain('parser blew up')

    errorLog.mockRestore()
  })

  it('handles sourceCode that is not markup at all without failing', async () => {
    const notMarkup = 'this is plain prose with a stray < and an unclosed <div'

    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({ sourceCode: notMarkup, metadata: buildMetadataRow() }),
    )

    expect(prompt).toContain(formatStructureForPrompt(parseHtmlStructure(notMarkup)))
    expect(writtenScoreStatuses()).toEqual(['SUCCESS'])
  })

  it('never parses a PARTYROCK project sourceCode into a structure', async () => {
    // A PartyRock `sourceCode` is a serialised capture, not markup, and the
    // PartyRock prompt never reads `structure`. Parsing it would be work spent
    // on metrics about a JSON blob.
    const capture = '{"widgets":[{"type":"chatbot","label":"Ask"}]}'

    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({
        projectType: ProjectType.PARTYROCK,
        sourceCode: capture,
        metadata: buildMetadataRow(),
      }),
    )

    expect(prompt).toContain('built on AWS PartyRock')
    expect(prompt).not.toContain('## HTML Structure')
    expect(prompt).not.toContain('Semantic elements:')
    expect(prompt).not.toContain('max DOM depth')
  })
})

// ---------------------------------------------------------------------------
// Requirement 4.6 — no evidence at all
// ---------------------------------------------------------------------------

describe('triggerScoring: HTML project with no evidence (Requirement 4.6)', () => {
  it('marks the project FAILED and never calls Gemini', async () => {
    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({ sourceCode: null, metadata: buildMetadataRow() }),
    )

    expect(prompt).toBeNull()
    expect(mockGenerateContent).not.toHaveBeenCalled()
    expect(mockAIScoreUpsert).not.toHaveBeenCalled()
    expect(writtenScoreStatuses()).toEqual(['FAILED'])
  })

  it('reports why, and leaves finalScore alone', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => { })

    await scoreAndCapturePrompt(
      buildProjectRow({ sourceCode: null, metadata: null }),
    )

    // The reason has nowhere to live in the schema, so the log is the record.
    expect(errorLog.mock.calls.flat().join(' ')).toContain(HTML_NO_EVIDENCE_MESSAGE)

    // `finalScore` can hold a jury-derived value; nothing was scored here that
    // would justify clearing it.
    const written = mockProjectUpdate.mock.calls.map(
      (call) => (call[0] as { data: Record<string, unknown> }).data,
    )
    expect(written).toEqual([{ scoreStatus: 'FAILED' }])

    errorLog.mockRestore()
  })

  it('treats whitespace-only sourceCode as no evidence', async () => {
    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({ sourceCode: '   \n\t  ', metadata: buildMetadataRow({ rawHtml: '  ' }) }),
    )

    expect(prompt).toBeNull()
    expect(writtenScoreStatuses()).toEqual(['FAILED'])
  })

  it('still reports SUCCESS when the category has no AUTO parameters', async () => {
    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({
        sourceCode: null,
        metadata: buildMetadataRow(),
        parameters: [{ ...PARAMETER, scoringMode: 'MANUAL' as unknown as 'AUTO' }],
      }),
    )

    // Nothing asked the AI for a score, so missing evidence failed nothing.
    expect(prompt).toBeNull()
    expect(writtenScoreStatuses()).toEqual(['SUCCESS'])
  })
})

// ---------------------------------------------------------------------------
// Sibling projects in the comparison section
// ---------------------------------------------------------------------------

describe('triggerScoring: sibling context', () => {
  it('carries sibling structure into the comparison section', async () => {
    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({
        sourceCode: '<main>mine</main>',
        metadata: buildMetadataRow({ structure: STRUCTURE }),
      }),
      [
        buildMetadataRow({
          title: 'Peer Project',
          description: 'Another web app',
          structure: { ...STRUCTURE, totalElementCount: 321, semanticRatio: 0.5 },
        }),
      ],
    )

    expect(prompt).toContain('Title: Peer Project')
    expect(prompt).toContain('Elements: 321')
    expect(prompt).toContain('Semantic ratio: 0.50')
  })

  it('never sends sibling markup, only the bounded structure summary', async () => {
    const siblingMarkup = '<div id="SIBLING-MARKUP-SHOULD-NOT-LEAK"></div>'

    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({
        sourceCode: '<main>mine</main>',
        metadata: buildMetadataRow({ structure: STRUCTURE }),
      }),
      [
        buildMetadataRow({
          title: 'Peer Project',
          rawHtml: siblingMarkup,
          structure: { ...STRUCTURE, totalElementCount: 321 },
        }),
      ],
    )

    // Pulling every peer's markup into every prompt, once per parameter, is the
    // token-cost blow-up recorded in design.md.
    expect(prompt).toContain('Title: Peer Project')
    expect(prompt).not.toContain('SIBLING-MARKUP-SHOULD-NOT-LEAK')
  })

  it('renders siblings without a structure, without inventing metrics', async () => {
    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({
        sourceCode: '<main>mine</main>',
        metadata: buildMetadataRow({ structure: STRUCTURE }),
      }),
      [buildMetadataRow({ title: 'Legacy Peer', structure: null })],
    )

    expect(prompt).toContain('Title: Legacy Peer')
    expect(prompt).not.toContain('Elements: ')
  })
})

// ---------------------------------------------------------------------------
// PartyRock projects are untouched
// ---------------------------------------------------------------------------

describe('triggerScoring: PartyRock projects unchanged', () => {
  it('uses the PartyRock template and ignores a stored structure', async () => {
    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({
        projectType: ProjectType.PARTYROCK,
        sourceCode: '{"widgets":[]}',
        metadata: buildMetadataRow({ structure: STRUCTURE }),
      }),
    )

    expect(prompt).toContain('built on AWS PartyRock')
    expect(prompt).not.toContain('## HTML Structure')
    expect(prompt).not.toContain(formatStructureForPrompt(STRUCTURE))
  })

  it('still calls Gemini for a PartyRock project with no evidence', async () => {
    // Requirement 4.6 is an HTML rule; Requirement 8.2 keeps this path as it was.
    const prompt = await scoreAndCapturePrompt(
      buildProjectRow({
        projectType: ProjectType.PARTYROCK,
        sourceCode: null,
        metadata: buildMetadataRow(),
      }),
    )

    expect(prompt).toContain('built on AWS PartyRock')
    expect(prompt).toContain('(no source code provided)')
    expect(writtenScoreStatuses()).toEqual(['SUCCESS'])
  })
})
