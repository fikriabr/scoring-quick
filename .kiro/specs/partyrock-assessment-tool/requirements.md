# Requirements Document

## Introduction

PartyRock Assessment Tool adalah aplikasi web fullstack berbasis Next.js 15 untuk mengelola penjurian project-project yang dibuat menggunakan platform PartyRock. Aplikasi ini memungkinkan penyelenggara event untuk membuat kategori penilaian dengan parameter dan matriks skor yang dapat dikonfigurasi secara dinamis, melakukan crawling otomatis terhadap URL submission peserta menggunakan Playwright, serta menghasilkan skor awal berbasis AI (AWS Bedrock). Juri manusia dapat melihat skor AI dan melakukan override penilaian. Sistem mendukung multi-event dengan kategori, parameter, dan bobot yang berbeda-beda per event.

---

## Glossary

- **System**: Aplikasi PartyRock Assessment Tool secara keseluruhan.
- **Admin**: Pengguna dengan peran administrator yang dapat membuat dan mengelola event, kategori, parameter penilaian, dan akun juri.
- **Juri**: Pengguna dengan peran juri yang dapat melihat dan menilai project yang ditugaskan, serta melakukan override skor AI.
- **Event**: Kompetisi atau program yang memiliki satu atau lebih kategori penilaian.
- **Kategori**: Pengelompokan project dalam sebuah event yang memiliki matriks dan parameter penilaian tersendiri.
- **Parameter Penilaian**: Kriteria penilaian yang dapat dikonfigurasi per kategori, mencakup nama, deskripsi, bobot (weight), dan rentang skor.
- **Matriks Penilaian**: Kumpulan parameter penilaian beserta bobot masing-masing yang digunakan dalam sebuah kategori.
- **Project**: Submission peserta berupa URL PartyRock yang akan dinilai.
- **Submission**: Tindakan peserta mengirimkan URL project PartyRock untuk dinilai.
- **Crawling**: Proses pengambilan data otomatis dari URL PartyRock menggunakan Playwright.
- **PartyRock Metadata**: Data struktural yang diekstrak dari halaman PartyRock, termasuk judul aplikasi, deskripsi, widget, dan prompt yang digunakan.
- **AI Scorer**: Komponen yang menggunakan AWS Bedrock untuk menghasilkan skor awal dan analisis per parameter.
- **Skor AI**: Skor yang dihasilkan secara otomatis oleh AI Scorer berdasarkan hasil crawling.
- **Skor Juri**: Skor final yang diberikan oleh Juri, yang dapat berupa konfirmasi atau override dari Skor AI.
- **Skor Final**: Skor tertimbang (weighted) yang dihitung dari seluruh parameter penilaian untuk sebuah project.
- **Leaderboard**: Tampilan peringkat project berdasarkan Skor Final dalam suatu kategori.
- **Prisma ORM**: Object-Relational Mapper yang digunakan untuk interaksi dengan database PostgreSQL (Neon).
- **NextAuth**: Library autentikasi yang digunakan untuk manajemen sesi dan JWT.
- **Google Sheets API**: API Google untuk membuat dan memanipulasi spreadsheet secara programatis, diakses melalui package `googleapis`.
- **Service Account**: Akun Google Cloud tanpa interaksi user yang digunakan untuk autentikasi server-to-server ke Google Sheets API.
- **Auto-sync**: Fitur opsional yang secara otomatis memperbarui data di Google Sheets setiap kali Skor Final berubah.

---

## Requirements

### Requirement 1: Manajemen Event dan Kategori

**User Story:** Sebagai Admin, saya ingin membuat dan mengelola event beserta kategori penilaiannya, agar setiap kompetisi memiliki konfigurasi penilaian yang sesuai.

#### Acceptance Criteria

