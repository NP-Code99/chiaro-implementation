import { NextResponse } from 'next/server'
import { createOAuthClient, getAuthUrl } from '@/lib/gmail/oauthClient'

export async function GET() {
  try {
    const oauthClient = createOAuthClient()
    const authUrl = getAuthUrl(oauthClient)
    return NextResponse.json({ authUrl })
  } catch (err) {
    console.error('[GET /api/auth/gmail/connect]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to build auth URL' },
      { status: 500 },
    )
  }
}
