# Requirements Document

## Introduction

Fitur ini memperluas aplikasi penjurian agar tidak lagi terbatas pada project PartyRock. Sistem akan mendukung penilaian **project web berbasis HTML**, dengan struktur HTML sebagai bukti utama (evidence) yang dianalisis oleh AI Scorer. Setiap submission memperoleh atribut baru **Tipe Project** (`PARTYROCK` atau `HTML`) yang menentukan aturan validasi URL, cara pengumpulan evidence, dan template prompt yang dipakai saat scoring.

Bersamaan dengan itu, produk di-rebrand dari "PartyRock Assessment Tool" menjadi **"Scoring Project by PindAI"**, karena nama lama sudah tidak merepresentasikan cakupan sistem.

Fitur ini dibangun di atas spec `partyrock-assessment-tool` yang sudah terimplementasi. Seluruh perilaku existing untuk project PartyRock harus tetap berjalan tanpa perubahan.

---

## Glossary

Istilah dari spec `partyrock-assessment-tool` tetap berlaku. Istilah tambahan:

- **Tipe Project (Project Type)**: Atribut pada Project yang menentukan platform asal submission. Nilainya `PARTYROCK` atau `HTML`.
- **Project PartyRock**: Project dengan Tipe Project `PARTYROCK`. Bukti penilaiannya berupa widget, prompt, dan output yang dikumpulkan lewat Capture Pipeline.
- **Project HTML**: Project dengan Tipe Project `HTML`. Bukti penilaiannya berupa markup HTML halaman, baik hasil fetch URL maupun source code yang ditempel manual.
- **Struktur HTML (HTML Structure)**: Kumpulan metrik terukur yang diturunkan dari markup HTML, mencakup hierarki heading, pemakaian elemen semantik, landmark dan atribut ARIA, kelengkapan atribut aksesibilitas, struktur form, serta metadata dokumen.
- **HTML Structure Extractor**: Komponen yang mengubah string HTML menjadi objek Struktur HTML.
- **Evidence**: Data yang dikirim ke AI Scorer sebagai dasar penilaian. Untuk Project PartyRock berupa hasil capture; untuk Project HTML berupa Struktur HTML dan source code.
- **Source Code**: Isi kolom `Project.sourceCode`. Untuk Project HTML berisi markup HTML; untuk Project PartyRock berisi hasil serialisasi capture.
- **Capture Pipeline**: Mekanisme existing pengumpulan data PartyRock dari sesi browser manusia (`scripts/partyrock-navigate.js`, `public/partyrock-capture.js`, `POST /api/capture`).
- **Rebranding**: Penggantian seluruh penamaan produk yang terlihat pengguna menjadi "Scoring Project by PindAI".

---

## Requirements

### Requirement 1: Tipe Project pada Submission

**User Story:** Sebagai Admin, saya ingin menentukan tipe project saat memasukkan submission, agar sistem tahu aturan validasi dan metode penilaian mana yang harus dipakai.

#### Acceptance Criteria

1. THE System SHALL menyimpan Tipe Project pada setiap Project sebagai enum dengan nilai yang dibatasi pada `PARTYROCK` dan `HTML`.
2. THE System SHALL menetapkan `PARTYROCK` sebagai nilai default Tipe Project, sehingga seluruh Project yang sudah tersimpan sebelum fitur ini diterapkan tetap valid tanpa migrasi data.
3. THE System SHALL menyediakan pilihan Tipe Project pada form submission tunggal, ditempatkan sebelum field URL karena pilihan tersebut mengubah aturan validasi field di bawahnya.
4. WHEN Admin mengubah pilihan Tipe Project pada form, THE System SHALL memperbarui label, placeholder, teks bantuan, dan aturan validasi client-side pada field URL dan Source Code sesuai tipe yang dipilih.
5. THE System SHALL menerima kolom Tipe Project pada bulk import CSV dengan nama header `project_type` atau `projectType`, dan SHALL menggunakan `PARTYROCK` bila kolom tersebut tidak ada atau kosong.
6. IF nilai Tipe Project pada CSV bukan salah satu nilai enum yang dikenali, THEN THE System SHALL menolak baris tersebut, melaporkan nomor barisnya, dan tetap mengimpor baris lain yang valid.
7. THE System SHALL menampilkan Tipe Project pada daftar submission dan pada halaman detail project.

---

### Requirement 2: Validasi URL Berdasarkan Tipe Project

