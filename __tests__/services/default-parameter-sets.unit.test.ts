/**
 * Unit Tests: default parameter set (HTML)
 *
 *   - The default set totals exactly 100% weight.
 *   - The caller may load it explicitly or via the default argument.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock the Prisma db singleton BEFORE importing the service under test.
// ---------------------------------------------------------------------------
vi.mock('@/lib/db', () => {
  const db = {
    parameter: {
      // `loadDefaultParameters` clears the category's existing parameters
      // with `deleteMany` (one plain DELETE statement, safe under the Neon
      // HTTP driver adapter) before calling `create` once per default row
      // (not `createMany`) — see the comment in category.service.ts for why
      // `createMany` can't run under that adapter.
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
  }
  return { db, prisma: db }
})

// The server action pulls in NextAuth and the Next cache; both are stubbed so
// the validation path can be exercised without a request context.
vi.mock('@/lib/auth/config', () => ({
  auth: vi.fn(),
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { auth } from '@/lib/auth/config'
import {
  DEFAULT_PARAMETER_SETS,
  DEFAULT_PARAMETER_SET_NAMES,
  getDefaultParameterSet,
  isDefaultParameterSet,
  loadDefaultParameters,
  LoadDefaultParametersError,
  type DefaultParameterSet,
} from '@/lib/services/category.service'
import { loadDefaultParametersAction } from '@/actions/parameter.actions'

const mockDeleteMany = vi.mocked(db.parameter.deleteMany)
const mockCreate = vi.mocked(db.parameter.create)
const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>

/** A P2003 error shaped like the one Prisma throws on a FK constraint violation. */
function foreignKeyError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Foreign key constraint failed on the field: `parameterId`',
    { code: 'P2003', clientVersion: 'test' },
  )
}

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
  mockAuth.mockResolvedValue({ user: { role: 'ADMIN' } })
})

describe('default parameter sets — total weight', () => {
  it.each(DEFAULT_PARAMETER_SET_NAMES)(
    'set %s totals exactly 100 percent weight',
    (set) => {
      const total = DEFAULT_PARAMETER_SETS[set].reduce(
        (sum, p) => sum + p.weight,
        0,
      )
      expect(total).toBe(100)
    },
  )

  it('exposes exactly the HTML set', () => {
    expect([...DEFAULT_PARAMETER_SET_NAMES]).toEqual(['HTML'])
  })

  it('getDefaultParameterSet returns a set whose weights total 100%', () => {
    for (const set of DEFAULT_PARAMETER_SET_NAMES) {
      const parameters = getDefaultParameterSet(set)
      expect(parameters).toHaveLength(5)
      expect(parameters.reduce((sum, p) => sum + p.weight, 0)).toBe(100)
    }
  })
})

describe('loadDefaultParameters — HTML set', () => {
  it('seeds 5 parameters with the specified names and weights', async () => {
    await loadDefaultParameters('cat_html', 'HTML')

    const data = seededParameters()
    expect(data).toHaveLength(5)
    expect(
      data.map((p) => ({
        name: p.name,
        weight: p.weight,
        orderIndex: p.orderIndex,
      })),
    ).toEqual([
      { name: 'Semantic HTML & Structure', weight: 25, orderIndex: 0 },
      { name: 'Accessibility', weight: 25, orderIndex: 1 },
      { name: 'Code Quality & Maintainability', weight: 20, orderIndex: 2 },
      { name: 'User Experience & Presentation', weight: 15, orderIndex: 3 },
      { name: 'Impact & Scalability', weight: 15, orderIndex: 4 },
    ])
    expect(data.reduce((sum, p) => sum + (p.weight as number), 0)).toBe(100)
  })

  it('gives every parameter a non-empty description, AUTO mode and 0-100 range', async () => {
    await loadDefaultParameters('cat_html_meta', 'HTML')

    for (const p of seededParameters()) {
      expect(typeof p.description).toBe('string')
      expect((p.description as string).trim().length).toBeGreaterThan(0)
      expect(p.scoringMode).toBe('AUTO')
      expect(p.minScore).toBe(0)
      expect(p.maxScore).toBe(100)
      expect(p.categoryId).toBe('cat_html_meta')
    }
  })

  it('seeds the same rows for the default argument as for an explicit HTML', async () => {
    await loadDefaultParameters('cat_default')
    const defaultData = seededParameters()

    vi.clearAllMocks()
    mockCreate.mockImplementation(fakeCreate)

    await loadDefaultParameters('cat_explicit', 'HTML')
    const explicitData = seededParameters()

    expect(defaultData.map((p) => p.name)).toEqual(
      explicitData.map((p) => p.name),
    )
  })
})

describe('loadDefaultParameters — replaces rather than appends', () => {
  it('clears the category before seeding, so re-loading always lands on exactly 100%', async () => {
    await loadDefaultParameters('cat_replace', 'HTML')

    expect(mockDeleteMany).toHaveBeenCalledOnce()
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { categoryId: 'cat_replace' },
    })
    // The delete must happen before any create, or a re-load would still
    // end up appending on top of rows the delete was supposed to clear.
    const deleteOrder = mockDeleteMany.mock.invocationCallOrder[0]
    for (const createCall of mockCreate.mock.invocationCallOrder) {
      expect(createCall).toBeGreaterThan(deleteOrder)
    }
    expect(seededParameters()).toHaveLength(5)
  })

  it('surfaces a clear error instead of a raw Prisma exception when scores block the delete', async () => {
    mockDeleteMany.mockRejectedValue(foreignKeyError())

    await expect(loadDefaultParameters('cat_scored', 'HTML')).rejects.toThrow(
      LoadDefaultParametersError,
    )
    await expect(
      loadDefaultParameters('cat_scored', 'HTML'),
    ).rejects.toThrow(/existing AI\/jury scores reference/)
    // The failed delete must not be followed by a create — half-replacing
    // would leave the category in a worse state than before the click.
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('lets an unrelated database error propagate as-is', async () => {
    mockDeleteMany.mockRejectedValue(new Error('connection reset'))

    await expect(
      loadDefaultParameters('cat_broken', 'HTML'),
    ).rejects.toThrow('connection reset')
  })
})

describe('unknown set names are rejected', () => {
  const unknownValues = ['html', 'PARTYROCK', 'REACT', '', 'toString', null, 42]

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
    expect(result.message).toContain('HTML')
    expect(mockDeleteMany).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe('loadDefaultParametersAction', () => {
  it('seeds HTML when the set argument is omitted', async () => {
    const result = await loadDefaultParametersAction('cat_action_default')

    expect(result.success).toBe(true)
    expect(seededParameters().map((p) => p.name)).toContain(
      'Semantic HTML & Structure',
    )
  })

  it('seeds HTML when HTML is requested explicitly', async () => {
    const result = await loadDefaultParametersAction('cat_action_html', 'HTML')

    expect(result.success).toBe(true)
    expect(seededParameters().map((p) => p.name)).toEqual([
      'Semantic HTML & Structure',
      'Accessibility',
      'Code Quality & Maintainability',
      'User Experience & Presentation',
      'Impact & Scalability',
    ])
  })

  it('rejects a non-admin caller before any set validation', async () => {
    mockAuth.mockResolvedValue({ user: { role: 'JURY' } })

    const result = await loadDefaultParametersAction('cat_forbidden', 'HTML')

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Forbidden/)
    expect(mockDeleteMany).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
