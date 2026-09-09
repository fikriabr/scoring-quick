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
import { revalidatePath } from 'next/cache'

export type ActionResult = {
  success: boolean
  message?: string
}

// -----------------------------------------------------------------------
// loadDefaultParametersAction
// Seeds the category with the chosen default parameter set (5 parameters
// totalling 100% weight). Defaults to PARTYROCK so existing callers are
// unaffected.
// Requirements: 2.4, 6.1, 6.3, 6.4
// -----------------------------------------------------------------------
export async function loadDefaultParametersAction(
  categoryId: string,
  set: DefaultParameterSet = 'PARTYROCK',
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
// Saves a full parameter set for a category (validates weight=100%).
// Requirements: 2.1, 2.2, 2.3
// -----------------------------------------------------------------------
export async function saveParametersAction(
  categoryId: string,
  parameters: {
    name: string
    description?: string | null
    weight: number
    minScore: number
    maxScore: number
    scoringMode: 'AUTO' | 'MANUAL'
    orderIndex: number
  }[],
): Promise<ActionResult> {
  const session = await auth()
  if (!session || session.user.role !== 'ADMIN') {
    return { success: false, message: 'Forbidden: Admin access required' }
  }

  try {
    await saveParameterSet(categoryId, parameters)
    revalidatePath(`/admin/categories/${categoryId}/parameters`)
    return { success: true }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to save parameters'
    return { success: false, message }
  }
}
