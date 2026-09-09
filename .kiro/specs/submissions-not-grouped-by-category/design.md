# Submissions Not Grouped By Category — Bugfix Design

## Overview

Halaman `/admin/submissions` merender satu tabel datar berisi seluruh project urut `createdAt` desc, sehingga project satu kategori tersebar dan jumlah per kategori tidak terlihat. Nama kategori juga ambigu karena `Category` hanya unik per event (`@@unique([eventId, name])`).

Perbaikannya murni perubahan tampilan pada satu React Server Component:

1. Query project existing ditambah `category.event.name` (satu-satunya perubahan data layer).
2. Pengelompokan dilakukan di memori lewat satu fungsi murni baru, `groupProjectsByCategory`, di `lib/submission-grouping.ts` — supaya logikanya bisa diuji unit tanpa merender React.
3. RSC merender satu `<section>` per grup: heading `Event — Kategori (N)` + sub-tabel. Markup baris/tabel diekstrak jadi dua komponen kecil di file yang sama agar header tabel tidak diduplikasi per section.

Tidak ada abstraksi baru selain satu fungsi grouping + dua komponen lokal. Tidak ada perubahan skema, API, atau query lain.

## Glossary

- **Bug_Condition (C)**: halaman punya minimal satu project untuk dirender (`count(projects) > 0`), sehingga ketiadaan pengelompokan per kategori bisa diamati.
- **Property (P)**: project dirender sebagai section per kategori, urut event lalu kategori A-Z, tiap section memuat heading `Event — Kategori`, jumlah project, dan sub-tabel project kategori itu urut `createdAt` desc.
- **Preservation**: empty state, total `Projects (N)`, form submit + CSV upload, isi kolom per project, badge, aksi View, dan scroll horizontal tetap sama.
- **`AdminSubmissionsPage`**: RSC di `app/(dashboard)/admin/submissions/page.tsx` yang mengambil data dan merender daftar.
- **`groupProjectsByCategory`**: fungsi murni baru di `lib/submission-grouping.ts` yang mengubah daftar project datar jadi daftar grup kategori terurut.
- **`categoryId`**: kunci pengelompokan yang dipakai (bukan nama kategori), karena nama bisa sama antar event.

## Bug Details

### Bug Condition

Bug muncul setiap kali halaman punya project untuk dirender: `AdminSubmissionsPage` melakukan `db.project.findMany({ orderBy: { createdAt: 'desc' } })` lalu memetakannya langsung ke baris `<tbody>` tunggal. Tidak ada langkah pengelompokan, dan `serializedProjects` hanya membawa `categoryName` tanpa `eventName`, sehingga heading `Event — Kategori` bahkan belum bisa dibentuk dari data yang ada.

**Formal Specification:**

```
FUNCTION isBugCondition(input)
  INPUT: input of type SubmissionsPageData   // daftar project + kategori & event-nya
  OUTPUT: boolean

  RETURN count(input.projects) > 0
END FUNCTION
```

### Examples

- 3 project di kategori "AI Track" dan 2 di "Web Track", submit berselang-seling → **sekarang**: 5 baris tercampur urut waktu; **seharusnya**: section "Hackathon 2025 — AI Track (3)" lalu "Hackathon 2025 — Web Track (2)".
- Event "Hackathon 2024" dan "Hackathon 2025" sama-sama punya kategori "AI Track" → **sekarang**: kolom Category menampilkan teks "AI Track" identik untuk keduanya; **seharusnya**: dua section terpisah dengan heading memuat nama event.
- Admin ingin tahu jumlah project kategori "Web Track" → **sekarang**: harus dihitung manual, heading hanya menampilkan total; **seharusnya**: angka ada di heading section.
- Kategori "Design Track" ada tapi belum ada project → **seharusnya**: tidak ada section untuknya (grouping diturunkan dari daftar project, jadi otomatis).
- Belum ada project sama sekali → **seharusnya**: empty state persis seperti sekarang (C(X) false).

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- Empty state "No projects submitted yet." dengan markup dan wrapper card yang sama, tanpa tabel/section (3.1).
- Heading daftar tetap `Projects (N)` dengan N = total seluruh project (3.2).
- Per project: kolom Participant (+ nama tim di bawahnya bila ada), URL sebagai tautan `target="_blank" rel="noopener noreferrer"`, Type, Crawl, Score, aksi View — label UI tetap bahasa Inggris (3.3).
- `ProjectTypeBadge` dan `StatusBadge` dipakai tanpa perubahan, termasuk fallback `PARTYROCK` untuk project lama (3.4, 3.5).
- View menuju `/admin/submissions/[projectId]`; retry crawl/score tetap hanya di halaman detail (3.6).
- `SubmissionForm` dengan `serializedCategories` (urut nama, memuat nama event) tetap di atas daftar (3.7).
- Wrapper `overflow-x-auto` dipertahankan di setiap sub-tabel sehingga tabel tetap bisa digeser horizontal di layar sempit (3.8).