1. THE System SHALL menyediakan halaman manajemen event yang hanya dapat diakses oleh pengguna dengan peran Admin.
2. WHEN Admin mengisi form pembuatan event dengan nama, deskripsi, dan tanggal, THE System SHALL menyimpan data event baru ke database dan menampilkan event dalam daftar event.
3. THE System SHALL memungkinkan Admin membuat satu atau lebih kategori dalam sebuah event, dengan setiap kategori memiliki nama dan deskripsi yang unik di dalam event tersebut.
4. WHEN Admin memperbarui detail event atau kategori, THE System SHALL memvalidasi input menggunakan Zod schema dan menyimpan perubahan ke database.
5. IF Admin mencoba menghapus kategori yang sudah memiliki project terdaftar, THEN THE System SHALL menampilkan pesan konfirmasi dan mencegah penghapusan hingga Admin mengonfirmasi pemindahan atau penghapusan project terkait.

---

### Requirement 2: Konfigurasi Matriks dan Parameter Penilaian Dinamis

**User Story:** Sebagai Admin, saya ingin mendefinisikan parameter penilaian dan bobotnya per kategori secara dinamis, agar matriks penilaian dapat disesuaikan dengan kebutuhan setiap event.

#### Acceptance Criteria

1. THE System SHALL memungkinkan Admin menambahkan parameter penilaian pada sebuah kategori, dengan setiap parameter memiliki nama, deskripsi, bobot (weight dalam persen), rentang skor minimum, dan rentang skor maksimum.
2. WHEN Admin menyimpan konfigurasi parameter dalam sebuah kategori, THE System SHALL memvalidasi bahwa total bobot semua parameter dalam kategori tersebut sama dengan 100% dan setiap parameter memiliki bobot lebih dari 0%.
3. IF total bobot parameter dalam kategori tidak sama dengan 100%, THEN THE System SHALL menampilkan pesan error yang menyebutkan selisih bobot yang perlu disesuaikan dan mencegah penyimpanan.
4. THE System SHALL menyediakan parameter penilaian default yang dapat digunakan sebagai template, mencakup: Creativity & Originality, Problem-Solution Fit, Effective Use of PartyRock Features, User Experience & Presentation, dan Impact & Scalability.
5. WHEN Admin mengedit atau menghapus parameter penilaian yang sudah memiliki data skor terkait, THE System SHALL menampilkan peringatan bahwa perubahan akan mempengaruhi skor yang sudah ada dan mencegah penyimpanan selama terdapat error validasi lainnya.
6. THE System SHALL memungkinkan Admin menentukan apakah setiap parameter dinilai secara otomatis oleh AI Scorer atau secara manual oleh Juri.

---

### Requirement 3: Submission Project oleh Peserta

**User Story:** Sebagai Admin atau Juri yang mengelola submission, saya ingin memasukkan URL project PartyRock peserta ke dalam kategori, agar project dapat diproses dan dinilai.

#### Acceptance Criteria

1. THE System SHALL menyediakan form input submission yang menerima URL PartyRock, nama peserta, dan nama tim (opsional) untuk dimasukkan ke dalam kategori tertentu.
2. WHEN URL PartyRock disubmit, THE System SHALL memvalidasi format URL menggunakan Zod, memastikan URL dimulai dengan domain `partyrock.aws`.
3. IF terdapat error validasi pada submission — termasuk URL duplikat dalam kategori yang sama, format URL tidak valid, atau field wajib yang tidak diisi — THEN THE System SHALL menampilkan pesan error yang sesuai dan mencegah penyimpanan.
4. THE System SHALL mendukung bulk submission melalui upload file CSV dengan format yang terdokumentasi (kolom: url, nama_peserta, nama_tim).
5. IF file CSV memiliki baris dengan format tidak valid, THEN THE System SHALL melaporkan nomor baris yang bermasalah dan mengimpor hanya baris yang valid.

---

### Requirement 4: Crawling Otomatis PartyRock Metadata

**User Story:** Sebagai sistem penjurian, saya ingin mengekstrak data struktural dari URL PartyRock secara otomatis, agar analisis AI dapat dilakukan berdasarkan konten aktual project peserta.

#### Acceptance Criteria

