// lib/services/html-structure.service.ts
//
// HTML Structure Extractor — mengubah string markup menjadi metrik terukur.
//
// Requirements: 3.3, 3.4
// Property 22: HTML Structure Metric Consistency
//
// `parseHtmlStructure` adalah pure function: tanpa I/O, tanpa DB, tanpa jam,
// tanpa random. Markup yang sama selalu menghasilkan metrik yang sama
// (Requirement 3.4). Semua rasio diturunkan dari hitungan mentah pada objek
// yang sama lewat helper `ratio()`, sehingga tidak mungkin ada rasio yang
// bertentangan dengan count-nya.

import { NodeType, parse, type HTMLElement } from 'node-html-parser'
import type { HeadingInfo, HtmlStructure } from '@/types'

// ---------------------------------------------------------------------------
// Konstanta klasifikasi elemen
// ---------------------------------------------------------------------------

/**
 * Elemen semantik yang dihitung sebagai "semantic" pada `semanticRatio`.
 * Daftar ini sengaja dibatasi pada sectioning/landmark element seperti yang
 * ditetapkan design.md, bukan seluruh elemen HTML5 bermakna, agar rasionya
 * membandingkan hal yang sebanding: pembungkus struktur bermakna versus
 * pembungkus struktur generik.
 */
const SEMANTIC_TAGS = new Set([
  'header',
  'nav',
  'main',
  'article',
  'section',
  'aside',
  'footer',
])

/** Pembungkus tanpa makna semantik. */
const GENERIC_TAGS = new Set(['div', 'span'])

/** Elemen landmark HTML5. Nama landmark yang dilaporkan = nama tag-nya. */
const LANDMARK_TAGS = new Set([
  'header',
  'nav',
  'main',
  'aside',
  'footer',
  'form',
  'section',
  'search',
])

/**
 * Nilai `role` yang diakui sebagai landmark ARIA. Landmark eksplisit lewat
 * `role=` ikut dihitung karena markup lama sering memakai
 * `<div role="navigation">` ketimbang `<nav>`, dan keduanya sama-sama
 * memberi landmark bagi screen reader.
 */
const LANDMARK_ROLES = new Set([
  'banner',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'form',
  'region',
  'search',
])

/**
 * `input` dengan type berikut TIDAK dihitung sebagai form field: bukan tempat
 * pengguna memasukkan data bernama, jadi tidak relevan untuk rasio label.
 * `hidden` tidak terlihat; `submit`/`reset`/`button`/`image` sudah membawa
 * label sendiri lewat `value`/`alt`.
 */
const NON_FIELD_INPUT_TYPES = new Set([
  'hidden',
  'submit',
  'reset',
  'button',
  'image',
])

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

/** Batas panjang teks heading yang disimpan, supaya objek tetap berukuran wajar. */
const MAX_HEADING_TEXT_LENGTH = 120

/** Jumlah anchor awal dokumen yang diperiksa untuk skip link. */
const SKIP_LINK_ANCHOR_WINDOW = 3

// ---------------------------------------------------------------------------
// Helper murni
// ---------------------------------------------------------------------------

/**
 * Rasio aman-pembagian-nol.
 *
 * Keputusan: bila denominator 0, rasio adalah **0**, bukan 1 dan bukan NaN.
 * Alasannya rasio ini dipakai sebagai sinyal kualitas untuk AI Scorer;
 * mengembalikan 1 untuk dokumen tanpa gambar akan memberi kredit palsu atas
 * aksesibilitas yang tidak pernah dibuktikan. Nol dibaca sebagai "tidak ada
 * bukti", dan count mentahnya (`imageCount = 0`) tetap tersedia di objek yang
 * sama sehingga konsumen bisa membedakan "nol dari nol" dari "nol dari
 * sepuluh". Hasilnya selalu berada di `[0, 1]` (Property 22).
 */
function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  const value = numerator / denominator
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Rapikan whitespace jadi spasi tunggal dan trim. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

/**
 * `getAttribute` di node-html-parser mengembalikan `undefined` (bukan `null`)
 * untuk atribut yang absen. Helper ini menormalkannya menjadi string ter-trim
 * atau `null`, sehingga pemanggil tidak perlu mengurus dua bentuk "kosong".
 */