**Scope:**

Saat tidak ada project (`count(projects) == 0`), render halaman harus identik dengan sebelum perbaikan. Untuk kasus lain, data per project yang ditampilkan tidak berubah; yang berubah hanya susunan (pengelompokan + hilangnya kolom Category yang informasinya pindah ke heading).

## Hypothesized Root Cause

Bukan bug logika — ini fitur presentasi yang belum ada. Penyebabnya bertingkat:

1. **Tidak ada langkah pengelompokan**: `serializedProjects.map(...)` dirender langsung ke satu `<tbody>`; kategori hanya jadi kolom, dan kolom tidak menghasilkan grouping.
2. **Data event tidak diambil**: query project memakai `include: { category: { select: { id: true, name: true } } }` — `event.name` tidak ikut, jadi heading `Event — Kategori` tidak bisa dibentuk tanpa mengubah query. Sudah diverifikasi langsung di file dan di `prisma/schema.prisma` (`Category.event` adalah relasi wajib, jadi `event.name` selalu ada).
3. **Urutan hanya satu dimensi**: `orderBy: { createdAt: 'desc' }` benar untuk urutan di dalam grup, tapi tidak memberi urutan antar grup.
4. **Markup tabel inline di satu blok**: header tabel ditulis sekali di dalam JSX halaman, sehingga merender beberapa sub-tabel akan menduplikasi markup kalau tidak diekstrak dulu.

## Correctness Properties

Property 1: Bug Condition - Project Dikelompokkan Per Kategori

_For any_ daftar project di mana bug condition berlaku (`isBugCondition` true), halaman yang sudah diperbaiki SHALL merender tepat satu section per kategori yang punya project, terurut berdasarkan nama event lalu nama kategori A-Z case-insensitive, dengan heading `Event — Kategori` beserta jumlah project di kategori itu, dan project di dalam setiap section terurut `createdAt` desc — setiap project muncul tepat satu kali, di grupnya sendiri.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8**

Property 2: Preservation - Halaman Tanpa Project

_For any_ input di mana bug condition TIDAK berlaku (`isBugCondition` false, yaitu tidak ada project sama sekali), halaman yang sudah diperbaiki SHALL menghasilkan render yang sama dengan versi sebelumnya: empty state "No projects submitted yet.", heading `Projects (0)`, dan form submit + CSV upload tetap tampil.

**Validates: Requirements 3.1, 3.2**

## Fix Implementation

### Changes Required

**File baru**: `lib/submission-grouping.ts`

Fungsi murni, tanpa `'use client'`, tanpa import runtime Prisma (tipe saja bila perlu), generik atas bentuk baris supaya bisa diuji dengan objek literal:

```ts
export type GroupableProject = {
  categoryId: string
  categoryName: string
  eventName: string
}

export type CategoryGroup<T> = {
  categoryId: string
  categoryName: string
  eventName: string
  heading: string // `${eventName} — ${categoryName}`
  projects: T[]
}

export function groupProjectsByCategory<T extends GroupableProject>(
  projects: T[],
): CategoryGroup<T>[]
```

Implementasi:

1. Iterasi `projects` sekali, kumpulkan ke `Map<categoryId, CategoryGroup<T>>` — kunci `categoryId`, bukan nama, karena nama hanya unik per event.
2. Karena input sudah urut `createdAt` desc dari Prisma dan `Map` mempertahankan urutan insert per grup, urutan project di dalam grup otomatis benar. Tidak perlu sort ulang di dalam grup (2.5).
3. Sort daftar grup dengan `localeCompare(..., undefined, { sensitivity: 'base' })` pada `eventName` lalu `categoryName` — case-insensitive (2.4). `orderBy` Prisma tidak bisa dipakai untuk ini karena urutan antar grup ditentukan setelah pengelompokan; sorting di memori jauh lebih sederhana daripada query kedua per kategori.
4. Kategori tanpa project tidak pernah masuk `Map`, jadi tidak dirender (2.6). `categories` yang sudah di-fetch tetap dipakai hanya untuk `SubmissionForm`.

