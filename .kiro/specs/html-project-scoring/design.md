# Design Document

## HTML Project Scoring + Rebranding ke Scoring Project by PindAI

---

## Overview

Desain ini menambahkan satu dimensi baru pada pipeline penilaian yang sudah ada: **Tipe Project**. Tipe Project menjadi satu-satunya sumber keputusan (single point of dispatch) untuk tiga hal yang selama ini di-hardcode ke PartyRock — aturan validasi URL, cara pengumpulan evidence, dan template prompt yang dikirim ke Gemini.

Prinsip desainnya: **lebarkan seam yang sudah ada, jangan bikin pipeline kedua.** Seluruh bagian hilir pipeline sudah agnostik terhadap sumber data — `parseGeminiResponse` beserta clamping-nya, upsert `AIScore`, `calculateWeightedScore`, transisi `scoreStatus`, leaderboard, override jury, dan export tidak perlu disentuh sama sekali.

---

## Kondisi Awal yang Relevan

Tiga temuan dari pembacaan kode yang membentuk desain ini:

1. **Jalur crawl praktis mati.** `POST /api/submissions` memanggil `ScorerService.triggerScoring` secara langsung tanpa crawl, dan loop crawl di `app/api/submissions/bulk/route.ts` dikomentari. `CrawlerService.triggerCrawl` hanya dipakai lewat pintu samping `POST /api/crawl/[projectId]` (admin-only). Untuk Project HTML jalur ini justru yang paling tepat, karena `triggerCrawl` sudah otomatis melanjutkan ke scoring saat sukses.

2. **`CrawlerService.crawl()` membuang HTML yang sudah di-fetch.** Ia mengambil `og:title` dan meta description lewat regex, lalu mengembalikan `widgets: []`, `prompts: []`, `widgetCount: 0`. Kolom `CrawlMetadata.rawHtml` sudah ada di skema tetapi **belum pernah ditulis oleh crawler** — hanya Capture Pipeline yang mengisinya. Ini seam yang sudah tersedia tanpa perlu kolom baru.

3. **Source Code tidak bisa diedit setelah submit.** Textarea `sourceCode` ada di form submission, tapi di halaman detail hanya ada `CaptureImportPanel` yang mewajibkan `JSON.parse` berhasil lalu POST ke `/api/capture` melalui `CaptureSchema`. Menempel HTML mentah ke panel itu akan gagal dengan "JSON tidak valid".

---

## Architecture

### Dispatch berdasarkan Tipe Project

```
                      ┌──────────────────────┐
   Submission ───────▶│   projectType?       │
                      └──────┬────────┬──────┘
                   PARTYROCK │        │ HTML
                             ▼        ▼
              ┌──────────────────┐  ┌──────────────────────────┐
              │ Validasi URL:    │  │ Validasi URL:            │
              │ partyrock.aws    │  │ http(s) hostname apa pun │
              └────────┬─────────┘  └────────────┬─────────────┘
                       │                         │
                       ▼                         ▼
              ┌──────────────────┐  ┌──────────────────────────┐
              │ Capture Pipeline │  │ HtmlCrawlStrategy:       │
              │ (tak berubah)    │  │ fetch → rawHtml →        │
              │ → sourceCode     │  │ parseHtmlStructure()     │
              └────────┬─────────┘  └────────────┬─────────────┘
                       │                         │
                       ▼                         ▼
              ┌──────────────────┐  ┌──────────────────────────┐
              │ buildPartyRock   │  │ buildHtmlPrompt()        │
              │ Prompt()         │  │ (## HTML Structure)      │
              └────────┬─────────┘  └────────────┬─────────────┘
                       └────────────┬────────────┘
                                    ▼
                    ┌───────────────────────────────────┐
                    │  Bagian hilir — TIDAK BERUBAH     │
                    │  parseGeminiResponse (clamping)   │
                    │  upsert AIScore                   │
                    │  calculateWeightedScore           │
                    │  scoreStatus, leaderboard, export │
                    └───────────────────────────────────┘
```

### Berkas yang Terdampak

