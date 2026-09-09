/**
 * Unit Tests: prompt selection by project type
 *
 * Requirements: 4.1, 4.2, 4.4
 *
 * `buildPartyRockPrompt` / `buildHtmlPrompt` are module-private, so the prompt
 * is observed where it actually matters: the string handed to Gemini. Gemini is
 * mocked and the argument captured, following the pattern already used in
 * `__tests__/services/backward-compatibility.property.test.ts`.
 *
 * What is pinned down here:
 *   - `HTML` selects the web template: the `## HTML Structure` section is
 *     present and carries the computed metrics, the PartyRock framing is gone.
 *   - `PARTYROCK` and an absent project type both select the PartyRock
 *     template, and produce the same string as each other.
 *   - A missing `structure` on an HTML project still yields the section
 *     (Property 23 ties its presence to the project type, not to whether the
 *     parse succeeded) — only its contents change.
 *   - The evidence budget (Requirement 4.3): the structure summary is rendered
 *     whole and charged to the budget first, the markup excerpt gets the
 *     remainder and carries a truncation marker when it is cut.
 *
 * The exhaustive "if and only if" form of the section rule is Property 23,
 * covered as a property in task 7.4.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProjectType } from '@prisma/client'
import type { HtmlStructure, ProjectMetadata, ScoringParameter } from '@/types'

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

// Prevents PrismaClient instantiation — no driver adapter in the test env.
vi.mock('@/lib/db', () => ({
  db: {
    project: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    crawlMetadata: { findMany: vi.fn() },
    aIScore: { upsert: vi.fn() },
  },
}))

import {
  ScorerService,
  HTML_EVIDENCE_CHAR_BUDGET,
  HTML_MARKUP_TRUNCATION_MARKER,
} from '@/lib/services/scorer.service'
import { formatStructureForPrompt } from '@/lib/services/html-structure.service'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PARAMETER: ScoringParameter = {
  id: 'param-1',
  name: 'Semantic HTML & Structure',
  description: 'Correct use of semantic elements',
  weight: 25,
  minScore: 0,
  maxScore: 100,
  scoringMode: 'AUTO',
}

const STRUCTURE: HtmlStructure = {
  headings: [
    { level: 1, text: 'Recycling Tracker' },
    { level: 2, text: 'How it works' },
  ],
  headingCount: 2,
  hasSingleH1: true,
  headingHierarchyValid: true,
  semanticElementCount: 5,
  genericElementCount: 12,
  semanticRatio: 5 / 17,
  landmarks: ['header', 'nav', 'main', 'footer'],
  ariaAttributeCount: 3,
  hasSkipLink: true,
  imageCount: 4,
  imagesWithAlt: 3,
  altTextRatio: 0.75,
  formFieldCount: 2,
  labelledFormFields: 2,
  formLabelRatio: 1,
  totalElementCount: 84,
  maxDomDepth: 9,
  scriptCount: 2,
  inlineStyleCount: 1,
  externalStylesheetCount: 1,
  documentTitle: 'Recycling Tracker',
  metaDescription: 'Track what you recycle',
  langAttribute: 'en',
  hasViewportMeta: true,
}

const BASE_METADATA: ProjectMetadata = {
  title: 'Recycling Tracker',
  description: 'A small web app for logging recycled items',
  widgets: [{ type: 'text-input', label: 'Item' }],
  prompts: ['Summarise the impact'],
  widgetCount: 1,
  sourceCode: '<html lang="en"><body><main><h1>Recycling Tracker</h1></main></body></html>',
  url: 'https://recycling.example.com',
}

/** Runs the scorer with Gemini mocked and returns the prompt it was handed. */
async function capturePrompt(
  metadata: ProjectMetadata,
  contextProjects: ProjectMetadata[] = [],
): Promise<string> {
  mockGenerateContent.mockResolvedValueOnce({
    response: { text: () => JSON.stringify({ score: 70, reasoning: 'ok' }) },
  })

  await ScorerService.scoreParameter(metadata, PARAMETER, contextProjects)

  const lastCall = mockGenerateContent.mock.calls.at(-1)
  expect(lastCall).toBeDefined()
  return String(lastCall?.[0])
}

/**
 * Returns the body of a `## `-headed section, i.e. everything between the
 * header line and the blank line preceding the next header. Used to measure the
 * evidence blocks exactly, rather than probing with `toContain` — the budget is
 * a claim about lengths, and `toContain` cannot see a length.
 */