1. WHEN project baru disubmit, THE System SHALL memicu proses crawling menggunakan Playwright secara asynchronous untuk mengekstrak PartyRock Metadata dari URL yang diberikan.
2. THE System SHALL mengekstrak PartyRock Metadata berikut: judul aplikasi, deskripsi aplikasi, daftar widget yang digunakan beserta tipenya, daftar prompt yang terdeteksi, dan jumlah total widget.
3. WHILE proses crawling berjalan, THE System SHALL menampilkan status "Processing" pada tampilan project di dasbor Admin dan Juri.
4. IF proses crawling gagal karena URL tidak dapat diakses atau timeout melebihi 30 detik, THEN THE System SHALL menyimpan status crawling sebagai "Failed", mencatat pesan error, dan memungkinkan Admin memicu ulang crawling secara manual.
5. WHEN proses crawling berhasil mengekstrak sebagian atau seluruh PartyRock Metadata, THE System SHALL menyimpan data yang berhasil diekstrak ke database dan menggunakannya sebagai input untuk AI Scorer, terlepas dari ada tidaknya masalah lain dalam proses crawling.
6. WHEN Admin memicu ulang crawling pada project yang sudah memiliki data sebelumnya, THE System SHALL menimpa data crawling lama dengan hasil terbaru dan menandai Skor AI sebagai perlu diperbarui.

---

### Requirement 5: Penilaian Otomatis Berbasis AI (AWS Bedrock)

**User Story:** Sebagai sistem penjurian, saya ingin menghasilkan skor awal berbasis AI untuk setiap parameter penilaian, agar juri memiliki referensi objektif sebelum melakukan penilaian manual.

#### Acceptance Criteria

1. WHEN crawling project berhasil diselesaikan, THE System SHALL memicu proses AI scoring menggunakan AWS Bedrock secara asynchronous untuk setiap parameter penilaian yang dikonfigurasi sebagai "auto-scored".
2. THE System SHALL menganalisis parameter Creativity & Originality menggunakan semantic similarity analysis terhadap PartyRock Metadata dibandingkan dengan project lain dalam kategori yang sama.
3. THE System SHALL menganalisis parameter Problem-Solution Fit menggunakan NLP extraction untuk mengidentifikasi relevansi deskripsi aplikasi terhadap masalah yang diselesaikan.
4. THE System SHALL menganalisis parameter Effective Use of PartyRock Features berdasarkan pemeriksaan kompleksitas widget dan prompt yang diekstrak dari PartyRock Metadata.
5. THE System SHALL menganalisis parameter User Experience & Presentation berdasarkan evaluasi kelengkapan deskripsi dan kejelasan tujuan aplikasi.
6. THE System SHALL menganalisis parameter Impact & Scalability menggunakan keyword dan topic analysis terhadap deskripsi dan konten aplikasi.
7. WHEN AI scoring selesai, THE System SHALL menyimpan Skor AI per parameter beserta narasi penjelasan (reasoning) ke database untuk setiap project.
8. IF proses AI scoring gagal untuk satu atau lebih parameter, THEN THE System SHALL menyimpan status scoring sebagai "Partial" atau "Failed", mencatat detail error, dan memungkinkan Admin memicu ulang scoring.
9. WHEN seluruh parameter berhasil di-score, THE System SHALL menghitung Skor Final sementara berdasarkan Skor AI dan bobot parameter yang dikonfigurasi, dan hanya memberlakukan batasan rentang skor (minimum dan maksimum) pada parameter yang proses scoring-nya berhasil.

---

### Requirement 6: Penilaian dan Override oleh Juri

**User Story:** Sebagai Juri, saya ingin melihat skor AI beserta penjelasannya dan dapat memberikan penilaian manual atau melakukan override, agar penilaian final mencerminkan pertimbangan manusia.

#### Acceptance Criteria

