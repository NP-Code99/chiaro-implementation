import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { fetchStartupJobs } from '@/lib/startupJobs'
import type { FetchStartupJobsParams } from '@/lib/startupJobs'

// POST /api/jobs/sync
// Body: optional FetchStartupJobsParams (maxResults)
// Returns: { upserted: number, skipped: number }
export async function POST(req: NextRequest) {
  try {
    let params: FetchStartupJobsParams = {}
    try {
      params = (await req.json()) as FetchStartupJobsParams
    } catch {
      // No body — use defaults
    }

    const jobs = await fetchStartupJobs(params)

    if (jobs.length === 0) {
      return NextResponse.json({ upserted: 0, skipped: 0 })
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

    return NextResponse.json({ upserted: upserted.length, skipped: 0 })
  } catch (err) {
    console.error('[POST /api/jobs/sync]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Sync failed' },
      { status: 500 }
    )
  }
}