function extractSection(prompt: string, header: string, nextHeader: string): string {
  const headerAt = prompt.indexOf(`${header}\n`)
  expect(headerAt, `section "${header}" missing from prompt`).toBeGreaterThanOrEqual(0)

  const bodyStart = headerAt + header.length + 1
  const bodyEnd = prompt.indexOf(`\n\n${nextHeader}`, bodyStart)
  expect(bodyEnd, `section after "${header}" missing from prompt`).toBeGreaterThanOrEqual(bodyStart)

  return prompt.slice(bodyStart, bodyEnd)
}

const extractStructureSection = (prompt: string) =>
  extractSection(prompt, '## HTML Structure', '## HTML Source (excerpt)')

const extractSourceSection = (prompt: string) =>
  extractSection(prompt, '## HTML Source (excerpt)', '## Evaluation Parameter')

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// HTML projects
// ---------------------------------------------------------------------------

describe('buildPrompt dispatch: HTML projects', () => {
  it('selects the web template and frames the task around HTML structure', async () => {
    const prompt = await capturePrompt({
      ...BASE_METADATA,
      projectType: ProjectType.HTML,
      structure: STRUCTURE,
    })

    expect(prompt).toContain('evaluating web projects based on their HTML structure')
    expect(prompt).toContain('## HTML Structure')
    expect(prompt).toContain('## HTML Source (excerpt)')

    // Web-specific analysis framing, not the PartyRock one.
    expect(prompt).toContain('Semantic HTML')
    expect(prompt).toContain('Accessibility')
    expect(prompt).not.toContain('built on AWS PartyRock')
    expect(prompt).not.toContain('Widget count')
  })

  it('embeds the formatted structure metrics verbatim', async () => {
    const prompt = await capturePrompt({
      ...BASE_METADATA,
      projectType: ProjectType.HTML,
      structure: STRUCTURE,
    })

    // The structure summary is the primary evidence, so it must arrive whole.
    expect(prompt).toContain(formatStructureForPrompt(STRUCTURE))
  })

  it('includes the project URL, title, description, source excerpt and parameter range', async () => {
    const prompt = await capturePrompt({
      ...BASE_METADATA,
      projectType: ProjectType.HTML,
      structure: STRUCTURE,
    })

    expect(prompt).toContain('URL: https://recycling.example.com')
    expect(prompt).toContain('Title: Recycling Tracker')
    expect(prompt).toContain('A small web app for logging recycled items')
    expect(prompt).toContain(BASE_METADATA.sourceCode as string)
    expect(prompt).toContain('Name: Semantic HTML & Structure')
    expect(prompt).toContain('Score range: 0 to 100')
  })

  it('keeps the HTML Structure section when the structure is missing, stating it is unavailable', async () => {
    for (const structure of [null, undefined]) {
      const prompt = await capturePrompt({
        ...BASE_METADATA,
        projectType: ProjectType.HTML,
        structure,
      })

      // Property 23: the section exists because the type is HTML. Only its
      // contents reflect the failed parse.
      expect(prompt).toContain('## HTML Structure')
      expect(prompt).toContain('HTML structure unavailable')
    }
  })

  it('states plainly when no HTML source is available', async () => {
    const prompt = await capturePrompt({
      ...BASE_METADATA,
      projectType: ProjectType.HTML,
      structure: STRUCTURE,
      sourceCode: null,
      url: null,
    })

    expect(prompt).toContain('(no HTML source provided)')
    expect(prompt).toContain('URL: (no url)')
  })

  it('spends the evidence budget on the structure summary first and markup second', async () => {
    const hugeMarkup = '<div>x</div>'.repeat(5000) // 60.000 chars

    const prompt = await capturePrompt({
      ...BASE_METADATA,
      projectType: ProjectType.HTML,
      structure: STRUCTURE,
      sourceCode: hugeMarkup,
    })

    const structureSummary = formatStructureForPrompt(STRUCTURE)
    const expectedMarkupChars =
      HTML_EVIDENCE_CHAR_BUDGET
      - structureSummary.length
      - HTML_MARKUP_TRUNCATION_MARKER.length

    // Requirement 4.3: the summary is subtracted from the budget first, and the
    // markup gets exactly what is left — not a flat cut of its own.
    expect(extractStructureSection(prompt)).toBe(structureSummary)
    expect(extractSourceSection(prompt)).toBe(
      hugeMarkup.slice(0, expectedMarkupChars) + HTML_MARKUP_TRUNCATION_MARKER,
    )
    expect(prompt).not.toContain(hugeMarkup)
  })

  it('marks a truncated markup excerpt so the model knows it is not the whole document', async () => {
    const hugeMarkup = '<section>y</section>'.repeat(4000) // 80.000 chars

    const prompt = await capturePrompt({
      ...BASE_METADATA,
      projectType: ProjectType.HTML,
      structure: STRUCTURE,
      sourceCode: hugeMarkup,
    })

    expect(extractSourceSection(prompt).endsWith(HTML_MARKUP_TRUNCATION_MARKER)).toBe(true)
  })

  it('leaves a markup excerpt that fits unmarked and whole', async () => {
    const prompt = await capturePrompt({
      ...BASE_METADATA,
      projectType: ProjectType.HTML,
      structure: STRUCTURE,
    })

    expect(extractSourceSection(prompt)).toBe(BASE_METADATA.sourceCode)
    expect(prompt).not.toContain(HTML_MARKUP_TRUNCATION_MARKER.trim())
  })

  it('keeps the structure summary whole and the evidence within budget across markup sizes', async () => {
    const structureSummary = formatStructureForPrompt(STRUCTURE)

    // Sizes straddling the budget: comfortably under, just under, just over,
    // and far over.
    for (const size of [10, 19_000, 19_990, 20_100, 250_000]) {
      const prompt = await capturePrompt({
        ...BASE_METADATA,
        projectType: ProjectType.HTML,
        structure: STRUCTURE,
        sourceCode: 'z'.repeat(size),
      })

      // Never truncated, under any markup size.
      expect(extractStructureSection(prompt)).toBe(structureSummary)

      const evidenceChars =
        structureSummary.length + extractSourceSection(prompt).length
      expect(evidenceChars).toBeLessThanOrEqual(HTML_EVIDENCE_CHAR_BUDGET)
    }
  })

  it('summarises sibling projects with structural size rather than widget counts', async () => {
    const prompt = await capturePrompt(
      { ...BASE_METADATA, projectType: ProjectType.HTML, structure: STRUCTURE },
      [
        {
          title: 'Peer Project',
          description: 'Another web app',
          widgets: [],
          prompts: [],
          widgetCount: 0,
          structure: { ...STRUCTURE, totalElementCount: 120 },
        },
      ],
    )

    expect(prompt).toContain('Title: Peer Project')
    expect(prompt).toContain('Elements: 120')
  })
})