| Berkas | Perubahan |
|---|---|
| `prisma/schema.prisma` | enum `ProjectType`, kolom `Project.projectType`, kolom `CrawlMetadata.structure Json?` |
| `types/index.ts` | `HtmlStructure`, pelebaran metadata scorer menjadi `ProjectMetadata` |
| `lib/validators/schemas.ts` | satukan 3 refine hostname terduplikasi jadi satu helper type-aware; tambah `projectType` |
| `lib/services/html-structure.service.ts` | **baru** — `parseHtmlStructure`, `formatStructureForPrompt` |
| `lib/services/crawler.service.ts` | pecah jadi strategi per tipe; tulis `rawHtml` dan `structure` untuk HTML |
| `lib/services/scorer.service.ts` | pecah `buildPrompt` jadi dua builder, dispatch per tipe |
| `lib/services/submission.service.ts` | alias header CSV `project_type`; teruskan `projectType` |
| `lib/services/category.service.ts` | set parameter default kedua untuk web/HTML |
| `app/api/submissions/route.ts` | Project HTML lewat `triggerCrawl`, bukan `triggerScoring` langsung |
| `app/api/submissions/[id]/route.ts` | **baru** — `PATCH` untuk update `sourceCode` (admin-only) |
| `components/SubmissionForm.tsx` | selector Tipe Project; validasi client-side type-aware |
| `components/SourceCodeEditor.tsx` | **baru** — editor Source Code di halaman detail |
| `app/(dashboard)/admin/submissions/page.tsx` | kolom Tipe Project pada tabel |
| `app/(dashboard)/admin/submissions/[projectId]/page.tsx` | tampilkan tipe; panel capture hanya untuk PARTYROCK |
| `app/layout.tsx`, `app/(dashboard)/admin/layout.tsx`, `package.json`, `README.md` | rebranding |

---

## Data Models

### Perubahan Prisma Schema

```prisma
enum ProjectType {
  PARTYROCK
  HTML
}

model Project {
  // ... field existing tidak berubah
  projectType ProjectType @default(PARTYROCK)
}

model CrawlMetadata {
  // ... field existing tidak berubah
  // rawHtml sudah ada; mulai sekarang crawler HTML mengisinya.
  structure   Json?   // HtmlStructure hasil parseHtmlStructure
}
```

`@default(PARTYROCK)` adalah inti dari kompatibilitas mundur: seluruh row lama otomatis valid tanpa backfill.

`structure` disimpan sebagai kolom terpisah supaya metrik tidak perlu dihitung ulang setiap kali scoring dijalankan, dan supaya nilainya bisa ditampilkan di UI.

**Penerapan skema:** repositori ini tidak punya `prisma/migrations/`, skema diterapkan lewat `prisma db push`. Jadi langkahnya `npm run db:generate` lalu `npm run db:push`, bukan `migrate dev`.

### Tipe TypeScript

```typescript
// types/index.ts

export interface HtmlStructure {
  // Hierarki heading
  headings: { level: number; text: string }[]
  headingCount: number
  hasSingleH1: boolean
  headingHierarchyValid: boolean      // tidak ada level yang dilompati

  // Semantik
  semanticElementCount: number         // header, nav, main, article, section, aside, footer
  genericElementCount: number          // div, span
  semanticRatio: number                // semantic / (semantic + generic)

  // Landmark & ARIA
  landmarks: string[]
  ariaAttributeCount: number
  hasSkipLink: boolean

  // Aksesibilitas
  imageCount: number
  imagesWithAlt: number
  altTextRatio: number
  formFieldCount: number
  labelledFormFields: number
  formLabelRatio: number

  // Kompleksitas dokumen
  totalElementCount: number
  maxDomDepth: number
  scriptCount: number
  inlineStyleCount: number
  externalStylesheetCount: number

  // Metadata dokumen
  documentTitle: string | null
  metaDescription: string | null
  langAttribute: string | null
  hasViewportMeta: boolean
}

/**
 * Menggantikan `PartyRockMetadata` sebagai tipe input scorer.
 * Field PartyRock dipertahankan agar jalur existing tidak berubah.
 */
export interface ProjectMetadata {
  title: string | null
  description: string | null
  widgets: WidgetInfo[]
  prompts: string[]
  widgetCount: number
  sourceCode?: string | null
  projectType?: ProjectType
  structure?: HtmlStructure | null
}
```

`PartyRockMetadata` dipertahankan sebagai alias agar perubahan tipe tidak menyebar ke seluruh call site sekaligus.

---

## Components and Interfaces

### 1. Validasi URL Type-Aware

Saat ini blok refine hostname `partyrock.aws` terduplikasi **tiga kali** di `lib/validators/schemas.ts` (`SubmissionSchema`, `CsvRowSchema`, `CaptureSchema`) dan **sekali lagi** di client sebagai `isPartyRockUrl()` di `components/SubmissionForm.tsx`. Duplikasi ini disatukan lebih dulu, baru dibuat type-aware.

