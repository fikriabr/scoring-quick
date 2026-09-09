/**
 * Property-Based Tests: Property 25 — Backward Compatibility Of Existing Projects
 *
 * **Validates: Requirements 1.2, 8.1, 8.2, 8.3**
 *
 * Property 25 (from design.md):
 *   For any project record created without an explicit project type, reading it
 *   back SHALL yield `projectType = PARTYROCK`, and its crawl, capture, scoring,
 *   jury, and export behaviour SHALL be indistinguishable from the behaviour
 *   before this feature was introduced. Existing `AIScore` and `finalScore`
 *   values SHALL remain unchanged by the schema migration.
 *
 * Three testing strategies are used:
 *
 * 1. **Schema default, verified against the real Prisma datamodel**:
 *    `Prisma.dmmf` is the datamodel the generated client was built from, so the
 *    default is read from the schema itself rather than hardcoded here. An
 *    in-memory Prisma double replays what PostgreSQL does on INSERT (absent
 *    columns receive their schema default), which lets the create → read-back
 *    round trip be exercised without a database.
 *
 * 2. **Dispatch on an absent project type**:
 *    `ProjectMetadata.projectType` is optional, so legacy call sites pass
 *    `undefined`. The prompt actually handed to Gemini is captured (Gemini is
 *    mocked) and compared against the prompt produced by legacy-shaped
 *    metadata — byte-identical means the PartyRock path was taken and the new
 *    optional fields changed nothing.
 *
 * 3. **Score invariance across the migration**:
 *    Stored `finalScore` and `AIScore` values survive the round trip unchanged,
 *    and `calculateWeightedScore` over the read-back values returns exactly the
 *    same number as before the new columns existed.
 *
 * Deferred coverage — the type-dispatching production code does not exist yet:
 *   - The HTML half of the dispatch rule (`projectType === 'HTML'` selects the
 *     HTML prompt) belongs to task 7.1 and is covered by Property 23 / task 7.4.
 *   - Crawl, capture, jury, and export dispatch (tasks 6.x, 9.x, 10.x) have no
 *     type-aware branch yet; once they do, the "indistinguishable behaviour"
 *     clause should be extended to them.
 *   `takesHtmlPath` below mirrors the dispatch rule stated in the design so the
 *   `undefined → PartyRock` half is pinned down now; it should be replaced by
 *   the production helper when task 7.1 lands.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fc from 'fast-check'
import { Prisma, ProjectType } from '@prisma/client'
import type {
  HtmlStructure,
  ProjectMetadata,
  ScoringParameter,
  WidgetInfo,
} from '@/types'

// ---------------------------------------------------------------------------
// Mock all dependencies BEFORE importing the services under test.
// 1. @google/generative-ai — no real Gemini calls; also lets us capture the
//    exact prompt string that was built.
// 2. @/lib/db — prevents PrismaClient instantiation (no driver adapter in the
//    test env). The in-memory project/AIScore doubles below stand in for the
//    rows themselves.
// 3. next/cache — revalidatePath is imported at module level by the scorer.
// ---------------------------------------------------------------------------

const { mockGenerateContent } = vi.hoisted(() => {
  const mockGenerateContent = vi.fn()
  return { mockGenerateContent }
})

vi.mock('@google/generative-ai', () => {
  class MockGoogleGenerativeAI {
    constructor(_apiKey: string) { }
    getGenerativeModel(_config: unknown) {
      return { generateContent: mockGenerateContent }
    }
  }
  return { GoogleGenerativeAI: MockGoogleGenerativeAI }
})

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    project: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    crawlMetadata: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    aIScore: {
      upsert: vi.fn(),
      findMany: vi.fn(),
    },
    category: {
      findUnique: vi.fn(),
    },
  },
}))

import { ScorerService } from '@/lib/services/scorer.service'
import { calculateWeightedScore } from '@/lib/services/leaderboard.service'

// ---------------------------------------------------------------------------
// Prisma datamodel access — the schema is the source of truth for the default
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

const projectModel = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Project')!
const projectTypeField = projectModel.fields.find((f) => f.name === 'projectType')!
const projectTypeEnum = Prisma.dmmf.datamodel.enums.find((e) => e.name === 'ProjectType')!

/** Column names that already existed before this feature — must round trip untouched. */
const PRE_FEATURE_PROJECT_COLUMNS = [
  'id',
  'categoryId',
  'url',
  'participantName',
  'teamName',
  'sourceCode',
  'crawlStatus',
  'crawlError',
  'scoreStatus',
  'finalScore',
] as const