**File**: `app/(dashboard)/admin/submissions/page.tsx`

1. **Query**: tambahkan event ke include project yang sudah ada — `include: { category: { select: { id: true, name: true, event: { select: { name: true } } } } }`. `orderBy: { createdAt: 'desc' }` tetap. Tetap satu query project, tanpa query tambahan.
2. **Serialisasi**: `serializedProjects` menambah `categoryId: p.categoryId` dan `eventName: p.category.event.name`; field lain tidak berubah.
3. **Grouping**: `const groups = groupProjectsByCategory(serializedProjects)` setelah serialisasi.
4. **Render**: heading `Projects ({serializedProjects.length})` dan cabang empty state dipertahankan apa adanya. Cabang non-empty berubah dari satu tabel jadi `groups.map(...)`, tiap grup jadi `<section>` dengan heading `{group.heading}` + `({group.projects.length})`, lalu `<ProjectsTable projects={group.projects} />`.
5. **Ekstraksi komponen** di file yang sama:
   - `ProjectsTable({ projects })` — memuat wrapper card + `overflow-x-auto` + `<thead>` + `<tbody>`, dipakai per section sehingga markup header tidak diduplikasi.
   - `ProjectRow` tetap ada, hanya kehilangan sel Category.
   - Kolom Category dihapus dari `<thead>` dan `ProjectRow` (2.7). `StatusBadge`, `ProjectTypeBadge`, dan link View tidak berubah.
6. **Tipe**: definisi props `ProjectRow`/`ProjectsTable` diperbarui (`categoryId`, `eventName` masuk; `categoryName` tetap ada untuk heading tapi tidak dirender di baris).

## Testing Strategy

### Validation Approach

Dua fase: lebih dulu tulis test yang gagal pada kode belum-diperbaiki untuk memastikan bug condition benar-benar terwakili, lalu verifikasi fix + preservation.

Repo **tidak** punya React testing-library (`package.json` hanya punya `vitest` + `fast-check`), jadi tidak ada test render komponen. Semua logika yang layak diuji diekstrak ke `groupProjectsByCategory` dan diuji sebagai fungsi murni di `__tests__/` mengikuti konvensi yang ada (`*.test.ts`, `*.property.test.ts`). Aspek visual (heading tampil, kolom Category hilang, empty state) diverifikasi manual di `npm run dev`.

Perintah verifikasi selama iterasi: `npm run typecheck` dan `npx vitest run`. **Jangan** pakai `npx next build` untuk iterasi — 2-3 menit karena prerender halaman ini menyentuh database.

### Exploratory Bug Condition Checking

**Goal**: memunculkan counterexample sebelum fix, dan mengonfirmasi/menolak analisis root cause.

**Test Plan**: tulis `__tests__/submission-grouping.test.ts` yang mengimpor `groupProjectsByCategory` dari `lib/submission-grouping.ts`. Sebelum fix, modul belum ada sehingga test gagal — counterexample paling langsung untuk "tidak ada langkah pengelompokan". Sekaligus baca ulang query di `page.tsx` untuk mengonfirmasi `event.name` memang tidak tersedia.

**Test Cases**:

1. **Dua kategori tercampur**: 5 project dari 2 kategori berselang-seling → 2 grup, tiap project di grup yang benar (gagal pada kode belum diperbaiki).
2. **Nama kategori sama antar event**: dua kategori berbeda `categoryId` dengan `categoryName` identik dari event berbeda → tetap 2 grup dengan heading berbeda (gagal pada kode belum diperbaiki).
3. **Urutan grup**: nama event/kategori dengan campuran huruf besar-kecil → urut A-Z case-insensitive (gagal pada kode belum diperbaiki).
4. **Edge case**: daftar kosong → `[]`, dan satu project → satu grup dengan `projects.length === 1`.