```typescript
// lib/validators/url-rules.ts (baru — dipakai server maupun client)

const ALLOWED_SCHEMES = ['http:', 'https:']

export function isPartyRockHost(hostname: string): boolean {
  return hostname === 'partyrock.aws' || hostname.endsWith('.partyrock.aws')
}

/** Satu-satunya sumber kebenaran aturan URL, dipakai di kedua sisi. */
export function validateProjectUrl(
  url: string,
  projectType: ProjectType,
): { ok: true } | { ok: false; message: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, message: 'URL must be a valid URL' }
  }
  if (!ALLOWED_SCHEMES.includes(parsed.protocol)) {
    return { ok: false, message: 'URL must use http or https' }
  }
  if (projectType === 'PARTYROCK' && !isPartyRockHost(parsed.hostname)) {
    return {
      ok: false,
      message: 'URL must be a valid PartyRock URL (domain: partyrock.aws)',
    }
  }
  return { ok: true }
}
```

`SubmissionSchema` dan `CsvRowSchema` memakai `superRefine` karena aturan URL bergantung pada field lain (`projectType`) — `refine` per-field tidak punya akses ke sibling field.

```typescript
export const SubmissionSchema = z
  .object({
    projectType: z.nativeEnum(ProjectType).default(ProjectType.PARTYROCK),
    url: z.string().min(1, 'URL is required'),
    // ... field lain tidak berubah
  })
  .superRefine((data, ctx) => {
    const result = validateProjectUrl(data.url, data.projectType)
    if (!result.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.message, path: ['url'] })
    }
  })
```

`CaptureSchema` **tidak diubah** — ia tetap mewajibkan hostname `partyrock.aws` (Requirement 2.6).

Catatan perubahan kontrak: pembatasan skema `http:`/`https:` adalah perilaku **baru**. Saat ini `ftp://partyrock.aws/` lolos, dan hal itu terdokumentasi sebagai perilaku sengaja di `__tests__/validators/url-domain.property.test.ts`.

### 2. HTML Structure Extractor

```typescript
// lib/services/html-structure.service.ts

/** Pure function: string HTML → metrik. Tanpa I/O, tanpa DB, mudah dites. */
export function parseHtmlStructure(html: string): HtmlStructure

/** Merender metrik menjadi blok teks ringkas untuk prompt. */
export function formatStructureForPrompt(structure: HtmlStructure): string
```

**Keputusan: butuh parser HTML sungguhan.** Crawler existing memakai regex, dan regex tidak cukup untuk menghitung kedalaman DOM, rasio elemen semantik, atau pasangan label–input. Tidak ada cheerio/jsdom/linkedom di `package.json`.

Rekomendasi: **`node-html-parser`** — ringan, tanpa dependency native, aman di serverless Vercel. Alternatif `cheerio` bila API jQuery-style lebih disukai. Penambahan dependency ini perlu persetujuan eksplisit sebelum task terkait dijalankan, dan versinya dipin (bukan range terbuka).

`parseHtmlStructure` wajib **pure dan deterministik** (Property 22). Semua metrik turunan seperti `altTextRatio` dihitung dari hitungan mentah pada objek yang sama, sehingga tidak mungkin saling bertentangan.

### 3. Crawler per Tipe Project

`CrawlerService.triggerCrawl` tetap menjadi orchestrator dan status machine-nya tidak berubah. Yang di-dispatch hanyalah tahap ekstraksinya.

```typescript
// lib/services/crawler.service.ts

interface CrawlOutcome {
  title: string | null
  description: string | null
  widgets: WidgetInfo[]
  prompts: string[]
  widgetCount: number
  rawHtml?: string | null
  structure?: HtmlStructure | null
  sourceCode?: string | null      // hanya diisi bila project belum punya
}

static async crawl(url: string, projectType: ProjectType): Promise<CrawlOutcome>
```

Untuk `HTML`:
1. fetch dengan `AbortController` dan timeout yang sama seperti sekarang (15 detik)
2. simpan markup ke `rawHtml` (dibatasi panjangnya agar konsisten dengan batas kolom capture)
3. `parseHtmlStructure(html)` → `structure`
4. `title`/`description` diambil dari `documentTitle`/`metaDescription` hasil parser, bukan lagi regex
5. `sourceCode` diisi markup **hanya jika `Project.sourceCode` masih kosong** — Source Code yang ditempel manual selalu menang (Requirement 3.6, Property 26)

