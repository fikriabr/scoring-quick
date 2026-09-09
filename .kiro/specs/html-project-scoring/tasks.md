# Implementation Plan: HTML Project Scoring + Rebranding

## Overview

Urutan implementasi: rebranding (independen, bisa langsung dirilis) → foundation (skema, tipe, validasi) → HTML Structure Extractor → crawler & scorer per tipe → UI submission → editor Source Code → parameter default → bulk CSV → checkpoint akhir.

Dua task menunggu keputusan sebelum dijalankan dan ditandai **[BUTUH KONFIRMASI]**: penambahan dependency parser HTML, dan cakupan rename. Lihat bagian "Keputusan yang Menunggu Konfirmasi" pada `design.md`.

Verifikasi di repositori ini: `npm run typecheck`, `npm test`, dan `npx next build`. Penerapan skema memakai `npm run db:push` (repositori tidak memakai folder migrations).

---

## Tasks

- [x] 1. Rebranding ke "Scoring Project by PindAI"
  - [x] 1.1 Ganti penamaan produk yang terlihat pengguna
    - `app/layout.tsx`: `metadata.title` → `'Scoring Project by PindAI'`, `metadata.description` → deskripsi netral platform
    - `app/(dashboard)/admin/layout.tsx`: dua occurrence `<span ...>PartyRock</span>` (sidebar desktop dan header mobile) → `PindAI`
    - _Requirements: 7.1, 7.2_
  - [x] 1.2 Ganti identitas paket dan dokumentasi
    - `package.json`: `"name": "scoring-partyrock"` → `"scoring-project-pindai"`
    - `README.md` dan `docs/*.md`: penamaan produk baru
    - Jangan sentuh: nama file `scripts/partyrock-navigate.js`, `public/partyrock-capture.js` beserta path publiknya, cek hostname `partyrock.aws`, alias CSV `partyrock_url`, CORS origin di `lib/capture-auth.ts`, nama parameter default "Effective Use of PartyRock Features"
    - _Requirements: 7.3, 7.4_
  - [x] 1.3 **[BUTUH KONFIRMASI]** Putuskan cakupan rename folder repositori dan direktori `.kiro/specs/partyrock-assessment-tool/`
    - Tidak dieksekusi tanpa persetujuan eksplisit — keduanya memutus referensi eksternal
  - [x] 1.4 Verifikasi rebranding tidak merusak apa pun
    - Jalankan `npm run typecheck`, `npm test`, dan `npx next build`
    - _Requirements: 7.5_

- [x] 2. Foundation: skema database dan tipe data
  - [x] 2.1 Tambahkan `ProjectType` ke Prisma schema
    - `prisma/schema.prisma`: `enum ProjectType { PARTYROCK HTML }`, `Project.projectType ProjectType @default(PARTYROCK)`, `CrawlMetadata.structure Json?`
    - Jalankan `npm run db:generate` lalu `npm run db:push`
    - _Requirements: 1.1, 1.2_
  - [x] 2.2 Definisikan tipe TypeScript baru
    - `types/index.ts`: interface `HtmlStructure` (heading, semantik, landmark/ARIA, aksesibilitas, kompleksitas dokumen, metadata dokumen), interface `ProjectMetadata` sebagai pelebaran dari `PartyRockMetadata` dengan `projectType` dan `structure` opsional
    - Pertahankan `PartyRockMetadata` sebagai alias agar call site existing tidak perlu diubah serentak
    - _Requirements: 3.3_
  - [x] 2.3 Tulis property test untuk Property 25: Backward Compatibility Of Existing Projects
    - **Property 25: Backward Compatibility Of Existing Projects**
    - **Validates: Requirements 1.2, 8.1, 8.2, 8.3**

- [x] 3. Validasi URL type-aware
  - [x] 3.1 Satukan aturan URL yang terduplikasi ke satu modul
    - Buat `lib/validators/url-rules.ts` — `isPartyRockHost`, `validateProjectUrl(url, projectType)` dengan pembatasan skema `http:`/`https:`
    - Hapus tiga blok refine hostname terduplikasi di `lib/validators/schemas.ts` dan `isPartyRockUrl()` di `components/SubmissionForm.tsx`, arahkan semuanya ke modul baru
    - _Requirements: 2.1, 2.2, 2.3, 2.5_
  - [x] 3.2 Terapkan validasi type-aware pada schema submission
    - `SubmissionSchema` dan `CsvRowSchema`: tambahkan `projectType` dengan default `PARTYROCK`, pindahkan validasi URL ke `superRefine` karena aturannya bergantung pada sibling field
    - `CaptureSchema` **tidak diubah** — tetap mewajibkan hostname `partyrock.aws`
    - _Requirements: 2.1, 2.2, 2.4, 2.6_
  - [x] 3.3 Perbarui property test Property 5 yang kontraknya berubah
    - `__tests__/validators/url-domain.property.test.ts` saat ini mengasumsikan seluruh URL non-PartyRock ditolak (`rejectedUrls` memuat `https://google.com`) dan bahwa `ftp://` diterima. Pecah menjadi kasus per `projectType`, jangan dihapus
    - _Requirements: 8.4_
  - [x] 3.4 Tulis property test untuk Property 21: Project Type Determines URL Validation
    - **Property 21: Project Type Determines URL Validation**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.5**

