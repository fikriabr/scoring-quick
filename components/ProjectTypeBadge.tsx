// components/ProjectTypeBadge.tsx
// Pill badge showing a project's type. Deliberately NOT a client component —
// it renders no interactive state, so both the submissions list and the
// project detail page (server components) can render it directly.
// Requirements: 1.7

import type { ProjectType } from '@prisma/client'
import {
  PROJECT_TYPE_BADGE_CLASSES,
  projectTypeLabel,
} from '@/lib/project-type'

export default function ProjectTypeBadge({
  projectType,
}: {
  // Projects stored before the column existed carry the PARTYROCK default, so
  // there is always a label to show. Requirements: 1.2
  projectType: ProjectType | null | undefined
}) {
  const colorClass =
    PROJECT_TYPE_BADGE_CLASSES[projectType ?? 'PARTYROCK'] ??
    'bg-gray-50 text-gray-700 ring-1 ring-gray-200'

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 text-xs font-medium rounded-full ${colorClass}`}
    >
      {projectTypeLabel(projectType)}
    </span>
  )
}
