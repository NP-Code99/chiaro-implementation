import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { PrismaClient } from '@prisma/client'
import { fetchWellfoundJobs } from '../src/lib/wellfound'

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding database...')

  // Upsert default user — preserves any existing profile data
  const user = await prisma.user.upsert({
    where: { email: 'demo@chiaro.app' },
    update: {},
    create: {
      name: 'Demo User',
      email: 'demo@chiaro.app',
      phone: '+1 (415) 555-0100',
      linkedinUrl: 'https://linkedin.com/in/demo-user',
      githubUrl: 'https://github.com/demo-user',
      location: 'San Francisco, CA',
    },
  })
  console.log(`Created user: ${user.email}`)

  // Fetch real jobs from Wellfound via Apify scraper BEFORE clearing DB
  // This way, if the scraper fails (quota exceeded, network error), existing DB jobs are preserved
  console.log('Fetching jobs from Wellfound...')
  let jobs: Awaited<ReturnType<typeof fetchWellfoundJobs>> = []
  try {
    jobs = await fetchWellfoundJobs({ maxResults: 60 })
  } catch (err) {
    console.warn('Wellfound fetch threw error:', err instanceof Error ? err.message : String(err))
  }

  if (jobs.length === 0) {
    console.warn('No jobs returned from Wellfound — check WELLFOUND_API_KEY / APIFY_API_KEY')
    console.warn('Possible cause: daily run quota exceeded (10 runs/day on free tier)')
    console.warn('Preserving existing DB jobs — skipping clear/reload')
    const existingCount = await prisma.job.count()
    console.log(`DB currently has ${existingCount} jobs`)
  } else {
    // Only clear stale jobs once we have fresh data to replace them with
    await prisma.application.deleteMany()
    await prisma.job.deleteMany()
    console.log('Cleared existing jobs and applications')

    for (const j of jobs) {
      await prisma.job.upsert({
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
          tags: JSON.stringify(j.tags ?? []),
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
          tags: JSON.stringify(j.tags ?? []),
          logoUrl: j.logoUrl,
        },
      })
    }
    console.log(`Seeded ${jobs.length} real jobs from Wellfound`)
  }

  console.log('Done!')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
