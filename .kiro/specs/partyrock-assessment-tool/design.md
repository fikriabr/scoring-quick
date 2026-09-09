# Design Document

## PartyRock Assessment Tool

---

## Overview

PartyRock Assessment Tool adalah aplikasi web fullstack yang dibangun di atas Next.js 15 App Router. Sistem ini mengorkestrasi seluruh alur penjurian: dari submission URL PartyRock peserta, crawling metadata otomatis via Playwright, penilaian awal berbasis AI (AWS Bedrock), hingga review dan override manual oleh juri manusia. Hasil akhir ditampilkan di leaderboard real-time yang dapat dipublikasikan.

---

## Architecture

### High-Level System Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Next.js 15 App Router                    │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  RSC Pages   │  │  API Routes  │  │  Server Actions  │  │
│  │  (app/*)     │  │  (app/api/*) │  │  (actions/*.ts)  │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         └─────────────────┴───────────────────┘            │
│                           │                                 │
│              ┌────────────▼────────────┐                   │
│              │   Service Layer         │                   │
│              │  (lib/services/*.ts)    │                   │
│              └────────────┬────────────┘                   │
│                           │                                 │
│         ┌─────────────────┼─────────────────┐              │
│         ▼                 ▼                 ▼              │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  ┌──────────────┐  │
│  │ Prisma ORM  │  │  Playwright  │  │  AWS Bedrock   │  │Google Sheets │  │
│  │ (Neon PG)   │  │  Crawler     │  │  AI Scorer     │  │  API (gapis) │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  └──────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

- **RSC Pages**: Server-rendered UI, reads data directly via Prisma dalam server context
- **API Routes**: REST endpoints untuk operasi CRUD, crawling trigger, scoring trigger, dan export
- **Server Actions**: Form submissions (event/kategori/parameter CRUD, submission form)
- **Service Layer**: Business logic terisolasi — `EventService`, `SubmissionService`, `CrawlerService`, `ScorerService`, `LeaderboardService`
- **Prisma ORM**: Satu-satunya jalur akses ke database Neon PostgreSQL
- **Playwright Crawler**: Dijalankan server-side sebagai async job, bukan di browser client
- **AWS Bedrock AI Scorer**: Dipanggil server-side setelah crawling selesai
- **Google Sheets API**: Dipanggil via `googleapis` package untuk create/update spreadsheet, autentikasi via service account

---

## Project Structure

```
scoring-partyrock/
├── app/
│   ├── (auth)/
│   │   └── login/
│   ├── (dashboard)/
│   │   ├── admin/
│   │   │   ├── events/
│   │   │   ├── categories/
│   │   │   ├── parameters/
│   │   │   ├── submissions/
│   │   │   └── users/
│   │   └── jury/
│   │       ├── projects/
│   │       └── scoring/
│   ├── api/
│   │   ├── auth/
│   │   ├── events/
│   │   ├── categories/
│   │   ├── parameters/
│   │   ├── submissions/
│   │   ├── crawl/
│   │   ├── score/
│   │   ├── leaderboard/
│   │   ├── export/
│   │   └── sheets/
│   └── public/
│       └── leaderboard/[token]/
├── lib/
│   ├── services/
│   │   ├── event.service.ts
│   │   ├── category.service.ts
│   │   ├── parameter.service.ts
│   │   ├── submission.service.ts
│   │   ├── crawler.service.ts
│   │   ├── scorer.service.ts
│   │   ├── jury.service.ts
│   │   ├── leaderboard.service.ts
│   │   └── sheets.service.ts
│   ├── validators/
│   │   └── schemas.ts
│   ├── auth/
│   │   └── config.ts
│   ├── db.ts
│   └── rate-limit.ts
├── prisma/
│   └── schema.prisma
└── types/
    └── index.ts
```

---

## Data Models

### Prisma Schema

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  JURY
}

enum CrawlStatus {
  PENDING
  PROCESSING
  SUCCESS
  FAILED
}

enum ScoreStatus {
  PENDING
  PROCESSING
  PARTIAL
  SUCCESS
  FAILED
}

enum ScoringMode {
  AUTO
  MANUAL
}

model User {
  id            String   @id @default(cuid())
  name          String
  email         String   @unique
  passwordHash  String
  role          Role     @default(JURY)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  categoryAssignments CategoryJury[]
  scoreOverrides      ScoreOverride[]
  auditLogs           AuditLog[]
}

model Event {
  id          String     @id @default(cuid())
  name        String
  description String?
  startDate   DateTime?
  endDate     DateTime?
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt

  categories Category[]
}

model Category {
  id            String   @id @default(cuid())
  eventId       String
  name          String
  description   String?
  isPublished   Boolean  @default(false)
  publicToken   String?  @unique
  spreadsheetId String?
  autoSync      Boolean  @default(false)
  syncEmail     String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  event       Event          @relation(fields: [eventId], references: [id])
  parameters  Parameter[]
  projects    Project[]
  juryAssignments CategoryJury[]

  @@unique([eventId, name])
}

model CategoryJury {
  categoryId String
  userId     String
  assignedAt DateTime @default(now())

  category Category @relation(fields: [categoryId], references: [id])
  user     User     @relation(fields: [userId], references: [id])

  @@id([categoryId, userId])
}

model Parameter {
  id          String      @id @default(cuid())
  categoryId  String
  name        String
  description String?
  weight      Float
  minScore    Float       @default(0)
  maxScore    Float       @default(100)
  scoringMode ScoringMode @default(AUTO)
  orderIndex  Int         @default(0)
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  category    Category     @relation(fields: [categoryId], references: [id])
  aiScores    AIScore[]
  juryScores  JuryScore[]
}

model Project {
  id              String      @id @default(cuid())
  categoryId      String
  url             String
  participantName String
  teamName        String?
  crawlStatus     CrawlStatus @default(PENDING)
  crawlError      String?
  scoreStatus     ScoreStatus @default(PENDING)
  finalScore      Float?
  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt

  category  Category      @relation(fields: [categoryId], references: [id])
  metadata  CrawlMetadata?
  aiScores  AIScore[]
  juryScores JuryScore[]
  auditLogs AuditLog[]

  @@unique([categoryId, url])
}

model CrawlMetadata {
  id           String   @id @default(cuid())
  projectId    String   @unique
  title        String?
  description  String?
  widgets      Json
  prompts      Json
  widgetCount  Int      @default(0)
  rawHtml      String?
  crawledAt    DateTime @default(now())

  project Project @relation(fields: [projectId], references: [id])
}

model AIScore {
  id          String   @id @default(cuid())
  projectId   String
  parameterId String
  score       Float
  reasoning   String
  scoredAt    DateTime @default(now())

  project   Project   @relation(fields: [projectId], references: [id])
  parameter Parameter @relation(fields: [parameterId], references: [id])

  @@unique([projectId, parameterId])
}

model JuryScore {
  id          String   @id @default(cuid())
  projectId   String
  parameterId String
  juryId      String
  score       Float
  comment     String?
  isOverride  Boolean  @default(false)
  scoredAt    DateTime @default(now())
  updatedAt   DateTime @updatedAt

  project   Project   @relation(fields: [projectId], references: [id])
  parameter Parameter @relation(fields: [parameterId], references: [id])

  @@unique([projectId, parameterId, juryId])
}

model AuditLog {
  id          String   @id @default(cuid())
  projectId   String
  userId      String
  parameterId String?
  action      String
  oldValue    Json?
  newValue    Json?
  createdAt   DateTime @default(now())

  project Project @relation(fields: [projectId], references: [id])
  user    User    @relation(fields: [userId], references: [id])
}

model ScoreOverride {
  id          String   @id @default(cuid())
  userId      String
  projectId   String
  parameterId String
  oldScore    Float
  newScore    Float
  comment     String
  createdAt   DateTime @default(now())

  user User @relation(fields: [userId], references: [id])
}
```

---

## Components and Interfaces

### 1. Authentication (NextAuth JWT)

```typescript
// lib/auth/config.ts
import { NextAuthConfig } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'

export const authConfig: NextAuthConfig = {
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        // Validate via Zod, then compare bcrypt hash
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.role = user.role
        token.id = user.id
      }
      return token
    },
    session({ session, token }) {
      session.user.role = token.role as Role
      session.user.id = token.id as string
      return session
    },
  },
  pages: {
    signIn: '/login',
  },
}
```

### 2. Zod Validation Schemas

```typescript
// lib/validators/schemas.ts
import { z } from 'zod'

export const EventSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
})

export const CategorySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  eventId: z.string().cuid(),
})

export const ParameterSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  weight: z.number().positive().max(100),
  minScore: z.number().min(0),
  maxScore: z.number().max(100),
  scoringMode: z.enum(['AUTO', 'MANUAL']),
})

export const ParameterSetSchema = z.array(ParameterSchema).refine(
  (params) => {
    const total = params.reduce((sum, p) => sum + p.weight, 0)
    return Math.abs(total - 100) < 0.001
  },
  { message: 'Total bobot parameter harus sama dengan 100%' },
)

export const SubmissionSchema = z.object({
  url: z.string().url().startsWith('https://partyrock.aws'),
  participantName: z.string().min(1).max(255),
  teamName: z.string().max(255).optional(),
  categoryId: z.string().cuid(),
})

export const JuryScoreSchema = z.object({
  score: z.number(),
  comment: z.string().optional(),
  projectId: z.string().cuid(),
  parameterId: z.string().cuid(),
})

export const CsvRowSchema = z.object({
  url: z.string().url().startsWith('https://partyrock.aws'),
  nama_peserta: z.string().min(1),
  nama_tim: z.string().optional(),
})
```

### 3. Crawler Service (Playwright)

```typescript
// lib/services/crawler.service.ts
import { chromium } from 'playwright'
import type { PartyRockMetadata } from '@/types'

export class CrawlerService {
  static async crawl(url: string): Promise<PartyRockMetadata> {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto(url, { timeout: 30_000, waitUntil: 'networkidle' })

      const title = await page.title()
      const description = await page
        .$eval('meta[name="description"]', (el) => el.getAttribute('content'))
        .catch(() => null)

      // Extract widgets: look for widget containers in PartyRock DOM
      const widgets = await page.evaluate(() => {
        const widgetEls = document.querySelectorAll('[data-widget-type]')
        return Array.from(widgetEls).map((el) => ({
          type: el.getAttribute('data-widget-type') ?? 'unknown',
          label: el.getAttribute('aria-label') ?? '',
        }))
      })

      // Extract prompts from textarea/input elements inside prompt widgets
      const prompts = await page.evaluate(() => {
        const promptEls = document.querySelectorAll(
          "[data-widget-type='ai'] textarea, [data-widget-type='ai'] [data-prompt]",
        )
        return Array.from(promptEls).map(
          (el) =>
            (el as HTMLTextAreaElement).value ||
            el.getAttribute('data-prompt') ||
            '',
        )
      })

      return {
        title,
        description,
        widgets,
        prompts,
        widgetCount: widgets.length,
      }
    } finally {
      await browser.close()
    }
  }
}
```

### 4. AI Scorer Service (AWS Bedrock)

```typescript
// lib/services/scorer.service.ts
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime'
import type {
  PartyRockMetadata,
  ScoringParameter,
  ScoringResult,
} from '@/types'

const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION })

export class ScorerService {
  static async scoreParameter(
    metadata: PartyRockMetadata,
    parameter: ScoringParameter,
    contextProjects: PartyRockMetadata[],
  ): Promise<ScoringResult> {
    const prompt = buildPrompt(metadata, parameter, contextProjects)
    const command = new InvokeModelCommand({
      modelId:
        process.env.BEDROCK_MODEL_ID ??
        'anthropic.claude-3-sonnet-20240229-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    const response = await bedrock.send(command)
    const parsed = JSON.parse(new TextDecoder().decode(response.body))
    return parseBedrockResponse(parsed, parameter)
  }
}

function buildPrompt(
  metadata: PartyRockMetadata,
  parameter: ScoringParameter,
  contextProjects: PartyRockMetadata[],
): string {
  return `
You are an AI judge evaluating PartyRock applications.

## Application to Evaluate
Title: ${metadata.title}
Description: ${metadata.description}
Widgets used: ${metadata.widgets.map((w) => w.type).join(', ')}
Widget count: ${metadata.widgetCount}
Prompts: ${metadata.prompts.join(' | ')}

## Evaluation Parameter
Parameter: ${parameter.name}
Description: ${parameter.description}
Score range: ${parameter.minScore} to ${parameter.maxScore}

## Other projects in category (for comparison)
${contextProjects.map((p) => `- ${p.title}: ${p.description}`).join('\n')}

Analyze this application on the parameter "${parameter.name}" using the appropriate method:
- Creativity & Originality: semantic similarity vs other projects
- Problem-Solution Fit: NLP extraction of problem-solution relevance
- Effective Use of PartyRock Features: widget complexity and diversity analysis
- User Experience & Presentation: description completeness and clarity
- Impact & Scalability: keyword and topic analysis

Return a JSON response:
{ "score": <number between ${parameter.minScore} and ${parameter.maxScore}>, "reasoning": "<explanation>" }
  `.trim()
}
```

### 5. Rate Limiting

```typescript
// lib/rate-limit.ts
import { LRUCache } from 'lru-cache'

type Options = {
  uniqueTokenPerInterval?: number
  interval?: number
}

export function rateLimit(options?: Options) {
  const tokenCache = new LRUCache<string, number[]>({
    max: options?.uniqueTokenPerInterval ?? 500,
    ttl: options?.interval ?? 60_000,
  })

  return {
    check: (limit: number, token: string) => {
      const timestamps = tokenCache.get(token) ?? []
      const now = Date.now()
      const windowStart = now - (options?.interval ?? 60_000)
      const recent = timestamps.filter((t) => t > windowStart)
      if (recent.length >= limit) {
        throw new Error('Rate limit exceeded')
      }
      tokenCache.set(token, [...recent, now])
    },
  }
}
```

### 6. Scoring Calculation

```typescript
// lib/services/leaderboard.service.ts

/**
 * Menghitung Skor Final tertimbang dari array skor per parameter.
 * Skor final = Σ (score_i * weight_i) / 100
 */
export function calculateWeightedScore(
  scores: { score: number; weight: number }[],
): number {
  if (scores.length === 0) return 0
  return scores.reduce(
    (sum, { score, weight }) => sum + (score * weight) / 100,
    0,
  )
}

/**
 * Menghitung rata-rata Skor Final dari beberapa juri.
 */
export function calculateAverageJuryScore(juryScores: number[]): number {
  if (juryScores.length === 0) return 0
  return juryScores.reduce((sum, s) => sum + s, 0) / juryScores.length
}
```

### 7. API Route Error Handler

```typescript
// lib/api-error.ts
import { NextResponse } from 'next/server'
import { ZodError } from 'zod'

export type ApiError = {
  error: string
  message: string
  code: string
}

export function handleApiError(error: unknown): NextResponse<ApiError> {
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: 'Validation Error',
        message: error.errors.map((e) => e.message).join(', '),
        code: 'VALIDATION_ERROR',
      },
      { status: 400 },
    )
  }
  if (error instanceof Error && error.message === 'Rate limit exceeded') {
    return NextResponse.json(
      {
        error: 'Too Many Requests',
        message: 'Melebihi batas 10 request per menit.',
        code: 'RATE_LIMIT_EXCEEDED',
      },
      { status: 429 },
    )
  }
  // Log full error server-side, return safe message to client
  console.error('[API Error]', error)
  return NextResponse.json(
    {
      error: 'Internal Server Error',
      message: 'Terjadi kesalahan pada server. Silakan coba lagi.',
      code: 'INTERNAL_ERROR',
    },
    { status: 500 },
  )
}
```

### 8. RBAC Middleware

```typescript
// middleware.ts
import { NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'

const ADMIN_PATHS = [
  '/admin',
  '/api/events',
  '/api/categories',
  '/api/parameters',
  '/api/users',
]

export async function middleware(request: NextRequest) {
  const token = await getToken({ req: request })

  // Unauthenticated: redirect to login
  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  // Jury trying to access admin-only paths
  const isAdminPath = ADMIN_PATHS.some((path) =>
    request.nextUrl.pathname.startsWith(path),
  )
  if (isAdminPath && token.role !== 'ADMIN') {
    return NextResponse.json(
      { error: 'Forbidden', message: 'Akses ditolak.', code: 'FORBIDDEN' },
      { status: 403 },
    )
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/admin/:path*', '/jury/:path*', '/api/:path*'],
}
```

### 9. CSV Bulk Upload Handler

```typescript
// lib/services/submission.service.ts (excerpt)
import { parse } from 'csv-parse/sync'
import { CsvRowSchema } from '@/lib/validators/schemas'

export type CsvImportResult = {
  imported: number
  errors: { row: number; message: string }[]
}

export async function bulkImportFromCsv(
  csvContent: string,
  categoryId: string,
): Promise<CsvImportResult> {
  const rows = parse(csvContent, { columns: true, skip_empty_lines: true })
  const errors: { row: number; message: string }[] = []
  let imported = 0

  for (let i = 0; i < rows.length; i++) {
    const parsed = CsvRowSchema.safeParse(rows[i])
    if (!parsed.success) {
      errors.push({ row: i + 2, message: parsed.error.errors[0].message })
      continue
    }
    // Insert valid row to DB (skip duplicates silently or report)
    imported++
  }

  return { imported, errors }
}
```

---

## Key Flows

### Flow 1: Submission → Crawl → AI Score

```
Admin/User submits URL
        │
        ▼
[SubmissionService] Validate URL domain (partyrock.aws)
        │ duplicate check
        ▼
[DB] Create Project (status: PENDING)
        │ async trigger
        ▼
[CrawlerService] Playwright crawl (timeout 30s)
        │ success            │ failure
        ▼                    ▼
[DB] Save CrawlMetadata   [DB] crawlStatus = FAILED
[DB] crawlStatus = SUCCESS
        │
        ▼
[ScorerService] AWS Bedrock — score each AUTO parameter
        │ success            │ partial/failure
        ▼                    ▼
[DB] Save AIScore[]        [DB] scoreStatus = PARTIAL/FAILED
[DB] scoreStatus = SUCCESS
[DB] Calculate & save finalScore (weighted sum)
```

### Flow 2: Jury Override

```
Jury opens project detail
        │
        ▼
[API] Fetch project + metadata + AI scores + existing jury scores
        │
        ▼
Jury inputs score per parameter
        │ score differs from AI score > 20% of range?
        │ YES → comment required (validated server-side via Zod)
        │ NO  → comment optional
        ▼
[JuryService] Validate score within [minScore, maxScore]
        │
        ▼
[DB] Upsert JuryScore
[DB] Create AuditLog (oldValue, newValue, userId, timestamp)
        │
        ▼
[LeaderboardService] Recalculate finalScore
        │  if 1 jury: finalScore = weightedSum(juryScores)
        │  if N jury: finalScore = avg(each jury's weightedSum)
        ▼
[DB] Update Project.finalScore
```

### Flow 3: Public Leaderboard

```
Admin activates "Publish" on category
        │
        ▼
[DB] category.isPublished = true, generate publicToken (UUID)
        │
        ▼
Public URL: /public/leaderboard/[publicToken]
        │ No auth required
        ▼
[RSC Page] Fetch leaderboard data via Prisma
[Display] Rank | Participant | URL | Final Score | Per-parameter breakdown
```

### Flow 4: Google Sheets Export & Auto-sync

```
Admin clicks "Export to Google Sheets" on leaderboard page
        │ inputs email(s) to share
        ▼
[API POST /api/sheets/[categoryId]]
        │ rate limit check (5/min)
        ▼
[SheetsService] Authenticate via service account
        │
        ▼
[Google Sheets API] Create new spreadsheet
        │
        ▼
[SheetsService] Write leaderboard data (header + rows)
        │
        ▼
[Google Drive API] Share to specified emails (role: writer)
        │
        ▼
[DB] Save spreadsheetId to category
        │
        ▼
Return spreadsheetUrl to Admin

--- Auto-sync (when enabled) ---

finalScore changes (via JuryService or ScorerService)
        │
        ▼
[triggerSheetSync] Check category.autoSync && spreadsheetId
        │ true
        ▼
[SheetsService] Clear existing data → write updated leaderboard
        │ error?
        ▼ (non-blocking: log error, don't interrupt scoring flow)
```

---

## Error Handling Strategy

| Scenario                       | Behavior                                                              |
| ------------------------------ | --------------------------------------------------------------------- |
| Zod validation failure         | HTTP 400, JSON `{error, message, code: "VALIDATION_ERROR"}`           |
| Unauthenticated request        | Redirect to /login (pages) or HTTP 401 (API)                          |
| Insufficient role              | HTTP 403, JSON `{error: "Forbidden", code: "FORBIDDEN"}`              |
| Duplicate URL in same category | HTTP 409, JSON `{code: "DUPLICATE_URL"}`                              |
| Crawl timeout (>30s)           | Project `crawlStatus = "FAILED"`, error message saved                 |
| AI scoring failure             | `scoreStatus = "PARTIAL"` or `"FAILED"`, per-parameter error recorded |
| Rate limit exceeded            | HTTP 429, JSON `{code: "RATE_LIMIT_EXCEEDED"}`                        |
| CSV invalid rows               | Partial import; error report lists row numbers with messages          |
| Delete category with projects  | HTTP 409, requires explicit confirmation with project migration       |
| Google Sheets auth failure     | HTTP 500, error message returned to Admin, logged server-side         |
| Google Sheets quota exceeded   | HTTP 429, informative message about quota limit                       |
| Sheets auto-sync failure       | Non-blocking: error logged, scoring flow continues uninterrupted      |
| Unhandled server error         | HTTP 500, generic message (no stack trace exposed), server-side log   |

---

## Default Assessment Parameters Template

Ketika Admin membuat kategori baru, sistem menawarkan opsi untuk memuat template 5 parameter default:

| Parameter                           | Default Weight | Scoring Mode | Analysis Method                        |
| ----------------------------------- | -------------- | ------------ | -------------------------------------- |
| Creativity & Originality            | 20%            | AUTO         | Semantic similarity vs other projects  |
| Problem-Solution Fit                | 25%            | AUTO         | NLP extraction — deskripsi vs masalah  |
| Effective Use of PartyRock Features | 20%            | AUTO         | Widget complexity & diversity analysis |
| User Experience & Presentation      | 20%            | AUTO         | Description completeness & clarity     |
| Impact & Scalability                | 15%            | AUTO         | Keyword & topic analysis               |

Total default weight: 100%. Admin dapat mengubah bobot, nama, deskripsi, atau mode penilaian setelah template dimuat.

---

## Leaderboard Real-time Strategy

Leaderboard menggunakan kombinasi:

1. **Server-side rendering (RSC)** untuk initial load — data di-fetch saat request
2. **Route segment revalidation** (`revalidatePath("/leaderboard/[categoryId]")`) dipanggil setiap kali `finalScore` project berubah
3. Untuk mode publik, halaman menggunakan `revalidate` time-based (setiap 30 detik) sebagai fallback

Tidak menggunakan WebSocket/SSE untuk menghindari kompleksitas infrastruktur serverless.

---

## Export Implementation

Export CSV/Excel menggunakan library `exceljs` (server-side only):

```typescript
// lib/services/export.service.ts
import ExcelJS from 'exceljs'
import type { ProjectWithScores } from '@/types'

export async function exportToExcel(
  projects: ProjectWithScores[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Penilaian')

  sheet.columns = [
    { header: 'Peringkat', key: 'rank', width: 10 },
    { header: 'Nama Peserta', key: 'participantName', width: 25 },
    { header: 'Tim', key: 'teamName', width: 20 },
    { header: 'URL Project', key: 'url', width: 40 },
    { header: 'Skor Final', key: 'finalScore', width: 12 },
    // Dynamic columns per parameter added at runtime
  ]

  projects.forEach((p, i) => {
    sheet.addRow({ rank: i + 1, ...p })
  })

  return workbook.xlsx.writeBuffer() as Promise<Buffer>
}
```

---

## Google Sheets Integration (SheetsService)

### 10. Sheets Service

```typescript
// lib/services/sheets.service.ts
import { google, sheets_v4 } from 'googleapis'
import type { ProjectWithScores } from '@/types'

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
]

export class SheetsService {
  private sheets: sheets_v4.Sheets
  private drive: ReturnType<typeof google.drive>

  constructor() {
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
      scopes: SCOPES,
    })
    this.sheets = google.sheets({ version: 'v4', auth })
    this.drive = google.drive({ version: 'v3', auth })
  }

  /**
   * Membuat spreadsheet baru dan mengisi data leaderboard.
   * Returns spreadsheetId dan spreadsheetUrl.
   */
  async createLeaderboardSheet(
    title: string,
    projects: ProjectWithScores[],
    parameterNames: string[],
  ): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> {
    const spreadsheet = await this.sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: [{ properties: { title: 'Leaderboard' } }],
      },
    })

    const spreadsheetId = spreadsheet.data.spreadsheetId!
    const spreadsheetUrl = spreadsheet.data.spreadsheetUrl!

    await this.writeLeaderboardData(spreadsheetId, projects, parameterNames)

    return { spreadsheetId, spreadsheetUrl }
  }

  /**
   * Share spreadsheet ke email tertentu dengan role writer.
   */
  async shareSpreadsheet(
    spreadsheetId: string,
    emails: string[],
  ): Promise<void> {
    for (const email of emails) {
      await this.drive.permissions.create({
        fileId: spreadsheetId,
        requestBody: {
          type: 'user',
          role: 'writer',
          emailAddress: email,
        },
        sendNotificationEmail: true,
      })
    }
  }

  /**
   * Update data di spreadsheet yang sudah ada (untuk auto-sync).
   * Clear sheet lalu tulis ulang seluruh data leaderboard.
   */
  async updateLeaderboardSheet(
    spreadsheetId: string,
    projects: ProjectWithScores[],
    parameterNames: string[],
  ): Promise<void> {
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: 'Leaderboard!A:ZZ',
    })
    await this.writeLeaderboardData(spreadsheetId, projects, parameterNames)
  }

  /**
   * Menulis data leaderboard ke sheet "Leaderboard".
   */
  private async writeLeaderboardData(
    spreadsheetId: string,
    projects: ProjectWithScores[],
    parameterNames: string[],
  ): Promise<void> {
    // Header row
    const headers = [
      'Peringkat',
      'Nama Peserta',
      'Tim',
      'URL Project',
      'Skor Final',
      ...parameterNames.flatMap((p) => [`${p} (AI)`, `${p} (Juri)`]),
      'Last Updated',
    ]

    // Data rows
    const rows = projects.map((project, index) => [
      index + 1,
      project.participantName,
      project.teamName ?? '',
      project.url,
      project.finalScore ?? '',
      ...parameterNames.flatMap((paramName) => {
        const paramScores = project.scores?.find(
          (s) => s.parameterName === paramName,
        )
        return [paramScores?.aiScore ?? '', paramScores?.juryScore ?? '']
      }),
      new Date().toISOString(),
    ])

    await this.sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Leaderboard!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [headers, ...rows] },
    })
  }
}
```

### Auto-sync Trigger

Auto-sync dipanggil dari `LeaderboardService` setiap kali `finalScore` berubah:

```typescript
// Dipanggil di jury.service.ts dan scorer.service.ts setelah recalculate finalScore
import { SheetsService } from './sheets.service'

