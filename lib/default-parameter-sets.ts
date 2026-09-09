// lib/default-parameter-sets.ts
//
// The default parameter template, plus its display metadata, in a neutral
// module — no `@/lib/db`, no value import from `@prisma/client`, no Node
// built-ins — so `ParameterBuilder` (a client component) can read the set
// name, label and contents without dragging the Prisma runtime and the
// database client into the browser bundle.

/** Identifier of the shipped default parameter template. */
export type DefaultParameterSet = 'HTML'

export type DefaultParameterTemplate = {
  name: string
  description: string
  weight: number
  minScore: number
  maxScore: number
  scoringMode: 'AUTO'
  orderIndex: number
}

export const DEFAULT_PARAMETER_SETS: Record<
  DefaultParameterSet,
  readonly DefaultParameterTemplate[]
> = {
  HTML: [
    {
      name: 'Semantic HTML & Structure',
      description:
        'How well does the markup use semantic elements and keep a logical heading hierarchy?',
      weight: 25,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      orderIndex: 0,
    },
    {
      name: 'Accessibility',
      description:
        'How accessible is the page in terms of image alt text, form labels, ARIA attributes, and landmark regions?',
      weight: 25,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      orderIndex: 1,
    },
    {
      name: 'Code Quality & Maintainability',
      description:
        'How well organised is the markup in terms of DOM depth, structure, and separation of styling from content?',
      weight: 20,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      orderIndex: 2,
    },
    {
      name: 'User Experience & Presentation',
      description:
        'How clear is the content, and are page metadata and viewport configuration in place?',
      weight: 15,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      orderIndex: 3,
    },
    {
      name: 'Impact & Scalability',
      description:
        'How relevant is the problem the page addresses and what is its potential for wider adoption?',
      weight: 15,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      orderIndex: 4,
    },
  ],
}

/** Names of every available default parameter set, for messages and UI. */
export const DEFAULT_PARAMETER_SET_NAMES = Object.keys(
  DEFAULT_PARAMETER_SETS,
) as DefaultParameterSet[]

/** Render order for the template selector, rather than relying on key order. */
export const DEFAULT_PARAMETER_SET_ORDER: DefaultParameterSet[] = ['HTML']

/**
 * Human-readable label for the set. The only place a raw set identifier gets
 * turned into UI copy — adding a set makes this map fail to typecheck, which is
 * the point: no template may reach the admin unlabelled.
 */
export const DEFAULT_PARAMETER_SET_LABELS: Record<DefaultParameterSet, string> = {
  HTML: 'HTML / web project',
}

// -----------------------------------------------------------------------
// isDefaultParameterSet
// Type guard for values arriving from untrusted sources (server actions).
// -----------------------------------------------------------------------
export function isDefaultParameterSet(
  value: unknown,
): value is DefaultParameterSet {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(DEFAULT_PARAMETER_SETS, value)
  )
}

// -----------------------------------------------------------------------
// getDefaultParameterSet
// Resolves a set name to its template, rejecting unknown names and any set
// whose weights do not total exactly 100%.
// -----------------------------------------------------------------------
export function getDefaultParameterSet(
  set: DefaultParameterSet = 'HTML',
): readonly DefaultParameterTemplate[] {
  if (!isDefaultParameterSet(set)) {
    throw new Error(
      `Unknown default parameter set "${String(set)}". Expected one of: ${DEFAULT_PARAMETER_SET_NAMES.join(', ')}.`,
    )
  }

  const parameters = DEFAULT_PARAMETER_SETS[set]
  const totalWeight = parameters.reduce((sum, p) => sum + p.weight, 0)
  if (totalWeight !== 100) {
    throw new Error(
      `Default parameter set "${set}" has a total weight of ${totalWeight}%, but it must total exactly 100%.`,
    )
  }

  return parameters
}
