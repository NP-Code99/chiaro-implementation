import { NextRequest, NextResponse } from 'next/server'
import { markMessageRead } from '@/lib/gmail'

export async function POST(req: NextRequest) {
  const body = await req.json() as { messageId?: string }
  const { messageId } = body

  if (!messageId || typeof messageId !== 'string') {
    return NextResponse.json({ error: 'messageId required' }, { status: 400 })
  }

  const ok = await markMessageRead(messageId)
  return NextResponse.json({ ok }, { status: ok ? 200 : 500 })
}
