# Menjalankan scoring lewat CLI

Panduan menjalankan penilaian borongan (ratusan sampai ribuan project) dari
terminal, memakai worker antrean `npm run score:queue`.

- [Kapan pakai CLI](#kapan-pakai-cli)
- [Prasyarat](#prasyarat)
- [Perintah dasar](#perintah-dasar)
- [Opsi](#opsi)
- [Cara kerja antreannya](#cara-kerja-antreannya)
- [Memantau progres](#memantau-progres)
- [Menghentikan worker](#menghentikan-worker)
- [Menangani kegagalan](#menangani-kegagalan)
- [Menyetel konkurensi](#menyetel-konkurensi)
- [Perkiraan waktu dan biaya](#perkiraan-waktu-dan-biaya)
- [Alternatif tanpa CLI](#alternatif-tanpa-cli)
- [Masalah yang sering muncul](#masalah-yang-sering-muncul)

## Kapan pakai CLI

| Situasi | Pakai |
| --- | --- |
| Submission masuk satu-satu lewat form | Tidak perlu apa-apa — langsung dinilai saat submit |
| Import CSV puluhan baris | Tombol **Process Queue** di halaman admin Submissions |
| Import CSV ratusan sampai ribuan baris | **CLI** (`npm run score:queue`) |
| Menilai ulang banyak project setelah parameter diubah | **CLI** |

Alasan CLI dipakai untuk borongan: deployment di Vercel membatasi tiap function
maksimal 300 detik (paket Hobby dengan Fluid Compute), sedangkan satu project
bisa butuh lebih dari satu menit (evaluator, critic, dan retry). Endpoint
antrean karena itu hanya memproses sepotong per panggilan. Worker CLI berjalan
di komputer Anda sendiri, tanpa batas durasi.

Worker CLI dan panel admin boleh jalan **bersamaan** — klaim antreannya atomik,
jadi tidak akan ada project yang dinilai dua kali.

## Prasyarat

1. Repo sudah di-clone dan `npm install` sudah dijalankan.
2. File `.env` terisi — minimal `DATABASE_URL` dan `ANTHROPIC_API_KEY`.
   Worker memakai `.env` yang sama dengan aplikasi, jadi ia menulis ke database
   yang sama dengan yang dipakai production.
3. Skema database sudah sinkron:

```bash
npm run db:push
```

> **Perhatian:** worker ini memanggil API berbayar dan menulis skor ke database
> production. Jalankan `--limit 1` dulu untuk memastikan semuanya benar sebelum
> melepas 3000 project.

## Perintah dasar

```bash
npm run score:queue
```

Tanpa opsi, worker akan: mengambil kembali klaim yang menggantung, lalu memproses
**seluruh** project berstatus PENDING sampai antrean habis, dengan konkurensi 3.

Contoh keluaran:

```
Queue: 2847 waiting, 0 in flight, 3 failed, 150 scored
  [1] cmg7x2k10000abcd — ok 1, failed 0, 6.2/min
  [2] cmg7x2k10001abcd — ok 2, failed 0, 7.1/min
  ...
Done in 184.3 min — claimed 2847, ok 2831, failed 16, 0 still waiting.
```

Uji coba dulu dengan satu project:

```bash
npm run score:queue -- --limit 1
```

> Perhatikan `--` sebelum opsi. Tanpa itu, npm akan menelan opsinya dan tidak
> meneruskannya ke script.

## Opsi

| Opsi | Default | Fungsi |
| --- | --- | --- |
| `--concurrency N` | 3 | Berapa project dinilai paralel. Tiap project menahan beberapa panggilan API sekaligus. |
| `--limit N` | semua | Berhenti setelah N project. Berguna untuk pilot. |
| `--category ID` | semua | Hanya kategori tertentu. ID-nya ada di URL halaman kategori. |
| `--retry-failed` | — | Reset project berstatus FAILED ke antrean sebelum mulai (termasuk yang sudah diparkir karena kehabisan percobaan). |

Contoh kombinasi:

```bash
# Pilot 20 project di satu kategori
npm run score:queue -- --category cmg7abc123 --limit 20

# Run penuh, agak agresif
npm run score:queue -- --concurrency 5

# Ulangi yang gagal saja
npm run score:queue -- --retry-failed
```

## Cara kerja antreannya

Antreannya bukan tabel terpisah, melainkan kolom `Project.scoreStatus` sendiri:

| Status | Artinya |
| --- | --- |
| `PENDING` | Menunggu giliran — inilah isi antrean |
| `PROCESSING` | Sedang dikerjakan worker |
| `SUCCESS` | Kedua track berhasil dinilai |
| `PARTIAL` | Satu track berhasil, satu gagal (misal dokumen ide tidak ada) |
| `FAILED` | Semua track gagal |

Yang perlu diketahui:

- **Klaim bersifat atomik.** Worker mengambil pekerjaan dengan satu statement SQL
  `FOR UPDATE SKIP LOCKED`, jadi beberapa worker (atau worker + panel admin)
  tidak akan pernah mengambil project yang sama.
- **Worker mati tidak membuat project tersangkut.** Klaim yang menggantung lebih
  dari 15 menit dikembalikan otomatis ke antrean oleh run berikutnya.
- **Ada batas percobaan.** Setelah 3 kali gagal, project diparkir dan tidak
  diambil lagi — supaya satu project rusak tidak menghabiskan kuota API.
  `--retry-failed` yang mereset hitungannya.
- **Import CSV tidak menilai apa pun.** Barisnya hanya masuk antrean; worker yang
  mengerjakan.

## Memantau progres

Tiga cara:

1. **Output worker** — menampilkan project ke-n, jumlah sukses/gagal, dan laju per menit.
2. **Halaman admin Submissions** — panel Scoring Queue menampilkan jumlah menunggu,
   sedang jalan, berhasil, gagal, dan diparkir. Angkanya ikut bergerak walau yang
   bekerja adalah worker CLI.
3. **Query database langsung**:

```sql
SELECT "scoreStatus", COUNT(*)
FROM "Project"
WHERE "isActive" = true
GROUP BY "scoreStatus";
```

## Menghentikan worker

Tekan `Ctrl-C` satu kali. Worker berhenti mengambil pekerjaan baru dan
menyelesaikan yang sedang jalan:

```
^C
Stopping after the projects currently in flight...
```

Tekan `Ctrl-C` kedua kalinya untuk keluar paksa. Project yang terpotong akan
dikembalikan ke antrean otomatis setelah 15 menit, atau langsung ikut terproses
saat worker dijalankan lagi.

Menjalankan ulang perintah yang sama akan melanjutkan dari sisa antrean — tidak
ada yang dinilai dua kali.

## Menangani kegagalan

Alasan kegagalan tersimpan di kolom `Project.scoreError` dan tampil di halaman
detail submission. Yang paling sering:

| Pesan | Artinya | Tindakan |
| --- | --- | --- |
| `Evidence not available yet: ... no idea document` | Peserta tidak mengirim file MD | Isi lewat halaman detail, lalu `--retry-failed` |
| `Evidence not available yet: ... no Source Code` | URL gagal di-fetch dan tidak ada markup ditempel | Tempel Source Code manual, lalu `--retry-failed` |
| `Could not resolve authentication method` | `ANTHROPIC_API_KEY` belum diisi | Perbaiki `.env` |
| `cut off at max_tokens` | Jawaban model terpotong | Naikkan `ANTHROPIC_MAX_TOKENS` di `.env` |
| `429` / `overloaded` berulang | Kena rate limit | Turunkan `--concurrency` |

Setelah diperbaiki:

```bash
npm run score:queue -- --retry-failed
```

## Menyetel konkurensi

Mulai dari 3. Perhatikan log: baris `[LLM] ... failed transiently (attempt n/4)`
menandakan Anda menabrak batas laju penyedia model.

| Gejala | Tindakan |
| --- | --- |
| Hampir tidak ada retry | Naikkan bertahap (5, lalu 8) |
| Retry sesekali | Biarkan — retry otomatis sudah menanganinya |
| Retry di hampir semua panggilan | Turunkan ke 2, atau naikkan tier API |

Konkurensi terlalu tinggi justru memperlambat: setiap panggilan gagal tetap
menunggu backoff sebelum diulang.

## Perkiraan waktu dan biaya

Dengan evaluator dan critic di Claude Haiku 4.5, sekitar 10 detik per project
per worker:

| Jumlah project | Konkurensi 3 | Konkurensi 5 | Perkiraan biaya |
| --- | --- | --- | --- |
| 100 | ~6 menit | ~4 menit | ~$5 |
| 1.000 | ~1 jam | ~35 menit | ~$52 |
| 3.000 | ~3 jam | ~1,7 jam | ~$157 |

Biaya di atas untuk kondisi critic langsung menyetujui. Kalau critic menolak dan
memicu evaluasi ulang, biaya naik sampai sekitar 30%.

## Alternatif tanpa CLI

Kalau tidak ingin membuka terminal, antrean juga bisa dikuras lewat HTTP.
Endpoint memproses sepotong (berhenti mengambil project baru setelah 150 detik)
tiap dipanggil, jadi perlu
dipanggil berulang:

```bash
curl -X POST https://<app>/api/scoring/queue \
  -H "Authorization: Bearer $CRON_SECRET"
```

Isi `CRON_SECRET` di environment aplikasi, lalu daftarkan URL-nya di penjadwal
seperti cron-job.org atau GitHub Actions dengan interval 1 menit. Cara ini cocok
untuk submission yang menetes sepanjang hari, tapi terlalu lambat untuk 3000
project sekaligus.

## Masalah yang sering muncul

**`Nothing to do.` padahal baru import CSV**
Cek apakah import benar-benar berhasil — respons import memuat `queued` dan
`errors`. Baris yang gagal validasi tidak dibuat sama sekali.

**Worker jalan tapi angka di panel admin tidak bergerak**
Refresh halamannya. Panel memuat angka awal dari server dan hanya melakukan
polling saat ada pekerjaan yang terdeteksi sedang jalan.

**`column Project.scoreAttempts does not exist`**
Skema database belum sinkron. Jalankan `npm run db:push`.

**Worker memakai database yang salah**
Worker membaca `.env` di root repo, bukan environment Vercel. Pastikan
`DATABASE_URL`-nya menunjuk ke database yang Anda maksud.
