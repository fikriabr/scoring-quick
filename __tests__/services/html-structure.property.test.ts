/**
 * Property-based tests for Property 22: HTML Structure Metric Consistency
 *
 * Property 22 states:
 *   _For any_ HTML string, `parseHtmlStructure` SHALL be deterministic —
 *   identical input always yields identical output — and the resulting metrics
 *   SHALL be internally consistent: `headingCount` equals the length of
 *   `headings`, `imagesWithAlt` never exceeds `imageCount`,
 *   `labelledFormFields` never exceeds `formFieldCount`, every ratio falls
 *   within `[0, 1]`, and every count is a non-negative integer.
 *
 * ---------------------------------------------------------------------------
 * What this file adds over `html-structure.unit.test.ts`
 * ---------------------------------------------------------------------------
 * The unit test pins concrete values for one hand-written document: it proves
 * the extractor reads *that* markup correctly. This file proves the *shape* of
 * the output can never be wrong, for markup nobody wrote by hand.
 *
 * The strength of the whole file rests on the generators, so they are built to
 * vary the markup **structurally** rather than lexically:
 *
 *   1. `structuredDocumentArbitrary` — a recursive `fc.letrec` tree: nesting of
 *      random depth, a mix of semantic and generic containers, headings at
 *      random levels (so hierarchy skips occur naturally), images with `alt`,
 *      with `alt=""` and with no `alt`, form fields carrying each of the four
 *      labelling mechanisms, random `aria-*` and `role=` attributes, and
 *      head-level `script`/`style`/`link`/`meta`/`title`.
 *   2. `brokenMarkupArbitrary` — unclosed tags, stray closing tags, unquoted
 *      attributes, crossed nesting, HTML entities, and — the realistic one —
 *      a well-formed generated document sliced at a random offset, which is
 *      what a truncated fetch actually looks like.
 *   3. `rawStringArbitrary` — raw `fc.string()` plus unicode and lone
 *      surrogates, so totality is asserted against input that is not markup at
 *      all.
 *   4. `degenerateArbitrary` — empty string, whitespace, tag-free prose, and
 *      documents nested hundreds of levels deep.
 *
 * None of the assertions below depend on the generator's *intent* (no expected
 * heading count is threaded through). Every check is either a relation between
 * two fields of the same result or a comparison of two runs, which is exactly
 * what Property 22 claims and is why the generators are free to emit anything.
 *
 * **Validates: Requirements 3.3, 3.4**
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  parseHtmlStructure,
  formatStructureForPrompt,
} from '@/lib/services/html-structure.service'
import type { HtmlStructure } from '@/types'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Every numeric field the property calls a "count". */
function countsOf(s: HtmlStructure): Array<[string, number]> {
  return [
    ['headingCount', s.headingCount],
    ['semanticElementCount', s.semanticElementCount],
    ['genericElementCount', s.genericElementCount],
    ['ariaAttributeCount', s.ariaAttributeCount],
    ['imageCount', s.imageCount],
    ['imagesWithAlt', s.imagesWithAlt],
    ['formFieldCount', s.formFieldCount],
    ['labelledFormFields', s.labelledFormFields],
    ['totalElementCount', s.totalElementCount],
    ['maxDomDepth', s.maxDomDepth],
    ['scriptCount', s.scriptCount],
    ['inlineStyleCount', s.inlineStyleCount],
    ['externalStylesheetCount', s.externalStylesheetCount],
  ]
}

/**
 * Every ratio, paired with the numerator/denominator it is documented to be
 * derived from. Pairing them here is what turns "the ratio is in range" into
 * "the ratio agrees with its own counts".
 */
function ratiosOf(
  s: HtmlStructure,
): Array<[string, number, number, number]> {
  return [
    [
      'semanticRatio',
      s.semanticRatio,
      s.semanticElementCount,
      s.semanticElementCount + s.genericElementCount,
    ],
    ['altTextRatio', s.altTextRatio, s.imagesWithAlt, s.imageCount],
    [
      'formLabelRatio',
      s.formLabelRatio,
      s.labelledFormFields,
      s.formFieldCount,
    ],
  ]
}

// ---------------------------------------------------------------------------
// Arbitraries — 1. structured markup
// ---------------------------------------------------------------------------

/**
 * Text content. The random branch has `<`, `>` and `&` stripped so it stays
 * text; markup-shaped noise is the job of `brokenMarkupArbitrary`. Entity and
 * non-Latin literals are kept because they go through the parser's decoder and
 * through `normalizeWhitespace`, which is where heading text is produced.
 */
const textArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'Hello',
    'Judul Bagian',
    'Lorem ipsum dolor sit amet',
    '',
    '   ',
    '\n\t  spasi  \r\n  banyak  \n',
    'Skip to main content',
    'Lompat ke konten utama',
    '© 2024 PindAI',
    '&amp; &lt;b&gt; &#169; &nbsp;',
    '日本語のテキスト',
    'emoji 🎉 dan 👩‍💻 zwj',
    'مرحبا بالعالم',
    'x'.repeat(400),
  ),
  fc.string({ maxLength: 40 }).map((s) => s.replace(/[<>&]/g, '')),
)

