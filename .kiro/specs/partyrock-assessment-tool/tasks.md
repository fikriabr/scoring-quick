# Implementation Plan: PartyRock Assessment Tool

## Overview

Implementasi dilakukan secara incremental dalam urutan: foundation (database, auth, infrastruktur) → service layer (crawler, scorer, leaderboard, jury) → API routes → UI pages → integrasi & wiring akhir. Setiap task membangun di atas task sebelumnya dan diakhiri dengan checkpoint validasi.

---

## Tasks

- [x] 1. Setup project foundation: Prisma schema, DB, dan tipe data
  - Inisialisasi `prisma/schema.prisma` dengan seluruh model: User, Event, Category, CategoryJury, Parameter, Project, CrawlMetadata, AIScore, JuryScore, AuditLog, ScoreOverride
  - Definisikan semua enum: Role, CrawlStatus, ScoreStatus, ScoringMode
  - Buat file `types/index.ts` dengan TypeScript interface: `PartyRockMetadata`, `ScoringParameter`, `ScoringResult`, `ProjectWithScores`, `ApiError`
  - Buat `lib/db.ts` sebagai Prisma client singleton
  - Jalankan `prisma generate` dan `prisma db push` ke Neon PostgreSQL
  - _Requirements: 9.2_

- [x] 2. Implementasi autentikasi NextAuth JWT dan RBAC middleware
  - [x] 2.1 Buat `lib/auth/config.ts` dengan NextAuth CredentialsProvider — validasi email/password via Zod, bandingkan bcrypt hash, inject `role` dan `id` ke JWT token dan session
    - _Requirements: 7.1_
  - [x] 2.2 Tulis property test untuk Property 1: RBAC Access Control
    - **Property 1: RBAC Access Control**
    - **Validates: Requirements 1.1, 7.2, 7.3, 7.4**
  - [x] 2.3 Buat `middleware.ts` di root project — definisikan `ADMIN_PATHS`, cek token via `getToken`, redirect unauthenticated ke `/login`, return HTTP 403 untuk Jury yang mengakses admin path
    - _Requirements: 7.2, 7.3, 7.4_
  - [x] 2.4 Tulis property test untuk Property 15: Jury Category Isolation
    - **Property 15: Jury Category Isolation**
    - **Validates: Requirements 7.6**

- [x] 3. Implementasi Zod validation schemas dan API error handler
  - [x] 3.1 Buat `lib/validators/schemas.ts` — definisikan EventSchema, CategorySchema, ParameterSchema, ParameterSetSchema (refine: total weight = 100% dalam toleransi 0.001), SubmissionSchema (domain `partyrock.aws`), JuryScoreSchema, CsvRowSchema
    - _Requirements: 2.2, 2.3, 3.2, 9.3_
  - [x] 3.2 Tulis property test untuk Property 4: Parameter Weight Sum Invariant
    - **Property 4: Parameter Weight Sum Invariant**
    - **Validates: Requirements 2.2, 2.3**
  - [x] 3.3 Tulis property test untuk Property 5: URL Domain Validation
    - **Property 5: URL Domain Validation**
    - **Validates: Requirements 3.2**
  - [x] 3.4 Buat `lib/api-error.ts` — fungsi `handleApiError` yang menangani ZodError (400), rate limit (429), dan unhandled errors (500) dengan response format `{error, message, code}` tanpa expose stack trace
    - _Requirements: 9.3, 9.5_
  - [x] 3.5 Tulis property test untuk Property 19: Input Validation Coverage
    - **Property 19: Input Validation Coverage**
    - **Validates: Requirements 9.3, 9.5**

- [x] 4. Implementasi rate limiting
  - [x] 4.1 Buat `lib/rate-limit.ts` menggunakan `lru-cache` — fungsi `rateLimit` dengan sliding window 60 detik, batas 10 request per user, throw error saat limit terlampaui
    - _Requirements: 9.6_
  - [x] 4.2 Tulis property test untuk Property 20: Rate Limiting Enforcement
    - **Property 20: Rate Limiting Enforcement**
    - **Validates: Requirements 9.6**

- [x] 5. Checkpoint — Pastikan foundation berjalan
  - Pastikan semua tests pass. Tanya user jika ada pertanyaan sebelum melanjutkan.

