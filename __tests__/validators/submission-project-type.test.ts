/**
 * Unit tests for type-aware URL validation on the submission schemas.
 *
 * The URL rule now depends on a sibling field (`projectType`), so it lives on
 * an object-level `superRefine`. These tests pin down the three behaviours that
 * matter: the PARTYROCK host restriction, the HTML "any host" allowance, and
 * the PARTYROCK fallback when `projectType` is absent — the last one being what
 * keeps every pre-existing caller working unchanged.
 *
 * Validates: Requirements 2.1, 2.2, 2.4, 2.6, 1.2, 8.1
 */

import { describe, it, expect } from 'vitest'
import {
  SubmissionSchema,
  CsvRowSchema,
  CsvRowRawSchema,
  CaptureSchema,
} from '@/lib/validators/schemas'

// ---------------------------------------------------------------------------
// Helpers — build a minimally valid payload and let the test vary the URL
// and the project type only.
// ---------------------------------------------------------------------------

function parseSubmission(url: string, projectType?: string) {
  return SubmissionSchema.safeParse({
    ...(projectType === undefined ? {} : { projectType }),
    url,
    participantName: 'Test Participant',
    categoryId: 'clabcdef0001',
  })
}

function parseCsvRow(url: string, projectType?: string) {
  return CsvRowSchema.safeParse({
    ...(projectType === undefined ? {} : { projectType }),
    url,
    participantName: 'Test Participant',
    categoryId: 'clabcdef0001',
    teamName: null,
    sourceCode: null,
  })
}

/** All issue messages recorded against the `url` field. */
function urlIssues(result: { success: boolean; error?: { issues: { path: (string | number | symbol)[]; message: string }[] } }) {
  if (result.success || !result.error) return []
  return result.error.issues
    .filter((issue) => issue.path[0] === 'url')
    .map((issue) => issue.message)
}

const NON_PARTYROCK_URL = 'https://my-portfolio.example.com/index.html'
const PARTYROCK_URL = 'https://partyrock.aws/app/abc123'

// ---------------------------------------------------------------------------
// SubmissionSchema
// ---------------------------------------------------------------------------

describe('SubmissionSchema — projectType drives the URL rule', () => {
  it('accepts a non-PartyRock URL when projectType is HTML', () => {
    const result = parseSubmission(NON_PARTYROCK_URL, 'HTML')
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.projectType).toBe('HTML')
      expect(result.data.url).toBe(NON_PARTYROCK_URL)
    }
  })

  it('rejects the same URL when projectType is PARTYROCK, reporting the domain rule on the url field', () => {
    const result = parseSubmission(NON_PARTYROCK_URL, 'PARTYROCK')
    expect(result.success).toBe(false)
    expect(urlIssues(result)).toContain(
      'URL must be a valid PartyRock URL (domain: partyrock.aws)',
    )
  })

  it('falls back to PARTYROCK when projectType is absent', () => {
    const withoutType = parseSubmission(NON_PARTYROCK_URL)
    expect(withoutType.success).toBe(false)
    expect(urlIssues(withoutType)).toContain(
      'URL must be a valid PartyRock URL (domain: partyrock.aws)',
    )

    const partyRock = parseSubmission(PARTYROCK_URL)
    expect(partyRock.success).toBe(true)
    if (partyRock.success) {
      expect(partyRock.data.projectType).toBe('PARTYROCK')
    }
  })

  it('accepts a PartyRock URL for both project types', () => {
    expect(parseSubmission(PARTYROCK_URL, 'PARTYROCK').success).toBe(true)
    expect(parseSubmission(PARTYROCK_URL, 'HTML').success).toBe(true)
  })

  it('rejects a non-http(s) scheme for both project types', () => {
    for (const projectType of ['PARTYROCK', 'HTML']) {
      const result = parseSubmission('ftp://example.com/index.html', projectType)
      expect(result.success).toBe(false)
      expect(urlIssues(result)).toContain('URL must use http or https')
    }
  })

  it('rejects an unrecognised projectType value', () => {
    const result = parseSubmission(PARTYROCK_URL, 'WORDPRESS')
    expect(result.success).toBe(false)
  })

  it('reports a missing url once, without a second host-rule issue', () => {
    const result = SubmissionSchema.safeParse({
      url: '',
      participantName: 'Test Participant',
      categoryId: 'clabcdef0001',
    })
    expect(result.success).toBe(false)
    expect(urlIssues(result)).toEqual(['URL is required'])
  })
})

// ---------------------------------------------------------------------------
// CsvRowSchema
// ---------------------------------------------------------------------------

describe('CsvRowSchema — projectType drives the URL rule', () => {
  it('accepts a non-PartyRock URL when projectType is HTML', () => {
    const result = parseCsvRow(NON_PARTYROCK_URL, 'HTML')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.projectType).toBe('HTML')
  })

  it('rejects the same URL when projectType is PARTYROCK', () => {
    const result = parseCsvRow(NON_PARTYROCK_URL, 'PARTYROCK')
    expect(result.success).toBe(false)
    expect(urlIssues(result)).toContain(
      'URL must be a valid PartyRock URL (domain: partyrock.aws)',
    )
  })

  it('falls back to PARTYROCK when projectType is absent', () => {
    expect(parseCsvRow(NON_PARTYROCK_URL).success).toBe(false)

    const partyRock = parseCsvRow(PARTYROCK_URL)
    expect(partyRock.success).toBe(true)
    if (partyRock.success) expect(partyRock.data.projectType).toBe('PARTYROCK')
  })
})

// ---------------------------------------------------------------------------
// CsvRowRawSchema — the .pipe() into CsvRowSchema must keep working even
// though the raw transform does not forward a projectType yet.
// ---------------------------------------------------------------------------

describe('CsvRowRawSchema — pipes into CsvRowSchema with the default project type', () => {
  it('defaults to PARTYROCK for a snake_case row without a project type column', () => {
    const result = CsvRowRawSchema.safeParse({
      url: PARTYROCK_URL,
      participant_name: 'Ayu',
      team_name: 'Tim Satu',
      category_id: 'clabcdef0001',
    })

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.projectType).toBe('PARTYROCK')
      expect(result.data.participantName).toBe('Ayu')
      expect(result.data.teamName).toBe('Tim Satu')
      expect(result.data.sourceCode).toBeNull()
    }
  })

  it('still rejects a non-PartyRock URL for a row without a project type column', () => {
    const result = CsvRowRawSchema.safeParse({
      url: NON_PARTYROCK_URL,
      participant_name: 'Ayu',
      category_id: 'clabcdef0001',
    })

    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// CaptureSchema — unchanged: the capture pipeline is PartyRock-only.
// Requirement 2.6
// ---------------------------------------------------------------------------

describe('CaptureSchema — stays PartyRock-only', () => {
  it('accepts a partyrock.aws URL', () => {
    const result = CaptureSchema.safeParse({ url: PARTYROCK_URL })
    expect(result.success).toBe(true)
  })

  it('rejects a non-PartyRock URL regardless of any projectType hint', () => {
    expect(CaptureSchema.safeParse({ url: NON_PARTYROCK_URL }).success).toBe(false)
    expect(
      CaptureSchema.safeParse({ url: NON_PARTYROCK_URL, projectType: 'HTML' }).success,
    ).toBe(false)
  })
})
