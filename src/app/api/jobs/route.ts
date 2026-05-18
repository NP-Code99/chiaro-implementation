import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { fetchStartupJobs } from '@/lib/startupJobs'

const DEFAULT_USER_ID = 'demo-user'
// 2 hours — keeps daily Apify runs well under quota
const CACHE_TTL_MS = 2 * 60 * 60 * 1000

let cachedJobIds: string[] | null = null
let cacheExpiresAt = 0
let refreshing = false

// Fire-and-forget — never blocks the response
function refreshInBackground(): void {
  if (refreshing || (cachedJobIds && Date.now() < cacheExpiresAt)) return
  refreshing = true

  void (async () => {
    try {
      const jobs = await fetchStartupJobs({ maxResults: 60 })

      if (jobs.length === 0) {
        console.warn('[jobs/route] Startup.jobs returned 0 jobs — quota may be exceeded, retrying in 1h')
        cacheExpiresAt = Date.now() + 60 * 60 * 1000
        return
      }

      const upserts = jobs.map(j =>
        prisma.job.upsert({
          where: { sourceUrl: j.sourceUrl },
          update: {
            company:     j.company,
            role:        j.role,
            description: j.description,
            applyUrl:    j.applyUrl,
            atsType:     j.atsType,
            location:    j.location,
            salaryMin:   j.salaryMin,
            salaryMax:   j.salaryMax,
            tags:        JSON.stringify(j.tags ?? []),
            logoUrl:     j.logoUrl,
          },
          create: {
            company:     j.company,
            role:        j.role,
            description: j.description,
            applyUrl:    j.applyUrl,
            atsType:     j.atsType,
            location:    j.location,
            salaryMin:   j.salaryMin,
            salaryMax:   j.salaryMax,
            tags:        JSON.stringify(j.tags ?? []),
            logoUrl:     j.logoUrl,
            source:      j.source,
            sourceUrl:   j.sourceUrl,
          },
        })
      )

      const upserted = await prisma.$transaction(upserts)
      cachedJobIds = upserted.map(j => j.id)
      cacheExpiresAt = Date.now() + CACHE_TTL_MS
      console.log(`[jobs/route] Background refresh done — ${upserted.length} jobs upserted`)
    } catch (err) {
      console.error('[jobs/route] Background refresh failed:', err)
    } finally {
      refreshing = false
    }
  })()
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

    // Kick off background refresh if cache is stale — never blocks the response
    refreshInBackground()

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
