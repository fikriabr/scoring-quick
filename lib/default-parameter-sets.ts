// lib/default-parameter-sets.ts
//
// The default parameter template, plus its display metadata, in a neutral
// module — no `@/lib/db`, no value import from `@prisma/client`, no Node
// built-ins — so `ParameterBuilder` (a client component) can read the set
// name, label and contents without dragging the Prisma runtime and the
// database client into the browser bundle.

import type { ScoringTrack } from '@/lib/scoring/tracks'
import { SCORING_TRACKS } from '@/lib/scoring/tracks'

/** Identifier of the shipped default parameter template. */
export type DefaultParameterSet = 'IDEA_HTML'

export type DefaultParameterTemplate = {
  name: string
  description: string
  weight: number
  minScore: number
  maxScore: number
  scoringMode: 'AUTO'
  track: ScoringTrack
  orderIndex: number
}

/**
 * Weights are per track: the IDEA parameters total 100% and the HTML
 * parameters total 100%. How the two tracks are blended (e.g. 60/40) is a
 * category setting, not part of the template.
 *
 * The IDEA descriptions deliberately say what *not* to reward (length,
 * formatting, buzzwords) — the evaluator and the critic both read them.
 */
export const DEFAULT_PARAMETER_SETS: Record<
  DefaultParameterSet,
  readonly DefaultParameterTemplate[]
> = {
  IDEA_HTML: [
    // ---- IDEA track (markdown document) ----
    {
      name: 'Problem & Relevance',
      description:
        'Is a real, specific problem identified, with a clear target user and evidence that it matters? Judge the substance, not the length or formatting of the document.',
      weight: 25,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      track: 'IDEA',
      orderIndex: 0,
    },
    {
      name: 'Originality & Innovation',
      description:
        'How novel is the solution compared with obvious or existing approaches? Buzzwords alone do not count as innovation.',
      weight: 25,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      track: 'IDEA',
      orderIndex: 1,
    },
    {
      name: 'Feasibility',
      description:
        'Is the solution realistic to build and run: concrete approach, resources, risks and constraints acknowledged?',
      weight: 20,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      track: 'IDEA',
      orderIndex: 2,
    },
    {
      name: 'Impact & Scalability',
      description:
        'What is the potential benefit if the idea succeeds, and can it grow beyond the first use case?',
      weight: 20,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      track: 'IDEA',
      orderIndex: 3,
    },
    {
      name: 'Clarity of Idea',
      description:
        'Can a reader understand what the idea is, who it is for and how it works? Rewards clear reasoning, not polished styling or document length.',
      weight: 10,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      track: 'IDEA',
      orderIndex: 4,
    },
    // ---- HTML track (static page generated with Quick) ----
    // The generator decides markup quality, accessibility and SEO, so these
    // judge what the participant shaped: the content and how it is composed.
    {
      name: 'Idea Communication',
      description:
        'Judge from the visible text: does the page on its own make clear what the product is, the problem it solves and who it is for? Judge how clearly the idea is presented, not how good the idea is.',
      weight: 25,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      track: 'HTML',
      orderIndex: 5,
    },
    {
      name: 'Content Quality & Specificity',
      description:
        'Judge the visible text: specific, relevant, domain-appropriate content versus generic template copy, lorem ipsum or filler. Ignore styling and markup.',
      weight: 25,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      track: 'HTML',
      orderIndex: 6,
    },
    {
      name: 'Page Completeness',
      description:
        'Does the page have the sections a product page needs — value proposition, features or how it works, benefits or use cases, a call to action — with no placeholder sections, dead "#" links or "coming soon" stubs?',
      weight: 20,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      track: 'HTML',
      orderIndex: 7,
    },
    {
      name: 'Information Flow',
      description:
        'Are the sections in a logical order for a first-time reader, do the headings guide the reader through the page, and does the navigation match the sections? Ignore styling.',
      weight: 15,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      track: 'HTML',
      orderIndex: 8,
    },
    {
      name: 'Presentation Polish',
      description:
        'Is the page free of leftover template artefacts, with meaningful button and call-to-action labels, relevant images and consistent naming? Judge from the source; do not guess how the page renders.',
      weight: 15,
      minScore: 0,
      maxScore: 100,
      scoringMode: 'AUTO',
      track: 'HTML',
      orderIndex: 9,
    },
  ],
}

/** Names of every available default parameter set, for messages and UI. */
export const DEFAULT_PARAMETER_SET_NAMES = Object.keys(
  DEFAULT_PARAMETER_SETS,
) as DefaultParameterSet[]

/** Render order for the template selector, rather than relying on key order. */
export const DEFAULT_PARAMETER_SET_ORDER: DefaultParameterSet[] = ['IDEA_HTML']

/**
 * Human-readable label for the set. The only place a raw set identifier gets
 * turned into UI copy — adding a set makes this map fail to typecheck, which is
 * the point: no template may reach the admin unlabelled.
 */
export const DEFAULT_PARAMETER_SET_LABELS: Record<DefaultParameterSet, string> = {
  IDEA_HTML: 'Idea (MD) + HTML',
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
// whose weights do not total exactly 100% within each track.
// -----------------------------------------------------------------------
export function getDefaultParameterSet(
  set: DefaultParameterSet = 'IDEA_HTML',
): readonly DefaultParameterTemplate[] {
  if (!isDefaultParameterSet(set)) {
    throw new Error(
      `Unknown default parameter set "${String(set)}". Expected one of: ${DEFAULT_PARAMETER_SET_NAMES.join(', ')}.`,
    )
  }

  const parameters = DEFAULT_PARAMETER_SETS[set]
  for (const track of SCORING_TRACKS) {
    const totalWeight = parameters
      .filter((p) => p.track === track)
      .reduce((sum, p) => sum + p.weight, 0)
    if (totalWeight !== 100) {
      throw new Error(
        `Default parameter set "${set}" has a ${track} track weight of ${totalWeight}%, but each track must total exactly 100%.`,
      )
    }
  }

  return parameters
}