// ---------------------------------------------------------------------------
// In-memory Prisma doubles
// ---------------------------------------------------------------------------

/**
 * Replays the part of an INSERT that Property 25 depends on: any column absent
 * from the payload receives its schema default. Defaults are read from the
 * generated datamodel, so a schema change that drops `@default(PARTYROCK)`
 * makes these tests fail. Function defaults (`cuid()`, `now()`) carry an object
 * default and are skipped — they are irrelevant here.
 */
function applySchemaDefaults(data: Row): Row {
  const row: Row = { ...data }
  for (const field of projectModel.fields) {
    if (row[field.name] !== undefined) continue
    if (!field.hasDefaultValue) continue
    const def = field.default
    if (typeof def === 'string' || typeof def === 'number' || typeof def === 'boolean') {
      row[field.name] = def
    }
  }
  return row
}

/** Minimal `db.project` double: create applies schema defaults, findUnique reads back. */
function createFakeProjectStore() {
  const rows = new Map<string, Row>()
  let seq = 0

  return {
    async create(data: Row): Promise<Row> {
      const id = typeof data.id === 'string' ? data.id : `project-${++seq}`
      const row = applySchemaDefaults({ ...data, id })
      rows.set(id, { ...row })
      return { ...row }
    },
    async findUnique(id: string): Promise<Row | null> {
      const row = rows.get(id)
      return row ? { ...row } : null
    },
  }
}

/** Minimal `db.aIScore` double — AIScore gained no new columns in this feature. */
function createFakeAiScoreStore() {
  const rows: Row[] = []

  return {
    async createMany(data: Row[]): Promise<void> {
      rows.push(...data.map((r) => ({ ...r })))
    },
    async findMany(projectId: string): Promise<Row[]> {
      return rows.filter((r) => r.projectId === projectId).map((r) => ({ ...r }))
    },
  }
}

let projectStore: ReturnType<typeof createFakeProjectStore>
let aiScoreStore: ReturnType<typeof createFakeAiScoreStore>

beforeEach(() => {
  vi.clearAllMocks()
  projectStore = createFakeProjectStore()
  aiScoreStore = createFakeAiScoreStore()
})

// ---------------------------------------------------------------------------
// Dispatch rule mirror (see the "Deferred coverage" note in the file header)
// ---------------------------------------------------------------------------

/**
 * The dispatch rule as stated in design.md: the HTML path is taken if and only
 * if the project type is `HTML`. An absent project type is therefore a
 * PartyRock project.
 */
function takesHtmlPath(metadata: ProjectMetadata): boolean {
  return metadata.projectType === ProjectType.HTML
}

// ---------------------------------------------------------------------------
// Prompt capture helper
// ---------------------------------------------------------------------------

const BASE_PARAMETER: ScoringParameter = {
  id: 'param-1',
  name: 'Creativity & Originality',
  description: 'Semantic similarity analysis',
  weight: 30,
  minScore: 0,
  maxScore: 100,
  scoringMode: 'AUTO',
}

/** Runs the scorer with Gemini mocked and returns the prompt it was handed. */
async function capturePrompt(
  metadata: ProjectMetadata,
  contextProjects: ProjectMetadata[] = [],
): Promise<string> {
  mockGenerateContent.mockResolvedValueOnce({
    response: { text: () => JSON.stringify({ score: 50, reasoning: 'ok' }) },
  })

  await ScorerService.scoreParameter(metadata, BASE_PARAMETER, contextProjects)

  const lastCall = mockGenerateContent.mock.calls.at(-1)
  expect(lastCall).toBeDefined()
  return String(lastCall?.[0])
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const cuidLikeArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-z0-9]{8,20}$/)