1. THE System SHALL menampilkan kepada Juri daftar project yang ditugaskan beserta status penilaian (belum dinilai, sebagian dinilai, selesai).
2. WHEN Juri membuka halaman detail project, THE System SHALL menampilkan PartyRock Metadata hasil crawling, Skor AI per parameter beserta narasi penjelasan, dan form input skor manual per parameter.
3. THE System SHALL memungkinkan Juri memberikan skor manual (override) untuk setiap parameter dalam rentang nilai yang telah dikonfigurasi Admin, disertai catatan/komentar wajib jika skor berbeda dari Skor AI lebih dari 20% dari rentang nilai.
4. WHEN Juri menyimpan skor manual, THE System SHALL memvalidasi skor berada dalam rentang minimum dan maksimum yang dikonfigurasi menggunakan Zod, dan menghitung ulang Skor Final berdasarkan skor Juri dan bobot parameter.
5. WHEN Juri menerima Skor AI sebagai Skor Final tanpa memasukkan nilai manual secara eksplisit, THE System SHALL menetapkan nilai Skor AI sebagai Skor Final dan menandai skor tersebut sebagai telah dihitung (calculated).
6. THE System SHALL mencatat riwayat perubahan skor (audit trail) yang menyimpan nilai sebelumnya, nilai baru, waktu perubahan, dan identitas Juri untuk setiap perubahan skor pada parameter manapun, termasuk perubahan yang bukan merupakan override eksplisit oleh Juri.
7. WHERE lebih dari satu Juri ditugaskan pada kategori yang sama, THE System SHALL menghitung Skor Final sebagai rata-rata dari seluruh Skor Juri yang telah disubmit dan menyimpan flag yang menandai bahwa Skor Final dihitung melalui proses averaging.

---

### Requirement 7: Manajemen Pengguna dan Autentikasi

**User Story:** Sebagai Admin, saya ingin mengelola akun pengguna dengan peran Admin dan Juri, agar akses ke fitur sistem dapat dikontrol sesuai tanggung jawab masing-masing.

#### Acceptance Criteria

1. THE System SHALL mengimplementasikan autentikasi menggunakan NextAuth dengan strategi JWT dan mendukung login via email dan password.
2. THE System SHALL memberlakukan kontrol akses berbasis peran (RBAC) dimana halaman dan API route yang bersifat admin-only hanya dapat diakses oleh pengguna yang telah terautentikasi dan memiliki peran Admin.
3. IF pengguna yang tidak terautentikasi mencoba mengakses halaman atau API endpoint yang memerlukan autentikasi, THEN THE System SHALL mengalihkan pengguna ke halaman login.
4. IF pengguna terautentikasi dengan peran Juri mencoba mengakses halaman atau API route yang hanya diizinkan untuk Admin, THEN THE System SHALL mengembalikan respons HTTP 403 Forbidden.
5. THE System SHALL memungkinkan Admin membuat akun Juri baru dengan mengisi nama, email, dan password awal.
6. WHEN Admin menugaskan Juri ke kategori tertentu, THE System SHALL memastikan Juri hanya dapat melihat dan menilai project dalam kategori yang ditugaskan.

---

### Requirement 8: Leaderboard dan Laporan Penilaian

**User Story:** Sebagai Admin dan Juri, saya ingin melihat leaderboard dan laporan penilaian, agar hasil kompetisi dapat dipantau dan diumumkan secara transparan.

#### Acceptance Criteria

1. THE System SHALL menampilkan Leaderboard per kategori yang mengurutkan project berdasarkan Skor Final secara descending dan memperbarui tampilan secara real-time saat ada perubahan skor.
2. THE System SHALL menampilkan pada Leaderboard setiap project dengan informasi: peringkat, nama peserta/tim, URL project, Skor Final, dan rincian skor per parameter.
3. WHEN Admin mengekspor laporan penilaian, THE System SHALL menghasilkan file CSV atau Excel yang mencakup seluruh project dalam kategori beserta detail skor AI, skor Juri, Skor Final, dan catatan per parameter.
4. THE System SHALL menyediakan tampilan perbandingan project yang memungkinkan Admin memilih dua atau lebih project untuk ditampilkan secara berdampingan dengan rincian skor per parameter.
5. WHERE Admin mengaktifkan mode "Publish", THE System SHALL membuat Leaderboard kategori dapat diakses publik melalui URL unik tanpa autentikasi.

---

### Requirement 10: Integrasi Google Sheets untuk Export dan Sinkronisasi Leaderboard

