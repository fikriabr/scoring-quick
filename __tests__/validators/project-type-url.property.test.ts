/**
 * Property-based tests for Property 21: Project Type Determines URL Validation
 *
 * Property 21 states:
 *   _For any_ well-formed `http`/`https` URL and any project type, the system
 *   SHALL accept the submission if and only if either the project type is
 *   `HTML`, or the project type is `PARTYROCK` and the URL hostname equals
 *   `partyrock.aws` or ends with `.partyrock.aws`. URLs using any other scheme
 *   SHALL be rejected for both project types. The same decision SHALL be
 *   produced by the single-submission path, the CSV import path, and the
 *   client-side check.
 *
 * ---------------------------------------------------------------------------
 * What this file adds over Property 5 (`url-domain.property.test.ts`)
 * ---------------------------------------------------------------------------
 * Property 5 pins the PartyRock host rule and a few HTML contrast cases. The
 * two clauses that belong to Property 21 alone are tested here:
 *
 *   1. The **iff** clause. Rather than enumerating known-good and known-bad
 *      hosts, each generated URL's expected outcome is recomputed
 *      independently from `new URL(url).hostname` and compared against what the
 *      schema decided. A host the generator never thought of cannot slip past.
 *   2. The **three-path agreement** clause. `SubmissionSchema`, `CsvRowSchema`
 *      and the client-side check must return the same accept/reject decision
 *      *and* the same message for the same input.
 *
 * The "client-side check" is `validateProjectUrl`, the function
 * `components/SubmissionForm.tsx` calls. It is exercised directly rather than
 * by rendering the component: this repository has no React testing-library
 * installed, and adding one is out of scope for this task. Testing the shared
 * function is also the stronger assertion — the form has no URL rule of its
 * own left to drift, which is the point of Requirement 2.5.
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.5**
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { ProjectType } from '@prisma/client'
import { SubmissionSchema, CsvRowSchema } from '@/lib/validators/schemas'
import { isPartyRockHost, validateProjectUrl } from '@/lib/validators/url-rules'

// ---------------------------------------------------------------------------
// The three paths under test
// ---------------------------------------------------------------------------

/**
 * `undefined` means "the field was omitted", which must behave exactly like
 * `PARTYROCK` because that is the schema default (Requirement 8.1). The client
 * always has a concrete type in hand, so it gets the resolved value.
 */
type ProjectTypeInput = ProjectType | undefined

/** Normalised outcome, so the three paths can be compared field by field. */
interface Decision {
  accepted: boolean
  /** Messages recorded against the `url` field, in order. */
  messages: string[]
}

function resolveType(projectType: ProjectTypeInput): ProjectType {
  return projectType ?? ProjectType.PARTYROCK
}

/**
 * Whether `new URL` accepts the string at all. Used to keep generator artefacts
 * out of the arbitraries that promise a *well-formed* URL: an unparseable input
 * is rejected by every path (correctly, and covered by
 * `malformedUrlArbitrary`), so it must not reach the assertions about hostnames
 * or schemes.
 */
function isParseableUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

function withProjectType(
  payload: Record<string, unknown>,
  projectType: ProjectTypeInput,
): Record<string, unknown> {
  return projectType === undefined ? payload : { ...payload, projectType }
}

/**
 * Structural shape shared by both schemas' `safeParse` results, so the two
 * server paths can be funnelled through one converter without casting between
 * unrelated zod result types.
 */
interface SafeParseLike {
  success: boolean
  error?: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }
}

function toDecision(result: SafeParseLike): Decision {
  if (result.success || !result.error) return { accepted: true, messages: [] }
  return {
    accepted: false,
    messages: result.error.issues
      .filter((issue) => issue.path[0] === 'url')
      .map((issue) => issue.message),
  }
}

/** Path 1 — single submission (`POST /api/submissions`). */
function submissionDecision(url: string, projectType: ProjectTypeInput): Decision {
  return toDecision(
    SubmissionSchema.safeParse(
      withProjectType(
        {
          url,
          participantName: 'Test Participant',
          categoryId: 'clabcdef0001',
        },
        projectType,
      ),
    ),
  )
}

/** Path 2 — bulk CSV import. */
function csvDecision(url: string, projectType: ProjectTypeInput): Decision {
  return toDecision(
    CsvRowSchema.safeParse(
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
    ),
  )
}