/**
 * A single attribute, serialised. Deliberately includes unquoted values and a
 * bare boolean attribute — both legal-ish HTML the parser has to cope with —
 * and `style=""`, which the extractor documents as *not* an inline style.
 */
const attributeArbitrary: fc.Arbitrary<string> = fc.oneof(
  {
    arbitrary: fc.constantFrom(
      'id="a"',
      'id="main-content"',
      'id="lbl"',
      'class="wrapper card"',
      'aria-label="Label aksesibel"',
      'aria-label=""',
      'aria-hidden="true"',
      'aria-live="polite"',
      'aria-labelledby="lbl"',
      'aria-describedby="desc"',
      'role="navigation"',
      'role="banner"',
      'role="main"',
      'role="complementary"',
      'role="contentinfo"',
      'role="region"',
      'role="search"',
      'role="form"',
      'role="presentation"',
      'role="button"',
      'style="color:red"',
      'style=""',
      'style="   "',
      'lang="id"',
      'tabindex="0"',
      'hidden',
      'data-x=unquoted',
      'title="tooltip"',
    ),
    weight: 6,
  },
  // Random aria-* names, so the aria counter is not tested only against the
  // handful of attributes the author happened to think of.
  {
    arbitrary: fc
      .tuple(
        fc.stringMatching(/^[a-z]{1,8}$/),
        fc.stringMatching(/^[a-z0-9 _-]{0,10}$/),
      )
      .map(([name, value]) => `aria-${name}="${value}"`),
    weight: 2,
  },
  // Random non-aria attributes, which must NOT be counted as aria.
  {
    arbitrary: fc
      .tuple(
        fc.stringMatching(/^[a-z][a-z-]{0,8}$/).filter((n) => !n.startsWith('aria')),
        fc.stringMatching(/^[a-z0-9 _-]{0,10}$/),
      )
      .map(([name, value]) => `${name}="${value}"`),
    weight: 1,
  },
)

function serialiseAttributes(attrs: string[]): string {
  return attrs.length === 0 ? '' : ' ' + attrs.join(' ')
}

/** Images across the whole alt spectrum, including the `alt=""` edge case. */
const imageArbitrary: fc.Arbitrary<string> = fc.constantFrom(
  '<img src="a.png" alt="Tangkapan layar beranda">',
  '<img src="b.png" alt="">',
  '<img src="c.png" alt="   ">',
  '<img src="d.png">',
  '<img>',
  '<img src="e.png" alt="mandiri" />',
  '<img src="f.png" aria-label="lewat aria">',
)

/**
 * Form fields, one per labelling mechanism plus the unlabelled and the
 * excluded-from-the-count kinds. Each is emitted as a self-contained fragment
 * so it stays valid wherever the recursive generator drops it.
 */
const formFieldArbitrary: fc.Arbitrary<string> = fc.constantFrom(
  // 1. label[for]
  '<label for="f1">Nama</label><input type="text" id="f1">',
  '<input type="email" id="f2"><label for="f2">Email</label>',
  // 2. wrapping label
  '<label>Pesan <textarea></textarea></label>',
  '<label>Topik <select><option>A</option></select></label>',
  // 3. aria-label
  '<input type="search" aria-label="Cari">',
  // 4. aria-labelledby
  '<span id="lbl">Umur</span><input type="number" aria-labelledby="lbl">',
  // unlabelled
  '<input type="text" name="tanpa-label">',
  '<input name="tanpa-type">',
  '<textarea name="kosong"></textarea>',
  '<select name="pilih"><option>A</option></select>',
  // not counted as fields at all
  '<input type="hidden" name="csrf" value="x">',
  '<input type="submit" value="Kirim">',
  '<input type="reset" value="Reset">',
  '<input type="button" value="Klik">',
  '<input type="image" src="go.png" alt="Kirim">',
  // label pointing at nothing
  '<label for="tidak-ada">Menggantung</label>',
)

/** Anchors, including skip-link shapes and near-misses. */
const anchorArbitrary: fc.Arbitrary<string> = fc.constantFrom(
  '<a href="#main-content">Skip to main content</a>',
  '<a href="#main">Lompat ke konten</a>',
  '<a href="#content">Menuju isi</a>',
  '<a href="#footnote-1">Catatan 1</a>',
  '<a href="#">Fragmen kosong</a>',
  '<a href="/about">Tentang</a>',
  '<a href="https://example.com">Luar</a>',
  '<a>Tanpa href</a>',
)

