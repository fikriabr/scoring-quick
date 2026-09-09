# Capture Pipeline — Mengambil Data Widget PartyRock

Dokumen ini menjelaskan bagian sistem yang sebelumnya tidak berfungsi: pengambilan
data widget dan prompt dari app PartyRock peserta.

---

## Masalah

`CrawlerService` awalnya dirancang memakai Playwright headless (task 8.1 di
`.kiro/specs/partyrock-assessment-tool/tasks.md`). Itu tidak pernah bisa jalan:

- PartyRock adalah SPA React Router. Judul, deskripsi, widget, dan prompt tidak
  ada di HTML awal — semuanya datang dari API internal `getLatestAppVersion`.
- AWS WAF memblokir panggilan API internal itu (HTTP 403) begitu request datang
  dari browser yang terlihat otomatis. Patchright/stealth patch pun tidak lolos.

Akibatnya crawler hanya bisa membaca meta tag SEO statis (`og:title`,
`meta[name=description]`) lewat `fetch` biasa — `widgets: []`, `prompts: []`,
`widgetCount: 0`. AI scorer jadi menilai app hanya dari judul dan deskripsi,
yang membuat seluruh skor praktis tidak bermakna.

---

## Keputusan desain

> Yang menurut saya masih worth dicoba — bukan scraping penuh, tapi **automasi
> navigasi saja** (bukan automasi interaksi widget/API call):
>
> - Script Playwright yang drive Chrome asli, pakai profil asli, headed
>   (kelihatan, bukan headless). Tugasnya cuma buka satu-satu project URL dan
>   suntik `partyrock-capture.js` otomatis.
> - Bagian yang tetap manual: klik widget untuk trigger AI generation — karena
>   ini butuh pemahaman semantik halaman per app, dan justru inilah "human
>   presence" yang bikin WAF tidak curiga.
> - Ini menghemat waktu buka-tutup tab untuk 30–100 project, tapi tidak
>   menyentuh sama sekali bagian yang diproteksi WAF, jadi risikonya rendah.

Implementasi mengikuti pembagian itu persis:

| Bagian                                    | Otomatis | Manual |
| ----------------------------------------- | :------: | :----: |
| Buka URL project satu per satu            |    ✅    |        |
| Inject script capture ke halaman          |    ✅    |        |
| Baca definisi app dari traffic halaman    |    ✅    |        |
| Kirim hasil ke app scoring + trigger skor |    ✅    |        |
| Login ke PartyRock                        |          |   ✅   |
| Klik widget untuk memicu AI generation    |          |   ✅   |
| Menentukan kapan sebuah app selesai       |          |   ✅   |

Tidak ada satu pun request ke endpoint yang diproteksi WAF. Script hanya
**mengamati** response yang halaman itu minta sendiri, di sesi yang memang
sedang dipakai manusia.

---

## Komponen

| File                                | Peran                                                            |
| ----------------------------------- | ---------------------------------------------------------------- |
| `public/partyrock-capture.js`       | Jalan di dalam halaman PartyRock; kumpulkan widget/prompt/output |
| `scripts/partyrock-navigate.js`     | Buka Chrome asli, kunjungi tiap URL, inject script, kirim hasil  |
| `app/api/capture/route.ts`          | `POST` — terima capture, simpan, trigger AI scoring              |
| `app/api/capture/queue/route.ts`    | `GET` — daftar project yang belum punya data widget              |
| `lib/services/capture.service.ts`   | Cocokkan URL ke project, simpan metadata, susun `sourceCode`     |
| `components/CaptureImportPanel.tsx` | Fallback manual per project di halaman admin                     |

### Cara script capture mengambil data

Dua sumber, digabung:

1. **Network** (utama) — `fetch` dan `XMLHttpRequest` di-wrap sebelum script
   halaman jalan, jadi JSON definisi app tertangkap saat halaman memuat
   dirinya sendiri. Ekstraksi memakai _bentuk_ objek (ada field type + label,
   atau key yang cocok `/prompt|template|instruction/`), bukan path field
   hardcoded — supaya tidak langsung rusak kalau Amazon ganti nama field.
