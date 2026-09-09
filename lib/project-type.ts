// lib/project-type.ts
//
// Display metadata for the `ProjectType` enum. Kept in a neutral module — no
// `'use client'`, no `@/lib/db`, no Node built-ins — so the submission form
// (client component), the submissions list, and the project detail page (both
// server components) all read the same labels and can never drift apart.
// `ProjectType` is imported as a *type* only so the Prisma runtime never ends
// up in the client bundle.
//
// Requirements: 1.3, 1.7

import type { ProjectType } from '@prisma/client'

/**
 * Human-readable label for each project type. This is the only place a raw
 * enum value gets turned into UI copy. Adding a value to the Prisma enum makes
 * this map fail to typecheck, which is the point — no project type may reach
 * the UI unlabelled.
 */
export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  PARTYROCK: 'PartyRock',
  HTML: 'HTML',
}

/**
 * Tailwind classes for the project type pill, deliberately outside the
 * amber/blue/emerald/red/orange palette the crawl and score status badges use
 * so a type is never mistaken for a status.
 */
export const PROJECT_TYPE_BADGE_CLASSES: Record<ProjectType, string> = {
  PARTYROCK: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200',
  HTML: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200',
}

/** Render order for selectors and legends, rather than relying on key order. */
export const PROJECT_TYPE_ORDER: ProjectType[] = ['PARTYROCK', 'HTML']

/**
 * Label for a project type read off a database row.
 *
 * Rows written before the project type column existed carry the `PARTYROCK`
 * default, so they render as "PartyRock" rather than as a blank cell. The
 * `null`/`undefined` fallback covers callers holding a loosely typed row.
 * Requirements: 1.2, 1.7
 */
export function projectTypeLabel(
  projectType: ProjectType | null | undefined,
): string {
  return PROJECT_TYPE_LABELS[projectType ?? 'PARTYROCK']
}
