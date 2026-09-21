// lib/services/parameter.service.ts
// Service layer for managing scoring parameters within a category.
// Requirements: 2.1, 2.2, 2.3, 2.5, 2.6

import type { Parameter } from '@prisma/client'
import { db } from '@/lib/db'
import {
  ParameterSchema,
  ParameterSetSchema,
  type ParameterInput,
  type ParameterSetInput,
} from '@/lib/validators/schemas'

// -----------------------------------------------------------------------
// listParametersByCategory
// Returns all parameters for a given category, ordered by orderIndex.
// Requirements: 2.1
// -----------------------------------------------------------------------

export async function listParametersByCategory(
  categoryId: string,
): Promise<Parameter[]> {
  return db.parameter.findMany({
    where: { categoryId },
    orderBy: { orderIndex: 'asc' },
  })
}

// -----------------------------------------------------------------------
// createParameter
// Creates a single parameter after validating via ParameterSchema.
// Requirements: 2.1, 2.2
// -----------------------------------------------------------------------

export async function createParameter(
  categoryId: string,
  input: ParameterInput,
): Promise<Parameter> {
  // Validate individual parameter — also enforces categoryId matches
  const validated = ParameterSchema.parse({ ...input, categoryId })

  return db.parameter.create({
    data: {
      categoryId: validated.categoryId,
      name: validated.name,
      description: validated.description ?? null,
      weight: validated.weight,
      minScore: validated.minScore,
      maxScore: validated.maxScore,
      scoringMode: validated.scoringMode,
      track: validated.track,
      orderIndex: validated.orderIndex,
    },
  })
}

// -----------------------------------------------------------------------
// updateParameter
// Updates a parameter by ID. Returns the updated parameter and a flag
// indicating whether existing AI/jury scores are affected (warning signal).
// Requirements: 2.5, 2.6
// -----------------------------------------------------------------------

export async function updateParameter(
  id: string,
  input: Partial<ParameterInput>,
): Promise<{ parameter: Parameter; hasExistingScores: boolean }> {
  // Verify parameter exists
  const existing = await db.parameter.findUniqueOrThrow({ where: { id } })

  // Merge existing values with the update and validate if weight-related fields change
  const merged = {
    categoryId: existing.categoryId,
    name: input.name ?? existing.name,
    description:
      input.description !== undefined ? input.description : existing.description,
    weight: input.weight ?? existing.weight,
    minScore: input.minScore ?? existing.minScore,
    maxScore: input.maxScore ?? existing.maxScore,
    scoringMode: input.scoringMode ?? existing.scoringMode,
    track: input.track ?? existing.track,
    orderIndex: input.orderIndex ?? existing.orderIndex,
  }

  // Validate merged data against ParameterSchema
  ParameterSchema.parse(merged)

  // Check if there are existing AI scores or jury scores tied to this parameter
  const [aiScoreCount, juryScoreCount] = await Promise.all([
    db.aIScore.count({ where: { parameterId: id } }),
    db.juryScore.count({ where: { parameterId: id } }),
  ])
  const hasExistingScores = aiScoreCount + juryScoreCount > 0

  const parameter = await db.parameter.update({
    where: { id },
    data: {
      name: merged.name,
      description: merged.description,
      weight: merged.weight,
      minScore: merged.minScore,
      maxScore: merged.maxScore,
      scoringMode: merged.scoringMode,
      track: merged.track,
      orderIndex: merged.orderIndex,
    },
  })

  return { parameter, hasExistingScores }
}

// -----------------------------------------------------------------------
// deleteParameter
// Deletes a parameter by ID.
// Requirements: 2.1
// -----------------------------------------------------------------------

export async function deleteParameter(id: string): Promise<void> {
  await db.parameter.delete({ where: { id } })
}

// -----------------------------------------------------------------------
// reorderParameters
// Accepts an array of {id, orderIndex} pairs and batch-updates all of them.
// Uses a Prisma transaction to ensure atomicity.
// Requirements: 2.1
// -----------------------------------------------------------------------

export async function reorderParameters(
  updates: { id: string; orderIndex: number }[],
): Promise<void> {
  // Execute updates sequentially (HTTP adapter does not support batch transactions)
  for (const { id, orderIndex } of updates) {
    await db.parameter.update({
      where: { id },
      data: { orderIndex },
    })
  }
}