/** Path 3 — client-side check performed by `SubmissionForm`. */
function clientDecision(url: string, projectType: ProjectTypeInput): Decision {
  const result = validateProjectUrl(url, resolveType(projectType))
  return result.ok
    ? { accepted: true, messages: [] }
    : { accepted: false, messages: [result.message] }
}

/**
 * The oracle: the property's own accept condition, recomputed from the parsed
 * hostname without consulting any of the three paths.
 */
function expectedAccept(url: string, projectType: ProjectTypeInput): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return resolveType(projectType) === ProjectType.HTML || isPartyRockHost(parsed.hostname)
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const projectTypeArbitrary: fc.Arbitrary<ProjectTypeInput> = fc.constantFrom(
  ProjectType.PARTYROCK,
  ProjectType.HTML,
  undefined,
)

/**
 * A single DNS label: lowercase alphanumerics and inner hyphens.
 *
 * `xn--` is the IDNA "punycode" prefix, and a label carrying it must decode to
 * a valid internationalised label. Most generated ones do not (`xn--a`, for
 * example), and `new URL` then refuses to parse the host at all. That is not a
 * hostname the rule under test is about — it is an unparseable URL — so those
 * labels are filtered out here, at the source, rather than in each arbitrary
 * that builds a URL string from a host.
 */
const labelArbitrary = fc
  .stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/)
  .filter((label) => !label.startsWith('xn--'))

/** `partyrock.aws` itself, plus subdomains up to three levels deep. */
const partyRockHostArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constant('partyrock.aws'),
  fc
    .array(labelArbitrary, { minLength: 1, maxLength: 3 })
    .map((labels) => `${labels.join('.')}.partyrock.aws`),
)

/**
 * Hosts engineered to look like the PartyRock domain without being it — the
 * cases a substring check would wave through. Some entries *do* legitimately
 * end with `.partyrock.aws`; they are kept deliberately so the test cannot be
 * satisfied by a blanket "lookalike means reject" rule.
 */
const lookalikeHostArbitrary: fc.Arbitrary<string> = fc.constantFrom(
  'partyrock.aws.evil.com',
  'partyrock.aws.co',
  'mypartyrock.aws',
  'notpartyrock.aws',
  'xpartyrock.aws',
  'partyrockaws',
  'partyrock.com',
  'aws.partyrock.com',
  'sub.mypartyrock.aws',
  'partyrock-aws.com',
  'partyrock.aws.partyrock.aws.evil.com',
  // genuine subdomains that happen to read as hostile
  'evil.partyrock.aws',
  'partyrock.aws.partyrock.aws',
)

/** Ordinary third-party hosts. */
const genericHostArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'google.com',
    'example.org',
    'aws.amazon.com',
    'my-portfolio.example.com',
    'localhost',
    '127.0.0.1',
  ),
  fc
    .tuple(labelArbitrary, fc.constantFrom('com', 'net', 'org', 'io', 'dev', 'aws'))
    .map(([label, tld]) => `${label}.${tld}`),
)

const hostArbitrary: fc.Arbitrary<string> = fc
  .oneof(
    { arbitrary: partyRockHostArbitrary, weight: 3 },
    { arbitrary: lookalikeHostArbitrary, weight: 3 },
    { arbitrary: genericHostArbitrary, weight: 2 },
  )
  // `nonWebSchemeUrlArbitrary` and P21-d splice a host straight into a URL
  // string, bypassing `webUrlArbitrary`'s filter, so the "host is usable in a
  // URL" invariant is pinned here instead of at each of those call sites.
  .filter((host) => isParseableUrl(`https://${host}`))

/**
 * Hostnames are case-insensitive and `new URL` lowercases them, so the
 * decision must not depend on how the admin typed the host.
 */
function applyCase(host: string, mode: 'lower' | 'upper' | 'title'): string {
  if (mode === 'upper') return host.toUpperCase()
  if (mode === 'title') {
    return host
      .split('.')
      .map((label) => label.charAt(0).toUpperCase() + label.slice(1))
      .join('.')
  }
  return host.toLowerCase()
}

const caseModeArbitrary = fc.constantFrom('lower' as const, 'upper' as const, 'title' as const)

/**
 * Well-formed `http`/`https` URLs with the trimmings a real submission carries:
 * userinfo, port, path, query, fragment, and arbitrary host casing. All of
 * these are noise as far as the rule goes — only the parsed hostname counts.
 */
