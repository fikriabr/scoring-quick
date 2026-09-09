/**
 * Property-Based Tests: Property 23 — Prompt Selection And Evidence Budget By
 * Project Type
 *
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4**
 *
 * Property 23 (from design.md):
 *   _For any_ project and parameter, the prompt sent to the AI Scorer SHALL
 *   contain the HTML structure section if and only if the project type is
 *   `HTML`. When the evidence exceeds the character budget, the structure
 *   summary SHALL be present in full and only the raw markup excerpt SHALL be
 *   truncated.
 *
 * ---------------------------------------------------------------------------
 * How the prompt is observed
 * ---------------------------------------------------------------------------
 * `buildPrompt` and both template builders are module-private, so the prompt is
 * read where it actually matters: the string handed to Gemini. Gemini is mocked
 * and the argument captured — the same harness as
 * `__tests__/services/scorer-prompt.unit.test.ts` and
 * `__tests__/services/scorer-metadata.unit.test.ts`, whose `capturePrompt` and
 * `extractSection` helpers are reused here.
 *
 * ---------------------------------------------------------------------------
 * What this file adds over `scorer-prompt.unit.test.ts`
 * ---------------------------------------------------------------------------
 * The unit test walks a handful of hand-picked cases: one structure, a few
 * markup sizes, one parameter. That proves the dispatch and the budget work for
 * *those* inputs. Property 23 is an "if and only if" over every project and
 * every parameter, plus an ordering claim over every evidence size, and neither
 * quantifier can be discharged by examples.
 *
 * The two generators that carry the file:
 *
 *   1. `structureArbitrary` — structures are produced by running the real
 *      `parseHtmlStructure` over generated markup, rather than by filling an
 *      `HtmlStructure` record with random numbers. Two reasons. Realism: every
 *      structure is one some document could actually produce, so the summary
 *      lengths under test are the lengths production sees. And soundness of the
 *      budget claim: `formatStructureForPrompt` is only bounded (≤2500 chars,
 *      pinned by P22-i in `html-structure.property.test.ts`) for structures the
 *      parser can emit — a hand-built record with ten thousand landmarks would
 *      render a summary larger than the whole budget, which is a shape the
 *      production pipeline cannot reach.
 *   2. `sourceCodeArbitrary` — markup sized *relative to the budget the
 *      structure summary left behind*, via `fc.chain`. That is what puts inputs
 *      exactly on the threshold (`remaining - 1`, `remaining`, `remaining + 1`)
 *      instead of near a hardcoded 20.000 that the summary has already eaten
 *      into. It also emits `null`, `undefined`, `''` and whitespace-only
 *      markup, which are the real states of `Project.sourceCode`.
 *
 * `projectType` and `structure` are generated *independently* throughout, which
 * is what makes the iff clause bite: the section must appear for an HTML project
 * whose structure is missing, and must stay away from a PartyRock project whose
 * structure is present. A rule keyed on "is a structure available" rather than
 * on the project type would pass a test that varied only one of them.
 *
 * `numRuns` is kept in the low hundreds because every run goes through
 * `ScorerService.scoreParameter`, and some runs build a quarter-megabyte prompt.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import { ProjectType } from '@prisma/client'
import type {
  HtmlStructure,
  ProjectMetadata,
  ScoringParameter,
  WidgetInfo,
} from '@/types'

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
import {
  parseHtmlStructure,
  formatStructureForPrompt,
} from '@/lib/services/html-structure.service'

// ---------------------------------------------------------------------------
// Section headers, as they appear in the prompt
// ---------------------------------------------------------------------------

const STRUCTURE_HEADER = '## HTML Structure'
const SOURCE_HEADER = '## HTML Source (excerpt)'
const PARAMETER_HEADER = '## Evaluation Parameter'

/** The PartyRock template's own markers, used to prove the other branch ran. */
const PARTYROCK_MARKERS = ['built on AWS PartyRock', '## Application to Evaluate']

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GEMINI_REPLY = JSON.stringify({ score: 70, reasoning: 'ok' })

/**
 * Runs the scorer with Gemini mocked and returns the prompt it was handed.
 *
 * Calls are cleared per capture rather than accumulated: a property run makes
 * hundreds of them, and reading `calls[0]` after a clear is both cheaper and
 * less error-prone than indexing from the end of an ever-growing array.
 */