async function triggerSheetSync(categoryId: string): Promise<void> {
  const category = await prisma.category.findUnique({
    where: { id: categoryId },
    select: { autoSync: true, spreadsheetId: true },
  })

  if (!category?.autoSync || !category.spreadsheetId) return

  try {
    const sheetsService = new SheetsService()
    const projects = await getLeaderboard(categoryId)
    const parameters = await prisma.parameter.findMany({
      where: { categoryId },
      orderBy: { orderIndex: 'asc' },
      select: { name: true },
    })
    await sheetsService.updateLeaderboardSheet(
      category.spreadsheetId,
      projects,
      parameters.map((p) => p.name),
    )
  } catch (error) {
    console.error('[Sheets Sync Error]', error)
    // Non-blocking: error tidak mengganggu alur penilaian utama
  }
}
```

### API Route

```typescript
// app/api/sheets/[categoryId]/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { SheetsService } from '@/lib/services/sheets.service'
import { getLeaderboard } from '@/lib/services/leaderboard.service'
import { handleApiError } from '@/lib/api-error'
import { rateLimit } from '@/lib/rate-limit'

const sheetsRateLimiter = rateLimit({
  interval: 60_000,
  uniqueTokenPerInterval: 100,
})

// POST: Create new spreadsheet & export leaderboard
export async function POST(
  req: NextRequest,
  { params }: { params: { categoryId: string } },
) {
  try {
    // Auth check (Admin only), rate limit (5/min)
    sheetsRateLimiter.check(5, `sheets_${session.user.id}`)

    const { emails } = await req.json() // Array of emails to share with
    const category = await prisma.category.findUnique({
      where: { id: params.categoryId },
      include: { event: true, parameters: { orderBy: { orderIndex: 'asc' } } },
    })

    const title = `${category.event.name} - ${category.name} - Leaderboard`
    const projects = await getLeaderboard(params.categoryId)
    const parameterNames = category.parameters.map((p) => p.name)

    const sheetsService = new SheetsService()
    const { spreadsheetId, spreadsheetUrl } =
      await sheetsService.createLeaderboardSheet(
        title,
        projects,
        parameterNames,
      )

    if (emails?.length) {
      await sheetsService.shareSpreadsheet(spreadsheetId, emails)
    }

    // Simpan spreadsheetId ke category
    await prisma.category.update({
      where: { id: params.categoryId },
      data: { spreadsheetId },
    })

    return NextResponse.json({ spreadsheetId, spreadsheetUrl })
  } catch (error) {
    return handleApiError(error)
  }
}

