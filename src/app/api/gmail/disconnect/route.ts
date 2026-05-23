import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUserId } from '@/lib/gmail/currentUser'

export async function POST() {
  const userId = await getCurrentUserId()
  if (!userId) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  await prisma.gmailConnection.updateMany({
    where: { userId },
    data: {
      isActive: false,
      accessToken: '',
      refreshToken: '',
    },
  })

  return NextResponse.json({ success: true })
}