- [x] 6. Implementasi EventService dan CategoryService
  - [x] 6.1 Buat `lib/services/event.service.ts` — fungsi `createEvent`, `updateEvent`, `deleteEvent`, `listEvents`, `getEventById` menggunakan Prisma; validasi input via EventSchema sebelum DB call
    - _Requirements: 1.1, 1.2, 1.4_
  - [x] 6.2 Tulis property test untuk Property 2: Event Creation Round Trip
    - **Property 2: Event Creation Round Trip**
    - **Validates: Requirements 1.2**
  - [x] 6.3 Buat `lib/services/category.service.ts` — fungsi `createCategory`, `updateCategory`, `deleteCategory` (cek existing projects — throw HTTP 409 jika ada, requires explicit confirmation), `listCategoriesByEvent`, `getCategoryById`, `publishCategory` (set isPublished = true, generate UUID v4 publicToken), `loadDefaultParameters` (seeding 5 parameter default dengan total weight 100%)
    - _Requirements: 1.3, 1.4, 1.5, 2.4, 8.5_
  - [x] 6.4 Tulis property test untuk Property 3: Category Name Uniqueness Within Event
    - **Property 3: Category Name Uniqueness Within Event**
    - **Validates: Requirements 1.3**
  - [x] 6.5 Tulis unit tests untuk `deleteCategory` dengan existing projects
    - Test bahwa delete ditolak jika ada projects (HTTP 409), dan berhasil jika tidak ada
    - _Requirements: 1.5_

- [x] 7. Implementasi ParameterService dan SubmissionService
  - [x] 7.1 Buat `lib/services/parameter.service.ts` — fungsi `createParameter`, `updateParameter` (warn jika ada existing scores), `deleteParameter`, `reorderParameters`, `listParametersByCategory`; validasi total bobot via ParameterSetSchema sebelum batch save
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6_
  - [x] 7.2 Buat `lib/services/submission.service.ts` — fungsi `submitProject` (validasi URL domain via SubmissionSchema, cek duplikat dalam kategori — return HTTP 409, create Project record dengan crawlStatus = PENDING), `bulkImportFromCsv` (parse CSV menggunakan `csv-parse/sync`, validasi setiap row via CsvRowSchema, import valid rows, kumpulkan errors dengan nomor baris 1-indexed dari header)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_
  - [x] 7.3 Tulis property test untuk Property 6: Submission Duplicate Prevention
    - **Property 6: Submission Duplicate Prevention**
    - **Validates: Requirements 3.3**
  - [x] 7.4 Tulis property test untuk Property 7: CSV Bulk Import Partial Success
    - **Property 7: CSV Bulk Import Partial Success**
    - **Validates: Requirements 3.4, 3.5**

- [x] 8. Implementasi CrawlerService (Playwright)
  - [x] 8.1 Buat `lib/services/crawler.service.ts` — class `CrawlerService` dengan method `crawl(url)`: launch Chromium headless, `page.goto` dengan timeout 30s dan `waitUntil: 'networkidle'`, ekstrak title, description meta tag, widgets dari `[data-widget-type]`, prompts dari textarea/input di dalam widget AI, hitung `widgetCount = widgets.length`
    - _Requirements: 4.1, 4.2_
  - [x] 8.2 Tulis property test untuk Property 8: Crawl Metadata Extraction Completeness
    - **Property 8: Crawl Metadata Extraction Completeness**
    - **Validates: Requirements 4.2, 4.5**
  - [x] 8.3 Tambahkan ke `CrawlerService` method `triggerCrawl(projectId)`: set `crawlStatus = PROCESSING`, panggil `crawl()`, simpan `CrawlMetadata` ke DB, set `crawlStatus = SUCCESS` atau `FAILED` dengan pesan error; method `retriggerCrawl(projectId)`: hapus CrawlMetadata lama, reset `scoreStatus = PENDING`, panggil `triggerCrawl`
    - _Requirements: 4.3, 4.4, 4.5, 4.6_
  - [x] 8.4 Tulis property test untuk Property 9: Crawl Re-trigger Overwrites Previous Data
    - **Property 9: Crawl Re-trigger Overwrites Previous Data**
    - **Validates: Requirements 4.6**