async function capturePrompt(
  metadata: ProjectMetadata,
  parameter: ScoringParameter,
  contextProjects: ProjectMetadata[] = [],
): Promise<string> {
  mockGenerateContent.mockClear()
  mockGenerateContent.mockResolvedValue({
    response: { text: () => GEMINI_REPLY },
  })

  await ScorerService.scoreParameter(metadata, parameter, contextProjects)

  expect(mockGenerateContent).toHaveBeenCalledTimes(1)
  return String(mockGenerateContent.mock.calls[0]?.[0])
}

/**
 * Returns the body of a `## `-headed section: everything between the header
 * line and the blank line preceding the next header. Sections are measured
 * rather than probed with `toContain`, because the budget is a claim about
 * lengths and `toContain` cannot see a length.
 *
 * The `\n\n${nextHeader}` terminator is unambiguous even when the body itself
 * ends in newlines: an earlier position in a run of newlines fails the `##`
 * check, so the first match is always the real separator.
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
  extractSection(prompt, STRUCTURE_HEADER, SOURCE_HEADER)

const extractSourceSection = (prompt: string) =>
  extractSection(prompt, SOURCE_HEADER, PARAMETER_HEADER)

/**
 * The prompt with the markup body swapped for a placeholder — everything the
 * markup is *not* allowed to influence. Used by P23-c to compare two prompts
 * that differ only in evidence size.
 */
function withMarkupBodyMasked(prompt: string): string {
  const body = extractSourceSection(prompt)
  const bodyStart = prompt.indexOf(`${SOURCE_HEADER}\n`) + SOURCE_HEADER.length + 1

  return prompt.slice(0, bodyStart) + '<<markup>>' + prompt.slice(bodyStart + body.length)
}

/**
 * Length of the rendered structure section.
 *
 * For a present structure it is `formatStructureForPrompt`. For an absent one it
 * is the length of the module-private "unavailable" notice, which is probed
 * once from a real prompt in `beforeAll` rather than copied here — a literal
 * copy would silently drift from the implementation, and the only thing the
 * generators need from it is a number to aim the boundary cases at.
 */
let unavailableSectionLength = 0

function structureSectionLength(structure: HtmlStructure | null | undefined): number {
  return structure ? formatStructureForPrompt(structure).length : unavailableSectionLength
}

/** Budget left for markup once the structure summary has been charged. */
function remainingBudgetFor(structure: HtmlStructure | null | undefined): number {
  return Math.max(0, HTML_EVIDENCE_CHAR_BUDGET - structureSectionLength(structure))
}

// ---------------------------------------------------------------------------
// Arbitraries — markup, and the structures parsed out of it
// ---------------------------------------------------------------------------

/**
 * Text content. `<`, `>`, `&` and `#` are stripped from the random branch: the
 * first three so it stays text rather than accidental markup, and `#` so no
 * generated value can ever spell a `##` section header and fool the section
 * extraction or the "no HTML section" assertions.
 */
const safeTextArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'Recycling Tracker',
    'Judul Bagian',
    'Lorem ipsum dolor sit amet',
    '',
    '   ',
    '\n\t  spasi banyak  \n',
    'Skip to main content',
    '日本語のテキスト',
    'emoji 🎉 dan 👩‍💻',
    'x'.repeat(300),
  ),
  fc.string({ maxLength: 24 }).map((s) => s.replace(/[<>&#]/g, '')),
)

const headingArbitrary: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 1, max: 6 }), safeTextArbitrary)
  .map(([level, text]) => `<h${level}>${text}</h${level}>`)

const leafArbitrary: fc.Arbitrary<string> = fc.constantFrom(
  '<img src="a.png" alt="Tangkapan layar">',
  '<img src="b.png" alt="">',
  '<img src="c.png">',
  '<label for="f1">Nama</label><input type="text" id="f1">',
  '<label>Pesan <textarea></textarea></label>',
  '<input type="search" aria-label="Cari">',
  '<input type="text" name="tanpa-label">',
  '<select name="pilih"><option>A</option></select>',
  '<a href="#main-content">Skip to main content</a>',
  '<a href="/about">Tentang</a>',
  '<p>Paragraf biasa</p>',
  '<br>',
)

const headElementArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    '<title>Judul Dokumen</title>',
    '<title></title>',
    '<meta name="description" content="Deskripsi halaman">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<link rel="stylesheet" href="/styles.css">',
    '<style>.a{color:red}</style>',
    '<script src="/app.js"></script>',
  ),
  // Oversized metadata, so the summary is exercised near its own upper bound —
  // the case where the least markup budget is left over.
  fc.integer({ min: 150, max: 600 }).map((n) => `<title>${'T'.repeat(n)}</title>`),
  fc
    .integer({ min: 250, max: 900 })
    .map((n) => `<meta name="description" content="${'D'.repeat(n)}">`),
)

const CONTAINER_TAGS = [
  'header',
  'nav',
  'main',
  'article',
  'section',
  'aside',
  'footer',
  'div',
  'span',
  'ul',
  'li',
  'form',
] as const

const CONTAINER_ATTRIBUTES = [
  '',
  ' class="wrapper"',
  ' id="main-content"',
  ' role="navigation"',
  ' aria-label="Wilayah"',
  ' style="color:red"',
] as const

const { markupNode } = fc.letrec<{ markupNode: string }>((tie) => ({
  markupNode: fc.oneof(
    { maxDepth: 3, depthIdentifier: 'markup', withCrossShrink: true },
    { arbitrary: safeTextArbitrary, weight: 1 },
    { arbitrary: headingArbitrary, weight: 3 },
    { arbitrary: leafArbitrary, weight: 3 },
    { arbitrary: headElementArbitrary, weight: 1 },
    {
      arbitrary: fc
        .tuple(
          fc.constantFrom(...CONTAINER_TAGS),
          fc.constantFrom(...CONTAINER_ATTRIBUTES),
          fc.array(tie('markupNode'), { maxLength: 3 }),
        )
        .map(([tag, attrs, children]) => `<${tag}${attrs}>${children.join('')}</${tag}>`),
      weight: 6,
    },
  ),
}))

/** Whole documents and bare fragments — both reach the parser in production. */
const documentArbitrary: fc.Arbitrary<string> = fc
  .record({
    head: fc.array(headElementArbitrary, { maxLength: 3 }),
    body: fc.array(markupNode, { maxLength: 4 }),
    lang: fc.constantFrom('', ' lang="id"', ' lang=""', ' lang="en-US"'),
    wrapped: fc.boolean(),
  })
  .map(({ head, body, lang, wrapped }) =>
    wrapped
      ? `<html${lang}><head>${head.join('')}</head><body>${body.join('')}</body></html>`
      : head.join('') + body.join(''),
  )

/**
 * `structure` as the scorer receives it: parsed from real markup, or absent.
 *
 * `null` and `undefined` are both generated because they arrive from different
 * places — `null` from a `CrawlMetadata.structure` column that was never
 * filled, `undefined` from a call site that omits the field entirely — and the
 * iff clause has to hold for both.
 */
const structureArbitrary: fc.Arbitrary<HtmlStructure | null | undefined> = fc.oneof(
  { arbitrary: documentArbitrary.map((html) => parseHtmlStructure(html)), weight: 6 },
  { arbitrary: fc.constant(null), weight: 1 },
  { arbitrary: fc.constant(undefined), weight: 1 },
)

/** A structure that is definitely present, for the cases that need one. */
const presentStructureArbitrary: fc.Arbitrary<HtmlStructure> = documentArbitrary.map(
  (html) => parseHtmlStructure(html),
)

// ---------------------------------------------------------------------------
// Arbitraries — source code sized against the budget
// ---------------------------------------------------------------------------

const MARKUP_UNIT = '<div class="row"><p>evidence</p></div>'

/** Markup of exactly `n` characters, so length is the generated dimension. */
function markupOfLength(n: number): string {
  if (n <= 0) return ''
  return MARKUP_UNIT.repeat(Math.ceil(n / MARKUP_UNIT.length)).slice(0, n)
}

/**
 * `Project.sourceCode` in every state it reaches the scorer in, with lengths
 * placed relative to `remaining` — the budget left after the structure summary.
 * Aiming at the *remaining* budget rather than at 20.000 is what lands inputs
 * exactly on the boundary the implementation actually uses.
 */
