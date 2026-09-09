/**
 * __tests__/default-parameter-set-labels.test.ts
 *
 * Unit tests for the display metadata of the default parameter templates, read
 * by the template selector in `ParameterBuilder` (a client component).
 *
 * Two things matter here:
 *   - every shipped set has a human label and a place in the render order, so
 *     no raw identifier such as "PARTYROCK" ever reaches the admin;
 *   - `lib/default-parameter-sets.ts` stays free of server-only imports, since
 *     that is the whole reason the templates were moved out of
 *     `lib/services/category.service.ts`.
 *
 * Requirements: 6.3
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The service under comparison imports the Prisma singleton at module load.
// Nothing here touches the database, so the singleton is stubbed away.
vi.mock('@/lib/db', () => {
  const db = { parameter: { createMany: vi.fn() } }
  return { db, prisma: db }
})

import {
  DEFAULT_PARAMETER_SETS,
  DEFAULT_PARAMETER_SET_LABELS,
  DEFAULT_PARAMETER_SET_NAMES,
  DEFAULT_PARAMETER_SET_ORDER,
} from '@/lib/default-parameter-sets'
import {
  DEFAULT_PARAMETER_SETS as SETS_VIA_SERVICE,
  DEFAULT_PARAMETER_SET_LABELS as LABELS_VIA_SERVICE,
} from '@/lib/services/category.service'

describe('default parameter set display metadata', () => {
  it('labels every shipped set', () => {
    for (const set of DEFAULT_PARAMETER_SET_NAMES) {
      expect(DEFAULT_PARAMETER_SET_LABELS[set]?.trim()).toBeTruthy()
    }
  })

  it('never shows a raw set identifier as the label', () => {
    for (const set of DEFAULT_PARAMETER_SET_NAMES) {
      expect(DEFAULT_PARAMETER_SET_LABELS[set]).not.toBe(set)
    }
  })

  it('gives each set a distinct label', () => {
    const labels = DEFAULT_PARAMETER_SET_NAMES.map(
      (set) => DEFAULT_PARAMETER_SET_LABELS[set],
    )
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('orders exactly the shipped sets, without duplicates', () => {
    expect([...DEFAULT_PARAMETER_SET_ORDER].sort()).toEqual(
      [...DEFAULT_PARAMETER_SET_NAMES].sort(),
    )
    expect(new Set(DEFAULT_PARAMETER_SET_ORDER).size).toBe(
      DEFAULT_PARAMETER_SET_ORDER.length,
    )
  })

  // The selector summary shows "<name> (<weight>%)" for each parameter, so both
  // fields have to be present on every row of every set. Requirements: 6.3
  it('gives every template row a name and a weight to display', () => {
    for (const set of DEFAULT_PARAMETER_SET_NAMES) {
      for (const parameter of DEFAULT_PARAMETER_SETS[set]) {
        expect(parameter.name.trim()).toBeTruthy()
        expect(parameter.weight).toBeGreaterThan(0)
      }
    }
  })
})

describe('lib/default-parameter-sets.ts stays importable from the browser', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../lib/default-parameter-sets.ts', import.meta.url)),
    'utf8',
  )
  // Comments explain *why* the module avoids these imports, so only real import
  // statements are inspected.
  const importLines = source
    .split('\n')
    .filter((line) => /^\s*import\b/.test(line))

  it('imports nothing at all, server-only or otherwise', () => {
    expect(importLines).toEqual([])
  })

  it('is the single source the service re-exports', () => {
    expect(SETS_VIA_SERVICE).toBe(DEFAULT_PARAMETER_SETS)
    expect(LABELS_VIA_SERVICE).toBe(DEFAULT_PARAMETER_SET_LABELS)
  })
})
