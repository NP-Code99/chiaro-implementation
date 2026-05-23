import { NextResponse } from 'next/server'
import { markEmailRead } from '@/lib/gmail/inboxSync'
import { getCurrentUserId } from '@/lib/gmail/currentUser'

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const userId = await getCurrentUserId()
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const ok = await markEmailRead(userId, params.id)
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 })
}
