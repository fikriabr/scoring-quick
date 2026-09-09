// app/api/export/[categoryId]/route.ts
// Export leaderboard data for a category as Excel or CSV.
// Admin-only endpoint.
// Requirements: 8.3

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth/config'
import { handleApiError } from '@/lib/api-error'
import { getLeaderboard } from '@/lib/services/leaderboard.service'
import { exportToExcel, exportToCsv } from '@/lib/services/export.service'

// -----------------------------------------------------------------------
// GET /api/export/[categoryId]?format=excel|csv
// Exports the leaderboard for the specified category.
// Query param `format`: "excel" for XLSX, anything else defaults to CSV.
// -----------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ categoryId: string }> },
) {
  try {
    const session = await auth()
    if (!session || session.user.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Forbidden', message: 'Admin only', code: 'FORBIDDEN' },
        { status: 403 },
      )
    }

    const { categoryId } = await params
    const format = request.nextUrl.searchParams.get('format') ?? 'csv'

    const projects = await getLeaderboard(categoryId)

    if (format === 'excel') {
      const buffer = await exportToExcel(projects)
      return new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition':
            'attachment; filename="leaderboard.xlsx"',
        },
      })
    }

    // Default: CSV
    const csv = exportToCsv(projects)
    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="leaderboard.csv"',
      },
    })
  } catch (error) {
    return handleApiError(error)
  }
}