- [x] 4. Checkpoint — foundation dan validasi
  - Pastikan `npm run typecheck` dan `npm test` lulus. Tanya user bila ada pertanyaan sebelum melanjutkan.

- [x] 5. HTML Structure Extractor
  - [x] 5.1 **[BUTUH KONFIRMASI]** Tambahkan dependency parser HTML
    - `node-html-parser` dengan versi dipin (bukan range terbuka). Tidak dipasang tanpa persetujuan
    - _Requirements: 3.3_
  - [x] 5.2 Buat `lib/services/html-structure.service.ts`
    - `parseHtmlStructure(html): HtmlStructure` — pure function, tanpa I/O, menghitung hierarki heading, rasio elemen semantik, landmark dan atribut ARIA, rasio alt text, rasio label form, kedalaman DOM maksimum, jumlah script/style, serta metadata dokumen
    - `formatStructureForPrompt(structure): string` — merender metrik menjadi blok teks ringkas berukuran terbatas
    - _Requirements: 3.3, 3.4_
  - [x] 5.3 Tulis property test untuk Property 22: HTML Structure Metric Consistency
    - **Property 22: HTML Structure Metric Consistency**
    - **Validates: Requirements 3.3, 3.4**

- [x] 6. Crawler per tipe project
  - [x] 6.1 Pecah ekstraksi `CrawlerService` menjadi strategi per tipe
    - `lib/services/crawler.service.ts`: `crawl(url, projectType): CrawlOutcome`. Untuk `HTML` — fetch dengan timeout existing 15 detik, simpan `rawHtml` (kolom sudah ada dan belum pernah ditulis crawler), hitung `structure`, ambil `title`/`description` dari hasil parser
    - Isi `sourceCode` **hanya** bila `Project.sourceCode` masih kosong
    - Untuk `PARTYROCK`: perilaku sekarang tanpa perubahan
    - _Requirements: 3.1, 3.2, 3.6, 3.7_
  - [x] 6.2 Simpan `structure` pada upsert `CrawlMetadata` dan pertahankan status machine existing
    - `crawlStatus = FAILED` beserta `crawlError` saat fetch gagal, lanjutkan scoring bila `sourceCode` tersedia
    - _Requirements: 3.2, 3.5_
  - [x] 6.3 Arahkan submission Project HTML ke jalur crawl
    - `app/api/submissions/route.ts`: `HTML` → `CrawlerService.triggerCrawl` (yang sudah otomatis melanjutkan ke scoring), `PARTYROCK` → `ScorerService.triggerScoring` seperti sekarang. Pastikan keduanya tidak dipanggil bersamaan
    - _Requirements: 3.1_
  - [x] 6.4 Tulis property test untuk Property 26: Pasted Source Code Takes Precedence Over Fetched Markup
    - **Property 26: Pasted Source Code Takes Precedence Over Fetched Markup**
    - **Validates: Requirements 3.6**

- [x] 7. Prompt AI per tipe project
  - [x] 7.1 Pecah `buildPrompt` menjadi dua builder
    - `lib/services/scorer.service.ts`: `buildPartyRockPrompt` (isi sekarang, tidak diubah) dan `buildHtmlPrompt` (section `## HTML Structure` dari `formatStructureForPrompt`, lalu potongan markup)
    - Dispatch berdasarkan `metadata.projectType`
    - _Requirements: 4.1, 4.2, 4.4_
  - [x] 7.2 Terapkan anggaran karakter yang memprioritaskan ringkasan struktur
    - Ringkasan struktur dikirim utuh lebih dulu, sisa anggaran baru dipakai untuk markup. Jangan biarkan markup menghabiskan anggaran seperti pada pemotongan 20.000 karakter yang berlaku sekarang
    - _Requirements: 4.3_
  - [x] 7.3 Teruskan `projectType` dan `structure` ke metadata scorer
    - `ScorerService.triggerScoring`: sertakan `projectType` dari Project dan `structure` dari `CrawlMetadata`. Tandai `scoreStatus = FAILED` dengan pesan jelas bila Project HTML tidak punya evidence apa pun
    - _Requirements: 4.5, 4.6_
  - [x] 7.4 Tulis property test untuk Property 23: Prompt Selection And Evidence Budget By Project Type
    - **Property 23: Prompt Selection And Evidence Budget By Project Type**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

