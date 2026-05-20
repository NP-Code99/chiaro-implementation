/**
 * Test Greenhouse centering + scroll-to-submit fixes on the Affect job board.
 * URL: https://job-boards.greenhouse.io/joinaffect/jobs/5225062008
 *
 * Run:
 *   npx tsx scripts/test-affect-greenhouse.ts
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { nanoid } from 'nanoid'

const RESUME_PATH = '/tmp/alex-rivera-test-resume.pdf'
const TARGET_URL = 'https://job-boards.greenhouse.io/joinaffect/jobs/5225062008?utm_source=startup.jobs&utm_medium=organic#application_form'

async function main() {
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
    location: 'Charlotte, NC',
    workAuth: 'US Citizen' as const,
    yearsExp: '3-5' as const,
    desiredSalary: '120000',
    resumeBase64,
    resumeFilename: 'alex-rivera-resume.pdf',
    bio: 'Full-stack software engineer with 4 years of experience building scalable web applications. Expertise in TypeScript, React, Node.js, PostgreSQL, and AWS.',
    applicationPassword: 'Chiaro2024!!',
  }

  const { browserApply } = await import('../src/lib/browserApply')

  const applicationId = `affect-gh-test-${nanoid(8)}`
  console.log(`\nApplication ID: ${applicationId}`)
  console.log(`URL: ${TARGET_URL}`)
  console.log('Testing: viewport centering (1366×768, deviceScaleFactor:1) + scroll-to-submit\n')

  const result = await browserApply(TARGET_URL, profile, applicationId)

  console.log('\n═══════════════════════════════')
  console.log('           RESULT')
  console.log('═══════════════════════════════')
  console.log('Status   :', result.status)
  console.log('Bypass   :', result.bypassMethod)
  if (result.errorMessage) console.log('Error    :', result.errorMessage)
  if (result.skipReason)   console.log('Skip     :', result.skipReason)
  if (result.screenshotUrl)        console.log('Screenshot (final)    :', result.screenshotUrl)
  if (result.preSubmitScreenshotUrl) console.log('Screenshot (pre-submit):', result.preSubmitScreenshotUrl)
  console.log('═══════════════════════════════\n')
}

main().catch(e => { console.error(e); process.exit(1) })