// -----------------------------------------------------------------------
// replaceCategoryParameters
// Makes the category's parameters equal to `desired` WITHOUT a blanket
// delete: a blanket delete fails (FK RESTRICT) as soon as any parameter has an
// AI or jury score, and would throw away every score even when the parameter
// itself did not change.
//
//   - desired rows are matched to existing parameters by `id` when given,
//     otherwise by (name, track); a match is updated in place, so its scores
//     survive (a weight/description edit does not invalidate them);
//   - a matched parameter that moved to a different track loses its AI scores
//     — they judged the other file;
//   - existing parameters with no match are removed together with their AI
//     scores (regenerated by re-scoring);
//   - removing a parameter that jury members have already scored is refused,
//     before anything is written.
//
// No transaction: the Neon HTTP adapter cannot run one. All validation happens
// before the first write so a refused request changes nothing.
// -----------------------------------------------------------------------

export class ParametersHaveJuryScoresError extends Error {
  readonly code = 'PARAMETERS_HAVE_JURY_SCORES'
  readonly status = 409
  constructor(names: string[]) {
    super(
      `Cannot remove parameter(s) ${names.map((n) => `"${n}"`).join(', ')}: jury members have already scored them. Keep these parameters (you may change their weight or description), or remove their jury scores first.`,
    )
    this.name = 'ParametersHaveJuryScoresError'
  }
}

export type DesiredParameter = {
  id?: string | null
  name: string
  description?: string | null
  weight: number
  minScore: number
  maxScore: number
  scoringMode: Parameter['scoringMode']
  track: Parameter['track']
  orderIndex: number
}

export async function replaceCategoryParameters(
  categoryId: string,
  desired: readonly DesiredParameter[],
): Promise<Parameter[]> {
  const existing = await db.parameter.findMany({ where: { categoryId } })
  const unmatched = new Map(existing.map((p) => [p.id, p]))

  const plan = desired.map((d) => {
    let match = d.id ? unmatched.get(d.id) : undefined
    if (!match) {
      match = [...unmatched.values()].find(
        (p) => p.name.trim().toLowerCase() === d.name.trim().toLowerCase() && p.track === d.track,
      )
    }
    if (match) unmatched.delete(match.id)
    return { desired: d, match }
  })
  const removed = [...unmatched.values()]

  if (removed.length > 0) {
    const juryScored = await db.juryScore.findMany({
      where: { parameterId: { in: removed.map((p) => p.id) } },
      select: { parameterId: true },
      distinct: ['parameterId'],
    })
    if (juryScored.length > 0) {
      const ids = new Set(juryScored.map((j) => j.parameterId))
      throw new ParametersHaveJuryScoresError(
        removed.filter((p) => ids.has(p.id)).map((p) => p.name),
      )
    }
  }

  // AI scores of removed parameters, and of parameters that changed track,
  // no longer describe anything — clear them before deleting/updating.
  const staleAiScoreParams = [
    ...removed.map((p) => p.id),
    ...plan
      .filter(({ desired: d, match }) => match && match.track !== d.track)
      .map(({ match }) => match!.id),
  ]
  if (staleAiScoreParams.length > 0) {
    await db.aIScore.deleteMany({ where: { parameterId: { in: staleAiScoreParams } } })
  }
  if (removed.length > 0) {
    await db.parameter.deleteMany({ where: { id: { in: removed.map((p) => p.id) } } })
  }

  return Promise.all(
    plan.map(({ desired: d, match }) => {
      const data = {
        name: d.name,
        description: d.description ?? null,
        weight: d.weight,
        minScore: d.minScore,
        maxScore: d.maxScore,
        scoringMode: d.scoringMode,
        track: d.track,
        orderIndex: d.orderIndex,
      }
      return match
        ? db.parameter.update({ where: { id: match.id }, data })
        : db.parameter.create({ data: { ...data, categoryId } })
    }),
  )
}

// -----------------------------------------------------------------------
// saveParameterSet
// Replaces the category's parameters with a new validated set.
// Validates each track's weight = 100% (±0.001) via ParameterSetSchema before
// any DB write, then reconciles via `replaceCategoryParameters` so parameters
// that still exist keep their scores.
// Requirements: 2.2, 2.3
// -----------------------------------------------------------------------

export async function saveParameterSet(
  categoryId: string,
  parameters: ParameterSetInput,
): Promise<Parameter[]> {
  // Validate total weight invariant — throws ZodError if invalid
  const validated = ParameterSetSchema.parse(parameters)

  return replaceCategoryParameters(
    categoryId,
    validated.map((p, i) => ({ ...p, orderIndex: p.orderIndex ?? i })),
  )
}