function attr(el: HTMLElement, key: string): string | null {
  if (!el.hasAttribute(key)) return null
  const value = el.getAttribute(key)
  if (value === undefined || value === null) return null
  const trimmed = normalizeWhitespace(value)
  return trimmed.length > 0 ? trimmed : null
}

/** Element children saja — text/comment node dibuang. */
function elementChildren(node: HTMLElement): HTMLElement[] {
  return node.childNodes.filter(
    (child): child is HTMLElement => child.nodeType === NodeType.ELEMENT_NODE,
  )
}

interface WalkedElement {
  el: HTMLElement
  /** Nama tag lowercase. `tagName` node-html-parser mengembalikan UPPERCASE. */
  tag: string
  /**
   * Kedalaman DOM. Keputusan: **root dokumen = 0**, jadi `<html>` berada di
   * kedalaman 1 dan dokumen tanpa elemen apa pun punya `maxDomDepth = 0`.
   * Titik nol ini dipilih supaya angkanya langsung terbaca sebagai "berapa
   * lapis pembungkus yang ada", dan supaya dokumen kosong tidak melaporkan
   * kedalaman yang tidak ada isinya.
   */
  depth: number
  /** Ada ancestor `<label>` — dipakai untuk deteksi label yang membungkus field. */
  insideLabel: boolean
}

/**
 * Traversal iteratif (bukan rekursif) dalam urutan dokumen. Iteratif dipilih
 * karena markup submission bisa bersarang sangat dalam — terutama setelah
 * `parseNoneClosedTags` memperbaiki tag yang tidak ditutup — dan rekursi akan
 * berisiko stack overflow.
 */
function collectElements(root: HTMLElement): WalkedElement[] {
  const collected: WalkedElement[] = []
  const stack: Array<{ node: HTMLElement; depth: number; insideLabel: boolean }> =
    []

  const rootChildren = elementChildren(root)
  for (let i = rootChildren.length - 1; i >= 0; i -= 1) {
    stack.push({ node: rootChildren[i], depth: 1, insideLabel: false })
  }

  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break

    const tag = (current.node.tagName || '').toLowerCase()
    collected.push({
      el: current.node,
      tag,
      depth: current.depth,
      insideLabel: current.insideLabel,
    })

    const insideLabel = current.insideLabel || tag === 'label'
    const children = elementChildren(current.node)
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({
        node: children[i],
        depth: current.depth + 1,
        insideLabel,
      })
    }
  }

  return collected
}

// ---------------------------------------------------------------------------
// parseHtmlStructure
// ---------------------------------------------------------------------------

/**
 * Turunkan Struktur HTML dari markup.
 *
 * Pure & deterministik (Requirement 3.4, Property 22). Tidak pernah throw:
 * markup malformed, string kosong, maupun potongan HTML tanpa `<html>` tetap
 * menghasilkan objek metrik yang valid.
 *
 * `parseNoneClosedTags: true` wajib — default `parse()` MEMBUANG tag yang
 * tidak ditutup (`parse('<div><p>unclosed')` menghasilkan nol `<p>`), dan
 * markup submission peserta sering tidak rapi. Tanpa opsi ini metriknya akan
 * under-count secara sistematis.
 */
