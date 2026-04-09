import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { fetchWellfoundJobs } from '@/lib/wellfound'

const DEFAULT_USER_ID = 'demo-user'
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

let cachedJobIds: string[] | null = null
let cacheExpiresAt = 0

async function warmCacheIfStale(): Promise<void> {
  if (cachedJobIds && Date.now() < cacheExpiresAt) return

  try {
    const jobs = await fetchWellfoundJobs({ maxResults: 60 })

    // Upsert into DB using wellfoundId as stable key
    const upserts = jobs.map(j =>
      prisma.job.upsert({
        where: { id: j.wellfoundId },
        update: {
          company: j.company,
          role: j.role,
          description: j.description,
          applyUrl: j.applyUrl,
          atsType: j.atsType,
          location: j.location,
          salaryMin: j.salaryMin,
          salaryMax: j.salaryMax,
          tags: j.tags,
          logoUrl: j.logoUrl,
        },
        create: {
          id: j.wellfoundId,
          company: j.company,
          role: j.role,
          description: j.description,
          applyUrl: j.applyUrl,
          atsType: j.atsType,
          location: j.location,
          salaryMin: j.salaryMin,
          salaryMax: j.salaryMax,
          tags: j.tags,
          logoUrl: j.logoUrl,
        },
      })
    )

    const upserted = await prisma.$transaction(upserts)
    cachedJobIds = upserted.map(j => j.id)
    cacheExpiresAt = Date.now() + CACHE_TTL_MS
  } catch (err) {
    console.error('[jobs/route] Wellfound fetch failed, serving DB data:', err)
    // Don't update cache — fall through to DB query below
  }
}

export async function GET() {
  try {
    // Get or create demo user
    let user = await prisma.user.findFirst()
    if (!user) {
      user = await prisma.user.create({
        data: {
          id: DEFAULT_USER_ID,
          name: 'Demo User',
          email: 'demo@chiaro.app',
        },
      })
    }

    // Try to warm the Wellfound cache (no-op if still fresh)
    await warmCacheIfStale()

    // Return jobs the user hasn't applied to or skipped
    const appliedJobIds = await prisma.application.findMany({
      where: { userId: user.id },
      select: { jobId: true },
    })
    const appliedIds = appliedJobIds.map((a) => a.jobId)

    const jobs = await prisma.job.findMany({
      where: { id: { notIn: appliedIds } },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ jobs, userId: user.id })
  } catch (err) {
    console.error('[GET /api/jobs]', err)
    return NextResponse.json({ error: 'Failed to load jobs' }, { status: 500 })
  }
}
