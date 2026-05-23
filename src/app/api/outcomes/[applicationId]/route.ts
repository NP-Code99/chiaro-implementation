import { NextRequest, NextResponse } from 'next/server'
import { getOutcomeDetail } from '@/lib/outcomeQueries'

// GET /api/outcomes/:applicationId — full outcome + field-level breakdown + steel session link
export async function GET(
  _req: NextRequest,
  { params }: { params: { applicationId: string } }
) {
  try {
    const outcome = await getOutcomeDetail(params.applicationId)
    if (!outcome) {
      return NextResponse.json({ success: false, error: 'No outcome recorded for this application' }, { status: 404 })
    }
    return NextResponse.json({ success: true, data: outcome })
  } catch (err) {
    console.error('[/api/outcomes/[applicationId]] Error:', err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