**Expected Counterexamples**: sebelum fix tidak ada fungsi/level pengelompokan sama sekali, dan `eventName` tidak ada di data halaman. Kemungkinan penyebab: pemetaan langsung ke satu `<tbody>`, `include` query tanpa `event`, dan tidak adanya urutan antar grup.

### Fix Checking

**Goal**: untuk semua input di mana bug condition berlaku, hasil sudah sesuai perilaku yang diharapkan.

**Pseudocode:**

```
FOR ALL input WHERE isBugCondition(input) DO
  groups := groupProjectsByCategory(input.projects)
  ASSERT groups = sortByEventThenCategoryName(distinctCategoriesOf(input.projects))
  ASSERT FOR EACH g IN groups:
           g.heading  = g.eventName + " — " + g.categoryName
           count(g.projects) = count(projectsOf(g))
           g.projects preserves createdAt-desc order of input
  ASSERT every project in input.projects appears in exactly one group
END FOR
```

### Preservation Checking

**Goal**: untuk semua input di mana bug condition TIDAK berlaku, hasilnya sama seperti sebelum fix.

**Pseudocode:**

```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT renderSubmissionsPage(input) = renderSubmissionsPage'(input)
END FOR
```

`¬C(X)` di sini hanya kasus "tidak ada project". Karena tidak ada test render, preservation dijaga dengan dua cara: (a) `groupProjectsByCategory([])` mengembalikan `[]` sehingga cabang empty state tidak pernah tersentuh, dan (b) blok empty state di `page.tsx` tidak disunting sama sekali — dipastikan lewat review diff (harus nol perubahan di blok itu) plus cek manual satu kali.

**Testing Approach**: property-based testing dipakai untuk fix checking karena menghasilkan banyak kombinasi kategori/event/urutan otomatis dan menangkap edge case (nama sama antar event, beda kapitalisasi) yang mudah terlewat di unit test manual. `fast-check` sudah tersedia di devDependencies.

**Test Plan**: verifikasi perilaku non-bug (mouse/View/badge/form) tetap lewat pemeriksaan manual di dev server, bukan test otomatis, karena semuanya perilaku render.

**Test Cases**:

1. **Empty state**: `groupProjectsByCategory([])` → `[]`; blok empty state di `page.tsx` tidak berubah (diff review).
2. **Total tetap**: jumlah project di seluruh grup = panjang input, jadi heading `Projects (N)` tetap benar (3.2).
3. **Data per project utuh**: objek project di dalam grup adalah referensi yang sama dengan input (fungsi tidak memodifikasi/menyalin field), sehingga badge, URL, dan aksi View menerima data identik (3.3–3.6).

### Unit Tests

- `__tests__/submission-grouping.test.ts`: dua kategori tercampur, nama kategori sama antar event, urutan grup case-insensitive, daftar kosong, satu project.
- Heading berformat `Event — Kategori` (em dash, bukan hyphen).
- Kategori tanpa project tidak menghasilkan grup (implisit: input tidak memuat project kategori itu).

### Property-Based Tests

- `__tests__/submission-grouping.property.test.ts` dengan `fast-check`: generate daftar project acak (`categoryId` dari pool kecil, `eventName`/`categoryName` campuran kapitalisasi, `createdAt` acak) lalu assert:
  - **Partisi**: total project di semua grup = panjang input, dan tiap project muncul tepat satu kali.
  - **Urutan grup**: daftar grup monoton non-menurun terhadap `(eventName, categoryName)` case-insensitive.
  - **Urutan dalam grup**: urutan relatif project dalam grup sama dengan urutan relatifnya di input (grouping stabil, jadi `createdAt` desc dari Prisma terjaga).

### Integration Tests

Tidak ada integration test otomatis untuk perubahan ini — halaman butuh database dan repo tidak punya harness render. Sebagai gantinya, pemeriksaan manual di `npm run dev`:

- Buka `/admin/submissions` dengan project di beberapa kategori → section per kategori, heading `Event — Kategori (N)`, kolom Category hilang dari sub-tabel.
- Dua event dengan kategori bernama sama → dua section yang bisa dibedakan.
- Klik View di salah satu baris → halaman detail terbuka; badge Type/Crawl/Score tampil seperti sebelumnya.
- Perkecil viewport → tiap sub-tabel masih bisa digeser horizontal.
- Database tanpa project → empty state seperti sebelumnya.
