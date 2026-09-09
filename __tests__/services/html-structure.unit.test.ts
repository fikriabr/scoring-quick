/**
 * Unit Tests: HTML Structure Extractor
 *
 * Requirements: 3.3, 3.4
 *
 * Requirement 3.3:
 *   THE System SHALL menurunkan Struktur HTML dari markup yang tersedia,
 *   mencakup jumlah dan hierarki heading, elemen semantik vs generik,
 *   landmark dan atribut ARIA, gambar beserta rasio alt, field form beserta
 *   rasio label, kedalaman maksimum DOM, jumlah total elemen, serta metadata
 *   dokumen.
 *
 * Requirement 3.4:
 *   THE System SHALL menghitung Struktur HTML secara deterministik.
 *
 * Test ini menguji kasus konkret. Property 22 (konsistensi metrik lintas
 * seluruh input) diuji terpisah di task 5.3.
 */

import { describe, it, expect } from 'vitest'
import {
  parseHtmlStructure,
  formatStructureForPrompt,
} from '@/lib/services/html-structure.service'

// ---------------------------------------------------------------------------
// Fixture: dokumen "baik" yang menyentuh seluruh kelompok metrik
// ---------------------------------------------------------------------------

const GOOD_DOC = `<!DOCTYPE html>
<html lang="id">
  <head>
    <title>  Portofolio   Saya  </title>
    <meta name="description" content="Halaman portofolio sederhana">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <a href="#main-content">Skip to main content</a>
    <header>
      <nav aria-label="Navigasi utama">
        <a href="/about">Tentang</a>
      </nav>
    </header>
    <main id="main-content">
      <h1>Portofolio</h1>
      <section>
        <h2>Proyek</h2>
        <article>
          <h3>Proyek Pertama</h3>
          <img src="a.png" alt="Tangkapan layar proyek pertama">
          <img src="deco.png" alt="">
          <img src="b.png">
        </article>
      </section>
      <form>
        <label for="email">Email</label>
        <input type="email" id="email" name="email">
        <label>Pesan <textarea name="pesan"></textarea></label>
        <select name="topik" aria-label="Topik"><option>Umum</option></select>
        <input type="text" name="tanpa-label">
        <input type="hidden" name="csrf" value="x">
        <input type="submit" value="Kirim">
      </form>
    </main>
    <footer><span>© 2024</span></footer>
    <script src="/app.js"></script>
  </body>
</html>`

describe('parseHtmlStructure — heading metrics (Req 3.3)', () => {
  it('collects headings in document order with level and normalized text', () => {
    const s = parseHtmlStructure(GOOD_DOC)

    expect(s.headings).toEqual([
      { level: 1, text: 'Portofolio' },
      { level: 2, text: 'Proyek' },
      { level: 3, text: 'Proyek Pertama' },
    ])
    expect(s.headingCount).toBe(3)
    expect(s.headingCount).toBe(s.headings.length)
    expect(s.hasSingleH1).toBe(true)
    expect(s.headingHierarchyValid).toBe(true)
  })

  it('flags a skipped heading level as invalid hierarchy', () => {
    const s = parseHtmlStructure('<h1>A</h1><h3>C</h3>')

    expect(s.headingCount).toBe(2)
    expect(s.headingHierarchyValid).toBe(false)
  })

  it('treats going back up the hierarchy as valid', () => {
    // h1 -> h2 -> h3 -> h1 : the jump back up is not a skip
    const s = parseHtmlStructure('<h1>A</h1><h2>B</h2><h3>C</h3><h1>D</h1>')

    expect(s.headingHierarchyValid).toBe(true)
    expect(s.hasSingleH1).toBe(false)
  })

  it('treats a document with no headings as vacuously valid hierarchy', () => {
    const s = parseHtmlStructure('<div><p>no headings here</p></div>')

    expect(s.headingCount).toBe(0)
    expect(s.headingHierarchyValid).toBe(true)
    expect(s.hasSingleH1).toBe(false)
  })

  it('does not treat multiple h1 as a single h1', () => {
    const s = parseHtmlStructure('<h1>A</h1><h1>B</h1>')

    expect(s.hasSingleH1).toBe(false)
  })
})

