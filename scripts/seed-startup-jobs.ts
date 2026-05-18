/**
 * Seed the database with jobs from Startup.jobs via Apify.
 * Run: npx tsx scripts/seed-startup-jobs.ts
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

async function main() {
  const { fetchStartupJobs } = await import('../src/lib/startupJobs')
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()

  console.log('Fetching jobs from Startup.jobs via Apify (max 60)...')
  const jobs = await fetchStartupJobs({ maxResults: 60 })
  console.log(`Fetched ${jobs.length} jobs`)

  if (jobs.length === 0) {
    console.error('No jobs returned — check STARTUP_JOBS_API_KEY')
    await prisma.$disconnect()
    process.exit(1)
  }

  let created = 0
  let updated = 0

  for (const j of jobs) {
    const result = await prisma.job.upsert({
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
    if (result.createdAt.getTime() === result.createdAt.getTime()) created++
    else updated++
  }

  const total = await prisma.job.count({ where: { source: 'startup.jobs' } })
  console.log(`\nDone. DB now has ${total} startup.jobs jobs.`)

  // Show ATS breakdown
  const allJobs = await prisma.job.findMany({
    where: { source: 'startup.jobs' },
    select: { atsType: true },
  })
  const atsCounts: Record<string, number> = {}
  for (const j of allJobs) {
    atsCounts[j.atsType] = (atsCounts[j.atsType] || 0) + 1
  }
  console.log('\nATS breakdown:')
  Object.entries(atsCounts)
    .sort((a, b) => b[1] - a[1])
    .forEach(([ats, count]) => console.log(`  ${ats}: ${count}`))

  await prisma.$disconnect()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
