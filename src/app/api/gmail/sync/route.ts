import { NextResponse } from 'next/server'
import { syncGmailInbox } from '@/lib/gmail/inboxSync'
import { getCurrentUserId } from '@/lib/gmail/currentUser'

export async function POST() {
  const userId = await getCurrentUserId()
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  try {
    const result = await syncGmailInbox(userId)
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    console.error('[POST /api/gmail/sync]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Sync failed' },
      { status: 500 },
    )
  }
}