// ---------------------------------------------------------------------------
// PartyRock projects and legacy metadata
// ---------------------------------------------------------------------------

describe('buildPrompt dispatch: PartyRock and absent project type', () => {
  it('selects the PartyRock template for PARTYROCK, with no HTML structure section', async () => {
    const prompt = await capturePrompt({
      ...BASE_METADATA,
      projectType: ProjectType.PARTYROCK,
    })

    expect(prompt).toContain('built on AWS PartyRock')
    expect(prompt).toContain('## Application to Evaluate')
    expect(prompt).toContain('Widget count: 1')
    expect(prompt).not.toContain('## HTML Structure')
    expect(prompt).not.toContain('## HTML Source (excerpt)')
  })

  it('falls back to the PartyRock template when the project type is absent', async () => {
    const { projectType: _omitted, ...legacyMetadata } = {
      ...BASE_METADATA,
      projectType: undefined,
    }

    const prompt = await capturePrompt(legacyMetadata as ProjectMetadata)

    expect(prompt).toContain('built on AWS PartyRock')
    expect(prompt).not.toContain('## HTML Structure')
  })

  it('produces the identical prompt for an absent type and an explicit PARTYROCK type', async () => {
    const legacyPrompt = await capturePrompt(BASE_METADATA)
    const explicitPrompt = await capturePrompt({
      ...BASE_METADATA,
      projectType: ProjectType.PARTYROCK,
    })

    expect(explicitPrompt).toBe(legacyPrompt)
  })

  it('ignores an attached structure when the project type is not HTML', async () => {
    const withoutStructure = await capturePrompt({
      ...BASE_METADATA,
      projectType: ProjectType.PARTYROCK,
    })
    const withStructure = await capturePrompt({
      ...BASE_METADATA,
      projectType: ProjectType.PARTYROCK,
      structure: STRUCTURE,
    })

    expect(withStructure).toBe(withoutStructure)
    expect(withStructure).not.toContain('## HTML Structure')
  })

  it('ignores the url field on the PartyRock path', async () => {
    const withUrl = await capturePrompt({ ...BASE_METADATA, url: 'https://partyrock.aws/app/x' })
    const withoutUrl = await capturePrompt({ ...BASE_METADATA, url: null })

    expect(withUrl).toBe(withoutUrl)
    expect(withUrl).not.toContain('partyrock.aws/app/x')
  })
})
