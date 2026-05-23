import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUserId } from '@/lib/gmail/currentUser'

const VALID_CATEGORIES = [
  'all',
  'verification_code',
  'interview',
  'offer',
  'rejection',
  'application_confirm',
  'other',
] as const

type Category = typeof VALID_CATEGORIES[number]

function isCategory(v: string): v is Category {
  return (VALID_CATEGORIES as readonly string[]).includes(v)
}

export async function GET(req: NextRequest) {
  const userId = await getCurrentUserId()
  if (!userId) {
    return NextResponse.json({ connected: false, emails: [] })
  }

  const conn = await prisma.gmailConnection.findUnique({ where: { userId } })
  if (!conn || !conn.isActive) {
    return NextResponse.json({ connected: false, emails: [] })
  }

  const raw = req.nextUrl.searchParams.get('category') ?? 'all'
  const category: Category = isCategory(raw) ? raw : 'all'
  const limit = Math.min(100, Math.max(1, parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10)))

  const emails = await prisma.inboxEmail.findMany({
    where: {
      userId,
      ...(category === 'all' ? {} : { emailCategory: category }),
    },
    orderBy: { receivedAt: 'desc' },
    take: limit,
  })

  return NextResponse.json({
    connected: true,
    gmailAddress: conn.gmailAddress,
    emails: emails.map(e => ({
      id: e.id,
      gmailMessageId: e.gmailMessageId,
      from: e.fromAddress,
      fromName: e.fromName || e.fromAddress,
      subject: e.subject,
      snippet: e.snippet,
      body: e.fullBody,
      receivedAt: e.receivedAt.toISOString(),
      category: e.emailCategory,
      verificationCode: e.verificationCode,
      companyName: e.companyName,
      applicationId: e.applicationId,
      isRead: e.isRead,
    })),
  })
}