const widgetInfoArb: fc.Arbitrary<WidgetInfo> = fc.record({
  type: fc.stringMatching(/^[a-z][a-z0-9\-]{0,20}$/),
  label: fc.oneof(fc.constant(''), fc.string({ minLength: 1, maxLength: 50 })),
})

const widgetsArb: fc.Arbitrary<WidgetInfo[]> = fc.array(widgetInfoArb, {
  minLength: 0,
  maxLength: 6,
})

const promptsArb: fc.Arbitrary<string[]> = fc.array(
  fc.string({ minLength: 1, maxLength: 120 }),
  { minLength: 0, maxLength: 4 },
)

/** A project row as it would have been written before this feature existed. */
const legacyProjectCreateInputArb: fc.Arbitrary<Row> = fc.record({
  categoryId: cuidLikeArb,
  url: fc
    .stringMatching(/^[a-z0-9\-]{3,20}$/)
    .map((slug) => `https://partyrock.aws/app/${slug}`),
  participantName: fc.string({ minLength: 1, maxLength: 60 }),
  teamName: fc.option(fc.string({ minLength: 1, maxLength: 60 }), { nil: null }),
  sourceCode: fc.option(fc.string({ minLength: 1, maxLength: 400 }), { nil: null }),
  crawlStatus: fc.constantFrom('PENDING', 'SUCCESS', 'FAILED'),
  crawlError: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: null }),
  scoreStatus: fc.constantFrom('PENDING', 'PARTIAL', 'SUCCESS', 'FAILED'),
  finalScore: fc.option(
    fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
    { nil: null },
  ),
})

/** Metadata in its pre-feature shape: no `projectType`, no `structure`. */
const legacyMetadataArb: fc.Arbitrary<ProjectMetadata> = fc
  .record({
    title: fc.option(fc.string({ minLength: 1, maxLength: 80 }), { nil: null }),
    description: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: null }),
    widgets: widgetsArb,
    prompts: promptsArb,
    sourceCode: fc.option(fc.string({ minLength: 1, maxLength: 400 }), { nil: null }),
  })
  .map((m) => ({ ...m, widgetCount: m.widgets.length }))

const ratioArb = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true })
const countArb = fc.integer({ min: 0, max: 50 })

/** A populated `HtmlStructure` — used to prove the new field changes nothing. */
const htmlStructureArb: fc.Arbitrary<HtmlStructure> = fc.record({
  headings: fc.array(
    fc.record({
      level: fc.integer({ min: 1, max: 6 }),
      text: fc.string({ minLength: 1, maxLength: 40 }),
    }),
    { maxLength: 5 },
  ),
  headingCount: countArb,
  hasSingleH1: fc.boolean(),
  headingHierarchyValid: fc.boolean(),
  semanticElementCount: countArb,
  genericElementCount: countArb,
  semanticRatio: ratioArb,
  landmarks: fc.array(fc.constantFrom('banner', 'navigation', 'main', 'contentinfo'), {
    maxLength: 4,
  }),
  ariaAttributeCount: countArb,
  hasSkipLink: fc.boolean(),
  imageCount: countArb,
  imagesWithAlt: countArb,
  altTextRatio: ratioArb,
  formFieldCount: countArb,
  labelledFormFields: countArb,
  formLabelRatio: ratioArb,
  totalElementCount: countArb,
  maxDomDepth: countArb,
  scriptCount: countArb,
  inlineStyleCount: countArb,
  externalStylesheetCount: countArb,
  documentTitle: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: null }),
  metaDescription: fc.option(fc.string({ minLength: 1, maxLength: 80 }), { nil: null }),
  langAttribute: fc.option(fc.constantFrom('en', 'id'), { nil: null }),
  hasViewportMeta: fc.boolean(),
})

/** Stored AI scores paired with their parameter weights, summing to 100. */
const storedAiScoresArb: fc.Arbitrary<
  Array<{ parameterId: string; score: number; reasoning: string; weight: number }>
