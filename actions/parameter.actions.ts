// actions/parameter.actions.ts
// Server actions for parameter management.
// Requirements: 2.1, 2.2, 2.3, 2.4

'use server'

import { auth } from '@/lib/auth/config'
import {
  DEFAULT_PARAMETER_SET_NAMES,
  isDefaultParameterSet,
  loadDefaultParameters,
  type DefaultParameterSet,
} from '@/lib/services/category.service'
import { saveParameterSet } from '@/lib/services/parameter.service'
import { updateCategoryScoringConfig } from '@/lib/services/category.service'
import { recalculateCategoryScores } from '@/lib/services/final-score.service'
import {
  CategoryScoringConfigSchema,
  type CategoryScoringConfigInput,
} from '@/lib/validators/schemas'
import { revalidatePath } from 'next/cache'

export type ActionResult = {
  success: boolean
  message?: string
}

// -----------------------------------------------------------------------
// loadDefaultParametersAction
// Seeds the category with the default parameter set (IDEA + HTML tracks,
// each totalling 100% weight).
// -----------------------------------------------------------------------
export async function loadDefaultParametersAction(
  categoryId: string,
  set: DefaultParameterSet = 'IDEA_HTML',
): Promise<ActionResult> {
  const session = await auth()
  if (!session || session.user.role !== 'ADMIN') {
    return { success: false, message: 'Forbidden: Admin access required' }
  }

  // The value comes from the client, so it is validated rather than trusted.
  if (!isDefaultParameterSet(set)) {
    return {
      success: false,
      message: `Unknown default parameter set "${String(set)}". Expected one of: ${DEFAULT_PARAMETER_SET_NAMES.join(', ')}.`,
    }
  }

  try {
    await loadDefaultParameters(categoryId, set)
    revalidatePath(`/admin/categories/${categoryId}/parameters`)
    return { success: true }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load default parameters'
    return { success: false, message }
  }
}

// -----------------------------------------------------------------------
// saveParametersAction
// Saves a full parameter set for a category (validates each track's
// weight = 100%) together with the track blend and critic settings.
// Requirements: 2.1, 2.2, 2.3
// -----------------------------------------------------------------------
export async function saveParametersAction(
  categoryId: string,
  parameters: {
    /** Existing parameter id, so it is updated in place and keeps its scores. */
    id?: string | null
    name: string
    description?: string | null
    weight: number
    minScore: number
    maxScore: number
    scoringMode: 'AUTO' | 'MANUAL'
    track: 'IDEA' | 'HTML'
    orderIndex: number
  }[],
  scoringConfig?: CategoryScoringConfigInput,
): Promise<ActionResult> {
  const session = await auth()
  if (!session || session.user.role !== 'ADMIN') {
    return { success: false, message: 'Forbidden: Admin access required' }
  }

  try {
    // Validate the config before the parameter set is replaced, so a bad
    // config cannot leave the category half-saved.
    if (scoringConfig) CategoryScoringConfigSchema.parse(scoringConfig)
    await saveParameterSet(categoryId, parameters)
    // Both branches re-blend every project's score with the new parameters.
    if (scoringConfig) {
      await updateCategoryScoringConfig(categoryId, scoringConfig)
    } else {
      await recalculateCategoryScores(categoryId)
    }
    revalidatePath(`/admin/categories/${categoryId}/parameters`)
    return { success: true }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to save parameters'
    return { success: false, message }
  }
}
