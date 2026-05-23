import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUserId } from '@/lib/gmail/currentUser'

export async function GET() {
  const userId = await getCurrentUserId()
  if (!userId) {
    return NextResponse.json({
      connected: false,
      gmailAddress: null,
      connectedAt: null,
      lastSyncedAt: null,
    })
  }

  const conn = await prisma.gmailConnection.findUnique({ where: { userId } })
  if (!conn || !conn.isActive) {
    return NextResponse.json({
      connected: false,
      gmailAddress: null,
      connectedAt: null,
      lastSyncedAt: null,
    })
  }

  return NextResponse.json({
    connected: true,
    gmailAddress: conn.gmailAddress,
    connectedAt: conn.connectedAt.toISOString(),
    lastSyncedAt: conn.lastSyncedAt?.toISOString() ?? null,
  })
}