> = fc.integer({ min: 1, max: 5 }).chain((n) =>
  fc
    .tuple(
      fc.array(fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }), {
        minLength: n,
        maxLength: n,
      }),
      fc.array(fc.string({ minLength: 1, maxLength: 60 }), { minLength: n, maxLength: n }),
    )
    .map(([scores, reasonings]) =>
      scores.map((score, i) => ({
        parameterId: `param-${i}`,
        score,
        reasoning: reasonings[i],
        weight: 100 / n,
      })),
    ),
)

// ---------------------------------------------------------------------------
// Part 1: schema default — a project written without a project type is PartyRock
// ---------------------------------------------------------------------------

describe('Property 25 (schema default): absent projectType reads back as PARTYROCK', () => {
  /**
   * P25-a: The Prisma datamodel itself declares `PARTYROCK` as the default for
   * `Project.projectType`, and the enum is limited to PARTYROCK | HTML. This is
   * what makes stored rows valid without a data migration.
   *
   * **Validates: Requirements 1.2, 8.1**
   */
  it('P25-a — Project.projectType SHALL default to PARTYROCK in the datamodel [**Validates: Requirements 1.2, 8.1**]', () => {
    expect(projectTypeField.type).toBe('ProjectType')
    expect(projectTypeField.isRequired).toBe(true)
    expect(projectTypeField.hasDefaultValue).toBe(true)
    expect(projectTypeField.default).toBe(ProjectType.PARTYROCK)
    expect(projectTypeEnum.values.map((v) => v.name)).toEqual(['PARTYROCK', 'HTML'])
  })

  /**
   * P25-b: For any project created without an explicit projectType, reading it
   * back yields PARTYROCK, and every pre-feature column round trips unchanged.
   *
   * **Validates: Requirements 1.2, 8.1, 8.3**
   */
  it('P25-b — create without projectType then read back SHALL yield PARTYROCK and leave existing columns untouched [**Validates: Requirements 1.2, 8.1, 8.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(legacyProjectCreateInputArb, async (input) => {
        const store = createFakeProjectStore()

        const created = await store.create(input)
        const readBack = await store.findUnique(created.id as string)

        expect(readBack).not.toBeNull()
        expect(readBack?.projectType).toBe(ProjectType.PARTYROCK)

        for (const column of PRE_FEATURE_PROJECT_COLUMNS) {
          if (column === 'id') continue
          expect(Object.is(readBack?.[column], input[column])).toBe(true)
        }
      }),
      { numRuns: 300 },
    )
  })

  /**
   * P25-c: An explicit projectType is never overwritten by the default — the
   * default only fills in absent values.
   *
   * **Validates: Requirements 1.2**
   */
  it('P25-c — an explicitly provided projectType SHALL be preserved [**Validates: Requirements 1.2**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        legacyProjectCreateInputArb,
        fc.constantFrom(ProjectType.PARTYROCK, ProjectType.HTML),
        async (input, projectType) => {
          const store = createFakeProjectStore()

          const created = await store.create({ ...input, projectType })
          const readBack = await store.findUnique(created.id as string)

          expect(readBack?.projectType).toBe(projectType)
        },
      ),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Part 2: an absent projectType dispatches to the PartyRock path
// ---------------------------------------------------------------------------