/** Head-level elements: metadata, scripts and stylesheets. */
const headElementArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    '<title>Judul Dokumen</title>',
    '<title>   </title>',
    '<title></title>',
    '<meta name="description" content="Deskripsi halaman">',
    '<meta name="description" content="">',
    '<meta property="og:description" content="Deskripsi open graph">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta charset="utf-8">',
    '<link rel="stylesheet" href="/styles.css">',
    '<link rel="alternate stylesheet" href="/alt.css">',
    '<link rel="preload" href="/pre.css">',
    '<link rel="icon" href="/favicon.ico">',
    '<link>',
    '<style>.a{color:red}</style>',
    '<style></style>',
    '<script src="/app.js"></script>',
    '<script>var a = 1;</script>',
    '<script>if (a < b) { c(); }</script>',
    '<base href="/">',
  ),
  // Very long metadata, so the prompt-length bound is exercised against
  // values that would otherwise dominate the summary.
  fc
    .integer({ min: 150, max: 600 })
    .map((n) => `<title>${'T'.repeat(n)}</title>`),
  fc
    .integer({ min: 250, max: 900 })
    .map((n) => `<meta name="description" content="${'D'.repeat(n)}">`),
)

/** Headings at any level, so downward skips (h1 → h4) arise on their own. */
const headingArbitrary: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 1, max: 6 }), textArbitrary)
  .map(([level, text]) => `<h${level}>${text}</h${level}>`)

/** Containers, mixing semantic sectioning elements with generic wrappers. */
const CONTAINER_TAGS = [
  // semantic (counted by semanticRatio)
  'header',
  'nav',
  'main',
  'article',
  'section',
  'aside',
  'footer',
  // generic (the other side of the same ratio)
  'div',
  'span',
  // neither — must land in totalElementCount only
  'p',
  'ul',
  'li',
  'form',
  'fieldset',
  'table',
  'tbody',
  'tr',
  'td',
  'figure',
  'figcaption',
  'search',
  'blockquote',
] as const

/**
 * Recursive markup tree. `fc.letrec` + `fc.oneof({ maxDepth })` is what makes
 * the nesting depth itself a generated value rather than a fixed shape, which
 * is the only way `maxDomDepth` gets meaningfully varied.
 */
const { markupNode } = fc.letrec<{ markupNode: string }>((tie) => ({
  markupNode: fc.oneof(
    { maxDepth: 4, depthIdentifier: 'markup', withCrossShrink: true },
    // leaves
    { arbitrary: textArbitrary, weight: 2 },
    { arbitrary: headingArbitrary, weight: 3 },
    { arbitrary: imageArbitrary, weight: 3 },
    { arbitrary: formFieldArbitrary, weight: 3 },
    { arbitrary: anchorArbitrary, weight: 2 },
    { arbitrary: headElementArbitrary, weight: 2 },
    { arbitrary: fc.constant('<!-- komentar -->'), weight: 1 },
    { arbitrary: fc.constant('<br>'), weight: 1 },
    // branch
    {
      arbitrary: fc
        .tuple(
          fc.constantFrom(...CONTAINER_TAGS),
          fc.array(attributeArbitrary, { maxLength: 3 }),
          fc.array(tie('markupNode'), { maxLength: 4 }),
        )
        .map(
          ([tag, attrs, children]) =>
            `<${tag}${serialiseAttributes(attrs)}>${children.join('')}</${tag}>`,
        ),
      weight: 8,
    },
  ),
}))

/**
 * A whole document, sometimes wrapped in `<html><head><body>` and sometimes
 * left as a bare fragment — both reach `parseHtmlStructure` in production
 * (fetched pages versus pasted Source Code).
 */
const structuredDocumentArbitrary: fc.Arbitrary<string> = fc
  .record({
    head: fc.array(headElementArbitrary, { maxLength: 5 }),
    body: fc.array(markupNode, { maxLength: 5 }),
    lang: fc.constantFrom('', ' lang="id"', ' lang=""', ' lang="en-US"', ' lang="   "'),
    wrapped: fc.boolean(),
    doctype: fc.boolean(),
  })
  .map(({ head, body, lang, wrapped, doctype }) => {
    const prefix = doctype ? '<!DOCTYPE html>' : ''
    if (!wrapped) return prefix + head.join('') + body.join('')
    return (
      prefix +
      `<html${lang}><head>${head.join('')}</head><body>${body.join('')}</body></html>`
    )
  })

// ---------------------------------------------------------------------------
// Arbitraries — 2. broken markup
// ---------------------------------------------------------------------------

const brokenMarkupArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    // unclosed
    '<div><p>tidak ditutup',
    '<h1>Judul<h2>Sub',
    '<html><body><div><span>',
    '<ul><li>a<li>b</ul>',
    '<table><tr><td>a</table>',
    '<img src="a.png" alt="x"',
    '<h1>',
    '<div',
    // closing without opening
    '</div></span>',
    '</h1>',
    '</body></html>',
    // crossed nesting
    '<div><span></div></span>',
    '<b><i>teks</b></i>',
    '<main><section></main></section>',
    '<html><body><div></body></html></div>',
    // unquoted / malformed attributes
    '<p attr=unquoted class=also-unquoted>teks</p>',
    '<img src=a.png alt=tanpa-kutip>',
    '<input type=text id=x><label for=x>L</label>',
    '<div style=color:red>x</div>',
    '<a href=#main>Skip to main</a>',
    '<div aria-label=tanpa-kutip role=navigation>x</div>',
    '<p unclosed="',
    "<p single='quoted'>x</p>",
    '<div ="kosong">x</div>',
    // entities and pseudo-tags
    '<div>&amp;&lt;&gt;&#169;&nbsp;&bukanentitas;&#xZZ;</div>',
    '<<>><p>x',
    '<div <span>>x</div>',
    '<?xml version="1.0"?><div>x</div>',
    '<!-- komentar tidak ditutup',
    '<!DOCTYPE html>',
    '<![CDATA[x]]>',
    '<style>a{content:"<div>"}</style>',
    '<script>var s = "</div>";</script>',
    '<TITLE>HURUF BESAR</TITLE><DIV CLASS="X">y</DIV>',
  ),
  // The realistic breakage: a well-formed document cut off mid-stream, which
  // is what a timed-out or size-capped fetch leaves behind.
  fc
    .tuple(structuredDocumentArbitrary, fc.double({ min: 0, max: 1, noNaN: true }))
    .map(([html, fraction]) => html.slice(0, Math.floor(html.length * fraction))),
  // Tag soup: fragments reassembled in a random order, so opening and closing
  // tags no longer pair up.
  fc
    .array(
      fc.constantFrom(
        '<div>',
        '</div>',
        '<main>',
        '</main>',
        '<h1>',
        '</h2>',
        '<img alt="">',
        '<input>',
        '<label for="x">',
        '</label>',
        '<script>',
        '</style>',
        'teks',
        '<',
        '>',
        '/>',
        '"',
      ),
      { maxLength: 24 },
    )
    .map((parts) => parts.join('')),
)

// ---------------------------------------------------------------------------
// Arbitraries — 3. raw strings and unicode
// ---------------------------------------------------------------------------

const rawStringArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.string({ maxLength: 200 }),
  fc.string({ unit: 'grapheme' }),
  fc.string({ unit: 'binary' }),
  fc.constantFrom(
    '<'.repeat(64),
    '>'.repeat(64),
    '<>'.repeat(32),
    '</'.repeat(32),
    '&'.repeat(64),
    '="'.repeat(32),
    '\u0000',
    '<div\u0000>x</div>',
    '\uD800',
    '\uDFFF\uD800',
    '𝕳𝖊𝖑𝖑𝖔 𝖜𝖔𝖗𝖑𝖉',
    '\u200B\u200C\u200D\uFEFF',
    'א<div>ב</div>ג',
    '\u2028\u2029',
  ),
)

// ---------------------------------------------------------------------------
// Arbitraries — 4. degenerate input
// ---------------------------------------------------------------------------

const degenerateArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    '',
    ' ',
    '\n',
    '\t',
    '   \r\n\t  ',
    'tanpa tag sama sekali',
    'a'.repeat(4000),
    '<div></div>',
    '<html></html>',
    '<html><head></head><body></body></html>',
  ),
  // Very deep documents, closed and unclosed. `parseHtmlStructure` walks the
  // tree iteratively for exactly this reason, so the depth is pushed well past
  // anything the structured generator produces.
  fc
    .integer({ min: 1, max: 250 })
    .map((n) => '<div>'.repeat(n) + 'isi' + '</div>'.repeat(n)),
  fc.integer({ min: 1, max: 250 }).map((n) => '<div>'.repeat(n)),
  fc
    .integer({ min: 1, max: 100 })
    .map((n) => `<h1>${'<span>'.repeat(n)}dalam${'</span>'.repeat(n)}</h1>`),
  // Wide rather than deep.
  fc.integer({ min: 1, max: 400 }).map((n) => '<div>x</div>'.repeat(n)),
)

// ---------------------------------------------------------------------------
// The union: every kind of input the extractor can ever receive
// ---------------------------------------------------------------------------

const anyHtmlArbitrary: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: structuredDocumentArbitrary, weight: 6 },
  { arbitrary: brokenMarkupArbitrary, weight: 4 },
  { arbitrary: rawStringArbitrary, weight: 2 },
  { arbitrary: degenerateArbitrary, weight: 2 },
)

// ---------------------------------------------------------------------------
// P22-a — determinism
// ---------------------------------------------------------------------------

