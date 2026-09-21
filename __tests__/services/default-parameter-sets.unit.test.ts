/**
 * Unit Tests: default parameter set (IDEA_HTML)
 *
 *   - Each track (IDEA, HTML) of the default set totals exactly 100% weight.
 *   - The caller may load it explicitly or via the default argument.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock the Prisma db singleton BEFORE importing the service under test.
// ---------------------------------------------------------------------------
vi.mock('@/lib/db', () => {
  const db = {
    // `loadDefaultParameters` reconciles the category's parameters with the
    // template: matching rows are updated in place (keeping their scores),
    // unmatched rows are deleted with their AI scores, the rest created.
    parameter: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    juryScore: { findMany: vi.fn() },
    aIScore: { deleteMany: vi.fn() },
  }
  return { db, prisma: db }
})

vi.mock('@/lib/services/final-score.service', () => ({
  recalculateCategoryScores: vi.fn(),
  recalculateProjectScores: vi.fn(),
}))

// The server action pulls in NextAuth and the Next cache; both are stubbed so
// the validation path can be exercised without a request context.
vi.mock('@/lib/auth/config', () => ({
  auth: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { db } from '@/lib/db'
import { auth } from '@/lib/auth/config'
import {
  DEFAULT_PARAMETER_SETS,
  DEFAULT_PARAMETER_SET_NAMES,
  getDefaultParameterSet,
  isDefaultParameterSet,
  loadDefaultParameters,
  type DefaultParameterSet,
} from '@/lib/services/category.service'
import { ParametersHaveJuryScoresError } from '@/lib/services/parameter.service'
import { recalculateCategoryScores } from '@/lib/services/final-score.service'
import { loadDefaultParametersAction } from '@/actions/parameter.actions'

const mockDeleteMany = vi.mocked(db.parameter.deleteMany)
const mockCreate = vi.mocked(db.parameter.create)
const mockUpdate = vi.mocked(db.parameter.update)
const mockFindMany = vi.mocked(db.parameter.findMany)
const mockJuryFindMany = vi.mocked(db.juryScore.findMany)
const mockAiDeleteMany = vi.mocked(db.aIScore.deleteMany)
const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>

/** An existing parameter row, as `parameter.findMany` returns it. */
function existingParam(id: string, name: string, track: 'IDEA' | 'HTML' = 'HTML') {
  return {
    id, name, track, categoryId: 'cat', description: null, weight: 20,
    minScore: 0, maxScore: 100, scoringMode: 'AUTO', orderIndex: 0,
    createdAt: new Date(), updatedAt: new Date(),
  }
}

/**
 * An existing, already-scored category: two rows that the template still has
 * (same name and track) and two that it no longer has.
 */
const LEGACY_HTML_SET = [
  existingParam('old-semantic', 'Semantic HTML & Structure'),
  existingParam('old-flow', 'Information Flow'),
  existingParam('old-content', 'Content Quality & Specificity'),
  existingParam('old-impact', 'Impact & Scalability'),
]

/** The `data` object from every individual `create` call, in call order. */
function seededParameters(): Array<Record<string, unknown>> {
  return mockCreate.mock.calls.map(
    (call) => (call[0] as { data: Record<string, unknown> }).data,
  )
}

/** Echoes back `args.data` as the "created" row — enough for these tests, which only inspect what was passed to `create`. */
const fakeCreate = (async (args: unknown) =>
  (args as { data: unknown }).data) as unknown as typeof db.parameter.create

beforeEach(() => {
  vi.clearAllMocks()
  mockDeleteMany.mockResolvedValue({ count: 0 })
  mockCreate.mockImplementation(fakeCreate)
  mockUpdate.mockImplementation(fakeCreate as unknown as typeof db.parameter.update)
  mockFindMany.mockResolvedValue([] as never)
  mockJuryFindMany.mockResolvedValue([] as never)
  mockAiDeleteMany.mockResolvedValue({ count: 0 } as never)
  mockAuth.mockResolvedValue({ user: { role: 'ADMIN' } })
})

