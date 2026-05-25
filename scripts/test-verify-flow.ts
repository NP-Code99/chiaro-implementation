/**
 * End-to-end test for the Greenhouse email-verification flow.
 *
 * Creates a real Job + Application row so the new VERIFICATION_PENDING path
 * (browserApply → poll Application.verificationCode) works. While the script
 * is running, paste the code into the dashboard banner — the apply flow will
 * pick it up within ~5s, fill the 8 boxes, and click Submit application.
 *
 * Run:
 *   npx tsx scripts/test-verify-flow.ts
 *
 * Override the URL:
 *   APPLY_URL='https://job-boards.eu.greenhouse.io/nice/jobs/4817745101?gh_jid=4817745101' npx tsx scripts/test-verify-flow.ts
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const USER_ID = process.env.TEST_USER_ID ?? 'cmnv07pn600001th78yn0qng6'
const APPLY_URL = process.env.APPLY_URL ?? 'https://job-boards.eu.greenhouse.io/nice/jobs/4817745101?gh_jid=4817745101&utm_source=startup.jobs&utm_medium=organic'
const RESUME_PATH = process.env.RESUME_PATH ?? '/tmp/alex-rivera-test-resume.pdf'

async function main() {
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  const { browserApply } = await import('../src/lib/browserApply')

  const resumeBase64 = fs.existsSync(RESUME_PATH)
    ? `data:application/pdf;base64,${fs.readFileSync(RESUME_PATH).toString('base64')}`
    : ''

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
    resumeBase64,
    resumeFilename: resumeBase64 ? 'resume.pdf' : '',
    bio: "Hello, I'm Nandan. Applying to jobs",
    applicationPassword: 'Chiaro10346488!',
    wellfoundCookies: '',
  }

  // Create or reuse a Job row matching this URL so we can attach an Application.
  let job = await prisma.job.findFirst({ where: { applyUrl: APPLY_URL } })
  if (!job) {
    job = await prisma.job.create({
      data: {
        company: 'NICE',
        role: 'Software Engineer (verify-flow test)',
        description: 'Test job for end-to-end verification flow',
        applyUrl: APPLY_URL,
        atsType: 'GREENHOUSE',
        location: 'Remote',
        source: 'startup.jobs',
        sourceUrl: APPLY_URL,
      },
    })
    console.log(`[setup] Created Job ${job.id}`)
  } else {
    console.log(`[setup] Reusing Job ${job.id}`)
  }

  // Fresh Application row each run so status transitions are clean.
  const existing = await prisma.application.findUnique({
    where: { userId_jobId: { userId: USER_ID, jobId: job.id } },
  })
  if (existing) {
    await prisma.application.update({
      where: { id: existing.id },
      data: {
        status: 'APPLYING',
        verificationCode: null,
        verificationExpiry: null,
        errorMessage: null,
        errorCode: null,
      },
    })
  }
  const application = existing ?? await prisma.application.create({
    data: { userId: USER_ID, jobId: job.id, status: 'APPLYING' },
  })

  console.log(`\n═══════════════════════════════`)
  console.log(`Application ID: ${application.id}`)
  console.log(`URL           : ${APPLY_URL}`)
  console.log(`Dashboard     : http://localhost:3000  (paste code in the blue banner when it appears)`)
  console.log(`═══════════════════════════════\n`)

  const result = await browserApply(APPLY_URL, profile, application.id)

  console.log('\n═══════════════════════════════')
  console.log('           RESULT')
  console.log('═══════════════════════════════')
  console.log('Status   :', result.status)
  console.log('Bypass   :', result.bypassMethod)
  if (result.errorMessage) console.log('Error    :', result.errorMessage)
  if (result.skipReason)   console.log('Skip     :', result.skipReason)
  if (result.screenshotUrl) console.log('Screenshot:', result.screenshotUrl)
  console.log('═══════════════════════════════\n')

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
