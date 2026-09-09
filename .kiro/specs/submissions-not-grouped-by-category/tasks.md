# Implementation Plan: Submissions Not Grouped By Category

## Overview

Perbaikan murni tampilan pada satu React Server Component (`app/(dashboard)/admin/submissions/page.tsx`), didukung satu fungsi murni baru (`lib/submission-grouping.ts`) yang bisa diuji tanpa merender React. Urutan implementasi: tulis fungsi grouping + test dulu (memunculkan counterexample bug, lalu memverifikasi fix), baru sentuh halaman.

Verifikasi di repositori ini: `npm run typecheck`, `npx vitest run`. Jangan andalkan `npx next build` untuk iterasi cepat.

---

## Tasks

- [x] 1. Fungsi grouping murni dan test-nya
  - [x] 1.1 Buat `lib/submission-grouping.ts`
    - Tipe `GroupableProject { categoryId, categoryName, eventName }` dan `CategoryGroup<T> { categoryId, categoryName, eventName, heading, projects: T[] }`
    - `groupProjectsByCategory<T extends GroupableProject>(projects: T[]): CategoryGroup<T>[]` — kumpulkan ke `Map<categoryId, CategoryGroup<T>>` (urutan insert menjaga urutan `createdAt` desc dari input), lalu sort daftar grup dengan `localeCompare(..., undefined, { sensitivity: 'base' })` pada `eventName` lalu `categoryName`
    - `heading` dibentuk sebagai `` `${eventName} — ${categoryName}` `` (em dash)
    - Tanpa `'use client'`, tanpa import runtime Prisma
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8_
  - [x] 1.2 Tulis unit test `__tests__/submission-grouping.test.ts`
    - Dua kategori tercampur → 2 grup, tiap project di grup yang benar
    - Nama kategori sama antar event (categoryId beda) → tetap 2 grup dengan heading berbeda
    - Urutan grup dengan campuran kapitalisasi → urut A-Z case-insensitive
    - Daftar kosong → `[]`; satu project → satu grup dengan `projects.length === 1`
    - Heading berformat `Event — Kategori` (em dash, bukan hyphen)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8_
  - [x] 1.3 Tulis property test untuk Property 1 dan Property 2

    **Property 1: Bug Condition - Project Dikelompokkan Per Kategori**

    _For any_ daftar project di mana bug condition berlaku (`isBugCondition` true), halaman yang sudah diperbaiki SHALL merender tepat satu section per kategori yang punya project, terurut berdasarkan nama event lalu nama kategori A-Z case-insensitive, dengan heading `Event — Kategori` beserta jumlah project di kategori itu, dan project di dalam setiap section terurut `createdAt` desc — setiap project muncul tepat satu kali, di grupnya sendiri.

    **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8**

    **Property 2: Preservation - Halaman Tanpa Project**

    _For any_ input di mana bug condition TIDAK berlaku (`isBugCondition` false, yaitu tidak ada project sama sekali), halaman yang sudah diperbaiki SHALL menghasilkan render yang sama dengan versi sebelumnya: empty state "No projects submitted yet.", heading `Projects (0)`, dan form submit + CSV upload tetap tampil.

    **Validates: Requirements 3.1, 3.2**
    - File `__tests__/submission-grouping.property.test.ts` memakai `fast-check`
    - Generate daftar project acak (`categoryId` dari pool kecil, `eventName`/`categoryName` campuran kapitalisasi, `createdAt` acak)
    - Assert partisi lengkap: total project di semua grup = panjang input, tiap project muncul tepat satu kali
    - Assert urutan grup monoton non-menurun terhadap `(eventName, categoryName)` case-insensitive
    - Assert urutan dalam grup: urutan relatif project dalam grup sama dengan urutan relatifnya di input
    - Assert `groupProjectsByCategory([])` mengembalikan `[]`

- [x] 2. Checkpoint — fungsi grouping terverifikasi
  - Jalankan `npm run typecheck` dan `npx vitest run`, pastikan seluruh test grouping lulus sebelum menyentuh halaman

- [x] 3. Perbarui query dan serialisasi data halaman
  - [x] 3.1 Tambahkan `event.name` ke query Prisma
    - `app/(dashboard)/admin/submissions/page.tsx`: ubah `include: { category: { select: { id: true, name: true } } }` menjadi menyertakan `event: { select: { name: true } }` di dalam `category`
    - `orderBy: { createdAt: 'desc' }` tetap tidak berubah
    - _Requirements: 2.2_
  - [x] 3.2 Perbarui `serializedProjects`
    - Tambahkan `categoryId: p.categoryId` dan `eventName: p.category.event.name`
    - Field lain (termasuk `categoryName`) tidak berubah
    - _Requirements: 2.2, 2.8_

- [x] 4. Ekstrak komponen tabel dan hapus kolom Category
  - [x] 4.1 Ekstrak `ProjectsTable` dan `ProjectRow`
    - `ProjectsTable({ projects })`: wrapper card + `overflow-x-auto` + `<thead>` + `<tbody>`, dipakai per section
    - `ProjectRow`: baris project tanpa sel Category
    - Hapus kolom Category dari `<thead>` dan `ProjectRow`
    - `StatusBadge`, `ProjectTypeBadge`, dan link View tidak berubah
    - _Requirements: 2.7, 3.3, 3.4, 3.5, 3.6, 3.8_
  - [x] 4.2 Render section per kategori
    - `const groups = groupProjectsByCategory(serializedProjects)` setelah serialisasi
    - Cabang non-empty: `groups.map(...)` → satu `<section>` per grup dengan heading `{group.heading} ({group.projects.length})` lalu `<ProjectsTable projects={group.projects} />`
    - Heading daftar `Projects ({serializedProjects.length})` dan cabang empty state dipertahankan tanpa perubahan (nol diff pada blok itu)
    - _Requirements: 2.1, 2.3, 2.6, 3.1, 3.2_

- [x] 5. Checkpoint akhir — verifikasi menyeluruh dan manual
  - Jalankan `npm run typecheck` dan `npx vitest run`, pastikan seluruh test (termasuk yang sudah ada sebelumnya) lulus
  - Verifikasi manual di `npm run dev`:
    - Project di beberapa kategori → section per kategori, heading `Event — Kategori (N)`, kolom Category hilang dari sub-tabel
    - Dua event dengan kategori bernama sama → dua section yang bisa dibedakan
    - Klik View pada sebuah project → halaman detail terbuka seperti sebelumnya; badge Type/Crawl/Score tampil seperti sebelumnya
    - Perkecil viewport → tiap sub-tabel masih bisa digeser horizontal
    - Database tanpa project → empty state seperti sebelumnya, form submit + CSV upload tetap tampil
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_