describe('parseHtmlStructure — semantic ratio (Req 3.3)', () => {
  it('counts semantic sectioning elements and generic wrappers separately', () => {
    // header, nav, main, section, article, footer = 6 semantic; 1 span generic
    const s = parseHtmlStructure(GOOD_DOC)

    expect(s.semanticElementCount).toBe(6)
    expect(s.genericElementCount).toBe(1)
    expect(s.semanticRatio).toBeCloseTo(6 / 7, 10)
  })

  it('returns ratio 0 when there are neither semantic nor generic elements', () => {
    const s = parseHtmlStructure('<p>plain</p>')

    expect(s.semanticElementCount).toBe(0)
    expect(s.genericElementCount).toBe(0)
    // Documented choice: zero denominator yields 0, never NaN and never 1
    expect(s.semanticRatio).toBe(0)
  })

  it('returns ratio 0 for a purely div/span document', () => {
    const s = parseHtmlStructure('<div><span>a</span><div>b</div></div>')

    expect(s.genericElementCount).toBe(3)
    expect(s.semanticRatio).toBe(0)
  })
})

describe('parseHtmlStructure — landmarks, ARIA, skip link (Req 3.3)', () => {
  it('reports HTML5 landmark elements deduplicated in document order', () => {
    const s = parseHtmlStructure(GOOD_DOC)

    expect(s.landmarks).toEqual([
      'header',
      'nav',
      'main',
      'section',
      'form',
      'footer',
    ])
  })

  it('recognises explicit landmark roles on generic elements', () => {
    const s = parseHtmlStructure(
      '<div role="navigation">nav</div><div role="banner">top</div><div role="presentation">x</div>',
    )

    // role=presentation is not a landmark role and must be excluded
    expect(s.landmarks).toEqual(['navigation', 'banner'])
  })

  it('counts aria-* attributes only, not role', () => {
    const s = parseHtmlStructure(
      '<div role="navigation" aria-label="a" aria-hidden="true"><span aria-live="polite"></span></div>',
    )

    expect(s.ariaAttributeCount).toBe(3)
  })

  it('detects a skip link at the top of the document', () => {
    const s = parseHtmlStructure(GOOD_DOC)

    expect(s.hasSkipLink).toBe(true)
  })

  it('does not treat an ordinary internal anchor as a skip link', () => {
    const s = parseHtmlStructure('<a href="#footnote-1">Catatan 1</a>')

    expect(s.hasSkipLink).toBe(false)
  })

  it('does not treat a late internal anchor as a skip link', () => {
    const s = parseHtmlStructure(
      '<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a><a href="#main">Skip to main</a>',
    )

    expect(s.hasSkipLink).toBe(false)
  })
})

describe('parseHtmlStructure — accessibility ratios (Req 3.3)', () => {
  it('counts images and treats alt="" as alt present', () => {
    const s = parseHtmlStructure(GOOD_DOC)

    expect(s.imageCount).toBe(3)
    // alt="..." and alt="" both count; the third img has no alt attribute
    expect(s.imagesWithAlt).toBe(2)
    expect(s.altTextRatio).toBeCloseTo(2 / 3, 10)
  })

  it('returns alt ratio 0 for a document with no images', () => {
    const s = parseHtmlStructure('<p>no images</p>')

    expect(s.imageCount).toBe(0)
    expect(s.imagesWithAlt).toBe(0)
    expect(s.altTextRatio).toBe(0)
  })

  it('counts form fields excluding hidden and button-like inputs', () => {
    const s = parseHtmlStructure(GOOD_DOC)

    // email input, textarea, select, unlabelled text input = 4
    // hidden + submit excluded
    expect(s.formFieldCount).toBe(4)
  })

  it('recognises all four labelling mechanisms', () => {
    const s = parseHtmlStructure(GOOD_DOC)

    // label[for] -> email, wrapping label -> textarea, aria-label -> select
    expect(s.labelledFormFields).toBe(3)
    expect(s.formLabelRatio).toBeCloseTo(3 / 4, 10)
  })

  it('counts aria-labelledby as a label', () => {
    const s = parseHtmlStructure(
      '<span id="lbl">Nama</span><input aria-labelledby="lbl">',
    )

    expect(s.formFieldCount).toBe(1)
    expect(s.labelledFormFields).toBe(1)
    expect(s.formLabelRatio).toBe(1)
  })

  it('returns form label ratio 0 when there are no form fields', () => {
    const s = parseHtmlStructure('<p>no form</p>')

    expect(s.formFieldCount).toBe(0)
    expect(s.labelledFormFields).toBe(0)
    expect(s.formLabelRatio).toBe(0)
  })

  it('treats an input with no type attribute as a text field', () => {
    const s = parseHtmlStructure('<input name="q">')

    expect(s.formFieldCount).toBe(1)
    expect(s.labelledFormFields).toBe(0)
  })
})

