import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { syncGmailInbox } from '@/lib/gmail/inboxSync'

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret')
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const connections = await prisma.gmailConnection.findMany({
    where: { isActive: true },
    select: { userId: true, gmailAddress: true },
  })

  const results: Array<{ userId: string; gmailAddress: string; ok: boolean; error?: string; newEmails?: number }> = []

  for (const c of connections) {
    try {
      const r = await syncGmailInbox(c.userId)
      results.push({ userId: c.userId, gmailAddress: c.gmailAddress, ok: true, newEmails: r.newEmails })
    } catch (err) {
      results.push({
        userId: c.userId,
        gmailAddress: c.gmailAddress,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return NextResponse.json({ ran: connections.length, results })
}

export const GET = POST