function webUrlArbitrary(hosts: fc.Arbitrary<string> = hostArbitrary): fc.Arbitrary<string> {
  return fc
    .record({
      scheme: fc.constantFrom('http', 'https'),
      userinfo: fc.constantFrom('', 'user@', 'user:pass@'),
      host: hosts,
      caseMode: caseModeArbitrary,
      port: fc.constantFrom('', ':80', ':443', ':8080', ':3000'),
      path: fc.constantFrom('', '/', '/app/abc123', '/index.html', '/a/b/c'),
      query: fc.constantFrom('', '?a=1', '?a=1&b=partyrock.aws'),
      fragment: fc.constantFrom('', '#top', '#partyrock.aws'),
    })
    .map(
      ({ scheme, userinfo, host, caseMode, port, path, query, fragment }) =>
        `${scheme}://${userinfo}${applyCase(host, caseMode)}${port}${path}${query}${fragment}`,
    )
    .filter(isParseableUrl)
}

/** Parseable URLs on a scheme that is never allowed, PartyRock host or not. */
const nonWebSchemeUrlArbitrary: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('ftp', 'file', 'ws', 'wss', 'gopher', 'chrome'),
    hostArbitrary,
    fc.constantFrom('', '/', '/app/abc123'),
  )
  .map(([scheme, host, path]) => `${scheme}://${host}${path}`)

/** Schemes that carry no authority component at all. */
const opaqueSchemeUrlArbitrary: fc.Arbitrary<string> = fc.constantFrom(
  'javascript:alert(1)',
  'data:text/html,<h1>partyrock.aws</h1>',
  'mailto:admin@partyrock.aws',
  'tel:+62800000000',
  'about:blank',
)

/** Non-empty strings that `new URL` cannot parse at all. */
const malformedUrlArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'not-a-url',
    'partyrock.aws',
    'partyrock.aws/app',
    '//partyrock.aws/app',
    'http://',
    'https://',
    ':::',
  ),
  fc.string().filter((s) => s.length > 0 && !isParseableUrl(s)),
)

/** Every kind of input a URL field can receive, valid or not. */
const anyUrlInputArbitrary: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: webUrlArbitrary(), weight: 5 },
  { arbitrary: nonWebSchemeUrlArbitrary, weight: 2 },
  { arbitrary: opaqueSchemeUrlArbitrary, weight: 1 },
  { arbitrary: malformedUrlArbitrary, weight: 2 },
)

// ---------------------------------------------------------------------------
// P21-a — the iff clause
// ---------------------------------------------------------------------------