// PATCH: Toggle auto-sync dan/atau update sync email
export async function PATCH(
  req: NextRequest,
  { params }: { params: { categoryId: string } },
) {
  try {
    const { autoSync, syncEmail } = await req.json()
    await prisma.category.update({
      where: { id: params.categoryId },
      data: { autoSync, syncEmail },
    })
    return NextResponse.json({ success: true })
  } catch (error) {
    return handleApiError(error)
  }
}
```

---

## Correctness Properties

_A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees._

---

### Property 1: RBAC Access Control

_For any_ HTTP request to an Admin-only route, if the requesting user does not have the `ADMIN` role (including unauthenticated users), the system SHALL deny access — returning HTTP 403 (authenticated non-admin) or redirecting to login (unauthenticated).

**Validates: Requirements 1.1, 7.2, 7.3, 7.4**

---

### Property 2: Event Creation Round Trip

_For any_ valid event data object (name, optional description, optional dates), creating an event and then fetching it by its ID should return an object with equivalent field values.

**Validates: Requirements 1.2**

---

### Property 3: Category Name Uniqueness Within Event

_For any_ event, attempting to create two categories with the same name within that event should succeed on the first creation and fail with a uniqueness error on the second.

**Validates: Requirements 1.3**

---

### Property 4: Parameter Weight Sum Invariant

_For any_ set of parameters being saved to a category, the system SHALL accept the configuration if and only if the sum of all weights equals exactly 100% (within floating-point tolerance of 0.001). Any configuration with a total differing from 100% SHALL be rejected with an error message indicating the discrepancy.

**Validates: Requirements 2.2, 2.3**

---

### Property 5: URL Domain Validation

_For any_ submitted URL string, the system SHALL accept it if and only if the URL is well-formed and its domain starts with `partyrock.aws`. All other URLs SHALL be rejected with a validation error.

**Validates: Requirements 3.2**

---

### Property 6: Submission Duplicate Prevention

_For any_ category, submitting the same URL twice to that category should succeed on the first submission and return a duplicate error on the second, leaving the project count unchanged.

**Validates: Requirements 3.3**

---

### Property 7: CSV Bulk Import Partial Success

_For any_ CSV file containing a mix of valid and invalid rows, the system SHALL import all valid rows, reject all invalid rows, and report the exact row numbers (1-indexed from header) of each invalid row along with the reason for rejection.

**Validates: Requirements 3.4, 3.5**

---

### Property 8: Crawl Metadata Extraction Completeness

_For any_ successfully crawled PartyRock URL, the resulting `CrawlMetadata` object SHALL contain non-null values for `title`, a `widgets` array (possibly empty), a `prompts` array (possibly empty), and a `widgetCount` equal to `widgets.length`.

**Validates: Requirements 4.2, 4.5**

---

### Property 9: Crawl Re-trigger Overwrites Previous Data

_For any_ project that already has `CrawlMetadata` stored, triggering a re-crawl SHALL replace all fields in `CrawlMetadata` with the new crawl results and mark the project's `scoreStatus` as `PENDING` to indicate AI scoring needs to be rerun.

**Validates: Requirements 4.6**

---

### Property 10: AI Score Range Invariant

_For any_ parameter with a configured `[minScore, maxScore]` range and any `CrawlMetadata` input, the AI scorer SHALL produce a `score` value that falls within `[minScore, maxScore]` inclusive. If the raw Bedrock response returns an out-of-range value, the service SHALL clamp it to the nearest boundary and record a warning in reasoning.

**Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6**

---

### Property 11: Weighted Score Calculation

_For any_ non-empty array of `{score, weight}` pairs where all weights are positive and sum to 100, the calculated final score SHALL equal `Σ(score_i × weight_i) / 100`, and this value SHALL be deterministic — calling `calculateWeightedScore` with the same inputs always returns the same result.

**Validates: Requirements 5.9, 6.4**

---

### Property 12: Multi-Jury Average Final Score

_For any_ category with N jury members (N ≥ 1) who have each submitted scores for all parameters of a project, the project's `finalScore` SHALL equal the arithmetic mean of each jury member's individual weighted score, computed as `(Σ jury_k_finalScore) / N`.

**Validates: Requirements 6.7**

---

### Property 13: Jury Override Comment Requirement

_For any_ jury score override where `|newScore - aiScore| > 0.20 × (maxScore - minScore)`, the server SHALL reject the request if the `comment` field is absent or empty, returning a validation error that specifies the comment is required.

**Validates: Requirements 6.3**

---

### Property 14: Audit Trail Completeness

_For any_ jury score change (initial score or override), an `AuditLog` record SHALL be created containing: `projectId`, `userId`, `parameterId`, `oldValue` (null for initial scoring), `newValue`, and `createdAt` timestamp. The audit log SHALL be immutable — existing records cannot be updated or deleted.

**Validates: Requirements 6.6**

---

### Property 15: Jury Category Isolation

_For any_ jury user assigned to a subset of categories, API requests by that user to view or score projects in a category outside their assignment SHALL return HTTP 403, leaving the target project's scores unchanged.

**Validates: Requirements 7.6**

---

### Property 16: Leaderboard Sort Order

_For any_ category with two or more projects, the leaderboard SHALL return projects in strictly descending order of `finalScore`. For projects with equal `finalScore`, order is deterministic (e.g., by `createdAt` ascending). No project with a null `finalScore` SHALL appear ahead of a project with a non-null `finalScore`.

**Validates: Requirements 8.1**

---

### Property 17: Export Data Completeness

_For any_ category export, every project in the category SHALL appear as exactly one row in the exported file, and each row SHALL contain: participant name, team name, URL, final score, AI score per parameter, jury score per parameter, and any comments. No project data SHALL be omitted or duplicated.

**Validates: Requirements 8.3**

---

### Property 18: Public Leaderboard Access Control

_For any_ category, when `isPublished = true`, requests to `/public/leaderboard/[publicToken]` SHALL succeed without authentication. When `isPublished = false`, the same URL SHALL return HTTP 404. The `publicToken` SHALL be unique and unguessable (UUID v4 or equivalent).

**Validates: Requirements 8.5**

---

### Property 19: Input Validation Coverage

_For any_ API route that accepts user input, if the request body fails Zod schema validation, the system SHALL return HTTP 400 with a JSON body matching the structure `{error: string, message: string, code: "VALIDATION_ERROR"}`. No invalid data SHALL reach the database layer.

**Validates: Requirements 9.3, 9.5**

---

### Property 20: Rate Limiting Enforcement

_For any_ authenticated user making requests to crawling or AI scoring API routes, after 10 requests within a 60-second sliding window, every subsequent request within that window SHALL be rejected with HTTP 429 and `{code: "RATE_LIMIT_EXCEEDED"}`. The counter SHALL reset after the window expires.

**Validates: Requirements 9.6**

---

### Property 21: Google Sheets Export Data Integrity

_For any_ category exported to Google Sheets, the resulting spreadsheet SHALL contain exactly one header row and one data row per project in the category, with all projects ordered by descending `finalScore`. Each data row SHALL contain: rank, participant name, team name, URL, final score, AI score per parameter, and jury score per parameter. The spreadsheet title SHALL follow the format `[Event Name] - [Category Name] - Leaderboard`.

**Validates: Requirements 10.3, 10.5, 10.6**

---

### Property 22: Google Sheets Auto-sync Idempotency

_For any_ category with `autoSync = true` and an existing `spreadsheetId`, triggering a sync multiple times with the same underlying data SHALL result in the spreadsheet containing the same content after each sync — no duplicate rows, no missing data, and timestamp updated to reflect latest sync.

**Validates: Requirements 10.5, 10.6**
