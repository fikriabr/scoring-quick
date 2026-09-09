# Scoring Project by PindAI

Aplikasi penilaian kompetisi untuk project yang dikumpulkan peserta. Sumber
project yang didukung saat ini adalah app [AWS PartyRock](https://partyrock.aws):
peserta mengumpulkan URL app-nya, sistem mengambil struktur app tersebut
(widget + prompt), lalu menilainya dengan AI per parameter berbobot. Juri manusia
bisa meninjau atau menimpa skor AI sebelum leaderboard dipublikasikan.

## Daftar isi

- [Fitur](#fitur)
- [Stack](#stack)
- [Cara kerja penilaian](#cara-kerja-penilaian)
- [Setup](#setup)
- [Perintah npm](#perintah-npm)
- [Model data](#model-data)
- [Peran dan hak akses](#peran-dan-hak-akses)
- [Pipeline capture](#pipeline-capture)
- [Struktur proyek](#struktur-proyek)
- [Testing](#testing)
- [Deploy](#deploy)

## Fitur

- **Event dan kategori** — satu event berisi banyak kategori lomba, tiap kategori
  punya set parameter penilaiannya sendiri.
- **Parameter berbobot** — bobot semua parameter dalam satu kategori wajib
  berjumlah 100%, divalidasi saat disimpan. Tiap parameter punya rentang skor
  sendiri (`minScore`–`maxScore`) dan mode `AUTO` (dinilai AI) atau `MANUAL`
  (khusus juri).
- **Submission satuan dan bulk CSV** — form tunggal atau unggah CSV. Duplikat URL
  dalam satu kategori ditolak, dan baris CSV yang gagal dilaporkan per nomor baris
  tanpa membatalkan baris lain yang valid.
- **Penilaian AI** — Google Gemini menilai tiap parameter `AUTO` dan memberi alasan
  tertulis. Skor di luar rentang diklem ke batas terdekat dan ditandai.
- **Penilaian juri** — juri hanya melihat kategori yang ditugaskan padanya. Bisa
  menerima skor AI apa adanya atau menimpanya dengan komentar wajib.
- **Leaderboard dan ekspor** — peringkat per kategori, halaman perbandingan antar
  project, ekspor Excel/CSV, dan leaderboard publik lewat token acak.
- **Jejak audit** — setiap penimpaan skor tercatat di `AuditLog` dan `ScoreOverride`
  lengkap dengan nilai lama, nilai baru, dan siapa yang mengubah.

## Stack

| Bagian    | Teknologi                                                    |
| --------- | ------------------------------------------------------------ |
| Framework | Next.js 16 (App Router, React 19, TypeScript)                |
| Styling   | Tailwind CSS v4                                              |
| Database  | Neon PostgreSQL via Prisma 6 (adapter HTTP `PrismaNeonHTTP`) |
| Auth      | NextAuth v5 (Auth.js), credentials + JWT, bcrypt             |
| AI        | Google Gemini (`@google/generative-ai`)                      |
| Capture   | Playwright (Chrome asli, headed) — **hanya jalan lokal**     |
| Testing   | Vitest + fast-check (property-based testing)                 |

## Cara kerja penilaian

```
Submission  ──▶  Data app         ──▶  Skor AI          ──▶  Skor juri       ──▶  Leaderboard
(URL app)        (widget/prompt)       (per parameter)       (terima/timpa)       (final)
```

Skor akhir dihitung tertimbang, bukan rata-rata biasa. Tiap parameter menyumbang
`score × weight / 100`, lalu dijumlahkan — lihat `calculateWeightedScore` di
[lib/services/leaderboard.service.ts](lib/services/leaderboard.service.ts). Kalau
satu project dinilai beberapa juri, skor tertimbang tiap juri dirata-ratakan
lewat `calculateAverageJuryScore`.

`Project.sourceCode` adalah bukti utama yang dibaca AI scorer. Isinya bisa datang
dari dua arah: ditempel langsung oleh admin di form submission, atau disusun
otomatis oleh pipeline capture dari widget, prompt, dan output app.

## Setup

### Prasyarat

- Node.js 20.19+ atau 22 LTS
- Database Neon PostgreSQL ([neon.tech](https://neon.tech) — free tier cukup)
- API key Google Gemini ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)
  — free tier, tanpa kartu kredit)

### Langkah

```bash
npm install
```

Salin `.env.example` menjadi `.env`, lalu isi nilainya:

```bash
cp .env.example .env
```

| Variabel                          | Keterangan                                                             |
| --------------------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`                    | Connection string Neon, sertakan `?sslmode=require`                    |
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | Isi sama, hasil `openssl rand -base64 32`                              |
| `GEMINI_API_KEY`                  | API key Google AI Studio                                               |
| `GEMINI_MODEL_ID`                 | Default `gemini-flash-lite-latest`                                     |
| `CAPTURE_TOKEN`                   | Secret bersama untuk endpoint capture, `openssl rand -hex 24`          |
| `APP_BASE_URL`                    | Opsional — alamat aplikasi yang dituju script capture, lihat di bawah  |
| `PR_CHROME_PROFILE`               | Opsional, **lokal saja** — lihat [Pipeline capture](#pipeline-capture) |

Dorong skema ke database dan buat akun admin pertama:

```bash
npm run db:push
npm run seed:admin
```

`seed:admin` membuat akun `admin@partyrock.local` dengan password `admin123`.
**Ganti password ini sebelum dipakai sungguhan** — kredensialnya hardcoded di
[scripts/seed-admin.js](scripts/seed-admin.js) dan hanya untuk bootstrap awal.

```bash
npm run dev
```

Buka http://localhost:3000 lalu login.

## Perintah npm

| Perintah                        | Fungsi                                                     |
| ------------------------------- | ---------------------------------------------------------- |
| `npm run dev`                   | Dev server                                                 |
| `npm run build` / `start`       | Build dan jalankan production                              |
| `npm run typecheck`             | `tsc --noEmit`                                             |
| `npm run lint`                  | ESLint                                                     |
| `npm test`                      | Seluruh test suite                                         |
| `npm run test:watch`            | Test mode watch                                            |
| `npm run test:coverage`         | Test dengan laporan coverage                               |
| `npm run db:push`               | Sinkronkan skema Prisma ke database (tanpa file migration) |
| `npm run db:migrate`            | Buat dan jalankan migration                                |
| `npm run db:studio`             | Prisma Studio                                              |
| `npm run db:generate`           | Generate Prisma Client (otomatis lewat `postinstall`)      |
| `npm run seed:admin`            | Buat akun admin awal                                       |
| `npm run capture`               | Jalankan navigator capture — **lokal saja**                |
| `npm run capture:clone-profile` | Salin sesi Chrome ke profil capture — **lokal saja**       |

## Model data

```
Event ──< Category ──< Parameter
               │            │
               │            ├──< AIScore ───┐
               │            └──< JuryScore ─┤
               │                            │
               ├──< Project ────────────────┘
               │       ├── CrawlMetadata (1:1)
               │       └──< AuditLog
               │
               └──< CategoryJury >── User ──< ScoreOverride
```

Constraint penting:

- `Category` unik per `(eventId, name)`
- `Project` unik per `(categoryId, url)` — satu URL tidak bisa disubmit dua kali
  ke kategori yang sama
- `AIScore` unik per `(projectId, parameterId)`
- `JuryScore` unik per `(projectId, parameterId, juryId)`

Definisi lengkapnya ada di [prisma/schema.prisma](prisma/schema.prisma).

## Peran dan hak akses

Dua peran: `ADMIN` dan `JURY`. Penjagaannya ada di [proxy.ts](proxy.ts) yang
memanggil fungsi murni `checkAccess` di [lib/auth/rbac.ts](lib/auth/rbac.ts),
supaya logika akses bisa dites terpisah dari internal Next.js.

| Peran   | Akses                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------- |
| `ADMIN` | Semua halaman dan API                                                                                   |
| `JURY`  | Semua kecuali prefix admin: `/admin`, `/api/events`, `/api/categories`, `/api/parameters`, `/api/users` |

Juri juga dibatasi di lapisan data: hanya bisa melihat dan menilai project di
kategori yang ditugaskan padanya lewat tabel `CategoryJury` — lihat
[lib/auth/jury-access.ts](lib/auth/jury-access.ts).

Setelah login, form mengarahkan ke `/`, dan [app/page.tsx](app/page.tsx)
meneruskan sesuai peran lewat `homePathForRole`: admin ke `/admin`, juri ke
`/jury/projects`. Tujuan tiap peran didefinisikan sekali di `ROLE_HOME`
([lib/auth/rbac.ts](lib/auth/rbac.ts)), dan property test memastikan tujuan itu
memang lolos `checkAccess` untuk peran tersebut.

Halaman `/public/leaderboard/[token]` sengaja terbuka tanpa auth. Tokennya acak
per kategori dan baru berlaku setelah admin menekan Publish.

## Pipeline capture

Widget dan prompt sebuah app PartyRock tidak ada di HTML awal — semuanya datang
dari API internal `getLatestAppVersion`, dan AWS WAF memblokir pemanggilan yang
terlihat otomatis atau terlalu sering. Karena itu data tersebut diambil dari sesi
browser sungguhan yang dikemudikan manusia, bukan hasil scraping.

Bagian ini **tidak bisa jalan di serverless** — butuh Chrome headed, profil di
filesystem, dan manusia yang mengklik widget. Jalankan dari komputer sendiri,
arahkan ke aplikasi yang sudah dideploy lewat `--base-url`:

```bash
npm run capture -- --base-url https://nama-app.vercel.app
```

Untuk satu project saja, pakai `--url`:

```bash
npm run capture -- --url https://partyrock.aws/u/user/appid/Nama-App
```

Tanpa flag itu, script memakai `APP_BASE_URL` bila diisi, lalu domain Vercel
(`VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL`) bila variabelnya ada di
lingkungan — misalnya hasil `vercel env pull` — dan terakhir jatuh ke
`http://localhost:3000`. URL yang dipakai dicetak saat script mulai jalan.

```bash
npm run capture:clone-profile   # sekali saja: salin sesi login Chrome
npm run capture                 # buka tiap project satu per satu
```

Detail lengkap, opsi CLI, dan troubleshooting ada di
**[docs/CAPTURE.md](docs/CAPTURE.md)**.

> `.pr-chrome-profile/` berisi salinan cookie dan Login Data dari profil Chrome
> asli. Folder itu sudah di-gitignore dan tidak boleh dibagikan.

## Struktur proyek

```
app/
  (auth)/login/               Halaman login
  (dashboard)/admin/          Event, kategori, parameter, submission, user, leaderboard
  (dashboard)/jury/           Daftar project dan form penilaian juri
  public/leaderboard/         Leaderboard publik berbasis token
  api/                        Route handler
components/                   Komponen client (form, tabel, panel)
lib/
  services/                   Logika bisnis — submission, scorer, jury, leaderboard, export, capture
  validators/schemas.ts       Skema Zod untuk semua input
  auth/                       Konfigurasi NextAuth, RBAC, pembatasan akses juri
  db.ts                       Prisma client singleton (adapter Neon HTTP)
prisma/schema.prisma          Skema database
scripts/                      Utilitas Node yang jalan lokal (seed, capture)
public/partyrock-capture.js   Script yang disuntik ke halaman PartyRock
docs/CAPTURE.md               Dokumentasi pipeline capture
__tests__/                    Test suite
```

## Testing

```bash
npm test
```

24 file test, 257 test. Sebagian besar berupa **property-based test** dengan
fast-check: alih-alih beberapa contoh kasus, tiap properti diuji terhadap ratusan
input acak. Yang dijaga antara lain bobot parameter selalu berjumlah 100%, skor
AI tidak pernah keluar rentang, isolasi juri antar kategori, impor CSV yang
sukses sebagian, validasi domain URL, dan kelengkapan hasil ekspor.

## Deploy

Aplikasi Next.js-nya siap dideploy ke Vercel atau hosting lain. Yang perlu
diperhatikan:

- **Script capture tidak ikut dideploy.** `scripts/partyrock-navigate.js` dan
  `clone-chrome-profile.js` hanya jalan di mesin lokal. Tidak ada file di `app/`
  atau `lib/` yang mengimpor Playwright, jadi tidak ada yang perlu dipisahkan —
  cukup jangan pernah menjalankannya di server.
- **Environment variables.** Set semua variabel dari tabel [Setup](#setup) kecuali
  `PR_CHROME_PROFILE` dan `PR_CHROME_PROFILE_DIR` yang khusus lokal.
- **Jangan set `AUTH_URL`/`NEXTAUTH_URL`.** `authConfig` memakai `trustHost: true`,
  jadi Auth.js membaca domain dari request yang masuk — sama benarnya di
  localhost, di preview deployment, maupun di domain production. Kalau
  `AUTH_URL` diisi, redirect setelah login dipaksa ke alamat itu, dan login di
  domain lain akan terlihat gagal.
- **Jangan set `NODE_ENV=production` atau `NPM_CONFIG_PRODUCTION=true`** di
  environment build. Keduanya membuat devDependencies dilewati, padahal CLI
  `prisma` ada di sana dan dibutuhkan oleh `postinstall: prisma generate`.
- **`CAPTURE_TOKEN` harus sama persis** antara server dan mesin lokal yang
  menjalankan `npm run capture`.
- **Rate limiter in-memory.** [lib/rate-limit.ts](lib/rate-limit.ts) memakai LRU
  cache di memori proses, jadi di serverless batasnya berlaku per instance, bukan
  global. Cukup untuk mencegah penyalahgunaan ringan; kalau butuh limit ketat,
  ganti ke penyimpanan bersama seperti Redis.