describe('Property 21: P21-a — acceptance is exactly "HTML or PartyRock host"', () => {
  /**
   * For any well-formed http/https URL and any project type, the decision must
   * equal `type === HTML || isPartyRockHost(hostname)`, where the hostname is
   * taken from `new URL(url)` rather than from the generator's intent.
   *
   * **Validates: Requirements 2.1, 2.2**
   */
  it('matches the independently computed predicate on every path', () => {
    fc.assert(
      fc.property(webUrlArbitrary(), projectTypeArbitrary, (url, projectType) => {
        const hostname = new URL(url).hostname
        const expected =
          resolveType(projectType) === ProjectType.HTML || isPartyRockHost(hostname)

        expect(submissionDecision(url, projectType).accepted).toBe(expected)
        expect(csvDecision(url, projectType).accepted).toBe(expected)
        expect(clientDecision(url, projectType).accepted).toBe(expected)
      }),
      { numRuns: 400 },
    )
  })

  /**
   * The `only if` direction, stated separately so a rule that accepted
   * everything could not pass: a PARTYROCK submission on a non-PartyRock host
   * is always rejected, and the message names the domain rule (the HTML
   * variant of the same URL is accepted, which is what makes the rejection
   * type-specific rather than absolute).
   *
   * **Validates: Requirements 2.1, 2.2**
   */
  it('rejects PARTYROCK on any host the predicate does not recognise, while HTML accepts it', () => {
    const nonPartyRockHosts = fc
      .oneof(lookalikeHostArbitrary, genericHostArbitrary)
      .filter((host) => !isPartyRockHost(host.toLowerCase()))

    fc.assert(
      fc.property(webUrlArbitrary(nonPartyRockHosts), (url) => {
        for (const partyRock of [ProjectType.PARTYROCK, undefined]) {
          const decision = submissionDecision(url, partyRock)
          expect(decision.accepted).toBe(false)
          expect(decision.messages).toContain(
            'URL must be a valid PartyRock URL (domain: partyrock.aws)',
          )
        }
        expect(submissionDecision(url, ProjectType.HTML).accepted).toBe(true)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * And the `if` direction: a PartyRock host is accepted for both types, so the
   * HTML allowance never turns into a new restriction.
   *
   * **Validates: Requirements 2.1, 2.2**
   */
  it('accepts a PartyRock host for every project type', () => {
    fc.assert(
      fc.property(
        webUrlArbitrary(partyRockHostArbitrary),
        projectTypeArbitrary,
        (url, projectType) => {
          expect(submissionDecision(url, projectType).accepted).toBe(true)
          expect(csvDecision(url, projectType).accepted).toBe(true)
          expect(clientDecision(url, projectType).accepted).toBe(true)
        },
      ),
      { numRuns: 300 },
    )
  })
})

// ---------------------------------------------------------------------------
// P21-b — the scheme clause
// ---------------------------------------------------------------------------

describe('Property 21: P21-b — non-http(s) schemes are rejected for both project types', () => {
  /**
   * A correct host does not rescue a wrong scheme, and the HTML allowance is
   * about hostnames only — it grants no scheme relief.
   *
   * **Validates: Requirements 2.3**
   */
  it('rejects parseable URLs on a non-web scheme', () => {
    fc.assert(
      fc.property(
        fc.oneof(nonWebSchemeUrlArbitrary, opaqueSchemeUrlArbitrary),
        projectTypeArbitrary,
        (url, projectType) => {
          expect(submissionDecision(url, projectType).accepted).toBe(false)
          expect(csvDecision(url, projectType).accepted).toBe(false)
          expect(clientDecision(url, projectType).accepted).toBe(false)
        },
      ),
      { numRuns: 300 },
    )
  })

  /**
   * The scheme check runs before the host check, so the message explains the
   * scheme rather than the domain — for both types, including PartyRock hosts.
   *
   * **Validates: Requirements 2.3**
   */
  it('reports the scheme rule, not the domain rule', () => {
    fc.assert(
      fc.property(nonWebSchemeUrlArbitrary, projectTypeArbitrary, (url, projectType) => {
        expect(submissionDecision(url, projectType).messages).toEqual([
          'URL must use http or https',
        ])
        expect(clientDecision(url, projectType).messages).toEqual([
          'URL must use http or https',
        ])
      }),
      { numRuns: 200 },
    )
  })

  /**
   * Unparseable input is rejected for both types too, with the parse message.
   *
   * **Validates: Requirements 2.3**
   */
  it('rejects unparseable input for both project types', () => {
    fc.assert(
      fc.property(malformedUrlArbitrary, projectTypeArbitrary, (url, projectType) => {
        expect(submissionDecision(url, projectType).messages).toEqual([
          'URL must be a valid URL',
        ])
        expect(csvDecision(url, projectType).messages).toEqual(['URL must be a valid URL'])
        expect(clientDecision(url, projectType).messages).toEqual([
          'URL must be a valid URL',
        ])
      }),
      { numRuns: 200 },
    )
  })
})

// ---------------------------------------------------------------------------
// P21-c — the three-path agreement clause
// ---------------------------------------------------------------------------

describe('Property 21: P21-c — submission, CSV and client agree exactly', () => {
  /**
   * The strongest clause of Property 21, and the one Property 5 does not
   * cover: for the same URL and project type the single-submission schema, the
   * CSV row schema and the client-side check must produce an identical
   * decision *and* an identical message. Any of the three drifting — a stale
   * copy of the host rule, a scheme check on one side only, a differently
   * worded message — fails here.
   *
   * **Validates: Requirements 2.5**
   */
  it('produces the same decision and message across all three paths', () => {
    fc.assert(
      fc.property(anyUrlInputArbitrary, projectTypeArbitrary, (url, projectType) => {
        const submission = submissionDecision(url, projectType)
        const csv = csvDecision(url, projectType)
        const client = clientDecision(url, projectType)

        expect(csv).toEqual(submission)
        expect(client).toEqual(submission)
      }),
      { numRuns: 500 },
    )
  })

  /**
   * The agreed decision is also the *correct* one — agreement on a shared
   * mistake would otherwise satisfy the test above.
   *
   * **Validates: Requirements 2.1, 2.2, 2.3, 2.5**
   */
  it('agrees with the property oracle, not merely with each other', () => {
    fc.assert(
      fc.property(anyUrlInputArbitrary, projectTypeArbitrary, (url, projectType) => {
        const expected = expectedAccept(url, projectType)
        expect(submissionDecision(url, projectType).accepted).toBe(expected)
        expect(csvDecision(url, projectType).accepted).toBe(expected)
        expect(clientDecision(url, projectType).accepted).toBe(expected)
      }),
      { numRuns: 500 },
    )
  })
})

// ---------------------------------------------------------------------------
// P21-d — hostname casing
// ---------------------------------------------------------------------------

describe('Property 21: P21-d — the decision does not depend on hostname casing', () => {
  /**
   * `new URL` lowercases the hostname, so `HTTPS://PARTYROCK.AWS/App` and
   * `https://partyrock.aws/App` must be decided identically. A rule that
   * compared the raw URL string instead of the parsed hostname would reject
   * the first one.
   *
   * **Validates: Requirements 2.1, 2.2, 2.5**
   */
  it('decides an upper-cased host the same way as its lower-cased form', () => {
    fc.assert(
      fc.property(
        hostArbitrary,
        caseModeArbitrary,
        projectTypeArbitrary,
        fc.constantFrom('', '/', '/App/ABC'),
        (host, caseMode, projectType, path) => {
          const cased = `https://${applyCase(host, caseMode)}${path}`
          const lower = `https://${host.toLowerCase()}${path}`

          expect(submissionDecision(cased, projectType)).toEqual(
            submissionDecision(lower, projectType),
          )
          expect(clientDecision(cased, projectType)).toEqual(
            clientDecision(lower, projectType),
          )
          expect(submissionDecision(cased, projectType).accepted).toBe(
            resolveType(projectType) === ProjectType.HTML ||
            isPartyRockHost(host.toLowerCase()),
          )
        },
      ),
      { numRuns: 300 },
    )
  })
})

// ---------------------------------------------------------------------------
// Deterministic edge cases — the specific inputs the clauses above are meant
// to catch, kept as named examples so a regression reads clearly.
// ---------------------------------------------------------------------------

describe('Property 21: deterministic edge cases', () => {
  /** [url, accepted for PARTYROCK, accepted for HTML] */
  const cases: Array<[string, boolean, boolean]> = [
    // PartyRock host survives userinfo, port, query and fragment noise
    ['https://user:pass@partyrock.aws/app/abc', true, true],
    ['https://partyrock.aws:8080/app?x=1#y', true, true],
    ['https://deep.sub.app.partyrock.aws/', true, true],
    ['HTTPS://PARTYROCK.AWS/App', true, true],
    ['http://partyrock.aws/app', true, true],
    // partyrock.aws present, but not as the hostname
    ['https://partyrock.aws.evil.com/app', false, true],
    ['https://evil.com/partyrock.aws', false, true],
    ['https://evil.com/?next=https://partyrock.aws', false, true],
    ['https://user@evil.com/#partyrock.aws', false, true],
    ['https://mypartyrock.aws/', false, true],
    ['https://partyrock.aws.co/', false, true],
    // right host, wrong scheme — rejected for both
    ['ftp://partyrock.aws/app', false, false],
    ['ws://partyrock.aws/socket', false, false],
    ['javascript:alert(1)', false, false],
    ['data:text/html,<h1>hi</h1>', false, false],
    // unparseable — rejected for both
    ['partyrock.aws', false, false],
    ['//partyrock.aws/app', false, false],
    ['not-a-url', false, false],
  ]

  it.each(cases)(
    '%s — all three paths agree (PARTYROCK: %s, HTML: %s)',
    (url, partyRockAccepted, htmlAccepted) => {
      for (const [projectType, expected] of [
        [ProjectType.PARTYROCK, partyRockAccepted],
        [undefined, partyRockAccepted],
        [ProjectType.HTML, htmlAccepted],
      ] as Array<[ProjectTypeInput, boolean]>) {
        const submission = submissionDecision(url, projectType)
        expect(submission.accepted).toBe(expected)
        expect(csvDecision(url, projectType)).toEqual(submission)
        expect(clientDecision(url, projectType)).toEqual(submission)
      }
    },
  )
})
