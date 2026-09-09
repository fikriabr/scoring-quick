/**
 * Property-based tests for Property 5: URL Domain Validation
 *
 * Validates: Requirements 3.2 (spec `partyrock-assessment-tool`)
 *
 * Property 5 states:
 *   For any submitted URL string, the system SHALL accept it if and only if the
 *   URL is well-formed and its domain starts with `partyrock.aws`. All other URLs
 *   SHALL be rejected with a validation error.
 *
 * Concretely, for a PartyRock submission the system accepts:
 *   - Exact domain: `partyrock.aws`
 *   - Subdomains:   `*.partyrock.aws` (e.g. `app.partyrock.aws`)
 *
 * And rejects every other well-formed (or malformed) URL.
 *
 * ---------------------------------------------------------------------------
 * SCOPE UPDATE — `html-project-scoring`
 * ---------------------------------------------------------------------------
 * The submission schemas now carry a `projectType`, so the host rule above is
 * the rule for `projectType: PARTYROCK` specifically, not for every submission:
 *
 *   - `PARTYROCK` (also the default when the field is omitted): host must be
 *     `partyrock.aws` or `*.partyrock.aws` — Property 5 unchanged.
 *   - `HTML`: any hostname is accepted, so a non-PartyRock URL that Property 5
 *     rejects is legitimately accepted here.
 *   - Both types: only the `http:` and `https:` schemes are accepted. This is a
 *     tightening — `ftp://partyrock.aws/` used to slip through because the old
 *     refinement only inspected the hostname.
 *
 * These tests therefore assert Property 5 against `PARTYROCK` (explicit and
 * defaulted) and additionally pin the `HTML` contrast cases that would
 * otherwise make the PartyRock assertions look unconditional. The full
 * type-vs-host matrix, including the client-side check, belongs to Property 21
 * (`html-project-scoring`) and is not duplicated here.
 *
 * **Validates: Requirements 3.2**
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { ProjectType } from '@prisma/client'
import { SubmissionSchema, CsvRowSchema } from '@/lib/validators/schemas'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `undefined` means "omit the field entirely", which must behave exactly like
 * `PARTYROCK` because that is the schema default (Requirement 8.1).
 */
type ProjectTypeInput = ProjectType | undefined

/** Only add `projectType` when a value was given, so `undefined` exercises the default. */
function withProjectType(
  payload: Record<string, unknown>,
  projectType: ProjectTypeInput,
): Record<string, unknown> {
  return projectType === undefined ? payload : { ...payload, projectType }
}

/** Validate only the URL field of SubmissionSchema */
function isUrlAcceptedBySubmission(url: string, projectType?: ProjectTypeInput): boolean {
  const result = SubmissionSchema.safeParse(
    withProjectType(
      {
        url,
        participantName: 'Test Participant',
        categoryId: 'clabcdef0001',
      },
      projectType,
    ),
  )
  return result.success
}