function sourceCodeArbitrary(remaining: number): fc.Arbitrary<string | null | undefined> {
  return fc.oneof(
    // Absent and blank columns: `null` from an untouched row, `''` from a
    // submitted-empty textarea, whitespace from a nearly-empty one.
    { arbitrary: fc.constantFrom(null, undefined, '', ' ', '   \n\t  ', '\n\n'), weight: 2 },
    // Far below the budget.
    { arbitrary: fc.integer({ min: 1, max: 2000 }).map(markupOfLength), weight: 2 },
    // Straddling the threshold by a few characters in each direction.
    {
      arbitrary: fc
        .integer({ min: -3, max: 3 })
        .map((delta) => markupOfLength(remaining + delta)),
      weight: 3,
    },
    // Anywhere across the range, including the far side of the budget.
    { arbitrary: fc.integer({ min: 0, max: 60_000 }).map(markupOfLength), weight: 3 },
    // Far above: a full page dump.
    {
      arbitrary: fc.constantFrom(remaining * 2, 100_000, 250_000).map(markupOfLength),
      weight: 1,
    },
  )
}

/**
 * A structure paired with source code sized against *that* structure's leftover
 * budget. `chain` is required: the threshold is not known until the structure
 * has been generated and its summary rendered.
 */
const htmlEvidenceArbitrary: fc.Arbitrary<{
  structure: HtmlStructure | null | undefined
  sourceCode: string | null | undefined
}> = structureArbitrary.chain((structure) =>
  sourceCodeArbitrary(remainingBudgetFor(structure)).map((sourceCode) => ({
    structure,
    sourceCode,
  })),
)

// ---------------------------------------------------------------------------
// Arbitraries — parameters and metadata
// ---------------------------------------------------------------------------

/**
 * Scoring parameters, including ranges that are not 0–100: the range is
 * interpolated into the prompt twice (the `Score range:` line and the output
 * contract), and a template that hardcoded 0–100 anywhere would only be caught
 * by a non-default range.
 */
const parameterArbitrary: fc.Arbitrary<ScoringParameter> = fc
  .record({
    id: fc.stringMatching(/^param-[a-z0-9]{1,8}$/),
    name: fc.constantFrom(
      'Semantic HTML & Structure',
      'Accessibility',
      'Aksesibilitas & Keterbacaan',
      'SEO',
      'Kualitas Struktur — bagian 1',
      'x'.repeat(120),
    ),
    description: fc.oneof(
      fc.constant(null),
      fc.constantFrom(
        'Correct use of semantic elements',
        'Penilaian atas kelengkapan atribut aksesibilitas',
        '',
      ),
    ),
    weight: fc.integer({ min: 1, max: 100 }),
    minScore: fc.integer({ min: -10, max: 50 }),
    span: fc.integer({ min: 1, max: 100 }),
  })
  .map(({ span, minScore, ...rest }) => ({
    ...rest,
    minScore,
    maxScore: minScore + span,
    scoringMode: 'AUTO' as const,
  }))

const widgetsArbitrary: fc.Arbitrary<WidgetInfo[]> = fc.array(
  fc.record({
    type: fc.constantFrom('text-input', 'chatbot', 'image-generation', 'document'),
    label: fc.constantFrom('Item', 'Pertanyaan', ''),
  }),
  { maxLength: 3 },
)

/**
 * The metadata fields that are common to both templates. `projectType`,
 * `structure`, `sourceCode` and `url` are deliberately *not* part of this
 * record — every property below sets them itself, because they are the
 * dimensions under test.
 */
const baseMetadataArbitrary: fc.Arbitrary<
  Omit<ProjectMetadata, 'projectType' | 'structure' | 'sourceCode' | 'url'>
> = fc.record({
  title: fc.oneof(fc.constant(null), safeTextArbitrary),
  description: fc.oneof(fc.constant(null), safeTextArbitrary),
  widgets: widgetsArbitrary,
  prompts: fc.array(safeTextArbitrary, { maxLength: 3 }),
  widgetCount: fc.integer({ min: 0, max: 12 }),
})

