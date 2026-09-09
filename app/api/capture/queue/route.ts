// app/api/capture/queue/route.ts
// Lists the submitted projects that the Playwright navigator should visit.
//
// `scripts/partyrock-navigate.js` calls this to build its worklist, so the
// operator never has to maintain a URL file by hand.
// Requirements: 4.1, 4.3

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { handleApiError } from '@/lib/api-error'
import { authorizeCapture, captureAuthErrorBody, CORS_HEADERS } from '@/lib/capture-auth'

// -----------------------------------------------------------------------
// GET /api/capture/queue?categoryId=...&pending=1
//
//   categoryId  restrict to one category
//   pending=1   only projects with no captured widget data yet — the usual
//               case on a second pass, so finished apps are not re-opened
// -----------------------------------------------------------------------
export async function GET(request: NextRequest) {
  try {
    const authResult = await authorizeCapture(request)
    if (!authResult.ok) {
      return NextResponse.json(captureAuthErrorBody(authResult.reason), {
        status: 401,
        headers: CORS_HEADERS,
      })
    }

    const categoryId = request.nextUrl.searchParams.get('categoryId')
    const pendingOnly = request.nextUrl.searchParams.get('pending') === '1'

    const projects = await db.project.findMany({
      where: categoryId ? { categoryId } : {},
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        url: true,
        participantName: true,
        teamName: true,
        crawlStatus: true,
        scoreStatus: true,
        category: { select: { id: true, name: true } },
        metadata: { select: { widgetCount: true, crawledAt: true } },
      },
    })

    const rows = projects.map((p) => ({
      id: p.id,
      url: p.url,
      participantName: p.participantName,
      teamName: p.teamName,
      categoryId: p.category.id,
      categoryName: p.category.name,
      crawlStatus: p.crawlStatus,
      scoreStatus: p.scoreStatus,
      // "Captured" means widget data is present — a title-only HTTP crawl
      // leaves widgetCount at 0 and still needs a human pass.
      captured: (p.metadata?.widgetCount ?? 0) > 0,
      capturedAt: p.metadata?.crawledAt ?? null,
    }))

    const filtered = pendingOnly ? rows.filter((r) => !r.captured) : rows

    return NextResponse.json(
      { total: rows.length, pending: rows.filter((r) => !r.captured).length, projects: filtered },
      { headers: CORS_HEADERS },
    )
  } catch (error) {
    return handleApiError(error)
  }
}