**User Story:** Sebagai Admin, saya ingin URL divalidasi sesuai tipe project, agar URL web biasa dapat diterima tanpa melemahkan validasi untuk project PartyRock.

#### Acceptance Criteria

1. WHEN Tipe Project adalah `PARTYROCK`, THE System SHALL menerima URL hanya jika hostname-nya sama dengan `partyrock.aws` atau berakhiran `.partyrock.aws`.
2. WHEN Tipe Project adalah `HTML`, THE System SHALL menerima URL dengan hostname apa pun.
3. THE System SHALL menolak URL yang skema-nya bukan `http:` atau `https:` untuk kedua Tipe Project.
4. IF URL tidak memenuhi aturan validasi Tipe Project yang dipilih, THEN THE System SHALL menampilkan pesan error yang menyebutkan aturan yang berlaku untuk tipe tersebut.
5. THE System SHALL menerapkan aturan validasi yang identik pada submission tunggal, bulk import CSV, dan validasi client-side pada form.
6. THE System SHALL mempertahankan aturan validasi hostname `partyrock.aws` pada payload Capture Pipeline, karena pipeline tersebut hanya berlaku untuk platform PartyRock.

---

### Requirement 3: Ekstraksi Struktur HTML

**User Story:** Sebagai sistem penjurian, saya ingin mengubah markup HTML menjadi metrik struktural yang terukur, agar AI Scorer menilai berdasarkan karakteristik yang objektif dan bukan menebak dari markup mentah.

#### Acceptance Criteria

1. WHEN Project HTML baru disubmit dan URL-nya dapat diakses, THE System SHALL mengambil markup HTML dari URL tersebut secara asynchronous.
2. THE System SHALL menyimpan markup HTML hasil fetch ke database untuk keperluan audit dan penilaian ulang.
3. THE System SHALL menurunkan Struktur HTML dari markup yang tersedia, mencakup sekurang-kurangnya: jumlah dan hierarki heading, jumlah pemakaian elemen semantik dibanding elemen generik, keberadaan landmark dan atribut ARIA, jumlah gambar beserta rasio yang memiliki atribut `alt`, jumlah field form beserta rasio yang memiliki label, kedalaman maksimum DOM, jumlah total elemen, serta metadata dokumen berupa judul, deskripsi, dan atribut bahasa.
4. THE System SHALL menghitung Struktur HTML secara deterministik, sehingga markup yang sama selalu menghasilkan metrik yang sama.
5. IF proses fetch gagal karena URL tidak dapat diakses atau melewati batas waktu, THEN THE System SHALL menyimpan status crawling sebagai `FAILED` beserta pesan error, dan SHALL tetap melanjutkan penilaian apabila Source Code sudah tersedia.
6. WHEN Source Code sudah tersedia pada sebuah Project HTML, THE System SHALL memakai Source Code tersebut sebagai sumber Struktur HTML dan SHALL TIDAK menimpanya dengan hasil fetch.
7. WHEN Admin memicu ulang crawling pada Project HTML, THE System SHALL mengambil ulang markup, menghitung ulang Struktur HTML, dan menandai Skor AI sebagai perlu diperbarui.

---

### Requirement 4: Penilaian AI untuk Project HTML

**User Story:** Sebagai Juri, saya ingin skor AI untuk project HTML dihitung berdasarkan struktur HTML-nya, agar penilaiannya relevan dengan jenis project yang dinilai.

#### Acceptance Criteria

1. WHEN AI Scorer memproses sebuah Project, THE System SHALL memilih template prompt berdasarkan Tipe Project.
2. WHEN Tipe Project adalah `HTML`, THE System SHALL menyertakan Struktur HTML dalam prompt sebagai bagian terstruktur yang terpisah dari Source Code.
3. THE System SHALL membatasi ukuran evidence yang dikirim ke AI Scorer, dan SHALL memprioritaskan Struktur HTML di atas markup mentah ketika batas tersebut tercapai.
4. WHEN Tipe Project adalah `PARTYROCK`, THE System SHALL menggunakan template prompt existing tanpa perubahan perilaku.
5. THE System SHALL menerapkan pembatasan rentang skor, penyimpanan Skor AI per parameter, penentuan status scoring, dan perhitungan Skor Final dengan cara yang identik untuk kedua Tipe Project.
6. IF Project HTML tidak memiliki Source Code maupun markup hasil fetch, THEN THE System SHALL menandai status scoring sebagai `FAILED` beserta pesan yang menjelaskan bahwa evidence belum tersedia.