/** Validate only the URL field of CsvRowSchema */
function isUrlAcceptedByCsv(url: string, projectType?: ProjectTypeInput): boolean {
  const result = CsvRowSchema.safeParse(
    withProjectType(
      {
        url,
        participantName: 'Test Participant',
        categoryId: 'clabcdef0001',
        teamName: null,
        sourceCode: null,
      },
      projectType,
    ),
  )
  return result.success
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * The two inputs that must both mean "PartyRock submission": the explicit enum
 * value, and an omitted field falling back to the schema default.
 */
const partyRockTypeArbitrary: fc.Arbitrary<ProjectTypeInput> = fc.constantFrom(
  ProjectType.PARTYROCK,
  undefined,
)

/** URL paths: e.g. '', '/', '/app/some-path', '/path?foo=bar' */
const pathArbitrary = fc.oneof(
  fc.constant(''),
  fc.constant('/'),
  fc.stringMatching(/^\/[a-z0-9\-/]{0,30}$/).filter((s) => s.length > 0),
)

/**
 * Generates a well-formed HTTPS URL with hostname === 'partyrock.aws'.
 * These MUST pass validation.
 */
const exactPartyRockUrlArbitrary: fc.Arbitrary<string> = pathArbitrary.map(
  (path) => `https://partyrock.aws${path}`,
)

/**
 * A single DNS label usable as a subdomain: 2–20 lowercase alphanumerics or
 * hyphens, never starting or ending with a hyphen.
 *
 * `xn--` is the IDNA "punycode" prefix, and a label carrying it must decode to
 * a valid internationalised label. Most generated ones do not (`xn--a`, for
 * example), and `new URL` then refuses to parse the host at all. Rejecting such
 * a URL is correct validator behaviour, so these labels must not appear in an
 * arbitrary whose contract is "a well-formed URL that MUST be accepted" —
 * otherwise the property fails on a generator artefact rather than a real bug.
 */
const subdomainLabelArbitrary: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z0-9][a-z0-9\-]{0,18}[a-z0-9]$/)
  .filter((label) => !label.startsWith('xn--'))

/**
 * Generates a well-formed HTTPS URL with a single-segment subdomain of
 * partyrock.aws (e.g. https://app.partyrock.aws/something).
 * These MUST pass validation.
 */
const subdomainPartyRockUrlArbitrary: fc.Arbitrary<string> = fc
  .tuple(subdomainLabelArbitrary, pathArbitrary)
  .map(([sub, path]) => `https://${sub}.partyrock.aws${path}`)

/** Either form of an accepted PartyRock URL. */
const anyPartyRockUrlArbitrary: fc.Arbitrary<string> = fc.oneof(
  exactPartyRockUrlArbitrary,
  subdomainPartyRockUrlArbitrary,
)

/**
 * Generates HTTPS URLs whose hostname is a completely different domain —
 * not partyrock.aws and not a subdomain of partyrock.aws.
 * These MUST fail validation for PARTYROCK, and MUST pass for HTML.
 */
const nonPartyRockDomainArbitrary: fc.Arbitrary<string> = fc
  .oneof(
    // well-known other domains
    fc.constantFrom(
      'google.com',
      'amazon.com',
      'aws.amazon.com',
      'evil.com',
      'partyrock.com',        // similar but wrong TLD
      'partyrock.aws.evil.com', // partyrock.aws appears as a label, not as hostname
      'mypartyrock.aws',      // 'mypartyrock' is not 'partyrock'
      'fakepartyrock.aws',
      'notpartyrock.aws',
    ),
    // random hostname: 3–20 lowercase letters followed by a generic TLD
    fc
      .tuple(
        fc.stringMatching(/^[a-z]{3,15}$/),
        fc.constantFrom('.com', '.net', '.org', '.io', '.dev', '.co'),
      )
      .map(([label, tld]) => `${label}${tld}`)
      .filter((h) => h !== 'partyrock.aws'),
  )
  .map((host) => `https://${host}/some-path`)

/**
 * Generates parseable URLs that do not use the `http:`/`https:` scheme,
 * including PartyRock-hosted ones. These MUST fail validation for BOTH project
 * types: the host may be right, but the scheme never is.
 */
const nonWebSchemeUrlArbitrary: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('ftp:', 'file:', 'ws:', 'wss:', 'data:', 'javascript:', 'mailto:'),
    fc.constantFrom('partyrock.aws', 'app.partyrock.aws', 'google.com', 'example.org'),
  )
  .map(([scheme, host]) =>
    scheme === 'data:' || scheme === 'javascript:' || scheme === 'mailto:'
      ? `${scheme}${host}`
      : `${scheme}//${host}/app`,
  )