- [x] 9. Implementasi ScorerService (AWS Bedrock)
  - [x] 9.1 Buat `lib/services/scorer.service.ts` — class `ScorerService` dengan method `scoreParameter(metadata, parameter, contextProjects)`: build prompt dengan 5 metode analisis (semantic similarity, NLP extraction, widget complexity, description completeness, keyword/topic analysis), invoke AWS Bedrock via `InvokeModelCommand`, parse response JSON `{score, reasoning}`, clamp score ke `[minScore, maxScore]` dan catat warning di reasoning jika nilai di luar rentang
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_
  - [x] 9.2 Tulis property test untuk Property 10: AI Score Range Invariant
    - **Property 10: AI Score Range Invariant**
    - **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6**
  - [x] 9.3 Tambahkan ke `ScorerService` method `triggerScoring(projectId)`: fetch semua parameter AUTO dari kategori project, fetch CrawlMetadata, fetch context projects, iterate tiap parameter → panggil `scoreParameter`, simpan `AIScore` ke DB; jika semua berhasil set `scoreStatus = SUCCESS`, sebagian gagal `PARTIAL`, semua gagal `FAILED`; hitung dan simpan `finalScore` sementara via `calculateWeightedScore`
    - _Requirements: 5.1, 5.7, 5.8, 5.9_

- [x] 10. Implementasi LeaderboardService dan JuryService
  - [x] 10.1 Buat `lib/services/leaderboard.service.ts` — fungsi `calculateWeightedScore(scores)` (Σ score_i × weight_i / 100), `calculateAverageJuryScore(juryScores)` (arithmetic mean), `getLeaderboard(categoryId)` (fetch projects dengan finalScore, sort descending, null last, tiebreak by createdAt asc), `getPublicLeaderboard(publicToken)` (cek isPublished — return null/404 jika false)
    - _Requirements: 8.1, 8.2, 8.5_
  - [x] 10.2 Tulis property test untuk Property 11: Weighted Score Calculation
    - **Property 11: Weighted Score Calculation**
    - **Validates: Requirements 5.9, 6.4**
  - [x] 10.3 Tulis property test untuk Property 12: Multi-Jury Average Final Score
    - **Property 12: Multi-Jury Average Final Score**
    - **Validates: Requirements 6.7**
  - [x] 10.4 Tulis property test untuk Property 16: Leaderboard Sort Order
    - **Property 16: Leaderboard Sort Order**
    - **Validates: Requirements 8.1**
  - [x] 10.5 Buat `lib/services/jury.service.ts` — fungsi `submitJuryScore(projectId, parameterId, juryId, score, comment)`: cek akses juri ke kategori (403 jika tidak assigned), validasi score dalam rentang via JuryScoreSchema, cek override threshold (|newScore - aiScore| > 20% × (maxScore - minScore) → comment wajib), upsert JuryScore, create AuditLog (oldValue dari existing score atau null), recalculate finalScore (single atau multi-jury average), update Project.finalScore, trigger `revalidatePath`; fungsi `acceptAiScore(projectId, parameterId, juryId)` — copy AIScore ke JuryScore dengan `isOverride = false`, tandai sebagai calculated
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_
  - [x] 10.6 Tulis property test untuk Property 13: Jury Override Comment Requirement
    - **Property 13: Jury Override Comment Requirement**
    - **Validates: Requirements 6.3**
  - [x] 10.7 Tulis property test untuk Property 14: Audit Trail Completeness
    - **Property 14: Audit Trail Completeness**
    - **Validates: Requirements 6.6**

- [x] 11. Checkpoint — Pastikan semua service tests pass
  - Pastikan semua tests pass. Tanya user jika ada pertanyaan sebelum melanjutkan ke API routes.

- [x] 12. Implementasi API Routes — Auth, Events, Categories, Parameters
  - [x] 12.1 Buat `app/api/auth/[...nextauth]/route.ts` — export handler NextAuth dengan config dari `lib/auth/config.ts`; buat `app/(auth)/login/page.tsx` dengan form login (email + password)
    - _Requirements: 7.1, 7.3_
  - [x] 12.2 Buat `app/api/events/route.ts` (GET list, POST create) dan `app/api/events/[id]/route.ts` (GET, PUT, DELETE) — gunakan EventService, wrap dengan `handleApiError`, guard Admin-only via session check
    - _Requirements: 1.1, 1.2, 1.4_
  - [x] 12.3 Buat `app/api/categories/route.ts` (GET, POST) dan `app/api/categories/[id]/route.ts` (GET, PUT, DELETE, POST /publish) — gunakan CategoryService, return HTTP 409 jika delete pada kategori yang memiliki projects
    - _Requirements: 1.3, 1.4, 1.5, 8.5_
  - [x] 12.4 Buat `app/api/parameters/route.ts` (GET, POST batch) dan `app/api/parameters/[id]/route.ts` (PUT, DELETE) — gunakan ParameterService, validasi total bobot 100% via ParameterSetSchema sebelum simpan, tampilkan peringatan jika ada existing scores
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6_