2. **DOM** (cadangan) — textarea, `contenteditable`, teks yang mengandung
   `{{...}}`, dan blok teks panjang di dalam kartu widget. Ini juga satu-satunya
   sumber untuk **output AI** yang baru saja dipicu manusia, karena teks itu
   dirender, tidak di-fetch ulang.

---

## Setup

1. Isi `CAPTURE_TOKEN` di `.env` (sudah digenerate otomatis saat setup):

   ```
   CAPTURE_TOKEN="<random hex>"
   ```

   `APP_BASE_URL` tidak wajib. Kalau kosong, script memakai domain Vercel
   (`VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL`) bila variabelnya ada di
   lingkungan, dan kalau tidak ada jatuh ke `http://localhost:3000`. Untuk
   menargetkan app yang sudah dideploy tanpa mengubah `.env`:

   ```bash
   npm run capture -- --base-url https://nama-app.vercel.app
   ```

2. Jalankan app:

   ```bash
   npm run dev
   ```

3. Submit URL project peserta lewat halaman **Submissions** (single atau CSV).
   Capture hanya bisa masuk ke URL yang sudah disubmit.

---

## Menjalankan capture

```bash
npm run capture
```

Alur di terminal:

1. Script mengambil antrian dari `/api/capture/queue?pending=1` — hanya project
   yang belum punya data widget.
2. Chrome terbuka (terlihat, bukan headless). **Login sekali** ke PartyRock;
   sesi tersimpan di `.pr-chrome-profile/` sehingga run berikutnya tidak perlu
   login lagi.
3. Untuk tiap project: tab terbuka, panel capture muncul di kanan bawah dengan
   hitungan `N widget · N prompt · N output`.
4. **Klik widget-widget di app** supaya AI-nya menghasilkan output.
5. Klik **Kirim & Lanjut**. Data terkirim, AI scoring jalan, tab berikutnya
   terbuka otomatis.

Kalau hitungan widget masih 0 dan berwarna merah, halaman belum selesai memuat
definisi app — tunggu sebentar lalu klik **Pindai Ulang**.

### Opsi

```bash
npm run capture -- --url <url>        # satu project saja, lihat di bawah
npm run capture -- --all              # termasuk yang sudah pernah di-capture
npm run capture -- --category <id>    # satu kategori saja
npm run capture -- --limit 10         # 10 project pertama
npm run capture -- --urls list.txt    # dari file URL, bukan dari antrian app
```

### Satu project saja: `--url`

```bash
npm run capture -- --url https://partyrock.aws/u/Addim/heN4dUfbn/Nama-App
```

Bedanya dengan `--urls`: `--url` **mencocokkan URL itu ke submission di database
dulu**, bukan memakainya mentah. Konsekuensinya:

- URL yang belum pernah disubmit langsung ditolak **sebelum Chrome terbuka**,
  lengkap dengan jumlah submission yang ada. Tanpa ini, ketidakcocokan baru
  ketahuan setelah kamu selesai mengklik semua widget dan capture-nya ditolak
  `NO_MATCHING_PROJECT` — kerja yang terbuang.
- Nama peserta dan kategori yang sebenarnya ikut tampil di terminal, bukan
  `(from file)`.
- Pencocokan dua tahap sama seperti di server: URL ternormalisasi dulu, lalu
  **app id**. Jadi app yang sudah di-rename peserta tetap ketemu, dan terminal
  memberi tahu `Matched by app id` kalau itu yang terjadi.
- Antrian diambil dengan cakupan `--all`, jadi project yang **sudah** punya data
  widget tetap bisa dituju. Ini memang tujuan `--url`: mengulang satu project.
- Kalau app yang sama disubmit ke beberapa kategori, tetap satu tab yang terbuka
  dan capture-nya tersimpan ke semua kategori itu — jumlahnya diberitahukan di
  terminal.

`--url` bisa dipersempit dengan `--category <id>` kalau ada URL kembar di
kategori berbeda dan kamu hanya mau satu.

### Memakai profil Chrome sendiri