describe('default parameter sets — total weight', () => {
  it.each(DEFAULT_PARAMETER_SET_NAMES)(
    'set %s totals exactly 100 percent weight in each track',
    (set) => {
      for (const track of ['IDEA', 'HTML'] as const) {
        const total = DEFAULT_PARAMETER_SETS[set]
          .filter((p) => p.track === track)
          .reduce((sum, p) => sum + p.weight, 0)
        expect(total).toBe(100)
      }
    },
  )

  it('exposes exactly the IDEA_HTML set', () => {
    expect([...DEFAULT_PARAMETER_SET_NAMES]).toEqual(['IDEA_HTML'])
  })

  it('getDefaultParameterSet returns 5 IDEA + 5 HTML parameters', () => {
    for (const set of DEFAULT_PARAMETER_SET_NAMES) {
      const parameters = getDefaultParameterSet(set)
      expect(parameters.filter((p) => p.track === 'IDEA')).toHaveLength(5)
      expect(parameters.filter((p) => p.track === 'HTML')).toHaveLength(5)
    }
  })
})

describe('loadDefaultParameters — IDEA_HTML set', () => {
  it('seeds the IDEA and HTML parameters with the specified names and weights', async () => {
    await loadDefaultParameters('cat_html', 'IDEA_HTML')

    const data = seededParameters()
    expect(data).toHaveLength(10)
    expect(
      data.map((p) => ({
        name: p.name,
        weight: p.weight,
        track: p.track,
        orderIndex: p.orderIndex,
      })),
    ).toEqual([
      { name: 'Problem & Relevance', weight: 25, track: 'IDEA', orderIndex: 0 },
      { name: 'Originality & Innovation', weight: 25, track: 'IDEA', orderIndex: 1 },
      { name: 'Feasibility', weight: 20, track: 'IDEA', orderIndex: 2 },
      { name: 'Impact & Scalability', weight: 20, track: 'IDEA', orderIndex: 3 },
      { name: 'Clarity of Idea', weight: 10, track: 'IDEA', orderIndex: 4 },
      { name: 'Idea Communication', weight: 25, track: 'HTML', orderIndex: 5 },
      { name: 'Content Quality & Specificity', weight: 25, track: 'HTML', orderIndex: 6 },
      { name: 'Page Completeness', weight: 20, track: 'HTML', orderIndex: 7 },
      { name: 'Information Flow', weight: 15, track: 'HTML', orderIndex: 8 },
      { name: 'Presentation Polish', weight: 15, track: 'HTML', orderIndex: 9 },
    ])
  })

  it('gives every parameter a non-empty description, AUTO mode and 0-100 range', async () => {
    await loadDefaultParameters('cat_html_meta', 'IDEA_HTML')

    for (const p of seededParameters()) {
      expect(typeof p.description).toBe('string')
      expect((p.description as string).trim().length).toBeGreaterThan(0)
      expect(p.scoringMode).toBe('AUTO')
      expect(p.minScore).toBe(0)
      expect(p.maxScore).toBe(100)
      expect(p.categoryId).toBe('cat_html_meta')
    }
  })

  it('seeds the same rows for the default argument as for an explicit IDEA_HTML', async () => {
    await loadDefaultParameters('cat_default')
    const defaultData = seededParameters()

    vi.clearAllMocks()
    mockCreate.mockImplementation(fakeCreate)

    await loadDefaultParameters('cat_explicit', 'IDEA_HTML')
    const explicitData = seededParameters()

    expect(defaultData.map((p) => p.name)).toEqual(
      explicitData.map((p) => p.name),
    )
  })
})

