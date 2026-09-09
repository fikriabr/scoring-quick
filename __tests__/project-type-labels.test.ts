/**
 * __tests__/project-type-labels.test.ts
 *
 * Unit tests for the shared project type display metadata that the submission
 * form, the submissions list, and the project detail page all read from.
 *
 * What matters here: every enum value has a label and a pill style, and
 * projects carrying the PARTYROCK default never render as an empty cell.
 *
 * Requirements: 1.2, 1.7
 */

import { describe, it, expect } from 'vitest'
import { ProjectType } from '@prisma/client'
import {
  PROJECT_TYPE_BADGE_CLASSES,
  PROJECT_TYPE_LABELS,
  PROJECT_TYPE_ORDER,
  projectTypeLabel,
} from '@/lib/project-type'

const ALL_TYPES = Object.values(ProjectType)

describe('project type display metadata', () => {
  it('labels every value of the Prisma enum', () => {
    for (const type of ALL_TYPES) {
      expect(PROJECT_TYPE_LABELS[type]).toBeTruthy()
    }
  })

  it('styles every value of the Prisma enum', () => {
    for (const type of ALL_TYPES) {
      expect(PROJECT_TYPE_BADGE_CLASSES[type]).toBeTruthy()
    }
  })

  it('orders exactly the values of the Prisma enum, without duplicates', () => {
    expect([...PROJECT_TYPE_ORDER].sort()).toEqual([...ALL_TYPES].sort())
    expect(new Set(PROJECT_TYPE_ORDER).size).toBe(PROJECT_TYPE_ORDER.length)
  })
})

describe('projectTypeLabel', () => {
  it('returns the label of the given type', () => {
    expect(projectTypeLabel(ProjectType.PARTYROCK)).toBe('PartyRock')
    expect(projectTypeLabel(ProjectType.HTML)).toBe('HTML')
  })

  // Projects created before the column existed carry the PARTYROCK default, so
  // the list and detail pages must still show something. Requirements: 1.2
  it('falls back to the PARTYROCK label for a missing value', () => {
    expect(projectTypeLabel(null)).toBe(PROJECT_TYPE_LABELS.PARTYROCK)
    expect(projectTypeLabel(undefined)).toBe(PROJECT_TYPE_LABELS.PARTYROCK)
  })

  it('never returns an empty string', () => {
    for (const type of [...ALL_TYPES, null, undefined]) {
      expect(projectTypeLabel(type).length).toBeGreaterThan(0)
    }
  })
})
