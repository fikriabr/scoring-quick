/**
 * __tests__/submission-grouping.test.ts
 *
 * Unit tests for `groupProjectsByCategory`, the pure grouping function behind
 * the admin submissions list. These verify the concrete example behaviours the
 * design calls out: mixed categories partition into the right groups, a name
 * shared across events still yields distinct groups, groups sort A-Z
 * case-insensitively, empty/singleton edge cases, and the em-dash heading.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8
 */

import { describe, it, expect } from 'vitest'
import {
  groupProjectsByCategory,
  type GroupableProject,
} from '@/lib/submission-grouping'

type Project = GroupableProject & { id: string }

// A fixed default so tests that don't care about category-creation order all
// share the same timestamp and fall through to the deterministic tie-break
// (eventName, then categoryName). Tests that assert createdAt ordering pass an
// explicit value.
const DEFAULT_CATEGORY_CREATED_AT = '2025-01-01T00:00:00.000Z'

const project = (
  id: string,
  categoryId: string,
  categoryName: string,
  eventName: string,
  categoryCreatedAt: string = DEFAULT_CATEGORY_CREATED_AT,
): Project => ({
  id,
  categoryId,
  categoryName,
  categoryCreatedAt,
  eventName,
})

describe('groupProjectsByCategory', () => {
  it('splits two interleaved categories into two groups with the right projects', () => {
    // Interleaved by time, as they would arrive from a createdAt-desc query.
    const projects: Project[] = [
      project('p1', 'ai', 'AI Track', 'Hackathon 2025'),
      project('p2', 'web', 'Web Track', 'Hackathon 2025'),
      project('p3', 'ai', 'AI Track', 'Hackathon 2025'),
      project('p4', 'web', 'Web Track', 'Hackathon 2025'),
      project('p5', 'ai', 'AI Track', 'Hackathon 2025'),
    ]

    const groups = groupProjectsByCategory(projects)

    expect(groups).toHaveLength(2)

    const ai = groups.find((g) => g.categoryId === 'ai')!
    const web = groups.find((g) => g.categoryId === 'web')!

    expect(ai.projects.map((p) => p.id)).toEqual(['p1', 'p3', 'p5'])
    expect(web.projects.map((p) => p.id)).toEqual(['p2', 'p4'])
  })

  it('preserves createdAt-desc order of projects within each group', () => {
    const projects: Project[] = [
      project('p1', 'ai', 'AI Track', 'Hackathon 2025'),
      project('p2', 'ai', 'AI Track', 'Hackathon 2025'),
      project('p3', 'ai', 'AI Track', 'Hackathon 2025'),
    ]

    const [group] = groupProjectsByCategory(projects)

    expect(group.projects.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('keeps categories with the same name but different ids as separate groups', () => {
    const projects: Project[] = [
      project('p1', 'ai-2024', 'AI Track', 'Hackathon 2024'),
      project('p2', 'ai-2025', 'AI Track', 'Hackathon 2025'),
    ]

    const groups = groupProjectsByCategory(projects)

    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.categoryId)).toEqual(['ai-2024', 'ai-2025'])
    expect(groups.map((g) => g.heading)).toEqual([
      'Hackathon 2024 — AI Track',
      'Hackathon 2025 — AI Track',
    ])
  })

  it('sorts groups by category creation time, newest first', () => {
    // Categories created out of alphabetical order: the sort must follow
    // createdAt, not the names. Insertion order here is also deliberately not
    // the expected output order.
    const projects: Project[] = [
      project('p1', 'zebra', 'Zebra', 'Event', '2025-03-01T00:00:00.000Z'),
      project('p2', 'apple', 'Apple', 'Event', '2025-01-01T00:00:00.000Z'),
      project('p3', 'mango', 'Mango', 'Event', '2025-02-01T00:00:00.000Z'),
    ]

    const groups = groupProjectsByCategory(projects)

    // zebra (Mar) → mango (Feb) → apple (Jan): newest category first.
    expect(groups.map((g) => g.categoryId)).toEqual(['zebra', 'mango', 'apple'])
  })

  it('falls back to event then category name when createdAt is identical', () => {
    // All share DEFAULT_CATEGORY_CREATED_AT, so the deterministic tie-break
    // (event, then category name, case-insensitive) decides the order.
    const projects: Project[] = [
      project('p1', 'zebra', 'zebra', 'beta event'),
      project('p2', 'apple', 'Apple', 'Alpha Event'),
      project('p3', 'web', 'web', 'Alpha Event'),
      project('p4', 'design', 'Design', 'Alpha Event'),
    ]

    const groups = groupProjectsByCategory(projects)

    expect(groups.map((g) => g.heading)).toEqual([
      'Alpha Event — Apple',
      'Alpha Event — Design',
      'Alpha Event — web',
      'beta event — zebra',
    ])
  })

  it('returns an empty array for an empty list', () => {
    expect(groupProjectsByCategory([])).toEqual([])
  })

  it('returns a single group with one project for a singleton list', () => {
    const groups = groupProjectsByCategory([
      project('p1', 'ai', 'AI Track', 'Hackathon 2025'),
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].projects).toHaveLength(1)
    expect(groups[0].projects[0].id).toBe('p1')
  })

  it('builds the heading as `Event — Category` with an em dash, not a hyphen', () => {
    const [group] = groupProjectsByCategory([
      project('p1', 'ai', 'AI Track', 'Hackathon 2025'),
    ])

    expect(group.heading).toBe('Hackathon 2025 — AI Track')
    // Explicitly assert the em dash (U+2014) and that no hyphen separator sneaks in.
    expect(group.heading).toContain(' — ')
    expect(group.heading).not.toContain(' - ')
  })
})
