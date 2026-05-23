// Lives at /api/auth/gmail/callback — must exactly match the redirect URI
// registered in Google Cloud Console and the GOOGLE_REDIRECT_URI env var.
// Default port is 3000 (next dev).
import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { exchangeCodeForTokens, saveConnection } from '@/lib/gmail/oauthClient'
import { getCurrentUserId } from '@/lib/gmail/currentUser'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const error = req.nextUrl.searchParams.get('error')

  const origin = req.nextUrl.origin

  if (error) {
    return NextResponse.redirect(`${origin}/profile?gmail=error&reason=${encodeURIComponent(error)}`)
  }
  if (!code) {
    return NextResponse.json({ error: 'Missing code parameter' }, { status: 400 })
  }

  try {
    const userId = await getCurrentUserId()
    if (!userId) {
      return NextResponse.json({ error: 'No user found — create a profile first' }, { status: 401 })
    }

    const { oauthClient, tokens } = await exchangeCodeForTokens(code)

    const gmail = google.gmail({ version: 'v1', auth: oauthClient })
    const profile = await gmail.users.getProfile({ userId: 'me' })
    const gmailAddress = profile.data.emailAddress ?? ''
    if (!gmailAddress) {
      return NextResponse.json({ error: 'Failed to read Gmail address from profile' }, { status: 500 })
    }

    await saveConnection({ userId, gmailAddress, tokens })

    return NextResponse.redirect(`${origin}/profile?gmail=connected`)
  } catch (err) {
    console.error('[GET /auth/gmail/callback]', err)
    return NextResponse.redirect(`${origin}/profile?gmail=error&reason=${encodeURIComponent('exchange_failed')}`)
  }
}