**User Story:** Sebagai Admin, saya ingin mengekspor dan menyinkronkan data leaderboard ke Google Sheets secara otomatis, agar hasil penilaian dapat dibagikan dan diakses secara kolaboratif melalui spreadsheet.

#### Acceptance Criteria

1. THE System SHALL menyediakan service `SheetsService` di `lib/services/sheets.service.ts` yang menggunakan package `googleapis` untuk berinteraksi dengan Google Sheets API v4.
2. THE System SHALL mengautentikasi ke Google Sheets API menggunakan service account yang kunci privatnya disimpan dalam environment variable `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` (path ke file JSON credentials).
3. WHEN Admin mengklik tombol "Export to Google Sheets" pada halaman leaderboard kategori, THE System SHALL membuat spreadsheet baru di Google Drive dengan nama format `[Event Name] - [Category Name] - Leaderboard` dan mengisi data leaderboard lengkap (peringkat, nama peserta/tim, URL project, skor final, rincian skor per parameter AI dan Juri).
4. THE System SHALL secara otomatis memberikan akses (share) spreadsheet yang baru dibuat ke satu atau lebih alamat email yang ditentukan Admin melalui field input sebelum export, dengan permission role "writer".
5. WHEN fitur auto-sync diaktifkan oleh Admin untuk sebuah kategori, THE System SHALL memperbarui data di spreadsheet yang sudah terhubung setiap kali `finalScore` sebuah project dalam kategori tersebut berubah.
6. IF auto-sync diaktifkan dan spreadsheet sudah ada, THEN THE System SHALL memperbarui baris yang berubah di spreadsheet yang sama tanpa membuat spreadsheet baru, dan memperbarui timestamp kolom "Last Updated" di sheet.
7. THE System SHALL menyimpan referensi `spreadsheetId` dan status `autoSync` (boolean) pada model `Category` di database agar koneksi ke Google Sheets persisten antar sesi.
8. IF proses pembuatan spreadsheet atau sinkronisasi gagal (misalnya credentials invalid, quota terlampaui, atau network error), THEN THE System SHALL mengembalikan pesan error yang informatif kepada Admin tanpa mengganggu alur penilaian utama, dan mencatat error ke logging system.
9. THE System SHALL menerapkan rate limiting pada API route Google Sheets (maksimum 5 request per menit per user) untuk menghindari pelanggaran quota Google Sheets API.

---

### Requirement 9: Infrastruktur dan Kualitas Teknis

**User Story:** Sebagai tim pengembang, saya ingin memastikan sistem dibangun dengan standar teknis yang sesuai, agar aplikasi dapat dipelihara, aman, dan dapat diandalkan.

#### Acceptance Criteria

1. THE System SHALL diimplementasikan sebagai aplikasi Next.js 15 App Router fullstack dengan API routes sebagai backend endpoint dan React Server Components untuk rendering.
2. THE System SHALL menggunakan Prisma ORM untuk seluruh interaksi dengan database PostgreSQL (Neon) dan schema database harus terdefinisi dalam file `prisma/schema.prisma`.
3. THE System SHALL memvalidasi seluruh input dari pengguna dan data dari sumber eksternal menggunakan Zod schema sebelum diproses atau disimpan ke database.
4. THE System SHALL menyimpan seluruh konfigurasi sensitif (database URL, AWS credentials, NextAuth secret, Google service account key file) dalam environment variables dan tidak pernah menyertakannya dalam source code.
5. WHEN terjadi error yang tidak tertangani pada API route, THE System SHALL mengembalikan respons JSON dengan struktur error yang konsisten (berisi `error`, `message`, dan `code`) dan mencatat error ke logging system tanpa mengekspos stack trace ke client.
6. THE System SHALL mengimplementasikan rate limiting pada API route yang memicu crawling dan AI scoring untuk mencegah penyalahgunaan, dengan batas maksimum 10 request per menit per pengguna terautentikasi.
7. THE System SHALL memastikan seluruh halaman publik dan dasbor dapat dirender dengan First Contentful Paint di bawah 3 detik pada koneksi jaringan standar.
