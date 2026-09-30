/**
 * Regression tests for defects found in a code review:
 *   - custom score ranges were weighted raw instead of on a common scale;
 *   - the public leaderboard leaked jury ids, jury comments and AI reasoning;
 *   - the export named columns by id, dropped MANUAL parameters and kept one
 *     arbitrary jury per parameter;
 *   - a jury could store a score for another category's parameter, or NaN;
 *   - the evaluator read `"score": null` as a 0;
 *   - database constraint errors surfaced as opaque 500s;
 *   - re-publishing a category rotated its public link;
 *   - a category with parameters could never be deleted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

const mockDb = vi.hoisted(() => ({
  category: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  categoryJury: { findFirst: vi.fn(), deleteMany: vi.fn() },
  parameter: { findUniqueOrThrow: vi.fn(), deleteMany: vi.fn() },
  project: { findMany: vi.fn(), count: vi.fn() },
  aIScore: { findFirst: vi.fn() },
  juryScore: { findFirst: vi.fn(), upsert: vi.fn() },
  auditLog: { create: vi.fn() },
}))
vi.mock('@/lib/db', () => ({ db: mockDb, prisma: mockDb }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/services/final-score.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/final-score.service')>()
  return { ...actual, recalculateProjectScores: vi.fn(), recalculateCategoryScores: vi.fn() }
})

import { effectiveParameterScores, normaliseScore } from '@/lib/services/final-score.service'
import { getPublicLeaderboard } from '@/lib/services/leaderboard.service'
import { exportToCsv } from '@/lib/services/export.service'
import { submitJuryScore, ScoreValidationError } from '@/lib/services/jury.service'
import { parseEvaluatorResponse } from '@/lib/services/ai/evaluator'
import { handleApiError } from '@/lib/api-error'
import { publishCategory, deleteCategory } from '@/lib/services/category.service'
import type { ProjectWithScores } from '@/types'

beforeEach(() => vi.clearAllMocks())

// ---------------------------------------------------------------------------

describe('score ranges', () => {
  it('puts every parameter on a 0–100 scale before weighting', () => {
    expect(normaliseScore(4, 1, 5)).toBe(75)
    expect(normaliseScore(80)).toBe(80)
    expect(normaliseScore(80, 0, 100)).toBe(80)
  })

  it('weights a 1–5 parameter and a 0–100 parameter on the same scale', () => {
    const scores = effectiveParameterScores(
      [
        { id: 'a', weight: 50, track: 'IDEA', minScore: 0, maxScore: 100 },
        { id: 'b', weight: 50, track: 'IDEA', minScore: 1, maxScore: 5 },
      ],
      [
        { parameterId: 'a', score: 80 },
        { parameterId: 'b', score: 4 },
      ],
      [],
    )
    expect(scores.map((s) => s.score)).toEqual([80, 75])
  })
})

// ---------------------------------------------------------------------------

describe('public leaderboard', () => {
  it('exposes ranking fields only — no jury ids, comments or AI reasoning', async () => {
    mockDb.category.findUnique.mockResolvedValue({ id: 'cat', isPublished: true })
    mockDb.project.findMany.mockResolvedValue([
      {
        id: 'p1',
        categoryId: 'cat',
        url: null,
        participantName: 'Ana',
        teamName: null,
        projectTitle: 'FarmLink',
        crawlStatus: 'SUCCESS',
        scoreStatus: 'SUCCESS',
        finalScore: 81,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        crawlError: null,
        aiScores: [{ parameterId: 'x', score: 80, reasoning: 'secret reasoning' }],
        juryScores: [{ parameterId: 'x', juryId: 'jury-user-id', score: 82, comment: 'private note' }],
      },
    ])

    const result = await getPublicLeaderboard('token')

    expect(result).toEqual([
      { rank: 1, participantName: 'Ana', teamName: null, projectTitle: 'FarmLink', url: null, finalScore: 81 },
    ])
    const json = JSON.stringify(result)
    expect(json).not.toContain('jury-user-id')
    expect(json).not.toContain('private note')
    expect(json).not.toContain('secret reasoning')
  })
})

// ---------------------------------------------------------------------------

function exportProject(overrides: Partial<ProjectWithScores> = {}): ProjectWithScores {
  return {
    id: 'p1',
    categoryId: 'cat',
    url: 'https://example.com',
    participantName: 'Ana',
    teamName: null,
    crawlStatus: 'SUCCESS',
    scoreStatus: 'SUCCESS',
    finalScore: 80,
    createdAt: new Date('2026-01-01'),
    aiScores: [{ parameterId: 'auto', score: 70, reasoning: 'r' }],
    juryScores: [
      { parameterId: 'auto', juryId: 'j1', score: 80, comment: 'good' },
      { parameterId: 'auto', juryId: 'j2', score: 90, comment: 'great' },
      { parameterId: 'manual', juryId: 'j1', score: 60, comment: null },
    ],
    rank: 1,
    ...overrides,
  }
}

describe('export', () => {
  const parameters = [
    { id: 'auto', name: 'Originality' },
    { id: 'manual', name: 'Pitch' },
  ]

  it('names columns after the parameters and includes MANUAL ones', () => {
    const header = exportToCsv([exportProject()], parameters).split('\n')[0]
    expect(header).toContain('AI: Originality')
    expect(header).toContain('Juri (rata-rata): Pitch')
    expect(header).not.toContain('AI: auto')
  })

  it('reports the mean of every jury and all their comments', () => {
    const row = exportToCsv([exportProject()], parameters).split('\n')[1]
    // auto: AI 70, jury mean (80+90)/2 = 85, both comments.
    expect(row).toContain('70,85,good | great')
    // manual: no AI score, one jury.
    expect(row).toContain(',,60,')
  })

  it('starts with a UTF-8 BOM so Excel reads non-Latin names correctly', () => {
    expect(exportToCsv([exportProject()], parameters).startsWith('﻿')).toBe(true)
  })

  it('neutralises participant text that would run as a spreadsheet formula', () => {
    const csv = exportToCsv([exportProject({ participantName: '=HYPERLINK("x")' })], parameters)
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
  })
})

// ---------------------------------------------------------------------------

describe('jury scoring', () => {
  beforeEach(() => {
    mockDb.categoryJury.findFirst.mockResolvedValue({ categoryId: 'cat-A', userId: 'jury' })
    mockDb.aIScore.findFirst.mockResolvedValue(null)
    mockDb.juryScore.findFirst.mockResolvedValue(null)
  })

  it("refuses a parameter from another category", async () => {
    mockDb.parameter.findUniqueOrThrow.mockResolvedValue({
      id: 'param',
      categoryId: 'cat-B',
      minScore: 0,
      maxScore: 100,
    })
    await expect(submitJuryScore('p', 'param', 'jury', 50, null)).rejects.toBeInstanceOf(
      ScoreValidationError,
    )
    expect(mockDb.juryScore.upsert).not.toHaveBeenCalled()
  })

  it('refuses a non-finite score', async () => {
    mockDb.parameter.findUniqueOrThrow.mockResolvedValue({
      id: 'param',
      categoryId: 'cat-A',
      minScore: 0,
      maxScore: 100,
    })
    await expect(submitJuryScore('p', 'param', 'jury', NaN, null)).rejects.toBeInstanceOf(
      ScoreValidationError,
    )
  })

  it('only reaches active projects', async () => {
    mockDb.categoryJury.findFirst.mockResolvedValue(null)
    await expect(submitJuryScore('p', 'param', 'jury', 50, null)).rejects.toThrow(
      'Jury is not assigned',
    )
    expect(mockDb.categoryJury.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'jury',
        category: { projects: { some: { id: 'p', isActive: true } } },
      },
    })
  })
})

// ---------------------------------------------------------------------------

describe('evaluator response', () => {
  const params = [{ id: 'a', name: 'A', description: null, minScore: 0, maxScore: 100 }]

  it.each([null, '', '  '])('rejects a %j score instead of reading it as 0', (score) => {
    const reply = JSON.stringify({ scores: [{ parameter: 'P1', score, reasoning: 'r' }] })
    expect(() => parseEvaluatorResponse(reply, params)).toThrow('non-numeric score')
  })

  it('still accepts numeric strings', () => {
    const reply = JSON.stringify({ scores: [{ parameter: 'P1', score: '72', reasoning: 'r' }] })
    expect(parseEvaluatorResponse(reply, params)[0].score).toBe(72)
  })
})

// ---------------------------------------------------------------------------

describe('handleApiError', () => {
  const prismaError = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('db error', { code, clientVersion: 'test', meta })

  it('answers a unique violation with 409 naming the field', async () => {
    const res = handleApiError(prismaError('P2002', { target: ['email'] }))
    expect(res.status).toBe(409)
    expect((await res.json()).message).toContain('email')
  })

  it('answers a foreign-key refusal with 409 and a missing record with 404', () => {
    expect(handleApiError(prismaError('P2003')).status).toBe(409)
    expect(handleApiError(prismaError('P2025')).status).toBe(404)
  })

  it('keeps unknown errors at 500', () => {
    expect(handleApiError(new Error('boom')).status).toBe(500)
  })
})

// ---------------------------------------------------------------------------

describe('categories', () => {
  it('keeps the public token when published again', async () => {
    mockDb.category.findUniqueOrThrow.mockResolvedValue({ publicToken: 'existing-token' })
    mockDb.category.update.mockResolvedValue({})
    await publishCategory('cat')
    expect(mockDb.category.update).toHaveBeenCalledWith({
      where: { id: 'cat' },
      data: { isPublished: true, publicToken: 'existing-token' },
    })
  })

  it('removes jury assignments and parameters before deleting an empty category', async () => {
    mockDb.project.count.mockResolvedValue(0)
    mockDb.categoryJury.deleteMany.mockResolvedValue({ count: 1 })
    mockDb.parameter.deleteMany.mockResolvedValue({ count: 10 })
    mockDb.category.delete.mockResolvedValue({ id: 'cat' })

    await deleteCategory('cat')

    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]
    expect(order(mockDb.categoryJury.deleteMany)).toBeLessThan(order(mockDb.category.delete))
    expect(order(mockDb.parameter.deleteMany)).toBeLessThan(order(mockDb.category.delete))
  })
})
