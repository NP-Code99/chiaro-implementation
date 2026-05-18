import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

async function main() {
  const { fetchWellfoundJobs } = await import('../src/lib/wellfound')
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()

  console.log('Fetching jobs from Apify/Wellfound (max 10)...')
  const jobs = await fetchWellfoundJobs({ maxResults: 10 })
  console.log(`Fetched ${jobs.length} jobs`)

  for (const j of jobs) {
    await prisma.job.upsert({
      where: { id: j.wellfoundId },
      update: {
        company: j.company, role: j.role, applyUrl: j.applyUrl,
        description: j.description, atsType: j.atsType, location: j.location,
        salaryMin: j.salaryMin, salaryMax: j.salaryMax,
        tags: JSON.stringify(j.tags), logoUrl: j.logoUrl,
      },
      create: {
        id: j.wellfoundId, company: j.company, role: j.role, applyUrl: j.applyUrl,
        description: j.description, atsType: j.atsType, location: j.location,
        salaryMin: j.salaryMin, salaryMax: j.salaryMax,
        tags: JSON.stringify(j.tags), logoUrl: j.logoUrl,
      },
    })
  }

  const sample = await prisma.job.findFirst({
    where: { applyUrl: { not: '' } },
    select: { company: true, role: true, applyUrl: true },
    orderBy: { createdAt: 'desc' },
  })
  console.log(`\nSample job: ${sample?.company} — ${sample?.role}`)
  console.log(`Apply URL:  ${sample?.applyUrl}`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
