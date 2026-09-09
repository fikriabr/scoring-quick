// lib/default-parameter-sets.ts
//
// The default parameter templates, plus their display metadata, in a neutral
// module — no `@/lib/db`, no value import from `@prisma/client`, no Node
// built-ins — so `ParameterBuilder` (a client component) can read the set
// names, labels and contents without dragging the Prisma runtime and the
// database client into the browser bundle.
//
// These lived in `lib/services/category.service.ts`, which imports `@/lib/db`
// and `@prisma/client` as values. That service now imports from here and
// re-exports everything, so existing call sites and tests keep working. Same
// pattern as `lib/validators/source-code-rules.ts` and `lib/project-type.ts`.
//
// Requirements: 6.1, 6.2, 6.3, 6.4

/** Identifier of a shipped default parameter template. */
export type DefaultParameterSet = 'PARTYROCK' | 'HTML'

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
  // ---------------------------------------------------------------------
  // PARTYROCK — preserved exactly as originally shipped (Requirement 6.4).
  // Names, descriptions and weights must not change.
  // ---------------------------------------------------------------------
  PARTYROCK: [
    {
      name: 'Creativity & Originality',
      description: 'How creative and original is the application compared to others?',
      weight: 20,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      orderIndex: 0,
    },
    {
      name: 'Problem-Solution Fit',
      description: 'How well does the application address a real problem?',
      weight: 25,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      orderIndex: 1,
    },
    {
      name: 'Effective Use of PartyRock Features',
      description: 'How effectively does the application leverage PartyRock widgets?',
      weight: 20,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      orderIndex: 2,
    },
    {
      name: 'User Experience & Presentation',
      description: 'How clear and compelling is the application presentation?',
      weight: 20,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      orderIndex: 3,
    },
    {
      name: 'Impact & Scalability',
      description: 'What is the potential impact and scalability of the application?',
      weight: 15,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      orderIndex: 4,
    },
  ],
  // ---------------------------------------------------------------------
  // HTML — template for web projects (Requirement 6.1).
  // "User Experience & Presentation" and "Impact & Scalability" appear in
  // both sets on purpose, with weights tuned for web projects.
  // ---------------------------------------------------------------------
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

/**
 * Render order for the template selector, rather than relying on key order.
 * PartyRock stays first because it is the default the action falls back to.
 */
export const DEFAULT_PARAMETER_SET_ORDER: DefaultParameterSet[] = [
  'PARTYROCK',
  'HTML',
]

/**
 * Human-readable label for each set. The only place a raw set identifier gets
 * turned into UI copy — adding a set makes this map fail to typecheck, which is
 * the point: no template may reach the admin unlabelled.
 * Requirements: 6.3
 */
export const DEFAULT_PARAMETER_SET_LABELS: Record<DefaultParameterSet, string> = {
  PARTYROCK: 'PartyRock project',
  HTML: 'HTML / web project',
}

// -----------------------------------------------------------------------
// isDefaultParameterSet
// Type guard for values arriving from untrusted sources (server actions).
// Requirements: 6.3
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
// Requirements: 6.1, 6.2
// -----------------------------------------------------------------------
export function getDefaultParameterSet(
  set: DefaultParameterSet = 'PARTYROCK',
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