/**
 * Generates strings that are clearly not valid URLs (unparseable or missing
 * scheme). These MUST fail validation for BOTH project types because
 * `validateProjectUrl` cannot parse them at all.
 *
 * Wrong-scheme-but-parseable inputs such as `ftp://partyrock.aws/app` live in
 * `nonWebSchemeUrlArbitrary` instead — they are rejected for a different
 * reason ("must use http or https" rather than "must be a valid URL").
 */
const malformedUrlArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constant('not-a-url'),
  fc.constant('partyrock.aws'),          // missing scheme — not a valid URL
  fc.constant('//partyrock.aws/app'),    // missing scheme — not a valid URL
  fc.string().filter((s) => {
    // Only include strings that are truly unparseable as a URL
    try {
      new URL(s)
      return false // skip valid URLs in this bucket
    } catch {
      // Exclude empty string — zod min(1) handles it differently
      return s.length > 0
    }
  }),
)

// ---------------------------------------------------------------------------
// Tests — projectType: PARTYROCK (explicit or defaulted)
// ---------------------------------------------------------------------------

describe('Property 5: URL Domain Validation — SubmissionSchema (PARTYROCK)', () => {
  /**
   * Property 5a (positive): Any well-formed HTTPS URL on partyrock.aws (exact)
   * MUST be accepted by SubmissionSchema.
   *
   * **Validates: Requirements 3.2**
   */
  it('accepts any HTTPS URL on the exact partyrock.aws domain', () => {
    fc.assert(
      fc.property(exactPartyRockUrlArbitrary, partyRockTypeArbitrary, (url, projectType) => {
        expect(isUrlAcceptedBySubmission(url, projectType)).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * Property 5b (positive): Any well-formed HTTPS URL on a subdomain of
   * partyrock.aws MUST be accepted by SubmissionSchema.
   *
   * **Validates: Requirements 3.2**
   */
  it('accepts any HTTPS URL on a *.partyrock.aws subdomain', () => {
    fc.assert(
      fc.property(subdomainPartyRockUrlArbitrary, partyRockTypeArbitrary, (url, projectType) => {
        expect(isUrlAcceptedBySubmission(url, projectType)).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * Property 5c (negative): Any URL whose hostname is NOT partyrock.aws and
   * NOT a subdomain of partyrock.aws MUST be rejected by SubmissionSchema.
   *
   * **Validates: Requirements 3.2**
   */
  it('rejects any URL whose domain is not partyrock.aws or a subdomain thereof', () => {
    fc.assert(
      fc.property(nonPartyRockDomainArbitrary, partyRockTypeArbitrary, (url, projectType) => {
        expect(isUrlAcceptedBySubmission(url, projectType)).toBe(false)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * Property 5d (negative): Malformed / non-URL strings MUST be rejected.
   *
   * **Validates: Requirements 3.2**
   */
  it('rejects malformed or non-URL strings', () => {
    fc.assert(
      fc.property(malformedUrlArbitrary, partyRockTypeArbitrary, (url, projectType) => {
        expect(isUrlAcceptedBySubmission(url, projectType)).toBe(false)
      }),
      { numRuns: 100 },
    )
  })

  /**
   * Property 5e (negative): A right-host / wrong-scheme URL such as
   * `ftp://partyrock.aws/app` MUST be rejected. The hostname check alone is not
   * enough — the scheme has to be `http:` or `https:`.
   *
   * **Validates: Requirements 3.2**
   */
  it('rejects PartyRock URLs that do not use the http or https scheme', () => {
    fc.assert(
      fc.property(nonWebSchemeUrlArbitrary, partyRockTypeArbitrary, (url, projectType) => {
        expect(isUrlAcceptedBySubmission(url, projectType)).toBe(false)
      }),
      { numRuns: 200 },
    )
  })
})

describe('Property 5: URL Domain Validation — CsvRowSchema (PARTYROCK)', () => {
  /**
   * CsvRowSchema must apply the same URL domain logic as SubmissionSchema.
   *
   * **Validates: Requirements 3.2**
   */
  it('accepts any HTTPS URL on the exact partyrock.aws domain', () => {
    fc.assert(
      fc.property(exactPartyRockUrlArbitrary, partyRockTypeArbitrary, (url, projectType) => {
        expect(isUrlAcceptedByCsv(url, projectType)).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  it('accepts any HTTPS URL on a *.partyrock.aws subdomain', () => {
    fc.assert(
      fc.property(subdomainPartyRockUrlArbitrary, partyRockTypeArbitrary, (url, projectType) => {
        expect(isUrlAcceptedByCsv(url, projectType)).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  it('rejects any URL whose domain is not partyrock.aws or a subdomain thereof', () => {
    fc.assert(
      fc.property(nonPartyRockDomainArbitrary, partyRockTypeArbitrary, (url, projectType) => {
        expect(isUrlAcceptedByCsv(url, projectType)).toBe(false)
      }),
      { numRuns: 200 },
    )
  })

  it('rejects malformed or non-URL strings', () => {
    fc.assert(
      fc.property(malformedUrlArbitrary, partyRockTypeArbitrary, (url, projectType) => {
        expect(isUrlAcceptedByCsv(url, projectType)).toBe(false)
      }),
      { numRuns: 100 },
    )
  })

  it('rejects PartyRock URLs that do not use the http or https scheme', () => {
    fc.assert(
      fc.property(nonWebSchemeUrlArbitrary, partyRockTypeArbitrary, (url, projectType) => {
        expect(isUrlAcceptedByCsv(url, projectType)).toBe(false)
      }),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// Tests — projectType: HTML
//
// The contrast cases that keep the assertions above from reading as
// unconditional. The exhaustive matrix is Property 21's job.
// ---------------------------------------------------------------------------

describe('Property 5 scope: projectType HTML lifts the partyrock.aws host rule', () => {
  /**
   * The same URLs Property 5c rejects MUST be accepted once the submission is
   * declared an HTML project — the host restriction is PartyRock-specific.
   *
   * **Validates: Requirements 3.2**
   */
  it('accepts non-PartyRock HTTPS URLs that PARTYROCK rejects', () => {
    fc.assert(
      fc.property(nonPartyRockDomainArbitrary, (url) => {
        expect(isUrlAcceptedBySubmission(url, ProjectType.HTML)).toBe(true)
        expect(isUrlAcceptedByCsv(url, ProjectType.HTML)).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * Lifting the restriction must not turn into a new one: PartyRock URLs stay
   * valid for HTML projects too.
   *
   * **Validates: Requirements 3.2**
   */
  it('still accepts PartyRock URLs', () => {
    fc.assert(
      fc.property(anyPartyRockUrlArbitrary, (url) => {
        expect(isUrlAcceptedBySubmission(url, ProjectType.HTML)).toBe(true)
        expect(isUrlAcceptedByCsv(url, ProjectType.HTML)).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * The scheme restriction is type-independent, so HTML gets no relief there.
   *
   * **Validates: Requirements 3.2**
   */
  it('rejects URLs that do not use the http or https scheme', () => {
    fc.assert(
      fc.property(nonWebSchemeUrlArbitrary, (url) => {
        expect(isUrlAcceptedBySubmission(url, ProjectType.HTML)).toBe(false)
        expect(isUrlAcceptedByCsv(url, ProjectType.HTML)).toBe(false)
      }),
      { numRuns: 200 },
    )
  })

  /**
   * Neither does the "must parse as a URL" requirement.
   *
   * **Validates: Requirements 3.2**
   */
  it('rejects malformed or non-URL strings', () => {
    fc.assert(
      fc.property(malformedUrlArbitrary, (url) => {
        expect(isUrlAcceptedBySubmission(url, ProjectType.HTML)).toBe(false)
        expect(isUrlAcceptedByCsv(url, ProjectType.HTML)).toBe(false)
      }),
      { numRuns: 100 },
    )
  })
})

// ---------------------------------------------------------------------------
// Deterministic edge-case unit tests (complement the property tests)
// ---------------------------------------------------------------------------

describe('Property 5: URL Domain Validation — deterministic edge cases', () => {
  /** Accepted for every project type. */
  const partyRockUrls = [
    'https://partyrock.aws',
    'https://partyrock.aws/',
    'https://partyrock.aws/app/123',
    'https://partyrock.aws/app?foo=bar',
    'https://app.partyrock.aws',
    'https://app.partyrock.aws/',
    'https://my-app.partyrock.aws/path',
    'https://sub.partyrock.aws/app/abc?x=1',
  ]

  /** Rejected for PARTYROCK (wrong host), accepted for HTML (any host allowed). */
  const nonPartyRockWebUrls = [
    'https://google.com',
    'https://amazon.com',
    'https://partyrock.com',          // wrong TLD
    'https://mypartyrock.aws',        // prefix differs
    'https://fakepartyrock.aws',
    'https://notpartyrock.aws',
    // partyrock.aws embedded in the hostname or the path but not as the host
    'https://partyrock.aws.evil.com', // hostname is partyrock.aws.evil.com
    'https://evil.com/partyrock.aws', // partyrock.aws is just a path segment
    'http://example.com/index.html',  // plain http is allowed
  ]

  /** Rejected for every project type: unparseable, or a non-http(s) scheme. */
  const alwaysRejectedUrls = [
    // malformed
    'partyrock.aws',
    '//partyrock.aws',
    '',
    'not-a-url',
    'http://',
    // parseable, but the scheme is not http/https — right host does not save it
    'ftp://partyrock.aws/',
    'ftp://partyrock.aws/app',
    'file://partyrock.aws/app',
    'javascript:alert(1)',
    'data:text/html,<h1>hi</h1>',
  ]

  it.each(partyRockUrls)('accepts for both project types: %s', (url) => {
    expect(isUrlAcceptedBySubmission(url)).toBe(true)
    expect(isUrlAcceptedByCsv(url)).toBe(true)
    expect(isUrlAcceptedBySubmission(url, ProjectType.PARTYROCK)).toBe(true)
    expect(isUrlAcceptedByCsv(url, ProjectType.PARTYROCK)).toBe(true)
    expect(isUrlAcceptedBySubmission(url, ProjectType.HTML)).toBe(true)
    expect(isUrlAcceptedByCsv(url, ProjectType.HTML)).toBe(true)
  })

  it.each(nonPartyRockWebUrls)('rejects for PARTYROCK, accepts for HTML: %s', (url) => {
    // default (field omitted) behaves as PARTYROCK
    expect(isUrlAcceptedBySubmission(url)).toBe(false)
    expect(isUrlAcceptedByCsv(url)).toBe(false)
    expect(isUrlAcceptedBySubmission(url, ProjectType.PARTYROCK)).toBe(false)
    expect(isUrlAcceptedByCsv(url, ProjectType.PARTYROCK)).toBe(false)
    expect(isUrlAcceptedBySubmission(url, ProjectType.HTML)).toBe(true)
    expect(isUrlAcceptedByCsv(url, ProjectType.HTML)).toBe(true)
  })

  it.each(alwaysRejectedUrls)('rejects for both project types: %s', (url) => {
    expect(isUrlAcceptedBySubmission(url)).toBe(false)
    expect(isUrlAcceptedByCsv(url)).toBe(false)
    expect(isUrlAcceptedBySubmission(url, ProjectType.PARTYROCK)).toBe(false)
    expect(isUrlAcceptedByCsv(url, ProjectType.PARTYROCK)).toBe(false)
    expect(isUrlAcceptedBySubmission(url, ProjectType.HTML)).toBe(false)
    expect(isUrlAcceptedByCsv(url, ProjectType.HTML)).toBe(false)
  })
})