---

### Requirement 5: Pengelolaan Source Code Pasca-Submit

**User Story:** Sebagai Admin, saya ingin dapat menempelkan atau memperbaiki source code sebuah project setelah project tersebut tersubmit, agar project HTML yang URL-nya tidak dapat di-fetch tetap bisa dinilai.

#### Acceptance Criteria

1. THE System SHALL menyediakan antarmuka pada halaman detail project untuk melihat dan mengubah Source Code, dengan nilai saat ini terisi otomatis.
2. THE System SHALL membatasi akses pengubahan Source Code hanya pada pengguna dengan peran Admin.
3. WHEN Admin menyimpan perubahan Source Code, THE System SHALL memvalidasi panjangnya terhadap batas maksimum yang berlaku dan menyimpannya ke database.
4. WHEN Source Code berhasil diperbarui, THE System SHALL menandai Skor AI sebagai perlu diperbarui dan memicu ulang proses AI scoring secara asynchronous.
5. THE System SHALL menampilkan antarmuka import Capture Pipeline hanya untuk Project PartyRock, karena payload capture tidak berlaku untuk Project HTML.
6. THE System SHALL menampilkan indikator ketersediaan Source Code beserta ukurannya pada halaman detail project untuk kedua Tipe Project.

---

### Requirement 6: Parameter Default untuk Project HTML

**User Story:** Sebagai Admin, saya ingin tersedia template parameter penilaian khusus project web, agar tidak perlu menyusun matriks penilaian dari nol untuk kategori HTML.

#### Acceptance Criteria

1. THE System SHALL menyediakan satu set parameter penilaian default untuk project web sebagai template, terpisah dari template PartyRock existing.
2. THE System SHALL memastikan total bobot pada setiap set parameter default sama dengan 100%.
3. WHEN Admin memuat parameter default pada sebuah kategori, THE System SHALL memungkinkan Admin memilih set template yang akan dimuat.
4. THE System SHALL mempertahankan set parameter default PartyRock existing tanpa perubahan pada nama, deskripsi, maupun bobotnya.

---

### Requirement 7: Rebranding menjadi "Scoring Project by PindAI"

**User Story:** Sebagai pemilik produk, saya ingin seluruh penamaan yang terlihat pengguna memakai nama "Scoring Project by PindAI", agar identitas produk konsisten dan tidak lagi terikat pada satu platform.

#### Acceptance Criteria

1. THE System SHALL menampilkan "Scoring Project by PindAI" sebagai judul dokumen pada seluruh halaman.
2. THE System SHALL menampilkan penamaan produk yang baru pada navigasi sidebar Admin dan pada header versi mobile.
3. THE System SHALL memakai identitas paket dan dokumentasi yang konsisten dengan nama produk baru.
4. THE System SHALL mempertahankan seluruh penamaan yang bersifat fungsional dan merujuk platform PartyRock, mencakup: nama file script Capture Pipeline beserta path publiknya, pemeriksaan hostname `partyrock.aws`, alias header CSV `partyrock_url`, dan konfigurasi CORS untuk origin PartyRock.
5. THE System SHALL tetap berfungsi penuh setelah rebranding, dibuktikan dengan build yang sukses dan seluruh test yang lulus.

---

### Requirement 8: Kompatibilitas Mundur

**User Story:** Sebagai Admin yang sudah memiliki data penilaian berjalan, saya ingin fitur baru ini tidak mengubah perilaku maupun skor project yang sudah ada.

#### Acceptance Criteria

1. THE System SHALL memperlakukan setiap Project yang tersimpan sebelum fitur ini diterapkan sebagai Project PartyRock.
2. THE System SHALL mempertahankan perilaku Capture Pipeline, penilaian jury, override, leaderboard, dan export tanpa perubahan untuk Project PartyRock.
3. THE System SHALL mempertahankan Skor AI dan Skor Final yang sudah tersimpan, tanpa memicu penilaian ulang otomatis akibat penerapan fitur ini.
4. THE System SHALL memastikan seluruh test existing tetap lulus, dan SHALL memperbarui test yang kontraknya memang berubah karena requirement baru — khususnya test validasi domain URL yang saat ini mengasumsikan seluruh URL non-PartyRock ditolak.