- [x] 13. Implementasi API Routes — Submissions, Crawl, Score, Users
  - [x] 13.1 Buat `app/api/submissions/route.ts` (POST single submission, POST /bulk untuk CSV upload) — gunakan SubmissionService, terapkan rate limiting 10/min, trigger `CrawlerService.triggerCrawl` secara async setelah project berhasil dibuat
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 9.6_
  - [x] 13.2 Buat `app/api/crawl/[projectId]/route.ts` (POST trigger/retrigger) — cek auth Admin, terapkan rate limiting 10/min, panggil `CrawlerService.triggerCrawl` atau `retriggerCrawl`; return status crawling terkini
    - _Requirements: 4.1, 4.4, 4.6, 9.6_
  - [x] 13.3 Buat `app/api/score/[projectId]/route.ts` (POST trigger AI scoring, POST retry) — cek auth Admin, terapkan rate limiting, panggil `ScorerService.triggerScoring`; return score status terkini
    - _Requirements: 5.1, 5.8, 9.6_
  - [x] 13.4 Buat `app/api/users/route.ts` (GET list, POST create jury) dan `app/api/users/[id]/route.ts` (PUT, DELETE) — hash password dengan bcrypt sebelum simpan, guard Admin-only; buat `app/api/categories/[id]/jury/route.ts` (POST assign, DELETE unassign)
    - _Requirements: 7.5, 7.6_

- [x] 14. Implementasi API Routes — Jury scoring, Leaderboard, Export
  - [x] 14.1 Buat `app/api/projects/[id]/score/route.ts` (POST jury score) dan `app/api/projects/[id]/score/accept/route.ts` (POST accept AI score) — gunakan JuryService, enforce 20% override threshold + comment requirement, upsert JuryScore, create AuditLog, recalculate finalScore, trigger `revalidatePath`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_
  - [x] 14.2 Buat `app/api/leaderboard/[categoryId]/route.ts` (GET) — gunakan LeaderboardService, sort descending, null last, tiebreak createdAt asc; buat `app/api/public/leaderboard/[token]/route.ts` — no auth, cek isPublished, return HTTP 404 jika false
    - _Requirements: 8.1, 8.2, 8.5_
  - [x] 14.3 Tulis property test untuk Property 18: Public Leaderboard Access Control
    - **Property 18: Public Leaderboard Access Control**
    - **Validates: Requirements 8.5**
  - [x] 14.4 Buat `lib/services/export.service.ts` dengan `exportToExcel(projects)` menggunakan ExcelJS — kolom dinamis per parameter (AI score, jury score, komentar), satu row per project, urutan peringkat; buat `app/api/export/[categoryId]/route.ts` (GET CSV, GET Excel) — stream file ke client dengan header `Content-Disposition`
    - _Requirements: 8.3_
  - [x] 14.5 Tulis property test untuk Property 17: Export Data Completeness
    - **Property 17: Export Data Completeness**
    - **Validates: Requirements 8.3**

- [x] 15. Checkpoint — Pastikan semua API route tests pass
  - Pastikan semua tests pass. Tanya user jika ada pertanyaan sebelum melanjutkan ke UI.

- [x] 16. Implementasi halaman Admin — Events, Categories, Parameters
  - [x] 16.1 Buat layout RSC `app/(dashboard)/admin/layout.tsx` — cek session server-side, redirect ke login jika tidak auth, return 403 jika bukan Admin; buat `app/(dashboard)/admin/events/page.tsx` (daftar events) dan `app/(dashboard)/admin/events/[id]/page.tsx` (detail event + daftar kategori)
    - _Requirements: 1.1, 9.1_
  - [x] 16.2 Buat Server Actions `actions/event.actions.ts` (`createEvent`, `updateEvent`, `deleteEvent`) dan form components `EventForm`, `CategoryForm` dengan validasi client-side via EventSchema/CategorySchema; tampilkan pesan konfirmasi sebelum delete kategori yang memiliki projects
    - _Requirements: 1.2, 1.3, 1.4, 1.5_
  - [x] 16.3 Buat `app/(dashboard)/admin/categories/[id]/parameters/page.tsx` — UI manajemen parameter dengan builder dinamis, tampilkan total bobot real-time, error jika total ≠ 100%, tombol "Load Default Template" yang memanggil `loadDefaultParameters`; tambahkan field toggle `scoringMode` per parameter (AUTO/MANUAL)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

