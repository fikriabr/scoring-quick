/**
 * Unit Tests: default parameter sets (PARTYROCK + HTML)
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 *
 *   6.1 A separate default parameter set for web projects exists alongside the
 *       existing PartyRock template.
 *   6.2 Every default set totals exactly 100% weight.
 *   6.3 The caller may choose which set is loaded.
 *   6.4 The existing PartyRock set keeps its names, descriptions and weights.
 *
 * The PartyRock expectations below are pinned verbatim on purpose: they are a
 * regression guard for 6.4, so any edit to that template — including a reworded
 * description — has to fail here first and be a conscious decision.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock the Prisma db singleton BEFORE importing the service under test.
// ---------------------------------------------------------------------------
vi.mock('@/lib/db', () => {
  const db = {
    parameter: {
      createMany: vi.fn(),
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
import { loadDefaultParametersAction } from '@/actions/parameter.actions'

const mockCreateMany = vi.mocked(db.parameter.createMany)
const mockAuth = vi.mocked(auth) as unknown as ReturnType<typeof vi.fn>

/** The `data` array handed to the single `createMany` call. */
function seededParameters(): Array<Record<string, unknown>> {
  expect(mockCreateMany).toHaveBeenCalledOnce()
  const args = mockCreateMany.mock.calls[0][0] as {
    data: Array<Record<string, unknown>>
  }
  return args.data
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateMany.mockResolvedValue({ count: 5 } as never)
  mockAuth.mockResolvedValue({ user: { role: 'ADMIN' } })
})

// ---------------------------------------------------------------------------
// Requirement 6.2 — every set totals 100%
// ---------------------------------------------------------------------------

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

  it('exposes exactly the PARTYROCK and HTML sets', () => {
    expect([...DEFAULT_PARAMETER_SET_NAMES].sort()).toEqual(['HTML', 'PARTYROCK'])
  })

  it('getDefaultParameterSet returns a set whose weights total 100%', () => {
    for (const set of DEFAULT_PARAMETER_SET_NAMES) {
      const parameters = getDefaultParameterSet(set)
      expect(parameters).toHaveLength(5)
      expect(parameters.reduce((sum, p) => sum + p.weight, 0)).toBe(100)
    }
  })
})

// ---------------------------------------------------------------------------
// Requirement 6.4 — the PartyRock set is untouched
// ---------------------------------------------------------------------------

describe('PARTYROCK set — regression guard (requirement 6.4)', () => {
  const expected = [
    {
      name: 'Creativity & Originality',
      description: 'How creative and original is the application compared to others?',
      weight: 20,
      orderIndex: 0,
    },
    {
      name: 'Problem-Solution Fit',
      description: 'How well does the application address a real problem?',
      weight: 25,
      orderIndex: 1,
    },
    {
      name: 'Effective Use of PartyRock Features',
      description: 'How effectively does the application leverage PartyRock widgets?',
      weight: 20,
      orderIndex: 2,
    },
    {
      name: 'User Experience & Presentation',
      description: 'How clear and compelling is the application presentation?',
      weight: 20,
      orderIndex: 3,
    },
    {
      name: 'Impact & Scalability',
      description: 'What is the potential impact and scalability of the application?',
      weight: 15,
      orderIndex: 4,
    },
  ]

  it('keeps every name, description, weight and order position', () => {
    expect(
      DEFAULT_PARAMETER_SETS.PARTYROCK.map((p) => ({
        name: p.name,
        description: p.description,
        weight: p.weight,
        orderIndex: p.orderIndex,
      })),
    ).toEqual(expected)
  })

  it('keeps the AUTO scoring mode and 0-100 score range on every parameter', () => {
    for (const p of DEFAULT_PARAMETER_SETS.PARTYROCK) {
      expect(p.scoringMode).toBe('AUTO')
      expect(p.minScore).toBe(0)
      expect(p.maxScore).toBe(100)
    }
  })
})

// ---------------------------------------------------------------------------
// Requirement 6.4 — the default argument still seeds PartyRock
// ---------------------------------------------------------------------------

describe('loadDefaultParameters — default argument', () => {
  it('seeds the PARTYROCK set when no set is given', async () => {
    await loadDefaultParameters('cat_default')

    const data = seededParameters()
    expect(data.map((p) => p.name)).toEqual([
      'Creativity & Originality',
      'Problem-Solution Fit',
      'Effective Use of PartyRock Features',
      'User Experience & Presentation',
      'Impact & Scalability',
    ])
    // Every row carries the categoryId, and duplicates stay skipped.
    expect(data.every((p) => p.categoryId === 'cat_default')).toBe(true)
    expect(mockCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    )
  })

  it('seeds the same rows for an explicit PARTYROCK as for the default', async () => {
    await loadDefaultParameters('cat_explicit')
    const explicitData = seededParameters()

    vi.clearAllMocks()
    mockCreateMany.mockResolvedValue({ count: 5 } as never)

    await loadDefaultParameters('cat_explicit', 'PARTYROCK')
    expect(seededParameters()).toEqual(explicitData)
  })
})

// ---------------------------------------------------------------------------
// Requirement 6.1 — the HTML set
// ---------------------------------------------------------------------------

describe('loadDefaultParameters — HTML set (requirement 6.1)', () => {
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

  it('gives every HTML parameter a non-empty description, AUTO mode and 0-100 range', async () => {
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
})

// ---------------------------------------------------------------------------
// Requirement 6.3 — unknown set names are rejected
// ---------------------------------------------------------------------------

describe('unknown set names are rejected (requirement 6.3)', () => {
  const unknownValues = ['html', 'PARTYROCK ', 'REACT', '', 'toString', null, 42]

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
    expect(mockCreateMany).not.toHaveBeenCalled()
  })

  it('loadDefaultParametersAction returns a failure instead of seeding', async () => {
    const result = await loadDefaultParametersAction(
      'cat_bad',
      'REACT' as unknown as DefaultParameterSet,
    )

    expect(result.success).toBe(false)
    expect(result.message).toMatch(/Unknown default parameter set/)
    expect(result.message).toContain('PARTYROCK')
    expect(result.message).toContain('HTML')
    expect(mockCreateMany).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Requirement 6.3 — the action forwards the chosen set
// ---------------------------------------------------------------------------

describe('loadDefaultParametersAction — set forwarding (requirement 6.3)', () => {
  it('seeds PARTYROCK when the set argument is omitted', async () => {
    const result = await loadDefaultParametersAction('cat_action_default')

    expect(result.success).toBe(true)
    expect(seededParameters().map((p) => p.name)).toContain(
      'Effective Use of PartyRock Features',
    )
  })

  it('seeds HTML when HTML is requested', async () => {
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
    expect(mockCreateMany).not.toHaveBeenCalled()
  })
})