describe('parseHtmlStructure — document complexity (Req 3.3)', () => {
  it('measures max DOM depth with the document root at zero', () => {
    // html(1) > body(2) > div(3) > div(4) > span(5)
    const s = parseHtmlStructure(
      '<html><body><div><div><span>x</span></div></div></body></html>',
    )

    expect(s.maxDomDepth).toBe(5)
  })

  it('reports depth 0 and zero elements for an empty document', () => {
    const s = parseHtmlStructure('')

    expect(s.totalElementCount).toBe(0)
    expect(s.maxDomDepth).toBe(0)
    expect(s.headings).toEqual([])
    expect(s.landmarks).toEqual([])
    expect(s.documentTitle).toBeNull()
  })

  it('counts scripts, inline styles and external stylesheets', () => {
    const s = parseHtmlStructure(
      '<link rel="stylesheet" href="a.css">' +
        '<link rel="preload" href="b.css">' +
        '<style>.a{color:red}</style>' +
        '<div style="color:blue">x</div>' +
        '<script>1</script><script src="a.js"></script>',
    )

    expect(s.scriptCount).toBe(2)
    // one <style> block + one style="" attribute
    expect(s.inlineStyleCount).toBe(2)
    // rel=preload must not be counted
    expect(s.externalStylesheetCount).toBe(1)
  })

  it('recognises stylesheet in a multi-token rel attribute', () => {
    const s = parseHtmlStructure(
      '<link rel="alternate stylesheet" href="a.css">',
    )

    expect(s.externalStylesheetCount).toBe(1)
  })

  it('does not count an empty style attribute as an inline style', () => {
    const s = parseHtmlStructure('<div style="">x</div>')

    expect(s.inlineStyleCount).toBe(0)
  })
})

describe('parseHtmlStructure — document metadata (Req 3.3)', () => {
  it('extracts title, description, lang and viewport', () => {
    const s = parseHtmlStructure(GOOD_DOC)

    expect(s.documentTitle).toBe('Portofolio Saya')
    expect(s.metaDescription).toBe('Halaman portofolio sederhana')
    expect(s.langAttribute).toBe('id')
    expect(s.hasViewportMeta).toBe(true)
  })

  it('falls back to og:description when meta description is absent', () => {
    const s = parseHtmlStructure(
      '<head><meta property="og:description" content="Dari open graph"></head>',
    )

    expect(s.metaDescription).toBe('Dari open graph')
  })

  it('prefers meta name=description over og:description', () => {
    const s = parseHtmlStructure(
      '<head><meta property="og:description" content="OG"><meta name="description" content="Utama"></head>',
    )

    expect(s.metaDescription).toBe('Utama')
  })

  it('returns null metadata when the document has none', () => {
    const s = parseHtmlStructure('<html><body><p>hi</p></body></html>')

    expect(s.documentTitle).toBeNull()
    expect(s.metaDescription).toBeNull()
    expect(s.langAttribute).toBeNull()
    expect(s.hasViewportMeta).toBe(false)
  })

  it('treats an empty title element as no title', () => {
    const s = parseHtmlStructure('<title>   </title>')

    expect(s.documentTitle).toBeNull()
  })
})

