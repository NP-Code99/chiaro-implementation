import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { fetchWellfoundJobs } from '@/lib/wellfound'
import type { FetchWellfoundParams } from '@/types/wellfound'

// POST /api/jobs/sync
// Body: optional FetchWellfoundParams (searchQuery, location, remote, maxResults)
// Returns: { upserted: number, skipped: number }
export async function POST(req: NextRequest) {
  try {
    let params: FetchWellfoundParams = {}
    try {
      params = await req.json() as FetchWellfoundParams
    } catch {
      // No body — use defaults
    }

    const jobs = await fetchWellfoundJobs(params)

    if (jobs.length === 0) {
      return NextResponse.json({ upserted: 0, skipped: 0 })
    }

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

    return NextResponse.json({ upserted: upserted.length, skipped: 0 })
  } catch (err) {
    console.error('[POST /api/jobs/sync]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Sync failed' },
      { status: 500 }
    )
  }
}
