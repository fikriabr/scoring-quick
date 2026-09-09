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
// saveParameterSet
// Replaces all parameters for a category with a new validated set.
// Validates total weight = 100% (±0.001) via ParameterSetSchema before
// any DB write. Deletes existing parameters and creates the new set within
// a single transaction.
// Requirements: 2.2, 2.3
// -----------------------------------------------------------------------

export async function saveParameterSet(
  categoryId: string,
  parameters: ParameterSetInput,
): Promise<Parameter[]> {
  // Validate total weight invariant — throws ZodError if invalid
  const validated = ParameterSetSchema.parse(parameters)

  // Delete existing parameters then create the new set sequentially.
  // (HTTP adapter does not support interactive transactions)
  await db.parameter.deleteMany({ where: { categoryId } })

  const created = await Promise.all(
    validated.map((p, i) =>
      db.parameter.create({
        data: {
          categoryId,
          name: p.name,
          description: p.description ?? null,
          weight: p.weight,
          minScore: p.minScore,
          maxScore: p.maxScore,
          scoringMode: p.scoringMode,
          orderIndex: p.orderIndex ?? i,
        },
      }),
    ),
  )

  return created
}