describe('parseHtmlStructure — robustness and determinism (Req 3.4)', () => {
  it('does not drop unclosed tags', () => {
    // Default parse() discards non-closed tags; parseNoneClosedTags fixes that
    const s = parseHtmlStructure('<div><p>unclosed')

    expect(s.totalElementCount).toBe(2)
    expect(s.genericElementCount).toBe(1)
  })

  it('does not throw on malformed markup', () => {
    expect(() => parseHtmlStructure('<div><<>><p unclosed="')).not.toThrow()
    expect(() => parseHtmlStructure('</div></span>')).not.toThrow()
    expect(() => parseHtmlStructure('plain text only')).not.toThrow()
  })

  it('produces identical output for identical input', () => {
    const a = parseHtmlStructure(GOOD_DOC)
    const b = parseHtmlStructure(GOOD_DOC)

    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('keeps every count a non-negative integer and every ratio within [0, 1]', () => {
    const s = parseHtmlStructure(GOOD_DOC)

    const counts = [
      s.headingCount,
      s.semanticElementCount,
      s.genericElementCount,
      s.ariaAttributeCount,
      s.imageCount,
      s.imagesWithAlt,
      s.formFieldCount,
      s.labelledFormFields,
      s.totalElementCount,
      s.maxDomDepth,
      s.scriptCount,
      s.inlineStyleCount,
      s.externalStylesheetCount,
    ]
    for (const count of counts) {
      expect(Number.isInteger(count)).toBe(true)
      expect(count).toBeGreaterThanOrEqual(0)
    }

    for (const r of [s.semanticRatio, s.altTextRatio, s.formLabelRatio]) {
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1)
    }

    expect(s.imagesWithAlt).toBeLessThanOrEqual(s.imageCount)
    expect(s.labelledFormFields).toBeLessThanOrEqual(s.formFieldCount)
  })

  it('truncates very long heading text so the object stays bounded', () => {
    const longText = 'x'.repeat(500)
    const s = parseHtmlStructure('<h1>' + longText + '</h1>')

    expect(s.headings[0].text.length).toBeLessThanOrEqual(120)
  })
})

describe('formatStructureForPrompt (Req 3.3, supports Req 4.3)', () => {
  it('renders every metric group', () => {
    const output = formatStructureForPrompt(parseHtmlStructure(GOOD_DOC))

    expect(output).toContain('Headings: 3 total')
    expect(output).toContain('Semantic elements: 6')
    expect(output).toContain('Landmarks (6)')
    expect(output).toContain('ARIA attributes:')
    expect(output).toContain('Images: 3')
    expect(output).toContain('Form fields: 4')
    expect(output).toContain('max DOM depth:')
    expect(output).toContain('external stylesheets: 1')
    expect(output).toContain('Title: "Portofolio Saya"')
    expect(output).toContain('viewport meta: yes')
  })

  it('stays small and bounded even for a huge document', () => {
    // 500 headings, 2000 divs, 300 images: the summary must not grow with them
    const html =
      '<html><body>' +
      '<h1>Root</h1>' +
      '<h2>Very long heading text that should be truncated in the prompt output</h2>'.repeat(
        500,
      ) +
      '<div><span>x</span></div>'.repeat(2000) +
      '<img src="a.png">'.repeat(300) +
      '</body></html>'

    const structure = parseHtmlStructure(html)
    const output = formatStructureForPrompt(structure)

    expect(structure.headingCount).toBe(501)
    expect(output.length).toBeLessThan(2000)
    expect(output).toContain('more headings not shown')
    // Only the capped number of headings is rendered
    expect(output.split('\n').filter((l) => l.startsWith('  h')).length).toBe(10)
  })

  it('renders (none) instead of null for absent metadata', () => {
    const output = formatStructureForPrompt(parseHtmlStructure(''))

    expect(output).toContain('Title: (none)')
    expect(output).toContain('Meta description: (none)')
    expect(output).toContain('Landmarks (0): (none)')
  })

  it('is deterministic for the same structure', () => {
    const structure = parseHtmlStructure(GOOD_DOC)

    expect(formatStructureForPrompt(structure)).toBe(
      formatStructureForPrompt(structure),
    )
  })
})