export function parseHtmlStructure(html: string): HtmlStructure {
  const root = parse(html ?? '', { parseNoneClosedTags: true })
  const elements = collectElements(root)

  // --- Heading -------------------------------------------------------------
  const headings: HeadingInfo[] = []

  // --- Semantik ------------------------------------------------------------
  let semanticElementCount = 0
  let genericElementCount = 0

  // --- Landmark & ARIA -----------------------------------------------------
  // Set + array agar hasilnya dedup tapi urutannya tetap urutan dokumen
  // (deterministik, tidak bergantung urutan iterasi Set implementation).
  const landmarkSeen = new Set<string>()
  const landmarks: string[] = []
  let ariaAttributeCount = 0

  // --- Aksesibilitas -------------------------------------------------------
  let imageCount = 0
  let imagesWithAlt = 0
  const formFields: WalkedElement[] = []

  // --- Kompleksitas --------------------------------------------------------
  let maxDomDepth = 0
  let scriptCount = 0
  let inlineStyleCount = 0
  let externalStylesheetCount = 0

  // --- Metadata ------------------------------------------------------------
  let documentTitle: string | null = null
  let metaDescription: string | null = null
  let ogDescription: string | null = null
  let langAttribute: string | null = null
  let hasViewportMeta = false

  // --- Bahan turunan -------------------------------------------------------
  /** id yang direferensikan oleh `<label for="...">`. */
  const labelForIds = new Set<string>()
  const anchors: WalkedElement[] = []
  const mainElementIds = new Set<string>()

  for (const walked of elements) {
    const { el, tag, depth } = walked

    if (depth > maxDomDepth) maxDomDepth = depth

    if (SEMANTIC_TAGS.has(tag)) semanticElementCount += 1
    if (GENERIC_TAGS.has(tag)) genericElementCount += 1

    // Landmark lewat elemen HTML5.
    if (LANDMARK_TAGS.has(tag) && !landmarkSeen.has(tag)) {
      landmarkSeen.add(tag)
      landmarks.push(tag)
    }

    // Atribut: hitung aria-*, landmark role eksplisit, dan inline style.
    // `attributes` adalah Record<string, string> dengan urutan sumber.
    const attributes = el.attributes
    for (const name of Object.keys(attributes)) {
      const lower = name.toLowerCase()
      // Keputusan: `ariaAttributeCount` hanya menghitung atribut `aria-*`.
      // `role` tidak ikut karena sudah terwakili lewat `landmarks`, dan
      // mencampurnya akan membuat angka ini menghitung hal yang sama dua kali.
      if (lower.startsWith('aria-')) ariaAttributeCount += 1
      if (lower === 'style') {
        const styleValue = attributes[name]
        if (styleValue !== undefined && styleValue.trim().length > 0) {
          inlineStyleCount += 1
        }
      }
    }

    const role = attr(el, 'role')
    if (role) {
      const roleValue = role.toLowerCase()
      if (LANDMARK_ROLES.has(roleValue) && !landmarkSeen.has(roleValue)) {
        landmarkSeen.add(roleValue)
        landmarks.push(roleValue)
      }
    }

    if (HEADING_TAGS.has(tag)) {
      headings.push({
        level: Number.parseInt(tag.slice(1), 10),
        text: truncate(normalizeWhitespace(el.text ?? ''), MAX_HEADING_TEXT_LENGTH),
      })
      continue
    }

    switch (tag) {
      case 'img': {
        imageCount += 1
        // Keputusan: `alt=""` DIHITUNG sebagai punya alt. Alt kosong adalah
        // penanda sah untuk gambar dekoratif, jadi yang dinilai di sini adalah
        // "penulis sadar akan alt", bukan "alt-nya berisi". `hasAttribute`
        // dipakai (bukan `getAttribute`) justru untuk membedakan `alt=""` dari
        // atribut alt yang absen.
        if (el.hasAttribute('alt')) imagesWithAlt += 1
        break
      }
      case 'input': {
        const type = (attr(el, 'type') ?? 'text').toLowerCase()
        if (!NON_FIELD_INPUT_TYPES.has(type)) formFields.push(walked)
        break
      }
      case 'textarea':
      case 'select': {
        formFields.push(walked)
        break
      }
      case 'label': {
        const forId = attr(el, 'for')
        if (forId) labelForIds.add(forId)
        break
      }
      case 'a': {
        anchors.push(walked)
        break
      }
      case 'script': {
        scriptCount += 1
        break
      }
      case 'style': {
        // `inlineStyleCount` menghitung dua bentuk style yang TIDAK berada di
        // file eksternal: blok `<style>` dan atribut `style="..."`. Keduanya
        // digabung karena keduanya sinyal yang sama bagi penilaian pemisahan
        // concern; pemecahannya tidak menambah informasi bagi AI Scorer.
        inlineStyleCount += 1
        break
      }
      case 'link': {
        const rel = attr(el, 'rel')
        if (rel && rel.toLowerCase().split(/\s+/).includes('stylesheet')) {
          externalStylesheetCount += 1
        }
        break
      }
      case 'title': {
        if (documentTitle === null) {
          const text = normalizeWhitespace(el.text ?? '')
          if (text.length > 0) documentTitle = text
        }
        break
      }
      case 'html': {
        if (langAttribute === null) langAttribute = attr(el, 'lang')
        break
      }
      case 'meta': {
        const name = (attr(el, 'name') ?? '').toLowerCase()
        const property = (attr(el, 'property') ?? '').toLowerCase()
        const content = attr(el, 'content')
        if (name === 'viewport') hasViewportMeta = true
        if (name === 'description' && metaDescription === null) {
          metaDescription = content
        }
        if (property === 'og:description' && ogDescription === null) {
          ogDescription = content
        }
        break
      }
      case 'main': {
        const id = attr(el, 'id')
        if (id) mainElementIds.add(id)
        break
      }
      default:
        break
    }
  }

  // --- Turunan heading -----------------------------------------------------
  const headingCount = headings.length
  const h1Count = headings.filter((heading) => heading.level === 1).length

  // Keputusan: `headingHierarchyValid` hanya memeriksa lompatan saat MENURUN
  // antar heading yang berurutan (h1 → h3 invalid, h3 → h1 valid karena naik
  // bukan lompatan). Level heading pertama tidak dinilai — dokumen yang
  // dimulai dari h2 bisa saja fragmen halaman yang sah. Dokumen TANPA heading
  // dianggap **valid** (vacuously true): tidak ada satu pun lompatan di sana,
  // dan ketiadaan heading sudah terlaporkan lewat `headingCount = 0` sehingga
  // tidak perlu dihukum dua kali.
  let headingHierarchyValid = true
  for (let i = 1; i < headings.length; i += 1) {
    if (headings[i].level - headings[i - 1].level > 1) {
      headingHierarchyValid = false
      break
    }
  }

  // --- Turunan form label --------------------------------------------------
  // Sebuah field dianggap berlabel bila salah satu dari empat cara terpenuhi:
  //   1. dibungkus `<label>` (ancestor label)
  //   2. ada `<label for="id">` yang cocok dengan `id` field
  //   3. punya `aria-label` tidak kosong
  //   4. punya `aria-labelledby` tidak kosong
  // Untuk (4) keberadaan elemen yang direferensikan TIDAK diverifikasi —
  // metrik ini mengukur niat penulis markup, dan verifikasi referensi silang
  // adalah ranah audit aksesibilitas, bukan ringkasan struktur.
  let labelledFormFields = 0
  for (const field of formFields) {
    const id = attr(field.el, 'id')
    const labelled =
      field.insideLabel ||
      (id !== null && labelForIds.has(id)) ||
      attr(field.el, 'aria-label') !== null ||
      attr(field.el, 'aria-labelledby') !== null
    if (labelled) labelledFormFields += 1
  }

  // --- Skip link -----------------------------------------------------------
  // Keputusan: skip link = anchor internal yang berada di AWAL dokumen
  // (di antara SKIP_LINK_ANCHOR_WINDOW anchor pertama, karena skip link sejati
  // selalu jadi tautan pertama yang dijangkau keyboard) DAN menunjuk ke konten
  // utama. "Menunjuk ke konten utama" dipenuhi bila fragmen-nya cocok dengan
  // `id` sebuah `<main>`, atau mengandung kata main/content, atau teks
  // anchor-nya mengandung "skip"/"lompat".
  let hasSkipLink = false
  const anchorWindow = anchors.slice(0, SKIP_LINK_ANCHOR_WINDOW)
  for (const anchor of anchorWindow) {
    const href = attr(anchor.el, 'href')
    if (!href || !href.startsWith('#') || href.length < 2) continue
    const fragment = href.slice(1)
    const text = normalizeWhitespace(anchor.el.text ?? '')
    if (
      mainElementIds.has(fragment) ||
      /main|content/i.test(fragment) ||
      /\bskip\b|\blompat/i.test(text)
    ) {
      hasSkipLink = true
      break
    }
  }

  return {
    // Heading
    headings,
    headingCount,
    hasSingleH1: h1Count === 1,
    headingHierarchyValid,

    // Semantik
    semanticElementCount,
    genericElementCount,
    semanticRatio: ratio(
      semanticElementCount,
      semanticElementCount + genericElementCount,
    ),

    // Landmark & ARIA
    landmarks,
    ariaAttributeCount,
    hasSkipLink,

    // Aksesibilitas
    imageCount,
    imagesWithAlt,
    altTextRatio: ratio(imagesWithAlt, imageCount),
    formFieldCount: formFields.length,
    labelledFormFields,
    formLabelRatio: ratio(labelledFormFields, formFields.length),

    // Kompleksitas dokumen
    totalElementCount: elements.length,
    maxDomDepth,
    scriptCount,
    inlineStyleCount,
    externalStylesheetCount,

    // Metadata dokumen
    documentTitle,
    metaDescription: metaDescription ?? ogDescription,
    langAttribute,
    hasViewportMeta,
  }
}

