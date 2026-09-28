# Scoring Quick

Aplikasi penilaian kompetisi untuk project web yang dikumpulkan peserta. Tiap
submission terdiri dari dua file: dokumen ide (markdown) dan halaman HTML-nya
(URL yang di-fetch atau source code yang ditempel). Keduanya dinilai AI di track
terpisah dengan parameter dan bobot masing-masing, lalu digabung jadi skor akhir.
Setiap penilaian AI diaudit agen kedua (Critic) untuk menekan bias. Juri manusia
bisa meninjau atau menimpa skor AI sebelum leaderboard dipublikasikan.

Ini adalah versi HTML-only dari [scoring-partyrock](https://github.com/fikriabr/scoring-partyrock),
dipisah ke repo, database, dan deployment sendiri supaya keduanya bisa
berkembang independen. Repo ini **tidak punya pipeline capture** — semua
evidence datang langsung dari fetch HTTP atas URL yang disubmit, atau dari
markup yang ditempel manual oleh admin/peserta.

## Daftar isi

- [Fitur](#fitur)
- [Stack](#stack)
- [Cara kerja penilaian](#cara-kerja-penilaian)
- [Setup](#setup)
- [Menjalankan scoring borongan](#menjalankan-scoring-borongan)
- [Perintah npm](#perintah-npm)
- [Model data](#model-data)
- [Peran dan hak akses](#peran-dan-hak-akses)
- [Struktur proyek](#struktur-proyek)
- [Testing](#testing)
- [Deploy](#deploy)

## Fitur

- **Event dan kategori** — satu event berisi banyak kategori lomba, tiap kategori
  punya set parameter penilaiannya sendiri.
- **Dua track penilaian** — parameter Idea menilai dokumen markdown, parameter
  HTML menilai halamannya. Bobot antar-track (default Idea 60% / HTML 40%) diatur
  per kategori.
- **Parameter berbobot** — bobot parameter di dalam tiap track wajib berjumlah
  100%, divalidasi saat disimpan. Tiap parameter punya rentang skor sendiri
  (`minScore`–`maxScore`) dan mode `AUTO` (dinilai AI) atau `MANUAL` (khusus juri).
- **Submission satuan dan bulk CSV** — form tunggal atau unggah CSV. Duplikat URL
  dalam satu kategori ditolak, dan baris CSV yang gagal dilaporkan per nomor baris
  tanpa membatalkan baris lain yang valid.
- **Fetch + analisis struktur HTML** — begitu disubmit, project langsung di-fetch:
  markup-nya disimpan, dan struktur (heading, elemen semantik, landmark, alt
  text, dsb.) dihitung lewat `lib/services/html-structure.service.ts`.
- **Penilaian AI multi-agen** — agen Evaluator menilai tiap parameter `AUTO`
  dengan alasan dan kutipan bukti; agen Critic mengauditnya untuk mencari bias
  dan meminta evaluasi ulang bila perlu. Jejak tiap putaran tersimpan dan bisa
  dilihat di halaman detail submission. Skor di luar rentang diklem dan ditandai.
- **Antrean scoring** — import CSV masuk antrean, dikerjakan worker
  ([panduan CLI](docs/scoring-cli.md)) supaya ribuan project tidak menabrak
  rate limit atau batas durasi function.
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
| AI        | Anthropic Claude (`@anthropic-ai/sdk`), opsional Google Gemini |
| Testing   | Vitest + fast-check (property-based testing)                 |

## Cara kerja penilaian

Tiap submission terdiri dari **dua file**, masing-masing dinilai di track
sendiri dengan parameter sendiri:

```
                ┌─▶ Track Idea (.md)  ─▶ Evaluator ─▶ Critic ─┐
Submission ─────┤                                             ├─▶ Skor akhir ─▶ Juri ─▶ Leaderboard
                └─▶ Track HTML        ─▶ Evaluator ─▶ Critic ─┘   (bobot 60/40)
```

- **Track terisolasi.** Evaluator Idea hanya melihat dokumen markdown, evaluator
  HTML hanya melihat halamannya. Jadi HTML yang bagus tidak bisa mengangkat skor
  ide, dan sebaliknya.
- **Agen Critic.** Setiap penilaian diaudit agen kedua yang mencari bias: skor
  terangkat tampilan, halo effect, panjang dokumen, alasan yang tidak didukung
  bukti, atau skor yang bertentangan dengan alasannya sendiri. Kalau bias
  ditemukan, evaluasi diulang dengan masukan Critic. Kalau setelah batas
  pengulangan masih bias, skornya tetap disimpan tapi ditandai untuk ditinjau
  juri.
- **Bobot dua lapis.** Di dalam tiap track, bobot parameter harus berjumlah 100%.
  Skor akhir = `skor Idea × bobot Idea + skor HTML × bobot HTML`, diatur per
  kategori (default 60/40) di halaman Parameters.
- **Skor juri menimpa AI** per parameter. Kalau beberapa juri menilai parameter
  yang sama, nilainya dirata-ratakan.

Model yang dipakai diatur lewat environment — lihat
[Setup](#setup). Default: evaluator dan critic sama-sama Claude Haiku 4.5.

Bukti yang dibaca AI: `Project.ideaDoc` untuk track Idea, dan `Project.sourceCode`
plus metrik struktur untuk track HTML. Source code bisa ditempel manual atau
diambil otomatis lewat fetch HTTP saat submit (markup yang sudah ditempel tidak
pernah ditimpa hasil fetch).

## Setup

### Prasyarat

- Node.js 20.19+ atau 22 LTS
- Database Neon PostgreSQL ([neon.tech](https://neon.tech) — free tier cukup)
- API key Anthropic ([console.anthropic.com](https://console.anthropic.com) —
  berbayar, dipakai evaluator dan critic)
- Opsional: API key Google Gemini
  ([aistudio.google.com/apikey](https://aistudio.google.com/apikey)) kalau salah
  satu agen ingin dijalankan di Gemini

### Langkah

```bash
npm install
```

Salin `.env.example` menjadi `.env`, lalu isi nilainya:

```bash
cp .env.example .env
```

| Variabel                          | Keterangan                                           |
| --------------------------------- | ----------------------------------------------------- |
| `DATABASE_URL`                    | Connection string Neon, sertakan `?sslmode=require`    |
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | Isi sama, hasil `openssl rand -base64 32`              |
| `ANTHROPIC_API_KEY`               | API key Anthropic — tanpa ini scoring tidak jalan      |
| `ANTHROPIC_MODEL_ID`              | Default `claude-haiku-4-5`                             |
| `LLM_EVALUATOR_PROVIDER`          | `anthropic` (default) atau `google`                    |
| `LLM_CRITIC_PROVIDER`             | `anthropic` (default) atau `google`                    |
| `GEMINI_API_KEY` / `GEMINI_MODEL_ID` | Hanya perlu kalau ada agen memakai provider `google` |
| `CRON_SECRET`                     | Opsional — untuk menguras antrean lewat penjadwal eksternal |
| `APP_BASE_URL`                    | Opsional — base URL deployment ini                     |

Daftar lengkap beserta penjelasannya ada di [.env.example](.env.example).

Dorong skema ke database dan buat akun admin pertama:

```bash
npm run db:push
npm run seed:admin
```

`seed:admin` membuat akun `admin@scoring-quick.local` dengan password `admin123`.
**Ganti password ini sebelum dipakai sungguhan** — kredensialnya hardcoded di
[scripts/seed-admin.js](scripts/seed-admin.js) dan hanya untuk bootstrap awal.

```bash
npm run dev
```

Buka http://localhost:3000 lalu login.

## Perintah npm

| Perintah                  | Fungsi                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `npm run dev`               | Dev server                                                  |
| `npm run build` / `start`   | Build dan jalankan production                                |
| `npm run typecheck`         | `tsc --noEmit`                                               |
| `npm run lint`              | ESLint                                                        |
| `npm test`                  | Seluruh test suite                                            |
| `npm run test:watch`        | Test mode watch                                               |
| `npm run test:coverage`     | Test dengan laporan coverage                                   |
| `npm run db:push`           | Sinkronkan skema Prisma ke database (tanpa file migration)     |
| `npm run db:migrate`        | Buat dan jalankan migration                                     |
| `npm run db:studio`         | Prisma Studio                                                    |
| `npm run db:generate`       | Generate Prisma Client (otomatis lewat `postinstall`)             |
| `npm run seed:admin`        | Buat akun admin awal                                                |
| `npm run score:queue`       | Worker antrean scoring — lihat [panduan CLI](docs/scoring-cli.md)    |

## Menjalankan scoring borongan

Submission tunggal dinilai langsung saat disubmit. Import CSV **tidak** —
barisnya masuk antrean, lalu dikerjakan worker:

```bash
npm run score:queue -- --concurrency 3
```

Untuk jumlah kecil, tombol **Process Queue** di halaman admin Submissions juga
bisa dipakai. Penjelasan lengkap — opsi, cara memantau, menangani kegagalan,
menyetel konkurensi, perkiraan waktu dan biaya — ada di
**[docs/scoring-cli.md](docs/scoring-cli.md)**.

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

## Struktur proyek

```
app/
  (auth)/login/               Halaman login
  (dashboard)/admin/          Event, kategori, parameter, submission, user, leaderboard
  (dashboard)/jury/           Daftar project dan form penilaian juri
  public/leaderboard/         Leaderboard publik berbasis token
  api/                        Route handler
components/                   Komponen client (form, tabel, editor source code)
lib/
  services/                   Logika bisnis — submission, crawler, scorer, jury, leaderboard, export
  validators/schemas.ts       Skema Zod untuk semua input
  auth/                       Konfigurasi NextAuth, RBAC, pembatasan akses juri
  db.ts                       Prisma client singleton (adapter Neon HTTP)
prisma/schema.prisma          Skema database
scripts/seed-admin.js         Bootstrap akun admin pertama
__tests__/                    Test suite
```

## Testing

```bash
npm test
```

Sebagian besar test berupa **property-based test** dengan fast-check: alih-alih
beberapa contoh kasus, tiap properti diuji terhadap ratusan input acak. Yang
dijaga antara lain bobot parameter selalu berjumlah 100%, skor AI tidak pernah
keluar rentang, isolasi juri antar kategori, impor CSV yang sukses sebagian,
validasi struktur HTML, dan kelengkapan hasil ekspor.

## Deploy

Aplikasi Next.js-nya siap dideploy ke Vercel atau hosting lain. Yang perlu
diperhatikan:

- **Environment variables.** Set semua variabel dari tabel [Setup](#setup).
- **Jangan set `AUTH_URL`/`NEXTAUTH_URL`.** `authConfig` memakai `trustHost: true`,
  jadi Auth.js membaca domain dari request yang masuk — sama benarnya di
  localhost, di preview deployment, maupun di domain production. Kalau
  `AUTH_URL` diisi, redirect setelah login dipaksa ke alamat itu, dan login di
  domain lain akan terlihat gagal.
- **Jangan set `NODE_ENV=production` atau `NPM_CONFIG_PRODUCTION=true`** di
  environment build. Keduanya membuat devDependencies dilewati, padahal CLI
  `prisma` ada di sana dan dibutuhkan oleh `postinstall: prisma generate`.
- **Rate limiter in-memory.** [lib/rate-limit.ts](lib/rate-limit.ts) memakai LRU
  cache di memori proses, jadi di serverless batasnya berlaku per instance, bukan
  global. Cukup untuk mencegah penyalahgunaan ringan; kalau butuh limit ketat,
  ganti ke penyimpanan bersama seperti Redis.