- [x] 17. Implementasi halaman Admin — Submissions, Users, Leaderboard
  - [x] 17.1 Buat `app/(dashboard)/admin/submissions/page.tsx` — form input submission tunggal (URL, nama peserta, tim, pilih kategori) dan upload CSV dengan preview baris error; tampilkan status crawl per project (badge: PENDING/PROCESSING/SUCCESS/FAILED) dengan tombol retry crawl dan retry AI scoring
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.3, 4.4_
  - [x] 17.2 Buat `app/(dashboard)/admin/users/page.tsx` — tabel daftar users, form create jury (nama, email, password), form assign jury ke kategori; tampilkan assignment matrix (jury × kategori)
    - _Requirements: 7.5, 7.6_
  - [x] 17.3 Buat `app/(dashboard)/admin/leaderboard/[categoryId]/page.tsx` — RSC page dengan tabel leaderboard (peringkat, peserta, URL, skor final, breakdown per parameter), tombol export CSV/Excel, tombol "Publish" yang toggle `isPublished` dan tampilkan public URL setelah dipublish
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
  - [x] 17.4 Buat `app/(dashboard)/admin/leaderboard/[categoryId]/compare/page.tsx` — halaman perbandingan project: UI untuk memilih 2+ project dari daftar, tampilkan side-by-side rincian skor per parameter untuk project yang dipilih
    - _Requirements: 8.4_

- [x] 18. Implementasi halaman Jury dan Public Leaderboard
  - [x] 18.1 Buat layout RSC `app/(dashboard)/jury/layout.tsx` — cek session, redirect jika tidak auth; buat `app/(dashboard)/jury/projects/page.tsx` — daftar project yang di-assign ke juri yang login, badge status penilaian (belum dinilai/sebagian/selesai), filter per kategori
    - _Requirements: 6.1, 7.6_
  - [x] 18.2 Buat `app/(dashboard)/jury/scoring/[projectId]/page.tsx` — tampilkan CrawlMetadata (title, description, widgets, prompts), Skor AI per parameter beserta reasoning, form input skor manual per parameter dengan validasi rentang; field komentar muncul dan wajib diisi jika score deviation >20% dari rentang nilai; tombol "Accept AI Score" per parameter yang memanggil `acceptAiScore`
    - _Requirements: 6.2, 6.3, 6.4, 6.5_
  - [x] 18.3 Buat `app/public/leaderboard/[token]/page.tsx` — RSC page tanpa auth (tidak di-guard middleware), fetch via `getPublicLeaderboard(token)`, panggil `notFound()` jika token tidak valid atau `isPublished = false`; set `export const revalidate = 30` untuk time-based ISR fallback
    - _Requirements: 8.5, 9.1_

- [x] 19. Wiring pipeline akhir: Submission → Crawl → AI Score
  - [x] 19.1 Wire end-to-end pipeline di `app/api/submissions/route.ts`: setelah `submitProject` berhasil, panggil `CrawlerService.triggerCrawl(projectId)` dalam background (tanpa await di response), pastikan di dalam `triggerCrawl` setelah crawl success otomatis memanggil `ScorerService.triggerScoring(projectId)` — verifikasi status transitions tepat (PENDING → PROCESSING → SUCCESS/FAILED)
    - _Requirements: 4.1, 5.1, 9.6_
  - [x] 19.2 Pastikan setiap perubahan `finalScore` memanggil `revalidatePath` untuk leaderboard halaman admin dan public; verifikasi Playwright berjalan di Node.js runtime (bukan edge runtime) dan AWS Bedrock client terinisialisasi dengan env vars dari `process.env`
    - _Requirements: 8.1, 9.4_
  - [x] 19.3 Tulis integration tests end-to-end untuk pipeline Submission → Crawl → Score menggunakan Playwright test runner dengan mock Bedrock responses
    - Test full happy path dan failure recovery (crawl timeout, scoring partial failure)
    - _Requirements: 4.1, 4.4, 5.1, 5.8_

- [x] 20. Final checkpoint — Pastikan semua tests pass
  - Pastikan semua tests pass (unit, property, integration). Tanya user jika ada pertanyaan sebelum menyatakan implementasi selesai.