/**
 * Every project type the scorer can see, including the absent one. `undefined`
 * is not a hypothetical: `ProjectMetadata.projectType` is optional, and every
 * pre-feature call site omits it (Requirement 4.4, Property 25).
 */
const projectTypeArbitrary: fc.Arbitrary<ProjectType | undefined> = fc.constantFrom(
  ProjectType.HTML,
  ProjectType.PARTYROCK,
  undefined,
)

const urlArbitrary: fc.Arbitrary<string | null> = fc.constantFrom(
  null,
  'https://recycling.example.com',
  'https://partyrock.aws/app/abc',
  'http://localhost:3000/index.html',
)

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Probe the "structure unavailable" notice's rendered length from a real
  // prompt, so the boundary generators can aim at the right threshold without
  // duplicating a module-private string.
  const prompt = await capturePrompt(
    {
      title: null,
      description: null,
      widgets: [],
      prompts: [],
      widgetCount: 0,
      projectType: ProjectType.HTML,
      structure: null,
      sourceCode: 'x',
      url: null,
    },
    {
      id: 'probe',
      name: 'probe',
      description: null,
      weight: 1,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
    },
  )

  unavailableSectionLength = extractStructureSection(prompt).length
  expect(unavailableSectionLength).toBeGreaterThan(0)
})

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// P23-a — the HTML sections appear if and only if the project type is HTML
// ---------------------------------------------------------------------------