describe('loadDefaultParameters — reconciles instead of delete-all', () => {
  it('on an empty category, creates every template row and deletes nothing', async () => {
    await loadDefaultParameters('cat_empty', 'IDEA_HTML')

    expect(seededParameters()).toHaveLength(10)
    expect(mockDeleteMany).not.toHaveBeenCalled()
    expect(recalculateCategoryScores).toHaveBeenCalledWith('cat_empty')
  })

  it('on an already-scored category, keeps matching parameters (and their scores) in place', async () => {
    mockFindMany.mockResolvedValue(LEGACY_HTML_SET as never)

    await loadDefaultParameters('cat_scored', 'IDEA_HTML')

    // The HTML parameters the template still has are updated, not recreated.
    const updatedIds = mockUpdate.mock.calls.map((c) => (c[0] as { where: { id: string } }).where.id)
    expect(updatedIds.sort()).toEqual(['old-content', 'old-flow'])

    // Rows the template no longer has — including "Impact & Scalability",
    // which moved to the IDEA track — are removed with their AI scores.
    expect(mockAiDeleteMany).toHaveBeenCalledWith({
      where: { parameterId: { in: ['old-semantic', 'old-impact'] } },
    })
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-semantic', 'old-impact'] } },
    })
    expect(seededParameters().map((p) => p.name)).toEqual([
      'Problem & Relevance',
      'Originality & Innovation',
      'Feasibility',
      'Impact & Scalability',
      'Clarity of Idea',
      'Idea Communication',
      'Page Completeness',
      'Presentation Polish',
    ])
    // AI scores are cleared before the parameter row is deleted (FK order).
    expect(mockAiDeleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteMany.mock.invocationCallOrder[0],
    )
  })

  it('refuses — before any write — to remove a parameter jury members have scored', async () => {
    mockFindMany.mockResolvedValue(LEGACY_HTML_SET as never)
    mockJuryFindMany.mockResolvedValue([{ parameterId: 'old-impact' }] as never)

    await expect(loadDefaultParameters('cat_jury', 'IDEA_HTML')).rejects.toThrow(
      ParametersHaveJuryScoresError,
    )
    await expect(loadDefaultParameters('cat_jury', 'IDEA_HTML')).rejects.toThrow(
      /"Impact & Scalability".*jury members have already scored/,
    )
    expect(mockAiDeleteMany).not.toHaveBeenCalled()
    expect(mockDeleteMany).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('is idempotent — loading twice lands on the same 10 parameters', async () => {
    await loadDefaultParameters('cat_twice', 'IDEA_HTML')
    const firstRun = seededParameters()

    vi.clearAllMocks()
    mockCreate.mockImplementation(fakeCreate)
    mockUpdate.mockImplementation(fakeCreate as unknown as typeof db.parameter.update)
    mockJuryFindMany.mockResolvedValue([] as never)
    mockFindMany.mockResolvedValue(
      firstRun.map((p, i) => existingParam(`id-${i}`, p.name as string, p.track as 'IDEA' | 'HTML')) as never,
    )

    await loadDefaultParameters('cat_twice', 'IDEA_HTML')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockDeleteMany).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalledTimes(10)
  })

  it('lets an unrelated database error propagate as-is', async () => {
    mockFindMany.mockRejectedValue(new Error('connection reset'))

    await expect(
      loadDefaultParameters('cat_broken', 'IDEA_HTML'),
    ).rejects.toThrow('connection reset')
  })
})

describe('unknown set names are rejected', () => {
  const unknownValues = ['HTML', 'html', 'PARTYROCK', 'REACT', '', 'toString', null, 42]

  it('isDefaultParameterSet accepts only the known names', () => {
    for (const set of DEFAULT_PARAMETER_SET_NAMES) {
      expect(isDefaultParameterSet(set)).toBe(true)
    }
    for (const value of unknownValues) {
      expect(isDefaultParameterSet(value)).toBe(false)
    }
  })

  it('loadDefaultParameters throws a clear error and touches no rows', async () => {
    for (const value of unknownValues) {
      await expect(
        loadDefaultParameters('cat_bad', value as unknown as DefaultParameterSet),
      ).rejects.toThrow(/Unknown default parameter set/)
    }
    expect(mockDeleteMany).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('loadDefaultParametersAction returns a failure instead of seeding', async () => {
    const result = await loadDefaultParametersAction(
      'cat_bad',
      'REACT' as unknown as DefaultParameterSet,
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Unknown default parameter set/)
    expect(result.message).toContain('IDEA_HTML')
    expect(mockDeleteMany).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe('loadDefaultParametersAction', () => {
  it('seeds IDEA_HTML when the set argument is omitted', async () => {
    const result = await loadDefaultParametersAction('cat_action_default')

    expect(result.success).toBe(true)
    expect(seededParameters().map((p) => p.name)).toContain('Idea Communication')
  })

  it('seeds IDEA_HTML when it is requested explicitly', async () => {
    const result = await loadDefaultParametersAction('cat_action_html', 'IDEA_HTML')

    expect(result.success).toBe(true)
    expect(seededParameters().map((p) => p.name)).toEqual([
      'Problem & Relevance',
      'Originality & Innovation',
      'Feasibility',
      'Impact & Scalability',
      'Clarity of Idea',
      'Idea Communication',
      'Content Quality & Specificity',
      'Page Completeness',
      'Information Flow',
      'Presentation Polish',
    ])
  })

  it('rejects a non-admin caller before any set validation', async () => {
    mockAuth.mockResolvedValue({ user: { role: 'JURY' } })

    const result = await loadDefaultParametersAction('cat_forbidden', 'IDEA_HTML')

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Forbidden/)
    expect(mockDeleteMany).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