Untuk `PARTYROCK`: perilaku sekarang, byte-for-byte.

**Wiring submission:** `app/api/submissions/route.ts` memilih jalur berdasarkan tipe — `HTML` → `CrawlerService.triggerCrawl` (yang otomatis lanjut ke scoring), `PARTYROCK` → `ScorerService.triggerScoring` seperti sekarang. Penting untuk tidak memanggil keduanya, karena `triggerCrawl` sudah memicu scoring di akhir.

### 4. Prompt per Tipe Project

```typescript
// lib/services/scorer.service.ts

function buildPartyRockPrompt(metadata, parameter, contextProjects): string  // isi sekarang, tidak diubah
function buildHtmlPrompt(metadata, parameter, contextProjects): string       // baru

function buildPrompt(metadata, parameter, contextProjects): string {
  return metadata.projectType === 'HTML'
    ? buildHtmlPrompt(metadata, parameter, contextProjects)
    : buildPartyRockPrompt(metadata, parameter, contextProjects)
}
```

Kerangka `buildHtmlPrompt`:

```
You are an AI judge evaluating web projects based on their HTML structure.

## Project to Evaluate
Title / Description / URL

## HTML Structure
<hasil formatStructureForPrompt — metrik terhitung, ringkas>

## HTML Source (excerpt)
<potongan source code, dipotong pada sisa anggaran karakter>

## Evaluation Parameter
Name / Description / Score range

## Other Projects in This Category (for comparison)

## Analysis Instructions
Semantic HTML, aksesibilitas, kualitas struktur & SEO, kejelasan presentasi,
serta kompleksitas relatif terhadap project lain di kategori yang sama.

## Output Format
{"score": <number>, "reasoning": "<2–4 sentences>"}
```

**Anggaran karakter.** `buildPrompt` existing memotong `sourceCode` pada 20.000 karakter. Untuk HTML, ringkasan struktur dikirim **lebih dulu dan utuh** (ukurannya kecil dan terbatas), sisa anggaran baru dipakai untuk potongan markup (Requirement 4.3, Property 23). Kalau urutannya dibalik, markup akan menghabiskan seluruh anggaran dan justru bagian yang paling informatif yang terpotong.

### 5. Editor Source Code Pasca-Submit

```typescript
// app/api/submissions/[id]/route.ts  (baru)
export async function PATCH(request: NextRequest, context: RouteContext)
// admin-only, rate-limited, body: { sourceCode: string | null }
// → simpan, set scoreStatus = PENDING, fire-and-forget triggerScoring
```

`components/SourceCodeEditor.tsx` — client component, prefill nilai sekarang, counter karakter, pesan inline `{ kind: 'ok' | 'error' }` mengikuti pola `CaptureImportPanel`, lalu `router.refresh()`.

**Keputusan: panel terpisah, bukan menumpangi `CaptureImportPanel`.** Panel capture memaksa `parsed.url` dan `parsed.categoryId` lalu POST ke `/api/capture` melalui `CaptureSchema`; semantiknya adalah payload capture PartyRock. Menjadikan satu textarea punya dua mode parsing akan membingungkan operator dan membuat pesan errornya ambigu. Di halaman detail, `CaptureImportPanel` hanya dirender untuk `PARTYROCK`, `SourceCodeEditor` dirender untuk keduanya.

### 6. Set Parameter Default Kedua

`loadDefaultParameters` di `lib/services/category.service.ts` saat ini menanam 5 parameter PartyRock dengan total bobot 100. Signature-nya dilebarkan:

```typescript
export type DefaultParameterSet = 'PARTYROCK' | 'HTML'
export async function loadDefaultParameters(
  categoryId: string,
  set: DefaultParameterSet = 'PARTYROCK',
)
```

Set `HTML` yang diusulkan (total 100%):

| Parameter | Bobot | Fokus |
|---|---|---|
| Semantic HTML & Structure | 25% | pemakaian elemen semantik, hierarki heading |
| Accessibility | 25% | alt text, label form, ARIA, landmark |
| Code Quality & Maintainability | 20% | organisasi markup, kedalaman DOM, pemisahan style |
| User Experience & Presentation | 15% | kejelasan konten, metadata, viewport |
| Impact & Scalability | 15% | relevansi masalah, potensi penerapan |

Default `'PARTYROCK'` menjaga Requirement 6.4 — pemanggil existing tidak berubah perilakunya.

### 7. Rebranding