describe('Property 22: P22-a — parseHtmlStructure is deterministic', () => {
  /**
   * Requirement 3.4 in its literal form: the same markup twice must give the
   * same metrics. Both a structural comparison and a serialised one are
   * asserted — `toEqual` would pass on two objects whose keys were emitted in
   * a different order, and `CrawlMetadata.structure` is persisted as JSON, so
   * key order is part of what has to be stable.
   *
   * **Validates: Requirements 3.4**
   */
  it('returns deep-equal and byte-identical results for repeated calls', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const first = parseHtmlStructure(html)
        const second = parseHtmlStructure(html)

        expect(second).toEqual(first)
        expect(JSON.stringify(second)).toBe(JSON.stringify(first))
      }),
      { numRuns: 400 },
    )
  })

  /**
   * Determinism must survive other work happening in between — a parser that
   * cached state across calls, or reused a mutable accumulator, would pass the
   * back-to-back check above and fail here.
   *
   * **Validates: Requirements 3.4**
   */
  it('is unaffected by intervening parses of other documents', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, anyHtmlArbitrary, (html, other) => {
        const before = JSON.stringify(parseHtmlStructure(html))
        parseHtmlStructure(other)
        parseHtmlStructure(other)
        const after = JSON.stringify(parseHtmlStructure(html))

        expect(after).toBe(before)
      }),
      { numRuns: 300 },
    )
  })

  /**
   * The result must be JSON round-trippable, because that is how it reaches
   * the database and comes back to the scorer. A `NaN`, `undefined` or
   * `Infinity` anywhere in the object would silently change shape here.
   *
   * **Validates: Requirements 3.3, 3.4**
   */
  it('survives a JSON round trip unchanged', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const structure = parseHtmlStructure(html)
        const roundTripped = JSON.parse(JSON.stringify(structure)) as HtmlStructure

        expect(roundTripped).toEqual(structure)
      }),
      { numRuns: 300 },
    )
  })
})

// ---------------------------------------------------------------------------
// P22-b — totality
// ---------------------------------------------------------------------------

describe('Property 22: P22-b — parseHtmlStructure never throws', () => {
  /**
   * The extractor sits behind a fetch of arbitrary third-party markup and
   * behind an admin-pasted textarea. Neither source can be trusted to be HTML
   * at all, so "returns metrics" has to be total: there is no input for which
   * throwing is acceptable, because a throw here would abort a crawl that
   * Requirement 3.5 expects to degrade gracefully.
   *
   * **Validates: Requirements 3.3**
   */
  it('returns a complete structure for any string whatsoever', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const structure = parseHtmlStructure(html)

        expect(structure).toBeDefined()
        expect(Array.isArray(structure.headings)).toBe(true)
        expect(Array.isArray(structure.landmarks)).toBe(true)
        for (const [, value] of countsOf(structure)) {
          expect(typeof value).toBe('number')
        }
        expect(typeof structure.hasSingleH1).toBe('boolean')
        expect(typeof structure.headingHierarchyValid).toBe('boolean')
        expect(typeof structure.hasSkipLink).toBe('boolean')
        expect(typeof structure.hasViewportMeta).toBe('boolean')
      }),
      { numRuns: 500 },
    )
  })

  /**
   * Nullable metadata must be exactly `string | null` — never `undefined`,
   * which is what `getAttribute` returns for an absent attribute and what a
   * missing normalisation step would leak through into the persisted JSON.
   *
   * **Validates: Requirements 3.3**
   */
  it('reports absent metadata as null, never undefined', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const s = parseHtmlStructure(html)

        for (const value of [
          s.documentTitle,
          s.metaDescription,
          s.langAttribute,
        ]) {
          expect(value === null || typeof value === 'string').toBe(true)
        }
      }),
      { numRuns: 300 },
    )
  })
})

// ---------------------------------------------------------------------------
// P22-c — headingCount agrees with the headings array
// ---------------------------------------------------------------------------

describe('Property 22: P22-c — headingCount equals headings.length', () => {
  /**
   * The count and the array are two representations of the same fact, and the
   * scorer reads both (the count for the summary line, the array for the
   * outline). They can never disagree.
   *
   * **Validates: Requirements 3.3**
   */
  it('keeps the count and the array in step, with well-formed entries', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const s = parseHtmlStructure(html)

        expect(s.headingCount).toBe(s.headings.length)

        for (const heading of s.headings) {
          expect(Number.isInteger(heading.level)).toBe(true)
          expect(heading.level).toBeGreaterThanOrEqual(1)
          expect(heading.level).toBeLessThanOrEqual(6)
          expect(typeof heading.text).toBe('string')
          // Bounded so the persisted structure cannot grow without limit.
          expect(heading.text.length).toBeLessThanOrEqual(120)
          // Whitespace is normalised, so no entry carries raw markup indentation.
          expect(heading.text).toBe(heading.text.replace(/\s+/g, ' ').trim())
        }
      }),
      { numRuns: 400 },
    )
  })
})

// ---------------------------------------------------------------------------
// P22-d — subset counts never exceed their totals
// ---------------------------------------------------------------------------

describe('Property 22: P22-d — subset counts never exceed their totals', () => {
  /**
   * `imagesWithAlt` counts a subset of the images and `labelledFormFields` a
   * subset of the fields. Exceeding the total would mean the same element was
   * counted twice, or counted in the subset without being counted in the
   * total — and would produce an above-1 ratio that reads to the AI scorer as
   * better-than-perfect accessibility.
   *
   * **Validates: Requirements 3.3**
   */
  it('keeps imagesWithAlt <= imageCount and labelledFormFields <= formFieldCount', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const s = parseHtmlStructure(html)

        expect(s.imagesWithAlt).toBeLessThanOrEqual(s.imageCount)
        expect(s.labelledFormFields).toBeLessThanOrEqual(s.formFieldCount)
      }),
      { numRuns: 400 },
    )
  })
})

