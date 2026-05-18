/**
 * 10-job end-to-end test against startup.jobs postings.
 * Uses mock profile "Alex Rivera" and calls browserApply for each job.
 *
 * Run: npx tsx scripts/test-10-jobs.ts
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'
import type { Job } from '@prisma/client'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

// ── Mock user profile ─────────────────────────────────────────────────────────

const RESUME_PATH = '/tmp/alex-rivera-test-resume.pdf'
const TEST_USER_ID = 'test-alex-rivera-e2e-001'
const OUTPUT_DIR = path.join(process.cwd(), 'public', '10-job-test-run')

// ── Error / fix log types ─────────────────────────────────────────────────────

interface ErrorLog {
  jobNumber: number
  company: string
  role: string
  atsType: string
  applyUrl: string
  step: string
  errorType: string
  errorMessage: string
  errorStack?: string
  pageUrl?: string
  timestamp: string
  fixAttempted?: string
  fixSucceeded?: boolean
}

interface JobResult {
  jobNumber: number
  company: string
  role: string
  atsType: string
  applyUrl: string
  status: 'applied' | 'needs_review' | 'failed' | 'skipped'
  errorMessage?: string
  skipReason?: string
  bypassMethod?: string
  steelSessionId?: string
  durationMs: number
  errors: ErrorLog[]
}

const allErrors: ErrorLog[] = []
const jobResults: JobResult[] = []

function logError(error: Omit<ErrorLog, 'timestamp'>) {
  const entry: ErrorLog = { ...error, timestamp: new Date().toISOString() }
  allErrors.push(entry)
  console.error('╔═══════════════════════════════════════════════════╗')
  console.error(`║ ERROR — Job ${error.jobNumber}: ${error.company}`.padEnd(52) + '║')
  console.error(`║ Step: ${error.step}`.padEnd(52) + '║')
  console.error(`║ Type: ${error.errorType}`.padEnd(52) + '║')
  const msg = error.errorMessage.slice(0, 44)
  console.error(`║ Msg:  ${msg}`.padEnd(52) + '║')
  console.error('╚═══════════════════════════════════════════════════╝')
  return entry
}

// ── Job diversity selector ────────────────────────────────────────────────────

function selectDiverseJobs(jobs: Job[], count: number): Job[] {
  const byAts: Record<string, Job[]> = {}
  for (const j of jobs) {
    if (!byAts[j.atsType]) byAts[j.atsType] = []
    byAts[j.atsType].push(j)
  }
  const selected: Job[] = []
  const atsTypes = Object.keys(byAts)
  let i = 0
  while (selected.length < count && i < 200) {
    const atsType = atsTypes[i % atsTypes.length]
    if (byAts[atsType] && byAts[atsType].length > 0) {
      selected.push(byAts[atsType].shift()!)
    }
    i++
  }
  return selected
}

// ── MASTER-REPORT writer ──────────────────────────────────────────────────────

function writeMasterReport(startedAt: Date) {
  const total = jobResults.length
  const applied = jobResults.filter(r => r.status === 'applied').length
  const needsReview = jobResults.filter(r => r.status === 'needs_review').length
  const failed = jobResults.filter(r => r.status === 'failed').length
  const skipped = jobResults.filter(r => r.status === 'skipped').length
  const durationMin = ((Date.now() - startedAt.getTime()) / 60000).toFixed(1)

  const lines: string[] = [
    '# 10-Job E2E Test Run — MASTER REPORT',
    '',
    `**Date:** ${startedAt.toISOString().split('T')[0]}`,
    `**Started:** ${startedAt.toISOString()}`,
    `**Duration:** ${durationMin} minutes`,
    `**Mock User:** Alex Rivera (alex.rivera.chiaro.test@gmail.com)`,
    '',
    '## Summary',
    '',
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Total jobs tested | ${total} |`,
    `| Applied successfully | ${applied} |`,
    `| Needs review | ${needsReview} |`,
    `| Failed | ${failed} |`,
    `| Skipped (broken posting) | ${skipped} |`,
    `| Total errors logged | ${allErrors.length} |`,
    '',
    '## Job-by-Job Results',
    '',
  ]

  for (const r of jobResults) {
    const icon = r.status === 'applied' ? '✅' : r.status === 'needs_review' ? '⚠️' : r.status === 'skipped' ? '⏭️' : '❌'
    lines.push(`### Job ${r.jobNumber}: ${r.company} ${icon}`)
    lines.push('')
    lines.push(`- **Role:** ${r.role}`)
    lines.push(`- **ATS:** ${r.atsType}`)
    lines.push(`- **URL:** ${r.applyUrl}`)
    lines.push(`- **Status:** \`${r.status.toUpperCase()}\``)
    lines.push(`- **Duration:** ${(r.durationMs / 1000).toFixed(1)}s`)
    if (r.bypassMethod) lines.push(`- **Bypass:** ${r.bypassMethod}`)
    if (r.steelSessionId) lines.push(`- **Steel session:** https://app.steel.dev/sessions/${r.steelSessionId}`)
    if (r.errorMessage) lines.push(`- **Error:** ${r.errorMessage}`)
    if (r.skipReason) lines.push(`- **Skip reason:** ${r.skipReason}`)
    if (r.errors.length > 0) {
      lines.push('')
      lines.push('**Errors logged:**')
      for (const e of r.errors) {
        lines.push(`- \`[${e.step}]\` ${e.errorType}: ${e.errorMessage.slice(0, 120)}`)
      }
    }
    lines.push('')
  }

  if (allErrors.length > 0) {
    lines.push('## All Errors (Chronological)')
    lines.push('')
    for (const e of allErrors) {
      lines.push(`### ${e.timestamp} — Job ${e.jobNumber} (${e.company})`)
      lines.push(`- **Step:** ${e.step}`)
      lines.push(`- **Type:** ${e.errorType}`)
      lines.push(`- **Message:** ${e.errorMessage}`)
      if (e.fixAttempted) lines.push(`- **Fix attempted:** ${e.fixAttempted}`)
      if (e.fixSucceeded !== undefined) lines.push(`- **Fix succeeded:** ${e.fixSucceeded}`)
      lines.push('')
    }
  }

  lines.push('## ATS Coverage')
  lines.push('')
  const atsCounts: Record<string, number> = {}
  for (const r of jobResults) {
    atsCounts[r.atsType] = (atsCounts[r.atsType] || 0) + 1
  }
  for (const [ats, count] of Object.entries(atsCounts)) {
    lines.push(`- **${ats}:** ${count} job(s)`)
  }

  const reportPath = path.join(OUTPUT_DIR, 'MASTER-REPORT.md')
  fs.writeFileSync(reportPath, lines.join('\n'))
  console.log(`\nMASTER-REPORT written → ${reportPath}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { PrismaClient } = await import('@prisma/client')
  const { browserApply } = await import('../src/lib/browserApply')
  const prisma = new PrismaClient()

  const startedAt = new Date()

  // ── 1. Load resume as base64 ─────────────────────────────────────────────────

  if (!fs.existsSync(RESUME_PATH)) {
    console.error(`Resume not found at ${RESUME_PATH}. Run: npx tsx scripts/generate-test-resume.ts`)
    await prisma.$disconnect()
    process.exit(1)
  }

  const resumeBytes = fs.readFileSync(RESUME_PATH)
  const resumeBase64 = `data:application/pdf;base64,${resumeBytes.toString('base64')}`
  console.log(`Resume loaded: ${Math.round(resumeBytes.length / 1024)}KB`)

  // ── 2. Mock profile ──────────────────────────────────────────────────────────

  const mockProfile = {
    firstName: 'Alex',
    lastName: 'Rivera',
    email: 'alex.rivera.chiaro.test@gmail.com',
    phone: '4155550192',
    linkedin: 'https://linkedin.com/in/alexrivera-test',
    github: 'https://github.com/alexrivera-test',
    location: 'San Francisco, CA',
    workAuth: 'US Citizen' as const,
    yearsExp: '3-5' as const,
    desiredSalary: '130000',
    resumeBase64,
    resumeFilename: 'alex-rivera-resume.pdf',
    bio: 'Full-stack software engineer with 4 years of experience building scalable web applications. Expertise in TypeScript, React, Node.js, PostgreSQL, and AWS. Passionate about clean architecture and developer tooling.',
    applicationPassword: 'Chiaro2024!!',
  }

  // ── 3. Query jobs from DB ────────────────────────────────────────────────────

  const allJobs = await prisma.job.findMany({
    where: {
      source: 'startup.jobs',
      applyUrl: { not: '' },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  if (allJobs.length === 0) {
    console.error('No startup.jobs found in DB. Run: npx tsx scripts/seed-startup-jobs.ts')
    await prisma.$disconnect()
    process.exit(1)
  }

  const selectedJobs = selectDiverseJobs(allJobs, 10)

  console.log('\n' + '═'.repeat(60))
  console.log('10 TEST JOBS SELECTED')
  console.log('═'.repeat(60))
  selectedJobs.forEach((job, i) => {
    console.log(`Job ${i + 1}: ${job.company}`)
    console.log(`  Role: ${job.role}`)
    console.log(`  ATS:  ${job.atsType}`)
    console.log(`  URL:  ${job.applyUrl}`)
    console.log('─'.repeat(60))
  })

  // ── 4. Ensure output dirs exist ──────────────────────────────────────────────

  fs.mkdirSync(OUTPUT_DIR, { recursive: true })

  // ── 5. Run each job ──────────────────────────────────────────────────────────

  for (let i = 0; i < selectedJobs.length; i++) {
    const job = selectedJobs[i]
    const jobNum = i + 1
    const safeName = job.company.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 30)
    const jobDir = path.join(OUTPUT_DIR, `job-${String(jobNum).padStart(2, '0')}-${safeName}`)
    fs.mkdirSync(jobDir, { recursive: true })

    const jobErrors: ErrorLog[] = []

    console.log('\n' + '═'.repeat(60))
    console.log(`JOB ${jobNum}/10: ${job.company} — ${job.role}`)
    console.log(`ATS:  ${job.atsType}`)
    console.log(`URL:  ${job.applyUrl}`)
    console.log('═'.repeat(60))

    // Upsert application record
    let app: { id: string }
    try {
      app = await prisma.application.upsert({
        where: { userId_jobId: { userId: TEST_USER_ID, jobId: job.id } },
        update: { status: 'PENDING', errorMessage: null, errorCode: null },
        create: {
          userId: TEST_USER_ID,
          jobId: job.id,
          status: 'PENDING',
          profileSnapshot: JSON.stringify(mockProfile),
        },
      })
      console.log(`Application ID: ${app.id}`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const logged = logError({
        jobNumber: jobNum,
        company: job.company,
        role: job.role,
        atsType: job.atsType,
        applyUrl: job.applyUrl ?? '',
        step: 'DB_UPSERT',
        errorType: 'DB_ERROR',
        errorMessage: msg,
        errorStack: err instanceof Error ? err.stack : undefined,
      })
      jobErrors.push(logged)
      jobResults.push({
        jobNumber: jobNum,
        company: job.company,
        role: job.role,
        atsType: job.atsType,
        applyUrl: job.applyUrl ?? '',
        status: 'failed',
        errorMessage: msg,
        durationMs: 0,
        errors: jobErrors,
      })
      continue
    }

    console.log('Connecting to Steel — watch https://app.steel.dev/sessions for live view...\n')

    const t0 = Date.now()
    let result: Awaited<ReturnType<typeof browserApply>>

    try {
      result = await browserApply(job.applyUrl ?? '', mockProfile, app.id)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const logged = logError({
        jobNumber: jobNum,
        company: job.company,
        role: job.role,
        atsType: job.atsType,
        applyUrl: job.applyUrl ?? '',
        step: 'BROWSER_APPLY',
        errorType: err instanceof Error ? err.constructor.name : 'UnknownError',
        errorMessage: msg,
        errorStack: err instanceof Error ? err.stack : undefined,
      })
      jobErrors.push(logged)

      const durationMs = Date.now() - t0

      await prisma.application.update({
        where: { id: app.id },
        data: { status: 'FAILED', errorMessage: msg },
      }).catch(() => {})

      jobResults.push({
        jobNumber: jobNum,
        company: job.company,
        role: job.role,
        atsType: job.atsType,
        applyUrl: job.applyUrl ?? '',
        status: 'failed',
        errorMessage: msg,
        durationMs,
        errors: jobErrors,
      })

      if (i < selectedJobs.length - 1) {
        console.log('\nWaiting 6s before next job...')
        await new Promise(r => setTimeout(r, 6000))
      }
      continue
    }

    const durationMs = Date.now() - t0

    // Map result to DB status
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
    }).catch(() => {})

    // Retrieve steel session ID if stored on application row
    const finalApp = await prisma.application.findUnique({ where: { id: app.id } }).catch(() => null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const steelSessionId = (finalApp as any)?.steelSessionId as string | undefined

    // Log an error entry for non-applied results
    if (result.status !== 'applied') {
      const isSkipped = result.skipped === true
      const logged = logError({
        jobNumber: jobNum,
        company: job.company,
        role: job.role,
        atsType: job.atsType,
        applyUrl: job.applyUrl ?? '',
        step: isSkipped ? 'SKIP_CHECK' : 'APPLY_RESULT',
        errorType: isSkipped ? 'SKIPPED_POSTING' : result.status === 'needs_review' ? 'NEEDS_REVIEW' : 'APPLY_FAILED',
        errorMessage: (result.errorMessage as string | undefined) ?? result.status,
      })
      jobErrors.push(logged)
    }

    const jobStatus: JobResult['status'] =
      result.skipped === true ? 'skipped' :
      result.status === 'applied' ? 'applied' :
      result.status === 'needs_review' ? 'needs_review' : 'failed'

    const statusLabel =
      jobStatus === 'applied' ? '✅ APPLIED' :
      jobStatus === 'needs_review' ? '⚠️  NEEDS_REVIEW' :
      jobStatus === 'skipped' ? '⏭️  SKIPPED' : '❌ FAILED'

    console.log(`\nRESULT: ${statusLabel}  (${(durationMs / 1000).toFixed(1)}s)`)
    if (result.errorMessage) console.log(`MSG:    ${result.errorMessage}`)
    if (steelSessionId) console.log(`Steel:  https://app.steel.dev/sessions/${steelSessionId}`)

    jobResults.push({
      jobNumber: jobNum,
      company: job.company,
      role: job.role,
      atsType: job.atsType,
      applyUrl: job.applyUrl ?? '',
      status: jobStatus,
      errorMessage: result.errorMessage as string | undefined,
      skipReason: result.skipReason,
      bypassMethod: result.bypassMethod as string | undefined,
      steelSessionId,
      durationMs,
      errors: jobErrors,
    })

    // Write per-job JSON log
    const jobLog = {
      job: { id: job.id, company: job.company, role: job.role, atsType: job.atsType, applyUrl: job.applyUrl },
      applicationId: app.id,
      result: { status: jobStatus, errorMessage: result.errorMessage, bypassMethod: result.bypassMethod, durationMs },
      errors: jobErrors,
    }
    fs.writeFileSync(path.join(jobDir, 'result.json'), JSON.stringify(jobLog, null, 2))

    if (i < selectedJobs.length - 1) {
      console.log('\nWaiting 6s before next job...')
      await new Promise(r => setTimeout(r, 6000))
    }
  }

  // ── 6. Print console summary ─────────────────────────────────────────────────

  const total = jobResults.length
  const applied = jobResults.filter(r => r.status === 'applied').length
  const review = jobResults.filter(r => r.status === 'needs_review').length
  const skipped = jobResults.filter(r => r.status === 'skipped').length
  const failed = jobResults.filter(r => r.status === 'failed').length

  const W = 52
  console.log('\n╔' + '═'.repeat(W) + '╗')
  console.log(`║${'  10-JOB TEST RUN COMPLETE'.padEnd(W)}║`)
  console.log('╠' + '═'.repeat(W) + '╣')
  console.log(`║${'  Applied successfully:     ' + applied + '/' + total}`.padEnd(W + 1) + '║')
  console.log(`║${'  Needs review:             ' + review + '/' + total}`.padEnd(W + 1) + '║')
  console.log(`║${'  Skipped (broken posting): ' + skipped + '/' + total}`.padEnd(W + 1) + '║')
  console.log(`║${'  Failed (error):           ' + failed + '/' + total}`.padEnd(W + 1) + '║')
  console.log(`║${'  Total errors logged:      ' + allErrors.length}`.padEnd(W + 1) + '║')
  console.log('╠' + '═'.repeat(W) + '╣')
  console.log(`║${'  Report: public/10-job-test-run/MASTER-REPORT.md'.padEnd(W)}║`)
  console.log('╚' + '═'.repeat(W) + '╝')

  // ── 7. Write MASTER-REPORT.md ────────────────────────────────────────────────

  writeMasterReport(startedAt)

  await prisma.$disconnect()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