- [x] 8. Checkpoint — pipeline HTML end-to-end
  - Tambahkan kasus jalur HTML pada `__tests__/integration/pipeline.test.ts` mengikuti pola mock yang sudah ada (`vi.stubGlobal('fetch', ...)` dan mock Gemini via `vi.hoisted`). Pastikan seluruh test lulus.

- [x] 9. UI submission: selector Tipe Project
  - [x] 9.1 Tambahkan selector Tipe Project pada form submission tunggal
    - `components/SubmissionForm.tsx`: tempatkan sebelum field URL karena pilihannya mengubah aturan validasi field di bawahnya
    - Label, placeholder, teks bantuan, dan validasi client-side pada field URL dan Source Code menyesuaikan tipe yang dipilih
    - _Requirements: 1.3, 1.4, 2.4_
  - [x] 9.2 Tampilkan Tipe Project pada daftar dan detail submission
    - `app/(dashboard)/admin/submissions/page.tsx`: kolom Tipe Project pada tabel
    - `app/(dashboard)/admin/submissions/[projectId]/page.tsx`: badge Tipe Project pada header card
    - _Requirements: 1.7_

- [x] 10. Editor Source Code pasca-submit
  - [x] 10.1 Buat endpoint update Source Code
    - `app/api/submissions/[id]/route.ts`: `PATCH`, admin-only, rate-limited, validasi panjang, simpan, set `scoreStatus = PENDING`, fire-and-forget `triggerScoring`
    - _Requirements: 5.2, 5.3, 5.4_
  - [x] 10.2 Buat `components/SourceCodeEditor.tsx`
    - Client component, prefill nilai sekarang, counter karakter, pesan inline mengikuti pola `CaptureImportPanel`, `router.refresh()` setelah sukses
    - _Requirements: 5.1, 5.6_
  - [x] 10.3 Render panel sesuai tipe pada halaman detail
    - `SourceCodeEditor` untuk kedua tipe; `CaptureImportPanel` **hanya** untuk `PARTYROCK`
    - _Requirements: 5.5_
  - [x] 10.4 Tulis property test untuk Property 24: Source Code Update Triggers Rescore
    - **Property 24: Source Code Update Triggers Rescore**
    - **Validates: Requirements 5.2, 5.3, 5.4**

- [x] 11. Set parameter default untuk project web
  - [x] 11.1 Lebarkan `loadDefaultParameters` agar menerima pilihan set
    - `lib/services/category.service.ts`: parameter `set: DefaultParameterSet = 'PARTYROCK'`. Tambahkan set `HTML` dengan total bobot 100% (Semantic HTML & Structure 25, Accessibility 25, Code Quality & Maintainability 20, User Experience & Presentation 15, Impact & Scalability 15)
    - Set PartyRock existing tidak diubah nama, deskripsi, maupun bobotnya
    - _Requirements: 6.1, 6.2, 6.4_
  - [x] 11.2 Sediakan pilihan set template di UI parameter
    - _Requirements: 6.3_

- [x] 12. Dukungan Tipe Project pada bulk CSV
  - [x] 12.1 Tambahkan alias header dan normalisasi nilai
    - `lib/services/submission.service.ts`: alias `project_type` dan `projectType`, default `PARTYROCK` bila absen atau kosong
    - `CsvRowRawSchema`: normalisasi nilai sebelum `.pipe(CsvRowSchema)`
    - _Requirements: 1.5_
  - [x] 12.2 Pastikan baris dengan Tipe Project tidak dikenal ditolak per baris
    - Nomor baris dilaporkan, baris valid lainnya tetap diimpor
    - _Requirements: 1.6_
  - [x] 12.3 Putuskan dan terapkan pemicuan crawl untuk row HTML pada bulk route
    - Loop crawl di `app/api/submissions/bulk/route.ts` saat ini dikomentari
    - _Requirements: 3.1_

- [x] 13. Checkpoint akhir — verifikasi menyeluruh
  - Jalankan `npm run typecheck`, `npm test`, dan `npx next build`
  - Verifikasi manual: submit satu Project HTML dan satu Project PARTYROCK, pastikan keduanya menghasilkan Skor AI, dan pastikan project PartyRock lama tidak berubah skornya
  - _Requirements: 7.5, 8.2, 8.3, 8.4_