// ---------------------------------------------------------------------------
// formatStructureForPrompt
// ---------------------------------------------------------------------------

/** Maksimum heading yang dirender ke prompt. Sisanya diringkas jadi hitungan. */
const MAX_HEADINGS_IN_PROMPT = 10
const MAX_HEADING_TEXT_IN_PROMPT = 60
const MAX_TITLE_IN_PROMPT = 120
const MAX_DESCRIPTION_IN_PROMPT = 200

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no'
}

function fixed2(value: number): string {
  return value.toFixed(2)
}

function quoteOrDash(value: string | null, max: number): string {
  if (value === null || value.length === 0) return '(none)'
  return '"' + truncate(value, max) + '"'
}

/**
 * Render metrik menjadi blok teks ringkas untuk prompt AI Scorer.
 *
 * Output-nya **berukuran terbatas dan kecil** by construction: setiap baris
 * berisi angka, satu-satunya bagian yang bisa tumbuh adalah daftar heading dan
 * daftar landmark, dan keduanya dibatasi. Sifat inilah yang dipakai
 * Requirement 4.3 — ringkasan struktur dikirim utuh lebih dulu, sisa anggaran
 * karakter baru diberikan ke potongan markup mentah, sehingga bagian paling
 * informatif tidak pernah jadi korban pemotongan.
 */