// ---------------------------------------------------------------------------
// P22-e — every ratio lies within [0, 1]
// ---------------------------------------------------------------------------

describe('Property 22: P22-e — every ratio lies within [0, 1]', () => {
  /**
   * Finite, not `NaN`, and inside the unit interval. `NaN` is the specific
   * failure mode worth naming: it is what `0 / 0` produces, it survives every
   * naive range check (`NaN >= 0` is false but so is `NaN > 1`), and it
   * serialises to `null` in JSON, so a single unguarded division would reach
   * the database as a missing metric rather than as an error.
   *
   * **Validates: Requirements 3.3**
   */
  it('produces finite ratios inside the unit interval', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const s = parseHtmlStructure(html)

        for (const [name, value] of ratiosOf(s)) {
          expect(Number.isNaN(value), `${name} is NaN`).toBe(false)
          expect(Number.isFinite(value), `${name} is not finite`).toBe(true)
          expect(value, name).toBeGreaterThanOrEqual(0)
          expect(value, name).toBeLessThanOrEqual(1)
        }
      }),
      { numRuns: 400 },
    )
  })
})

// ---------------------------------------------------------------------------
// P22-f — every count is a non-negative integer
// ---------------------------------------------------------------------------

describe('Property 22: P22-f — every count is a non-negative integer', () => {
  /**
   * Counts are cardinalities, so fractional or negative values are not merely
   * out of range but meaningless. `Number.isInteger` also rules out `NaN` and
   * both infinities in one check.
   *
   * **Validates: Requirements 3.3**
   */
  it('produces integral, non-negative, finite counts', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const s = parseHtmlStructure(html)

        for (const [name, value] of countsOf(s)) {
          expect(Number.isInteger(value), `${name} is not an integer`).toBe(true)
          expect(value, name).toBeGreaterThanOrEqual(0)
        }
      }),
      { numRuns: 400 },
    )
  })
})

// ---------------------------------------------------------------------------
// P22-g — each ratio agrees with the counts it is derived from
// ---------------------------------------------------------------------------

describe('Property 22: P22-g — ratios agree with their own counts', () => {
  /**
   * The range check in P22-e is satisfied by any constant, so the stronger
   * claim is asserted here: each ratio equals `numerator / denominator`
   * exactly, computed from the counts in the *same* result object. Exact
   * equality is the right assertion rather than an approximate one, because
   * both sides are the same IEEE-754 division of the same two integers — the
   * clamp inside `ratio()` is the identity whenever the numerator does not
   * exceed the denominator, which P22-d establishes.
   *
   * **Validates: Requirements 3.3**
   */
  it('equals numerator/denominator when the denominator is positive', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const s = parseHtmlStructure(html)

        for (const [name, value, numerator, denominator] of ratiosOf(s)) {
          if (denominator > 0) {
            expect(value, name).toBe(numerator / denominator)
          }
        }
      }),
      { numRuns: 400 },
    )
  })

  /**
   * And equals the documented zero when there is nothing to divide. The choice
   * matters and is deliberate: a document with no images reports
   * `altTextRatio = 0`, not 1, so absent evidence is never rewarded as if it
   * were perfect accessibility. `imageCount = 0` sits in the same object for
   * consumers that need to tell "none of ten" from "none at all".
   *
   * **Validates: Requirements 3.3**
   */
  it('is exactly 0 when the denominator is zero', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const s = parseHtmlStructure(html)

        for (const [name, value, , denominator] of ratiosOf(s)) {
          if (denominator === 0) {
            expect(value, name).toBe(0)
          }
        }
      }),
      { numRuns: 400 },
    )
  })

  /**
   * A ratio of exactly 1 must mean the subset is the whole set, and 0 with a
   * positive denominator must mean the subset is empty. This pins the two
   * boundary readings the scorer treats as signals.
   *
   * **Validates: Requirements 3.3**
   */
  it('reaches 1 only when the subset is the whole set', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const s = parseHtmlStructure(html)

        for (const [name, value, numerator, denominator] of ratiosOf(s)) {
          if (denominator > 0 && value === 1) {
            expect(numerator, name).toBe(denominator)
          }
          if (denominator > 0 && value === 0) {
            expect(numerator, name).toBe(0)
          }
        }
      }),
      { numRuns: 400 },
    )
  })
})

// ---------------------------------------------------------------------------
// P22-h — structural invariants between the remaining fields
// ---------------------------------------------------------------------------

