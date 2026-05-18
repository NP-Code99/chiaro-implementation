import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

async function main() {
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  const jobs = await prisma.job.findMany({
    take: 30,
    orderBy: { createdAt: 'desc' },
    where: { atsType: 'CUSTOM' },
    select: { id: true, company: true, role: true, applyUrl: true }
  })
  jobs.forEach(j => console.log(`${j.id} | ${j.company} | ${j.role} | ${j.applyUrl}`))
  await prisma.$disconnect()
}
main().catch(console.error)
