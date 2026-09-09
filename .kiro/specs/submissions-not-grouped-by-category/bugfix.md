# Bugfix Requirements Document

## Introduction

Halaman `/admin/submissions` menampilkan seluruh project dalam satu tabel datar yang diurutkan hanya berdasarkan waktu submit (terbaru dulu). Akibatnya project dari satu kategori tersebar di sepanjang tabel dan admin harus memindai baris satu per satu — plus menghitung manual — untuk tahu isi sebuah kategori. Kolom Category memang ada, tapi kolom saja tidak menghasilkan pengelompokan.

Masalah ini diperparah karena nama kategori hanya unik per event: dua event bisa punya kategori bernama sama, dan di tabel sekarang keduanya tampil sebagai teks yang identik tanpa penanda event.

Perbaikan yang diminta: project dikelompokkan per kategori, tiap kategori jadi section sendiri dengan heading `Event — Kategori`, jumlah project di heading, dan sub-tabel berisi project kategori tersebut.

### Bug Condition

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type SubmissionsPageData   // daftar project + kategori & event-nya
  OUTPUT: boolean

  // Halaman punya project untuk dirender, sehingga ketiadaan pengelompokan
  // per kategori bisa diamati.
  RETURN count(X.projects) > 0
END FUNCTION
```

```pascal
// Property: Fix Checking
FOR ALL X WHERE isBugCondition(X) DO
  view ← renderSubmissionsPage'(X)
  ASSERT view.groups = sortByEventThenCategoryName(distinctCategoriesOf(X.projects))
  ASSERT FOR EACH g IN view.groups:
           g.heading  = g.eventName + " — " + g.categoryName
           g.count    = count(projectsOf(g))
           g.projects = sortByCreatedAtDesc(projectsOf(g))
  ASSERT every project in X.projects appears in exactly one group
END FOR
```

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT renderSubmissionsPage(X) = renderSubmissionsPage'(X)
END FOR
```

Artinya: saat halaman tidak punya project sama sekali, tampilannya harus persis seperti sebelum perbaikan (empty state). Untuk semua kasus lain, per-project data yang ditampilkan tetap sama; yang berubah hanya susunan/pengelompokannya.

## Bug Analysis

### Current Behavior (Defect)

Yang terjadi sekarang saat halaman submissions dibuka:

1.1 WHEN ada project dari lebih dari satu kategori THEN sistem menampilkan semua project dalam satu tabel datar yang diurutkan waktu submit terbaru dulu, sehingga project dari kategori yang sama tersebar dan tidak berdampingan

1.2 WHEN dua kategori dari event berbeda punya nama yang sama THEN sistem menampilkan hanya nama kategori pada kolom Category, sehingga baris dari kedua kategori tersebut tidak bisa dibedakan

1.3 WHEN admin ingin mengetahui berapa project yang masuk di satu kategori THEN sistem tidak menampilkan angka itu, hanya total seluruh project pada heading "Projects (N)"

1.4 WHEN admin ingin melihat isi satu kategori saja THEN sistem tidak menyediakan batas visual antar kategori, sehingga admin harus membaca kolom Category baris per baris

### Expected Behavior (Correct)

Yang seharusnya terjadi:

2.1 WHEN ada project dari lebih dari satu kategori THEN sistem SHALL merender satu section per kategori, masing-masing dengan heading kategori dan sub-tabel berisi hanya project kategori tersebut

2.2 WHEN dua kategori dari event berbeda punya nama yang sama THEN sistem SHALL menampilkan heading section dengan format `Event — Kategori`, sehingga kedua kategori tampil sebagai section terpisah yang bisa dibedakan

2.3 WHEN sebuah section kategori dirender THEN sistem SHALL menampilkan jumlah project di kategori itu pada heading section

2.4 WHEN halaman merender lebih dari satu section THEN sistem SHALL mengurutkan section berdasarkan nama event lalu nama kategori secara A-Z (case-insensitive)

2.5 WHEN sebuah section kategori memuat beberapa project THEN sistem SHALL mengurutkan project di dalamnya berdasarkan waktu submit terbaru dulu, sama seperti urutan tabel datar sebelumnya

2.6 WHEN sebuah kategori tidak punya project sama sekali THEN sistem SHALL tidak merender section untuk kategori tersebut

2.7 WHEN sub-tabel sebuah section dirender THEN sistem SHALL tidak lagi menampilkan kolom Category, karena informasi itu sudah ada di heading section

2.8 WHEN halaman dirender THEN sistem SHALL menampilkan setiap project tepat satu kali, di bawah kategori miliknya

### Unchanged Behavior (Regression Prevention)

Perilaku yang harus tetap sama setelah perbaikan:

3.1 WHEN belum ada project sama sekali THEN sistem SHALL CONTINUE TO menampilkan empty state "No projects submitted yet." tanpa tabel maupun section

3.2 WHEN halaman submissions dibuka THEN sistem SHALL CONTINUE TO menampilkan total seluruh project pada heading daftar ("Projects (N)")

3.3 WHEN sebuah project dirender THEN sistem SHALL CONTINUE TO menampilkan kolom Participant (dengan nama tim di bawahnya bila ada), URL sebagai tautan yang membuka tab baru secara aman, Type, Crawl, Score, dan aksi View — dengan teks label UI tetap bahasa Inggris

3.4 WHEN sebuah project dirender THEN sistem SHALL CONTINUE TO menampilkan badge tipe project (PartyRock/HTML) dengan label dan warna yang sama seperti sekarang, termasuk untuk project lama yang bertipe default PARTYROCK

3.5 WHEN sebuah project dirender THEN sistem SHALL CONTINUE TO menampilkan badge status Crawl dan Score dengan warna per status yang sama seperti sekarang

3.6 WHEN admin menekan View pada sebuah project THEN sistem SHALL CONTINUE TO membuka halaman detail submission project tersebut, dan aksi retry crawl/score SHALL CONTINUE TO tersedia hanya di halaman detail itu

3.7 WHEN halaman submissions dibuka THEN sistem SHALL CONTINUE TO menampilkan form submit project tunggal dan CSV bulk upload di atas daftar, dengan pilihan kategori yang sama (terurut nama, memuat nama event)

3.8 WHEN daftar dibuka di layar sempit THEN sistem SHALL CONTINUE TO bisa digeser horizontal tanpa memotong kolom
