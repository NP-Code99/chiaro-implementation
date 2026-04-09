import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { enqueue } from '@/lib/jobQueue'
import { ApplicationStatus } from '@prisma/client'

// Rate limiting: max 10 applications per minute per user
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

function isRateLimited(userId: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(userId)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + 60_000 })
    return false
  }
  if (entry.count >= 10) return true
  entry.count++
  return false
}

export async function GET() {
  try {
    const user = await prisma.user.findFirst()
    if (!user) return NextResponse.json({ applications: [] })

    const applications = await prisma.application.findMany({
      where: { userId: user.id },
      include: { job: true },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ applications })
  } catch (err) {
    console.error('[GET /api/applications]', err)
    return NextResponse.json({ error: 'Failed to load applications' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { jobId?: string; userId?: string; profileSnapshot?: string }
    const { jobId, userId, profileSnapshot } = body

    if (!jobId || !userId) {
      return NextResponse.json({ error: 'jobId and userId are required' }, { status: 400 })
    }

    if (isRateLimited(userId)) {
      return NextResponse.json({ error: 'Rate limit: max 10 applications per minute' }, { status: 429 })
    }

    // Idempotent
    const existing = await prisma.application.findUnique({
      where: { userId_jobId: { userId, jobId } },
    })
    if (existing) {
      return NextResponse.json({ application: existing, alreadyExists: true })
    }

    // Strip resumeBase64 before persisting — resume bytes must not sit in the applications table
    let safeSnapshot: string | null = null
    if (profileSnapshot) {
      try {
        const parsed = JSON.parse(profileSnapshot) as Record<string, unknown>
        const { resumeBase64: _, ...rest } = parsed
        safeSnapshot = JSON.stringify(rest)
      } catch {
        safeSnapshot = null
      }
    }

    const application = await prisma.application.create({
      data: {
        userId,
        jobId,
        status: ApplicationStatus.PENDING,
        profileSnapshot: safeSnapshot,
      },
    })

    enqueue(application.id)

    return NextResponse.json({ application }, { status: 201 })
  } catch (err) {
    console.error('[POST /api/applications]', err)
    return NextResponse.json({ error: 'Failed to create application' }, { status: 500 })
  }
}