- [x] 21. Capture pipeline — pengganti crawling widget yang diblokir WAF
  - Task 8.1 mengasumsikan Playwright headless bisa membaca widget/prompt dari
    halaman PartyRock. Asumsi itu salah: AWS WAF memblokir API internal
    `getLatestAppVersion` (HTTP 403) untuk browser otomatis, sehingga
    `widgets`, `prompts`, dan `widgetCount` selalu kosong dan AI scoring
    menilai hanya dari judul + deskripsi.
  - [x] 21.1 Buat `public/partyrock-capture.js` — jalan di dalam halaman
        PartyRock, wrap `fetch`/`XHR` untuk membaca definisi app dari traffic yang
        diminta halaman itu sendiri, plus ekstraksi DOM sebagai cadangan dan
        satu-satunya sumber output AI; panel melayang untuk kirim/salin/lewati
    - _Requirements: 4.2, 4.5_
  - [x] 21.2 Buat `lib/services/capture.service.ts` + `app/api/capture/route.ts`
        dan `app/api/capture/queue/route.ts` — cocokkan URL ke project (normalisasi
        URL, fallback app id), simpan `CrawlMetadata` + `Project.sourceCode`, set
        `crawlStatus = SUCCESS`, panggil `ScorerService.triggerScoring`; auth via
        shared token (`CAPTURE_TOKEN`) atau sesi Admin
    - _Requirements: 4.2, 4.5, 4.6, 5.1, 9.3, 9.4_
  - [x] 21.3 Buat `scripts/partyrock-navigate.js` — automasi **navigasi saja**:
        buka Chrome asli (headed, profil persisten), kunjungi tiap URL antrian,
        inject script capture, kirim hasil dari Node. Klik widget tetap manual —
        lihat `docs/CAPTURE.md` untuk alasannya
    - _Requirements: 4.1, 4.3_
  - [x] 21.4 Buat `components/CaptureImportPanel.tsx` — fallback paste-JSON per
        project di halaman detail submission, tanpa Playwright
    - _Requirements: 4.6_
  - [x] 21.5 Tulis test untuk capture pipeline
    - `__tests__/services/capture-ingest.property.test.ts` — pencocokan URL
      tahan rename app, kelengkapan `sourceCode`, persistensi + re-scoring
    - `__tests__/services/capture-script.test.ts` — ekstraksi widget dari JSON
      arbitrer di DOM stub, termasuk payload siklik dan false positive schema

- [ ] 22. Implementasi Google Sheets Integration
  - [ ] 22.1 Update Prisma schema — tambahkan field `spreadsheetId String?`, `autoSync Boolean @default(false)`, dan `syncEmail String?` pada model `Category`; jalankan `prisma generate` dan `prisma db push`
    - _Requirements: 10.7_
  - [ ] 22.2 Buat `lib/services/sheets.service.ts` — class `SheetsService` dengan autentikasi Google service account via `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` env var; method `createLeaderboardSheet(title, projects, parameterNames)` yang membuat spreadsheet baru via Google Sheets API v4 dan menulis header + data rows; method `shareSpreadsheet(spreadsheetId, emails)` yang memberi akses writer via Google Drive API; method `updateLeaderboardSheet(spreadsheetId, projects, parameterNames)` yang clear lalu tulis ulang data
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.6_
  - [ ] 22.3 Buat `app/api/sheets/[categoryId]/route.ts` — POST handler untuk create spreadsheet baru (fetch leaderboard, panggil `createLeaderboardSheet`, share ke emails, simpan `spreadsheetId` ke DB); PATCH handler untuk toggle `autoSync` dan update `syncEmail`; terapkan rate limiting 5 request/menit per user, guard Admin-only
    - _Requirements: 10.3, 10.4, 10.7, 10.9_
  - [ ] 22.4 Buat fungsi `triggerSheetSync(categoryId)` di `lib/services/sheets.service.ts` — cek `category.autoSync` dan `spreadsheetId`, jika aktif panggil `updateLeaderboardSheet`; wrap dalam try-catch agar error non-blocking (log ke console, jangan ganggu alur scoring)
    - _Requirements: 10.5, 10.6, 10.8_
  - [ ] 22.5 Wire auto-sync: panggil `triggerSheetSync(categoryId)` di `jury.service.ts` (setelah recalculate finalScore) dan di `scorer.service.ts` (setelah calculate finalScore sementara) — pastikan non-blocking (fire-and-forget pattern dengan `.catch(console.error)`)
    - _Requirements: 10.5_
  - [ ]\* 22.6 Tulis property test untuk Property 21: Google Sheets Export Data Integrity
    - **Property 21: Google Sheets Export Data Integrity**
    - **Validates: Requirements 10.3, 10.5, 10.6**
  - [ ]\* 22.7 Tulis property test untuk Property 22: Google Sheets Auto-sync Idempotency
    - **Property 22: Google Sheets Auto-sync Idempotency**
    - **Validates: Requirements 10.5, 10.6**
  - [ ]\* 22.8 Tulis unit tests untuk SheetsService
    - Test createLeaderboardSheet dengan mock googleapis
    - Test shareSpreadsheet dengan multiple emails
    - Test updateLeaderboardSheet (clear + rewrite)
    - Test error handling (invalid credentials, quota exceeded)
    - _Requirements: 10.8_