export function formatStructureForPrompt(structure: HtmlStructure): string {
  const lines: string[] = []

  lines.push(
    'Headings: ' +
      structure.headingCount +
      ' total | single h1: ' +
      yesNo(structure.hasSingleH1) +
      ' | hierarchy valid: ' +
      yesNo(structure.headingHierarchyValid),
  )

  const shown = structure.headings.slice(0, MAX_HEADINGS_IN_PROMPT)
  for (const heading of shown) {
    lines.push(
      '  h' +
        heading.level +
        ': ' +
        quoteOrDash(heading.text, MAX_HEADING_TEXT_IN_PROMPT),
    )
  }
  const hiddenHeadings = structure.headings.length - shown.length
  if (hiddenHeadings > 0) {
    lines.push('  ... (+' + hiddenHeadings + ' more headings not shown)')
  }

  lines.push(
    'Semantic elements: ' +
      structure.semanticElementCount +
      ' | generic (div/span): ' +
      structure.genericElementCount +
      ' | semantic ratio: ' +
      fixed2(structure.semanticRatio),
  )

  // Landmark unik maksimal 16 nilai (tag + role whitelist), jadi baris ini
  // sudah terbatas tanpa perlu pemotongan tambahan.
  lines.push(
    'Landmarks (' +
      structure.landmarks.length +
      '): ' +
      (structure.landmarks.length > 0 ? structure.landmarks.join(', ') : '(none)'),
  )

  lines.push(
    'ARIA attributes: ' +
      structure.ariaAttributeCount +
      ' | skip link: ' +
      yesNo(structure.hasSkipLink),
  )

  lines.push(
    'Images: ' +
      structure.imageCount +
      ' | with alt: ' +
      structure.imagesWithAlt +
      ' | alt ratio: ' +
      fixed2(structure.altTextRatio),
  )

  lines.push(
    'Form fields: ' +
      structure.formFieldCount +
      ' | labelled: ' +
      structure.labelledFormFields +
      ' | label ratio: ' +
      fixed2(structure.formLabelRatio),
  )

  lines.push(
    'Total elements: ' +
      structure.totalElementCount +
      ' | max DOM depth: ' +
      structure.maxDomDepth,
  )

  lines.push(
    'Scripts: ' +
      structure.scriptCount +
      ' | inline styles: ' +
      structure.inlineStyleCount +
      ' | external stylesheets: ' +
      structure.externalStylesheetCount,
  )

  lines.push('Title: ' + quoteOrDash(structure.documentTitle, MAX_TITLE_IN_PROMPT))
  lines.push(
    'Meta description: ' +
      quoteOrDash(structure.metaDescription, MAX_DESCRIPTION_IN_PROMPT),
  )
  lines.push(
    'Lang attribute: ' +
      quoteOrDash(structure.langAttribute, 16) +
      ' | viewport meta: ' +
      yesNo(structure.hasViewportMeta),
  )

  return lines.join('\n')
}
