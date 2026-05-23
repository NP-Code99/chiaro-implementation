import { NextRequest, NextResponse } from 'next/server'
import {
  getAtsSummaryStats,
  getFieldFailureRates,
  getRecentOutcomes,
  getOverallSummary,
} from '@/lib/outcomeQueries'

// GET /api/outcomes?view=summary|ats|fields|recent&since=<ISO>&atsType=<str>&limit=<n>&offset=<n>
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl
    const view = searchParams.get('view') ?? 'summary'
    const sinceParam = searchParams.get('since')
    const since = sinceParam ? new Date(sinceParam) : undefined
    const atsType = searchParams.get('atsType') ?? undefined
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 200)
    const offset = parseInt(searchParams.get('offset') ?? '0', 10)

    if (view === 'summary') {
      const data = await getOverallSummary(since)
      return NextResponse.json({ success: true, data })
    }

    if (view === 'ats') {
      const data = await getAtsSummaryStats(since)
      return NextResponse.json({ success: true, data })
    }

    if (view === 'fields') {
      const data = await getFieldFailureRates(atsType, limit)
      return NextResponse.json({ success: true, data })
    }

    if (view === 'recent') {
      const data = await getRecentOutcomes(limit, offset)
      return NextResponse.json({ success: true, data })
    }

    return NextResponse.json({ success: false, error: 'Unknown view. Use: summary | ats | fields | recent' }, { status: 400 })
  } catch (err) {
    console.error('[/api/outcomes] Error:', err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