describe('Property 22: P22-h — the metric groups stay mutually consistent', () => {
  /**
   * `totalElementCount` is the population every other element tally is drawn
   * from. Semantic and generic tags are disjoint sets, so their sum is a
   * genuine subset count; headings, images, scripts, stylesheet links and form
   * fields are each subsets too.
   *
   * **Validates: Requirements 3.3**
   */
  it('keeps every element tally within totalElementCount', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const s = parseHtmlStructure(html)

        expect(
          s.semanticElementCount + s.genericElementCount,
        ).toBeLessThanOrEqual(s.totalElementCount)
        expect(s.headingCount).toBeLessThanOrEqual(s.totalElementCount)
        expect(s.imageCount).toBeLessThanOrEqual(s.totalElementCount)
        expect(s.formFieldCount).toBeLessThanOrEqual(s.totalElementCount)
        expect(s.scriptCount).toBeLessThanOrEqual(s.totalElementCount)
        expect(s.externalStylesheetCount).toBeLessThanOrEqual(s.totalElementCount)
      }),
      { numRuns: 400 },
    )
  })

  /**
   * Depth is measured along a chain of nested elements, so it can never exceed
   * the number of elements. And the two must vanish together: the extractor
   * documents the document root as depth 0, which makes `maxDomDepth === 0`
   * equivalent to "there are no elements at all" — an `iff`, not just an
   * implication, so a stray depth on an empty document is caught too.
   *
   * **Validates: Requirements 3.3**
   */
  it('keeps maxDomDepth <= totalElementCount, and zero exactly when empty', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const s = parseHtmlStructure(html)

        expect(s.maxDomDepth).toBeLessThanOrEqual(s.totalElementCount)
        expect(s.maxDomDepth === 0).toBe(s.totalElementCount === 0)
      }),
      { numRuns: 400 },
    )
  })

  /**
   * Landmarks are reported as a deduplicated list drawn from a fixed
   * vocabulary, so the array is a set: no repeats, and bounded in length
   * regardless of document size. The bound is what lets
   * `formatStructureForPrompt` render the list in full without a cap.
   *
   * **Validates: Requirements 3.3**
   */
  it('reports landmarks as a bounded, duplicate-free list', () => {
    // header, nav, main, aside, footer, form, section, search (tags) plus
    // banner, navigation, complementary, contentinfo, region (roles not
    // already named by a tag) — 13 distinct values in total.
    const MAX_DISTINCT_LANDMARKS = 13

    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const s = parseHtmlStructure(html)

        expect(new Set(s.landmarks).size).toBe(s.landmarks.length)
        expect(s.landmarks.length).toBeLessThanOrEqual(MAX_DISTINCT_LANDMARKS)
        for (const landmark of s.landmarks) {
          expect(typeof landmark).toBe('string')
          expect(landmark.length).toBeGreaterThan(0)
          // Reported in lowercase, so consumers can compare without folding.
          expect(landmark).toBe(landmark.toLowerCase())
        }
      }),
      { numRuns: 400 },
    )
  })

  /**
   * The two derived heading flags must be recomputable from the `headings`
   * array alone — they are summaries of it, not independent observations.
   * `hasSingleH1` is "exactly one level-1 entry"; `headingHierarchyValid` is
   * "no downward jump larger than one level", which makes a heading-free
   * document vacuously valid.
   *
   * **Validates: Requirements 3.3**
   */
  it('derives hasSingleH1 and headingHierarchyValid from the headings array', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const s = parseHtmlStructure(html)

        const h1Count = s.headings.filter((h) => h.level === 1).length
        expect(s.hasSingleH1).toBe(h1Count === 1)

        const noDownwardSkip = s.headings.every(
          (heading, index) =>
            index === 0 || heading.level - s.headings[index - 1].level <= 1,
        )
        expect(s.headingHierarchyValid).toBe(noDownwardSkip)
      }),
      { numRuns: 400 },
    )
  })

  /**
   * A skip link is a kind of anchor, so claiming one requires the document to
   * contain at least one element. Cheap, but it rules out a flag defaulting to
   * `true`, which would hand every empty document an accessibility feature it
   * does not have.
   *
   * **Validates: Requirements 3.3**
   */
  it('never claims a skip link in a document with no elements', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const s = parseHtmlStructure(html)

        if (s.totalElementCount === 0) {
          expect(s.hasSkipLink).toBe(false)
          expect(s.landmarks).toEqual([])
          expect(s.headings).toEqual([])
          expect(s.documentTitle).toBeNull()
          expect(s.metaDescription).toBeNull()
          expect(s.langAttribute).toBeNull()
          expect(s.hasViewportMeta).toBe(false)
        }
      }),
      { numRuns: 300 },
    )
  })
})

// ---------------------------------------------------------------------------
// P22-i — formatStructureForPrompt is deterministic and bounded
// ---------------------------------------------------------------------------

/**
 * Concrete upper bound on the rendered summary, in characters.
 *
 * It is a constant of the renderer, not a function of the input: every line
 * holds either a fixed label with a number, a capped list (10 headings at 60
 * characters of text each, at most 13 landmarks from a closed vocabulary), or
 * a truncated metadata string (title 120, description 200, lang 16). Summing
 * the worst case gives roughly 1.9k; 2500 leaves room for the digits of counts
 * on a very large document without weakening the claim.
 *
 * Requirement 4.3 depends on this number existing. The HTML prompt sends the
 * structure summary in full *first* and only then spends what is left of the
 * character budget on raw markup — a plan that is only sound if the summary's
 * size is known in advance and cannot be driven up by the document itself.
 */
const MAX_PROMPT_SUMMARY_CHARS = 2500

