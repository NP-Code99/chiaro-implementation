/**
 * Trakstar ATS apply test.
 * Tests two Trakstar job postings — one from Ocient, one from Xideral.
 * Both use reCAPTCHA v3 (standard, not Enterprise) with the same sitekey.
 *
 * Run:
 *   npx tsx scripts/test-trakstar-single.ts
 *   npx tsx scripts/test-trakstar-single.ts xideral
 *
 * Watch live at: https://app.steel.dev/sessions
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { nanoid } from 'nanoid'

const RESUME_PATH = '/tmp/alex-rivera-test-resume.pdf'

const JOBS: Record<string, string> = {
  ocient: 'https://ocient.hire.trakstar.com/jobs/fk0z25t/?apply=true&utm_source=startup.jobs&utm_medium=organic',
  xideral: 'https://xideral.hire.trakstar.com/jobs/fk0z2kq/?apply=true&utm_source=startup.jobs&utm_medium=organic',
}

async function main() {
  const target = process.argv[2] ?? 'ocient'
  const targetUrl = JOBS[target]
  if (!targetUrl) {
    console.error(`Unknown target "${target}". Choose: ${Object.keys(JOBS).join(', ')}`)
    process.exit(1)
  }

  // Load resume
  if (!fs.existsSync(RESUME_PATH)) {
    console.error(`Resume not found at ${RESUME_PATH}. Run: npx tsx scripts/generate-test-resume.ts`)
    process.exit(1)
  }
  const resumeBytes = fs.readFileSync(RESUME_PATH)
  const resumeBase64 = `data:application/pdf;base64,${resumeBytes.toString('base64')}`
  console.log(`Resume loaded: ${Math.round(resumeBytes.length / 1024)}KB`)

  const profile = {
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

  const { browserApply } = await import('../src/lib/browserApply')

  const applicationId = `trakstar-test-${nanoid(8)}`
  console.log(`\nTarget     : ${target}`)
  console.log(`Application: ${applicationId}`)
  console.log(`URL        : ${targetUrl}`)
  console.log('Watch live : https://app.steel.dev/sessions\n')

  const result = await browserApply(targetUrl, profile, applicationId)

  console.log('\n═══════════════════════════════')
  console.log('           RESULT')
  console.log('═══════════════════════════════')
  console.log('Status   :', result.status)
  console.log('Bypass   :', result.bypassMethod)
  if (result.errorMessage) console.log('Error    :', result.errorMessage)
  if (result.skipReason)   console.log('Skip     :', result.skipReason)
  if (result.screenshotUrl) console.log('Screenshot:', result.screenshotUrl)
  console.log('═══════════════════════════════\n')
}

main().catch(e => { console.error(e); process.exit(1) })