Default-nya script memakai folder profil kosong (`.pr-chrome-profile/`). Masalahnya:
**Google menolak login di browser yang terdeteksi otomatis** ("This browser or app
may not be secure"), jadi login Google di profil kosong itu biasanya memang tidak
bisa. Ada dua jalan keluar.

#### Cara A — clone profil (disarankan)

Menyalin sesi login dari profil Chrome harian ke profil capture. Karena
cookie-nya sudah ada, **tidak perlu login sama sekali**.

```bash
npm run capture:clone-profile -- --list      # lihat daftar profil
npm run capture:clone-profile                # clone profil "Default"
npm run capture:clone-profile -- "Profile 3" # clone profil tertentu
```

**Tutup Chrome dulu** sebelum menjalankannya — Chrome baru menulis cookie ke
disk saat keluar, jadi menyalin dari Chrome yang sedang jalan bisa dapat data
basi. Setelah itu pastikan `PR_CHROME_PROFILE` **tidak** di-set di `.env`, lalu
`npm run capture` seperti biasa.

Yang disalin hanya file sesi (cookie, kunci enkripsi cookie di `Local State`,
preferences, login data) — bukan history, cache, extension, atau bookmark. Di
Windows kunci cookie diproteksi DPAPI dan terikat ke akun Windows, jadi salinan
ini hanya bisa dibuka oleh user yang sama di mesin yang sama.

Kalau Chrome nanti mengubah cookie (logout, ganti password, sesi expired),
tinggal jalankan clone-nya lagi.

#### Cara B — pakai folder profil asli langsung

```env
PR_CHROME_PROFILE="C:/Users/fikri/AppData/Local/Google/Chrome/User Data"
PR_CHROME_PROFILE_DIR="Default"
```

`PR_CHROME_PROFILE` menunjuk ke folder **User Data** (bukan ke folder profilnya),
dan `PR_CHROME_PROFILE_DIR` memilih profil di dalamnya — `Default`, `Profile 3`,
dst. Pakai `npm run capture:clone-profile -- --list` untuk melihat nama-nama itu.

Konsekuensinya:

- **Chrome harus benar-benar tertutup setiap kali capture jalan.** Chrome
  mengunci folder profilnya. Script sudah mengecek ini dan berhenti dengan pesan
  jelas kalau Chrome masih jalan.
- Sesi otomatis akan menulis ke profil yang dipakai sehari-hari (history, cookie,
  preferences bisa berubah).
- Semua extension ikut termuat, yang kadang mengganggu halaman PartyRock.

Karena itu Cara A lebih disarankan untuk pemakaian rutin.

---

## Fallback: satu project tanpa Playwright

Kalau yang dibutuhkan hanya satu project, `npm run capture -- --url <url>` di
atas sudah cukup. Jalur di bawah ini untuk kondisi Playwright/Chrome otomatis
tidak bisa dipakai sama sekali — misalnya Chrome tidak mau dikemudikan, atau
kamu sedang di mesin lain.

Buka **Admin → Submissions → View** pada sebuah project, lalu pakai panel
**Import Capture Manual**:

1. Klik **Salin Script Capture**.
2. Buka halaman PartyRock project itu, tempel script di DevTools console.
3. Klik widget-widget seperti biasa.
4. Klik **Salin JSON** di panel kanan bawah.
5. Tempel di kotak di halaman admin, klik **Import & Score Ulang**.

Jalur ini tidak butuh Playwright dan tidak butuh `CAPTURE_TOKEN` (memakai sesi
admin yang sedang login).

---

## Setelah capture masuk

`ingestCapture` menulis, untuk **setiap** project yang cocok dengan URL itu:

- `CrawlMetadata.title / description / widgets / prompts / widgetCount`
- `CrawlMetadata.rawHtml` — JSON capture mentah, untuk audit
- `Project.sourceCode` — dokumen gabungan (widget + prompt + output + definisi
  app mentah). Ini yang dibaca `ScorerService` sebagai bukti utama.
- `Project.crawlStatus = SUCCESS`, `scoreStatus = PENDING`

lalu memanggil `ScorerService.triggerScoring` untuk masing-masing.

### Pencocokan URL

Dua tahap, supaya capture tetap sampai ke submission yang benar:

1. URL ternormalisasi (host lowercase, tanpa query/hash/trailing slash).
2. **App id** — segmen setelah `/u/{user}/` di
   `https://partyrock.aws/u/{user}/{appId}/{Nama-App}`. Nama app berubah kalau
   peserta rename, app id tidak.

Satu app yang disubmit ke lebih dari satu kategori akan menerima data yang sama
di semua kategori tersebut.
