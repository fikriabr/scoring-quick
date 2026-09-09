// app/api/capture/route.ts
// Receives PartyRock app data captured from a real browser session and stores
// it against the matching submitted project(s), then triggers AI scoring.
//
// Auth is by shared token (or admin session) rather than the session cookie —
// see lib/capture-auth.ts for why. CORS is open to the partyrock.aws origin so
// the in-page panel can post directly when Playwright is not in the loop.
// Requirements: 4.2, 4.5, 4.6, 5.1, 9.3, 9.5

export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { handleApiError } from '@/lib/api-error'
import { authorizeCapture, captureAuthErrorBody, CORS_HEADERS } from '@/lib/capture-auth'
import { ingestCapture, NoMatchingProjectError } from '@/lib/services/capture.service'

// -----------------------------------------------------------------------
// OPTIONS /api/capture — CORS preflight for the in-page capture panel
// -----------------------------------------------------------------------
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

// -----------------------------------------------------------------------
// POST /api/capture — ingest one captured app
// -----------------------------------------------------------------------
export async function POST(request: NextRequest) {
  try {
    const authResult = await authorizeCapture(request)
    if (!authResult.ok) {
      return NextResponse.json(captureAuthErrorBody(authResult.reason), {
        status: 401,
        headers: CORS_HEADERS,
      })
    }

    const body = await request.json()
    const result = await ingestCapture(body)

    return NextResponse.json(
      {
        ok: true,
        matched: result.matched,
        widgetCount: result.widgetCount,
        promptCount: result.promptCount,
        outputCount: result.outputCount,
        projects: result.projects.map((p) => ({
          id: p.id,
          participantName: p.participantName,
        })),
        message:
          `Capture stored for ${result.matched} project(s). AI scoring started.`,
      },
      { headers: CORS_HEADERS },
    )
  } catch (error) {
    if (error instanceof NoMatchingProjectError) {
      return NextResponse.json(
        { error: 'Not Found', message: error.message, code: error.code },
        { status: error.status, headers: CORS_HEADERS },
      )
    }

    const response = handleApiError(error)
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      response.headers.set(key, value)
    }
    return response
  }
}
