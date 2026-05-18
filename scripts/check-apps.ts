import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

async function main() {
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  const apps = await prisma.application.findMany({
    include: { job: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  for (const a of apps) {
    console.log(`[${a.status}] ${a.job.company} | ${a.job.role} | errorCode=${a.errorCode ?? 'none'} | ${a.job.applyUrl}`)
  }
  await prisma.$disconnect()
}
main().catch(console.error)