describe('Property 25 (dispatch): undefined projectType behaves as PARTYROCK', () => {
  /**
   * P25-d: For any metadata whose projectType is absent or PARTYROCK, the HTML
   * path is not taken. `undefined` must fall through to PartyRock, not HTML.
   *
   * **Validates: Requirements 1.2, 8.1**
   */
  it('P25-d — metadata without projectType SHALL NOT take the HTML path [**Validates: Requirements 1.2, 8.1**]', () => {
    fc.assert(
      fc.property(legacyMetadataArb, htmlStructureArb, (metadata, structure) => {
        expect(metadata.projectType).toBeUndefined()
        expect(takesHtmlPath(metadata)).toBe(false)

        // Even with a structure attached, an absent type stays PartyRock.
        expect(takesHtmlPath({ ...metadata, structure })).toBe(false)
        expect(takesHtmlPath({ ...metadata, projectType: ProjectType.PARTYROCK })).toBe(false)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * P25-e: The prompt handed to the AI scorer for metadata without a
   * projectType is byte-identical to the prompt for the same metadata with
   * projectType explicitly PARTYROCK, and identical again when the new
   * `structure` field is populated. The new optional fields therefore cannot
   * change scoring behaviour for pre-existing projects.
   *
   * **Validates: Requirements 8.2, 8.3**
   */
  it('P25-e — prompt for absent projectType SHALL equal the PARTYROCK prompt, with or without structure [**Validates: Requirements 8.2, 8.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        legacyMetadataArb,
        htmlStructureArb,
        async (metadata, structure) => {
          const legacyPrompt = await capturePrompt(metadata)
          const explicitPartyRockPrompt = await capturePrompt({
            ...metadata,
            projectType: ProjectType.PARTYROCK,
          })
          const withStructurePrompt = await capturePrompt({ ...metadata, structure })

          expect(explicitPartyRockPrompt).toBe(legacyPrompt)
          expect(withStructurePrompt).toBe(legacyPrompt)
        },
      ),
      { numRuns: 60 },
    )
  })

  /**
   * P25-f: The prompt built for metadata without a projectType is the PartyRock
   * prompt — it carries the PartyRock framing and no HTML structure section.
   *
   * **Validates: Requirements 8.2**
   */
  it('P25-f — prompt for absent projectType SHALL be the PartyRock prompt with no HTML structure section [**Validates: Requirements 8.2**]', async () => {
    await fc.assert(
      fc.asyncProperty(legacyMetadataArb, async (metadata) => {
        const prompt = await capturePrompt(metadata)

        expect(prompt).toContain('built on AWS PartyRock')
        expect(prompt).not.toContain('## HTML Structure')
      }),
      { numRuns: 60 },
    )
  })
})

// ---------------------------------------------------------------------------
// Part 3: stored scores are unchanged by the migration
// ---------------------------------------------------------------------------

describe('Property 25 (score invariance): stored AIScore and finalScore survive the migration', () => {
  /**
   * P25-g: For any stored AI scores and finalScore, writing the project through
   * the migrated schema (new columns present, projectType defaulted) and reading
   * everything back yields the exact same values, and recomputing the weighted
   * score from the read-back rows returns exactly the pre-migration number.
   *
   * **Validates: Requirements 8.3**
   */
  it('P25-g — AIScore and finalScore round trip unchanged and the weighted score is identical [**Validates: Requirements 8.3**]', async () => {
    await fc.assert(
      fc.asyncProperty(
        legacyProjectCreateInputArb,
        storedAiScoresArb,
        async (input, storedScores) => {
          const scoreBeforeMigration = calculateWeightedScore(
            storedScores.map(({ score, weight }) => ({ score, weight })),
          )

          const created = await projectStore.create({
            ...input,
            finalScore: scoreBeforeMigration,
          })
          const projectId = created.id as string

          await aiScoreStore.createMany(
            storedScores.map(({ parameterId, score, reasoning }) => ({
              projectId,
              parameterId,
              score,
              reasoning,
            })),
          )

          const readBack = await projectStore.findUnique(projectId)
          const readBackScores = await aiScoreStore.findMany(projectId)

          // New column present, existing values untouched.
          expect(readBack?.projectType).toBe(ProjectType.PARTYROCK)
          expect(readBack?.finalScore).toBe(scoreBeforeMigration)

          expect(readBackScores).toHaveLength(storedScores.length)
          storedScores.forEach((stored, i) => {
            expect(readBackScores[i].score).toBe(stored.score)
            expect(readBackScores[i].reasoning).toBe(stored.reasoning)
            expect(readBackScores[i].parameterId).toBe(stored.parameterId)
          })

          // Recomputation from the read-back rows is bit-identical.
          const scoreAfterMigration = calculateWeightedScore(
            readBackScores.map((row, i) => ({
              score: row.score as number,
              weight: storedScores[i].weight,
            })),
          )
          expect(scoreAfterMigration).toBe(scoreBeforeMigration)
        },
      ),
      { numRuns: 200 },
    )
  })

  /**
   * P25-h: `calculateWeightedScore` ignores anything but score and weight —
   * attaching the new projectType/structure fields to the surrounding records
   * cannot move the result.
   *
   * **Validates: Requirements 8.3**
   */
  it('P25-h — weighted score SHALL be unaffected by the new project fields [**Validates: Requirements 8.3**]', () => {
    fc.assert(
      fc.property(storedAiScoresArb, htmlStructureArb, (storedScores, structure) => {
        const pairs = storedScores.map(({ score, weight }) => ({ score, weight }))
        const augmented = storedScores.map(({ score, weight }) => ({
          score,
          weight,
          projectType: ProjectType.PARTYROCK,
          structure,
        }))

        expect(calculateWeightedScore(augmented)).toBe(calculateWeightedScore(pairs))
      }),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Deterministic edge-case unit tests (complement the property tests)
// ---------------------------------------------------------------------------

describe('Property 25: Backward Compatibility — deterministic edge cases', () => {
  it('a project row with only the pre-feature columns is readable and PartyRock', async () => {
    const created = await projectStore.create({
      categoryId: 'category-1',
      url: 'https://partyrock.aws/app/legacy-app',
      participantName: 'Legacy User',
      teamName: null,
      sourceCode: null,
      crawlError: null,
      finalScore: 84,
    })

    const readBack = await projectStore.findUnique(created.id as string)

    expect(readBack?.projectType).toBe(ProjectType.PARTYROCK)
    // Untouched pre-feature defaults still apply.
    expect(readBack?.crawlStatus).toBe('PENDING')
    expect(readBack?.scoreStatus).toBe('PENDING')
    expect(readBack?.finalScore).toBe(84)
    // The new structure column lives on CrawlMetadata, not Project.
    expect(readBack).not.toHaveProperty('structure')
  })

  it('a null finalScore stays null after the round trip', async () => {
    const created = await projectStore.create({
      categoryId: 'category-1',
      url: 'https://partyrock.aws/app/unscored',
      participantName: 'Unscored User',
      finalScore: null,
    })

    const readBack = await projectStore.findUnique(created.id as string)

    expect(readBack?.finalScore).toBeNull()
    expect(readBack?.projectType).toBe(ProjectType.PARTYROCK)
  })

  it('CrawlMetadata.structure is optional, so existing metadata rows stay valid', () => {
    const crawlMetadataModel = Prisma.dmmf.datamodel.models.find(
      (m) => m.name === 'CrawlMetadata',
    )!
    const structureField = crawlMetadataModel.fields.find((f) => f.name === 'structure')!

    expect(structureField.isRequired).toBe(false)
    expect(structureField.type).toBe('Json')
  })

  it('legacy metadata without projectType produces the PartyRock prompt', async () => {
    const metadata: ProjectMetadata = {
      title: 'Legacy App',
      description: 'Built before HTML support existed',
      widgets: [{ type: 'text-input', label: 'Topic' }],
      prompts: ['Write a story about {{topic}}'],
      widgetCount: 1,
      sourceCode: '<widget>legacy</widget>',
    }

    const prompt = await capturePrompt(metadata)

    expect(prompt).toContain('built on AWS PartyRock')
    expect(prompt).toContain('Legacy App')
    expect(prompt).not.toContain('## HTML Structure')
    expect(takesHtmlPath(metadata)).toBe(false)
  })

  it('the known 5-parameter PartyRock template still yields the same weighted score', () => {
    const pairs = [
      { score: 85, weight: 20 },
      { score: 90, weight: 25 },
      { score: 75, weight: 20 },
      { score: 80, weight: 20 },
      { score: 70, weight: 15 },
    ]
    const expected = (85 * 20 + 90 * 25 + 75 * 20 + 80 * 20 + 70 * 15) / 100

    expect(calculateWeightedScore(pairs)).toBeCloseTo(expected, 10)
  })
})