describe('Property 23: P23-a — HTML sections appear iff projectType is HTML', () => {
  /**
   * The iff clause in full. `projectType` and `structure` are generated
   * independently, which is the point: the section must be there for an HTML
   * project whose structure could not be computed, and must stay away from a
   * PartyRock project that happens to carry one. That pins the rule to the
   * *type* rather than to the availability of evidence — a dispatch written as
   * `metadata.structure ? htmlPrompt : partyRockPrompt` would satisfy a test
   * that varied only one of the two.
   *
   * The `undefined` type is folded into the same claim, since Requirement 4.4
   * makes it a PartyRock project.
   *
   * **Validates: Requirements 4.1, 4.2, 4.4**
   */
  it('ties both HTML sections to the project type alone, not to evidence availability', async () => {
    await fc.assert(
      fc.asyncProperty(
        baseMetadataArbitrary,
        projectTypeArbitrary,
        structureArbitrary,
        urlArbitrary,
        fc.oneof(
          fc.constantFrom<string | null | undefined>(null, undefined, '', '   '),
          fc.integer({ min: 1, max: 2000 }).map(markupOfLength),
        ),
        parameterArbitrary,
        async (base, projectType, structure, url, sourceCode, parameter) => {
          const prompt = await capturePrompt(
            { ...base, projectType, structure, sourceCode, url },
            parameter,
          )

          const isHtml = projectType === ProjectType.HTML

          expect(prompt.includes(STRUCTURE_HEADER)).toBe(isHtml)
          expect(prompt.includes(SOURCE_HEADER)).toBe(isHtml)

          // The other branch has to have run — "no HTML section" would also be
          // satisfied by an empty prompt.
          for (const marker of PARTYROCK_MARKERS) {
            expect(prompt.includes(marker)).toBe(!isHtml)
          }
        },
      ),
      { numRuns: 150 },
    )
  })

  /**
   * The same claim stated as an invariance: for a fixed project, attaching or
   * detaching a structure never adds or removes a section. Asserted as a
   * comparison of two prompts rather than as two independent checks, so a rule
   * that flipped on structure availability shows up as a diff.
   *
   * **Validates: Requirements 4.1, 4.2**
   */
  it('keeps section presence unchanged when a structure is attached or detached', async () => {
    await fc.assert(
      fc.asyncProperty(
        baseMetadataArbitrary,
        projectTypeArbitrary,
        presentStructureArbitrary,
        parameterArbitrary,
        async (base, projectType, structure, parameter) => {
          const sourceCode = markupOfLength(500)

          const withStructure = await capturePrompt(
            { ...base, projectType, structure, sourceCode, url: null },
            parameter,
          )
          const withoutStructure = await capturePrompt(
            { ...base, projectType, structure: null, sourceCode, url: null },
            parameter,
          )

          const isHtml = projectType === ProjectType.HTML

          expect(withStructure.includes(STRUCTURE_HEADER)).toBe(isHtml)
          expect(withoutStructure.includes(STRUCTURE_HEADER)).toBe(isHtml)
          expect(withStructure.includes(SOURCE_HEADER)).toBe(isHtml)
          expect(withoutStructure.includes(SOURCE_HEADER)).toBe(isHtml)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// P23-b — the evidence budget spends on the structure summary first
// ---------------------------------------------------------------------------

describe('Property 23: P23-b — structure summary whole, markup truncated, within budget', () => {
  /**
   * The budget clause, as four checks over one captured prompt:
   *
   *   1. the structure summary is byte-identical to `formatStructureForPrompt`,
   *      i.e. it arrives whole no matter how large the markup is;
   *   2. the two evidence blocks together never exceed the budget;
   *   3. a markup excerpt that was cut ends with the truncation marker and is a
   *      genuine prefix of the original;
   *   4. truncation happens exactly when the markup does not fit in what the
   *      summary left over — not according to a flat cap of its own.
   *
   * Check 4 is the one that distinguishes the implemented ordering from the
   * previous behaviour: a 20.000-character cap applied to the markup alone
   * would satisfy 1 and 3, and would break 2 for every structure with a
   * non-empty summary.
   *
   * **Validates: Requirements 4.2, 4.3**
   */
  it('renders the summary in full, charges it first, and truncates only the markup', async () => {
    await fc.assert(
      fc.asyncProperty(
        baseMetadataArbitrary,
        htmlEvidenceArbitrary,
        urlArbitrary,
        parameterArbitrary,
        async (base, { structure, sourceCode }, url, parameter) => {
          const prompt = await capturePrompt(
            { ...base, projectType: ProjectType.HTML, structure, sourceCode, url },
            parameter,
          )

          const structureSection = extractStructureSection(prompt)
          const markupSection = extractSourceSection(prompt)

          // 1. The summary is never cut. For an absent structure the section
          //    carries the notice instead, which must also be complete.
          if (structure) {
            expect(structureSection).toBe(formatStructureForPrompt(structure))
          } else {
            expect(structureSection).toContain('HTML structure unavailable')
          }

          // 2. Combined evidence stays inside the budget.
          expect(structureSection.length + markupSection.length).toBeLessThanOrEqual(
            HTML_EVIDENCE_CHAR_BUDGET,
          )

          const remaining = HTML_EVIDENCE_CHAR_BUDGET - structureSection.length

          if (sourceCode) {
            // 4. Whether the markup survives whole is decided by the leftover
            //    budget, and by nothing else.
            const fits = sourceCode.length <= remaining
            expect(markupSection === sourceCode).toBe(fits)

            if (fits) {
              expect(markupSection.endsWith(HTML_MARKUP_TRUNCATION_MARKER)).toBe(false)
            } else {
              // 3. Marked as an excerpt, and still the head of the original —
              //    a cut must not reorder or rewrite what it keeps.
              expect(markupSection.endsWith(HTML_MARKUP_TRUNCATION_MARKER)).toBe(true)

              const kept = markupSection.slice(
                0,
                markupSection.length - HTML_MARKUP_TRUNCATION_MARKER.length,
              )
              expect(kept.length).toBeGreaterThan(0)
              expect(sourceCode.startsWith(kept)).toBe(true)
            }
          } else {
            // Nothing to excerpt: the block says so rather than going blank.
            expect(markupSection.length).toBeGreaterThan(0)
            expect(markupSection).toContain('no HTML source provided')
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * The marker is charged to the budget, not appended on top of it. Worth its
   * own check because an implementation that sliced to `remaining` and *then*
   * appended the marker would pass every other assertion here while shipping a
   * prompt slightly over budget — and check 2 above would only catch it when
   * the marker's length happened to matter.
   *
   * **Validates: Requirements 4.3**
   */
  it('counts the truncation marker inside the budget', async () => {
    await fc.assert(
      fc.asyncProperty(
        presentStructureArbitrary,
        fc.integer({ min: 20_001, max: 120_000 }).map(markupOfLength),
        parameterArbitrary,
        async (structure, sourceCode, parameter) => {
          const prompt = await capturePrompt(
            {
              title: null,
              description: null,
              widgets: [],
              prompts: [],
              widgetCount: 0,
              projectType: ProjectType.HTML,
              structure,
              sourceCode,
              url: null,
            },
            parameter,
          )

          const summary = formatStructureForPrompt(structure)
          const markupSection = extractSourceSection(prompt)

          // Every one of these inputs is over budget, so the excerpt is exactly
          // the leftover allowance — marker included.
          expect(markupSection.length).toBe(HTML_EVIDENCE_CHAR_BUDGET - summary.length)
          expect(markupSection.endsWith(HTML_MARKUP_TRUNCATION_MARKER)).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// P23-c — priority monotonicity: more markup never costs structure
// ---------------------------------------------------------------------------

describe('Property 23: P23-c — growing the markup never shrinks the structure summary', () => {
  /**
   * Requirement 4.3 at its core: the structure summary outranks the raw markup,
   * so the amount of markup available cannot influence it. Two prompts are
   * built over the same structure — one with a small excerpt, one with a page
   * far past the budget — and the structure section is compared byte for byte.
   *
   * The second assertion is the stronger one: with the markup body masked out,
   * the two prompts are identical. That says the markup's only effect anywhere
   * in the prompt is on its own block. An implementation that dropped headings
   * from the summary, or trimmed metadata, or reordered the blocks under
   * pressure would fail it — and a summary that merely stayed the same *length*
   * would not slip through.
   *
   * **Validates: Requirements 4.2, 4.3**
   */
  it('produces an identical prompt outside the markup block for small and huge markup', async () => {
    await fc.assert(
      fc.asyncProperty(
        baseMetadataArbitrary,
        presentStructureArbitrary,
        fc.integer({ min: 0, max: 4000 }),
        fc.integer({ min: 60_000, max: 200_000 }),
        urlArbitrary,
        parameterArbitrary,
        async (base, structure, smallSize, hugeSize, url, parameter) => {
          const metadata = {
            ...base,
            projectType: ProjectType.HTML,
            structure,
            url,
          }

          const smallPrompt = await capturePrompt(
            { ...metadata, sourceCode: markupOfLength(smallSize) },
            parameter,
          )
          const hugePrompt = await capturePrompt(
            { ...metadata, sourceCode: markupOfLength(hugeSize) },
            parameter,
          )

          const summary = formatStructureForPrompt(structure)

          expect(extractStructureSection(smallPrompt)).toBe(summary)
          expect(extractStructureSection(hugePrompt)).toBe(summary)
          expect(withMarkupBodyMasked(hugePrompt)).toBe(withMarkupBodyMasked(smallPrompt))

          // Sanity on the setup: the huge case really is the over-budget one,
          // otherwise the comparison above is vacuous.
          expect(
            extractSourceSection(hugePrompt).endsWith(HTML_MARKUP_TRUNCATION_MARKER),
          ).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })

  /**
   * Monotonicity across a whole ladder of sizes, rather than between two
   * points: as the markup grows past the budget the summary stays fixed and the
   * markup block never grows beyond its allowance. Pressure is applied
   * gradually, which is where an off-by-one in the leftover arithmetic surfaces.
   *
   * **Validates: Requirements 4.3**
   */
  it('holds the summary fixed across an increasing ladder of markup sizes', async () => {
    await fc.assert(
      fc.asyncProperty(
        presentStructureArbitrary,
        parameterArbitrary,
        async (structure, parameter) => {
          const summary = formatStructureForPrompt(structure)
          const remaining = HTML_EVIDENCE_CHAR_BUDGET - summary.length

          let previousMarkupLength = -1

          for (const size of [
            0,
            1,
            remaining - 1,
            remaining,
            remaining + 1,
            remaining * 3,
            150_000,
          ]) {
            const prompt = await capturePrompt(
              {
                title: null,
                description: null,
                widgets: [],
                prompts: [],
                widgetCount: 0,
                projectType: ProjectType.HTML,
                structure,
                sourceCode: markupOfLength(size),
                url: null,
              },
              parameter,
            )

            expect(extractStructureSection(prompt)).toBe(summary)

            const markupLength = extractSourceSection(prompt).length
            expect(markupLength).toBeLessThanOrEqual(remaining)

            // `size = 0` yields the "no source" notice, which is not part of
            // the ladder; from the first real excerpt onwards the block may
            // only grow, up to its allowance.
            if (size > 0) {
              if (previousMarkupLength >= 0) {
                expect(markupLength).toBeGreaterThanOrEqual(previousMarkupLength)
              }
              previousMarkupLength = markupLength
            }
          }
        },
      ),
      { numRuns: 40 },
    )
  })
})

// ---------------------------------------------------------------------------
// P23-d — the PartyRock prompt is untouched by the new fields
// ---------------------------------------------------------------------------

describe('Property 23: P23-d — PartyRock prompts ignore structure and url entirely', () => {
  /**
   * Requirement 4.4: the PartyRock template keeps working exactly as before, so
   * the fields this feature added must be inert on that path. Three prompts are
   * captured for the same project — one with `structure` and `url` attached, one
   * with both cleared, one with `projectType` omitted altogether — and all three
   * must be the same string.
   *
   * String equality is the right assertion here rather than a set of
   * `not.toContain` probes: it also rules out the subtler regressions, such as a
   * new field leaking into the comparison section or a whitespace change in the
   * template.
   *
   * **Validates: Requirements 4.4**
   */
  it('produces the same prompt whether or not structure and url are present', async () => {
    await fc.assert(
      fc.asyncProperty(
        baseMetadataArbitrary,
        presentStructureArbitrary,
        fc.oneof(
          fc.constantFrom<string | null>(null, ''),
          fc.integer({ min: 1, max: 3000 }).map(markupOfLength),
        ),
        parameterArbitrary,
        async (base, structure, sourceCode, parameter) => {
          const bare = await capturePrompt(
            {
              ...base,
              projectType: ProjectType.PARTYROCK,
              sourceCode,
              structure: null,
              url: null,
            },
            parameter,
          )

          const enriched = await capturePrompt(
            {
              ...base,
              projectType: ProjectType.PARTYROCK,
              sourceCode,
              structure,
              url: 'https://partyrock.aws/app/abc',
            },
            parameter,
          )

          // Legacy shape: no projectType key at all.
          const legacy = await capturePrompt({ ...base, sourceCode }, parameter)

          expect(enriched).toBe(bare)
          expect(legacy).toBe(bare)

          for (const header of [STRUCTURE_HEADER, SOURCE_HEADER]) {
            expect(bare).not.toContain(header)
          }
          expect(bare).not.toContain('partyrock.aws/app/abc')
        },
      ),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// P23-e — the HTML prompt is always usable: evidence present, contract correct
// ---------------------------------------------------------------------------

describe('Property 23: P23-e — the HTML prompt always carries evidence and its parameter contract', () => {
  /**
   * Two things that must hold for every HTML prompt regardless of how thin the
   * evidence is.
   *
   * The structure section is never blank: either metrics or the explicit
   * "unavailable" notice. An empty block would read to the model as a document
   * with no structure at all — a silent penalty for what is really a failed
   * fetch, and the reason the notice exists.
   *
   * And the parameter block carries the range that was asked for, in both places
   * the prompt states it. The range travels with the parameter, not with the
   * project type (Requirement 4.5), so a template that hardcoded 0–100 anywhere
   * would invite out-of-range scores that only the clamp would catch.
   *
   * **Validates: Requirements 4.1, 4.2**
   */
  it('never emits an empty structure block and always states the parameter range', async () => {
    await fc.assert(
      fc.asyncProperty(
        baseMetadataArbitrary,
        htmlEvidenceArbitrary,
        parameterArbitrary,
        async (base, { structure, sourceCode }, parameter) => {
          const prompt = await capturePrompt(
            {
              ...base,
              projectType: ProjectType.HTML,
              structure,
              sourceCode,
              url: null,
            },
            parameter,
          )

          expect(extractStructureSection(prompt).trim().length).toBeGreaterThan(0)

          expect(prompt).toContain(PARAMETER_HEADER)
          expect(prompt).toContain(`Name: ${parameter.name}`)
          expect(prompt).toContain(
            `Score range: ${parameter.minScore} to ${parameter.maxScore}`,
          )
          expect(prompt).toContain(
            `between ${parameter.minScore} and ${parameter.maxScore}`,
          )
        },
      ),
      { numRuns: 150 },
    )
  })
})
