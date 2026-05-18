/**
 * 6-job test run — pulls jobs directly from the database and runs browserApply
 * against each one sequentially with skip logic for broken postings.
 * Run: npx tsx scripts/run-apply.ts
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const USER_ID = 'cmnv07pn600001th78yn0qng6'

const profile = {
  firstName: 'Nandan',
  lastName: 'Pullakandam',
  email: 'nandan.pullakandam12@gmail.com',
  phone: '17046251688',
  linkedin: 'www.linkedin.com/in/nandan-pullakandam',
  github: '',
  location: 'Charlotte, NC',
  workAuth: 'US Citizen' as const,
  yearsExp: '1-3' as const,
  desiredSalary: '100000',
  resumeBase64: '',
  resumeFilename: '',
  bio: "Hello, I'm Nandan. Applying to jobs",
  applicationPassword: 'Chiaro10346488!',
  wellfoundCookies: '',
}

async function main() {
  const { PrismaClient } = await import('@prisma/client')
  const { browserApply } = await import('../src/lib/browserApply')
  const prisma = new PrismaClient()

  // ── Part 1: Pull up to 6 jobs from database ─────────────────────────────────
  const testJobs = await prisma.job.findMany({
    where: {
      applyUrl: { not: '' },
      status: { not: 'skipped' },
    },
    orderBy: { createdAt: 'desc' },
    take: 6,
  })

  if (testJobs.length === 0) {
    console.log('No jobs found in database. Swipe right on some jobs first.')
    await prisma.$disconnect()
    return
  }

  if (testJobs.length < 6) {
    console.log(`Only ${testJobs.length} job(s) found in database — running with ${testJobs.length} jobs`)
  }

  console.log('\n=== TEST JOBS SELECTED FROM DATABASE ===')
  testJobs.forEach((job, i) => {
    console.log(`Job ${i + 1}: ${job.company} | ${job.role} | ${job.atsType} | ${job.applyUrl}`)
  })
  console.log('=========================================\n')

  type SummaryEntry = {
    role: string
    company: string
    status: string
    skipped: boolean
    skipCode?: string
    error?: string
    steel?: string
  }

  const summary: SummaryEntry[] = []

  for (let i = 0; i < testJobs.length; i++) {
    const job = testJobs[i]

    console.log('\n' + '═'.repeat(60))
    console.log(`TEST ${i + 1}/${testJobs.length} — ${job.company} | ${job.role}`)
    console.log(`URL: ${job.applyUrl}`)
    console.log('═'.repeat(60))

    // Upsert application (reset status so it re-runs)
    const app = await prisma.application.upsert({
      where: { userId_jobId: { userId: USER_ID, jobId: job.id } },
      update: { status: 'PENDING', errorMessage: null, errorCode: null },
      create: {
        userId: USER_ID,
        jobId: job.id,
        status: 'PENDING',
        profileSnapshot: JSON.stringify(profile),
      },
    })

    console.log(`Application ID: ${app.id}`)
    console.log('Connecting to Steel — watch https://app.steel.dev/sessions for live view...\n')

    const result = await browserApply(job.applyUrl, profile, app.id)

    const finalStatus =
      result.status === 'applied' ? 'APPLIED' :
      result.status === 'needs_review' ? 'NEEDS_REVIEW' : 'FAILED'

    await prisma.application.update({
      where: { id: app.id },
      data: {
        status: finalStatus,
        errorMessage: (result.errorMessage as string | undefined) ?? null,
        appliedAt: result.status === 'applied' ? new Date() : null,
        bypassMethod: (result.bypassMethod as string | undefined) ?? null,
        errorCode: result.skipReason ?? null,
      },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const final = await prisma.application.findUnique({ where: { id: app.id } })
    const steelId = (final as any)?.steelSessionId as string | undefined

    const isSkipped = result.skipped === true

    console.log(`\nRESULT: ${finalStatus}${isSkipped ? ' (SKIPPED — broken posting)' : ''}`)
    if (result.errorMessage) console.log(`MSG:    ${result.errorMessage}`)
    if (steelId)             console.log(`Steel:  https://app.steel.dev/sessions/${steelId}`)
    if (!isSkipped)          console.log(`Bypass: ${(result.bypassMethod as string | undefined) ?? 'unknown'}`)

    summary.push({
      role: job.role,
      company: job.company,
      status: finalStatus,
      skipped: isSkipped,
      skipCode: result.skipReason,
      error: result.errorMessage as string | undefined,
      steel: steelId,
    })

    if (i < testJobs.length - 1) {
      console.log('\nWaiting 8s before next job...')
      await new Promise(res => setTimeout(res, 8000))
    }
  }

  // ── Summary output ───────────────────────────────────────────────────────────
  const total   = summary.length
  const applied = summary.filter(r => r.status === 'APPLIED').length
  const review  = summary.filter(r => r.status === 'NEEDS_REVIEW' && !r.skipped).length
  const skipped = summary.filter(r => r.skipped).length
  const failed  = summary.filter(r => r.status === 'FAILED').length
  const skippedJobs = summary.filter(r => r.skipped)

  const W = 47
  const pad = (str: string, width: number) => str.padEnd(width)

  console.log('\n╔' + '═'.repeat(W) + '╗')
  console.log(`║${pad(`         ${total}-JOB TEST RUN COMPLETE`, W)}║`)
  console.log('╠' + '═'.repeat(W) + '╣')
  console.log(`║${pad(`  Applied successfully:    ${applied}/${total}`, W)}║`)
  console.log(`║${pad(`  Needs review:            ${review}/${total}`, W)}║`)
  console.log(`║${pad(`  Skipped (broken post):   ${skipped}/${total}`, W)}║`)
  console.log(`║${pad(`  Failed (error/timeout):  ${failed}/${total}`, W)}║`)

  if (skippedJobs.length > 0) {
    console.log('╠' + '═'.repeat(W) + '╣')
    console.log(`║${pad('  SKIPPED JOBS:', W)}║`)
    for (const r of skippedJobs) {
      const line = `  ${r.company} — ${r.skipCode ?? '??'}: ${(r.error ?? '').slice(0, W - 8)}`
      console.log(`║${pad(line, W)}║`)
    }
  }

  console.log('╠' + '═'.repeat(W) + '╣')
  console.log(`║${pad('  Screenshots: public/screenshots/', W)}║`)
  console.log('╚' + '═'.repeat(W) + '╝')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