describe('Property 22: P22-i — formatStructureForPrompt is deterministic and bounded', () => {
  /**
   * The renderer is a pure function of the structure, so repeated calls must
   * agree exactly. Combined with P22-a this makes the whole markup → prompt
   * path deterministic, which is what makes a re-score of unchanged evidence
   * reproducible.
   *
   * **Validates: Requirements 3.4**
   */
  it('renders the same text every time, for the same markup', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const structure = parseHtmlStructure(html)

        const first = formatStructureForPrompt(structure)
        const second = formatStructureForPrompt(structure)
        const fromFreshParse = formatStructureForPrompt(parseHtmlStructure(html))

        expect(second).toBe(first)
        expect(fromFreshParse).toBe(first)
      }),
      { numRuns: 400 },
    )
  })

  /**
   * The bound itself. Asserted against generated documents of wildly different
   * sizes — including 250-deep nesting, 400-wide repetition and 900-character
   * meta descriptions — none of which may push the summary past the constant.
   *
   * **Validates: Requirements 3.3, 3.4**
   */
  it('stays under the documented character bound for any document', () => {
    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const output = formatStructureForPrompt(parseHtmlStructure(html))

        expect(output.length).toBeLessThanOrEqual(MAX_PROMPT_SUMMARY_CHARS)
        // At most 10 heading detail lines, whatever the outline looks like.
        expect(
          output.split('\n').filter((line) => /^ {2}h[1-6]: /.test(line)).length,
        ).toBeLessThanOrEqual(10)
      }),
      { numRuns: 400 },
    )
  })

  /**
   * Bounded is not the same as independent of size, and Requirement 4.3 needs
   * the stronger reading: growing the document must not grow the summary in
   * proportion.
   *
   * A unit of markup is repeated `n` times for `n` spanning three orders of
   * magnitude. The growth comparison deliberately starts at `n = 25` rather
   * than `n = 1`: below ten headings the outline is still shorter than its own
   * cap, so a small document renders fewer lines simply because it has less to
   * say. Once the cap binds, the summary may only gain the extra *digits* of
   * the counts it prints — never a line per element — and that is the claim
   * Requirement 4.3 rests on.
   *
   * **Validates: Requirements 3.3**
   */
  it('does not grow in proportion to the document', () => {
    const unit =
      '<section aria-label="blok"><h2>Judul bagian yang cukup panjang untuk dipotong</h2>' +
      '<div><span>teks</span></div><img src="a.png" alt="gambar">' +
      '<label for="q">Cari</label><input type="text" id="q">' +
      '<input type="text" name="tanpa-label"><img src="b.png"></section>'

    const measured = [1, 5, 25, 100, 400, 2000].map((n) => {
      const structure = parseHtmlStructure(
        `<html lang="id"><body>${unit.repeat(n)}</body></html>`,
      )
      return {
        n,
        markup: unit.length * n,
        elements: structure.totalElementCount,
        headings: structure.headingCount,
        output: formatStructureForPrompt(structure).length,
      }
    })

    // The absolute bound holds at every size, including the smallest.
    for (const { n, output } of measured) {
      expect(output, `n=${n}`).toBeLessThanOrEqual(MAX_PROMPT_SUMMARY_CHARS)
    }

    // Two sizes that both saturate the outline cap, 80x apart in document size.
    const saturated = measured.filter((m) => m.headings > 10)
    const first = saturated[0]
    const last = saturated[saturated.length - 1]

    expect(first.n).toBe(25)
    expect(last.markup / first.markup).toBeGreaterThan(50)
    expect(last.elements / first.elements).toBeGreaterThan(50)
    // Only the digits of the counters may differ.
    expect(Math.abs(last.output - first.output)).toBeLessThan(60)

    // And across the whole range the summary shrinks relative to the markup it
    // describes, which is what "does not grow in proportion" means.
    const smallest = measured[0]
    const largest = measured[measured.length - 1]
    expect(largest.output).toBeLessThan(largest.markup / 200)
    expect(largest.output / largest.markup).toBeLessThan(
      smallest.output / smallest.markup,
    )
  })

  /**
   * Every metric group has to appear, or the bound above could be met by
   * simply dropping information. This is the counterweight to the size limit:
   * the summary is small *and* complete.
   *
   * **Validates: Requirements 3.3**
   */
  it('always renders every metric group', () => {
    const requiredLabels = [
      'Headings: ',
      'Semantic elements: ',
      'Landmarks (',
      'ARIA attributes: ',
      'Images: ',
      'Form fields: ',
      'Total elements: ',
      'max DOM depth: ',
      'Scripts: ',
      'inline styles: ',
      'external stylesheets: ',
      'Title: ',
      'Meta description: ',
      'Lang attribute: ',
      'viewport meta: ',
    ]

    fc.assert(
      fc.property(anyHtmlArbitrary, (html) => {
        const output = formatStructureForPrompt(parseHtmlStructure(html))

        for (const label of requiredLabels) {
          expect(output, label).toContain(label)
        }
      }),
      { numRuns: 300 },
    )
  })
})