| Lokasi | Sekarang | Menjadi |
|---|---|---|
| `app/layout.tsx` metadata | `title: 'PartyRock Assessment Tool'` | `'Scoring Project by PindAI'` |
| `app/layout.tsx` metadata | `description: 'Sistem penjurian untuk project PartyRock'` | deskripsi netral platform |
| `app/(dashboard)/admin/layout.tsx` | `<span>PartyRock</span>` (sidebar desktop) | `PindAI` |
| `app/(dashboard)/admin/layout.tsx` | `<span>PartyRock</span>` (header mobile) | `PindAI` |
| `package.json` | `"name": "scoring-partyrock"` | `"scoring-project-pindai"` (npm melarang spasi/kapital) |
| `README.md`, `docs/*.md` | penamaan lama | penamaan baru |

**Dipertahankan dengan sengaja** (Requirement 7.4): nama file `scripts/partyrock-navigate.js` dan `public/partyrock-capture.js` beserta path publiknya (di-fetch oleh `CaptureImportPanel`, rename akan memutus panel), pemeriksaan hostname `partyrock.aws`, alias header CSV `partyrock_url`, CORS origin di `lib/capture-auth.ts`, dan nama parameter default "Effective Use of PartyRock Features". Semuanya merujuk platform PartyRock yang masih didukung, bukan nama produk.

---

## Key Flows

### Flow 1: Submission Project HTML

```
Admin pilih projectType = HTML, isi URL (+ Source Code opsional)
        │
        ▼
POST /api/submissions ── SubmissionSchema.superRefine (aturan URL per tipe)
        │
        ▼
submitProject() → Project { projectType: HTML, crawlStatus: PENDING }
        │
        ▼
CrawlerService.triggerCrawl(projectId)      [asynchronous, fire-and-forget]
        │
        ├─ crawlStatus = PROCESSING
        ├─ fetch URL (timeout 15s)
        ├─ rawHtml disimpan
        ├─ parseHtmlStructure() → structure
        ├─ sourceCode diisi HANYA bila masih kosong
        ├─ crawlStatus = SUCCESS
        └─ ScorerService.triggerScoring()
                 │
                 ├─ buildHtmlPrompt() per parameter AUTO
                 ├─ parseGeminiResponse (clamping)   ← tidak berubah
                 ├─ upsert AIScore                    ← tidak berubah
                 └─ scoreStatus + finalScore          ← tidak berubah
```

### Flow 2: Fetch Gagal, Source Code Menyelamatkan

```
triggerCrawl → fetch gagal (403 / timeout / DNS)
        │
        ├─ crawlStatus = FAILED, crawlError dicatat
        └─ Project.sourceCode ada?
              ├─ ya  → lanjut scoring dari sourceCode (Requirement 3.5)
              └─ tidak → scoreStatus = FAILED, "evidence belum tersedia" (Requirement 4.6)
                          Admin menempel HTML lewat SourceCodeEditor → re-score
```

### Flow 3: Update Source Code Pasca-Submit

```
Admin edit Source Code di halaman detail
        │
        ▼
PATCH /api/submissions/[id]   (admin-only, rate-limited)
        │
        ├─ validasi panjang
        ├─ simpan sourceCode
        ├─ scoreStatus = PENDING
        └─ triggerScoring()  [fire-and-forget]  → router.refresh()
```

---

## Error Handling Strategy

| Skenario | Perilaku |
|---|---|
| URL non-PartyRock dengan `projectType = PARTYROCK` | HTTP 400, pesan menyebut aturan domain PartyRock |
| Skema URL bukan http/https | HTTP 400, pesan menyebut skema yang diizinkan |
| Nilai `projectType` tidak dikenal (JSON) | HTTP 400 `VALIDATION_ERROR` dari `z.nativeEnum` |
| Nilai `projectType` tidak dikenal (CSV) | baris ditolak, nomor baris dilaporkan, baris lain tetap diimpor |
| Fetch HTML gagal / timeout | `crawlStatus = FAILED` + `crawlError`; scoring lanjut bila `sourceCode` ada |
| HTML berhasil di-fetch tapi gagal diparse | `structure = null`, scoring lanjut dari markup mentah, error dicatat |
| Project HTML tanpa evidence apa pun | `scoreStatus = FAILED` dengan pesan yang menjelaskan penyebabnya |
| `PATCH` sourceCode oleh non-admin | HTTP 403 `FORBIDDEN` |
| Source Code melewati batas panjang | HTTP 400 `VALIDATION_ERROR` |

---

## Keputusan yang Menunggu Konfirmasi