- [ ] 23. Implementasi UI Google Sheets di halaman Leaderboard Admin
  - [ ] 23.1 Update `app/(dashboard)/admin/leaderboard/[categoryId]/page.tsx` — tambahkan tombol "Export to Google Sheets" yang membuka modal input emails (comma-separated); setelah export berhasil tampilkan link ke spreadsheet; tambahkan toggle switch "Auto-sync" dengan indikator status (aktif/nonaktif) dan field email penerima
    - _Requirements: 10.3, 10.4, 10.5, 10.7_
  - [ ] 23.2 Buat component `components/SheetsExportModal.tsx` — modal dialog dengan: input field emails (validasi format email client-side), tombol "Export", loading state, success state (tampilkan spreadsheet URL sebagai link), error state (tampilkan pesan error dari API)
    - _Requirements: 10.3, 10.4, 10.8_

- [ ] 24. Checkpoint — Pastikan Google Sheets integration tests pass
  - Pastikan semua tests pass (unit, property). Tanya user jika ada pertanyaan.

---

## Notes

- Tasks bertanda `*` adalah opsional dan dapat dilewati untuk MVP yang lebih cepat
- Setiap task merujuk ke requirement spesifik untuk traceability
- Checkpoint memastikan validasi inkremental sebelum lanjut ke layer berikutnya
- Property tests memvalidasi correctness properties universal dari design document
- Unit tests memvalidasi contoh spesifik dan edge cases
- Pipeline Submission → Crawl → AI Score berjalan async — status polling dari frontend dilakukan via polling API atau ISR revalidation
- Requirement 8.4 (project comparison view) diimplementasikan di task 17.4 sebagai halaman terpisah
- Google Sheets auto-sync bersifat non-blocking (fire-and-forget) agar tidak mengganggu alur penilaian utama
- `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` env var harus di-set ke path file JSON service account credentials

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.2", "3.3", "3.4", "4.2"] },
    { "id": 3, "tasks": ["2.4", "3.5", "6.1", "7.1"] },
    { "id": 4, "tasks": ["6.2", "6.3", "6.4", "6.5", "7.2", "7.3", "7.4"] },
    { "id": 5, "tasks": ["8.1", "9.1", "10.1"] },
    {
      "id": 6,
      "tasks": ["8.2", "8.3", "9.2", "9.3", "10.2", "10.3", "10.4", "10.5"]
    },
    { "id": 7, "tasks": ["8.4", "9.3", "10.6", "10.7", "12.1", "12.2"] },
    { "id": 8, "tasks": ["12.3", "12.4", "13.1", "13.4"] },
    { "id": 9, "tasks": ["13.2", "13.3", "14.1", "14.2"] },
    { "id": 10, "tasks": ["14.3", "14.4", "16.1"] },
    { "id": 11, "tasks": ["14.5", "16.2", "16.3"] },
    { "id": 12, "tasks": ["17.1", "17.2"] },
    { "id": 13, "tasks": ["17.3", "17.4", "18.1"] },
    { "id": 14, "tasks": ["18.2", "18.3"] },
    { "id": 15, "tasks": ["19.1", "22.1"] },
    { "id": 16, "tasks": ["19.2", "22.2"] },
    { "id": 17, "tasks": ["19.3", "22.3", "22.4"] },
    { "id": 18, "tasks": ["22.5", "22.6", "22.7", "22.8"] },
    { "id": 19, "tasks": ["23.1", "23.2"] }
  ]
}
```