Tercatat di sini agar tidak hilang saat implementasi:

1. **Fetch URL live untuk Project HTML** — desain ini mengasumsikan **ya**, dengan Source Code sebagai override/fallback. Alasannya banyak submission akan berupa URL saja. Bila diputuskan tidak, Task 3.x dan 4.x dilewati dan `sourceCode` menjadi satu-satunya evidence.
2. **Dependency parser HTML (`node-html-parser`, versi dipin)** — perlu persetujuan sebelum Task 3.1 dijalankan. Tanpa parser, analisis struktur hanya bisa regex dan hasilnya rapuh.
3. **Cakupan rename** — desain ini membatasi pada metadata, sidebar, nama paket, dan dokumentasi. Rename folder repositori dan direktori `.kiro/specs/partyrock-assessment-tool/` **tidak** termasuk dan perlu keputusan terpisah.

---

## Risiko yang Sudah Diketahui

**Biaya token bisa naik tajam.** `ScorerService` menarik `CrawlMetadata` **seluruh** project lain dalam kategori yang sama sebagai context, satu kali per parameter. Untuk Project HTML dengan evidence lebih besar, ini tumbuh cepat seiring jumlah submission. Mitigasi yang disarankan: batasi jumlah context project dan jangan pernah menyertakan `sourceCode` project lain (saat ini memang tidak disertakan).

**`finalScore` pada status PARTIAL tidak dinormalisasi.** `calculateWeightedScore` menjumlah `Σ(score × weight) / 100` hanya atas parameter yang berhasil, sehingga project PARTIAL nilainya tertekan secara sistematis. Ini perilaku existing dan di luar cakupan spec ini, tetapi efeknya akan lebih terlihat bila parameter HTML lebih sering gagal.

---

## Correctness Properties

_A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees._

Penomoran melanjutkan spec `partyrock-assessment-tool` yang berakhir pada Property 20.

---

### Property 21: Project Type Determines URL Validation

_For any_ well-formed `http`/`https` URL and any project type, the system SHALL accept the submission if and only if either the project type is `HTML`, or the project type is `PARTYROCK` and the URL hostname equals `partyrock.aws` or ends with `.partyrock.aws`. URLs using any other scheme SHALL be rejected for both project types. The same decision SHALL be produced by the single-submission path, the CSV import path, and the client-side check.

**Validates: Requirements 2.1, 2.2, 2.3, 2.5**

---

### Property 22: HTML Structure Metric Consistency

_For any_ HTML string, `parseHtmlStructure` SHALL be deterministic — identical input always yields identical output — and the resulting metrics SHALL be internally consistent: `headingCount` equals the length of `headings`, `imagesWithAlt` never exceeds `imageCount`, `labelledFormFields` never exceeds `formFieldCount`, every ratio falls within `[0, 1]`, and every count is a non-negative integer.

**Validates: Requirements 3.3, 3.4**

---

### Property 23: Prompt Selection And Evidence Budget By Project Type

_For any_ project and parameter, the prompt sent to the AI Scorer SHALL contain the HTML structure section if and only if the project type is `HTML`. When the evidence exceeds the character budget, the structure summary SHALL be present in full and only the raw markup excerpt SHALL be truncated.

**Validates: Requirements 4.1, 4.2, 4.3, 4.4**

---

### Property 24: Source Code Update Triggers Rescore

_For any_ project whose `sourceCode` is successfully updated through the admin endpoint, the project's `scoreStatus` SHALL be set to `PENDING` and AI scoring SHALL be triggered. A request that fails validation or authorization SHALL leave both `sourceCode` and `scoreStatus` unchanged.

**Validates: Requirements 5.2, 5.3, 5.4**

---

### Property 25: Backward Compatibility Of Existing Projects

_For any_ project record created without an explicit project type, reading it back SHALL yield `projectType = PARTYROCK`, and its crawl, capture, scoring, jury, and export behaviour SHALL be indistinguishable from the behaviour before this feature was introduced. Existing `AIScore` and `finalScore` values SHALL remain unchanged by the schema migration.

**Validates: Requirements 1.2, 8.1, 8.2, 8.3**

---

### Property 26: Pasted Source Code Takes Precedence Over Fetched Markup

_For any_ HTML project that already has a non-empty `sourceCode`, running or re-running a crawl SHALL NOT overwrite that `sourceCode`, even when the fetch succeeds. When `sourceCode` is empty, a successful fetch SHALL populate it.

**Validates: Requirements 3.6**
