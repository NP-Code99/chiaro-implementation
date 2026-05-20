/**
 * Test Greenhouse fill on HiddenLayer.
 * Run: npx tsx scripts/test-hiddenlayer-greenhouse.ts
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })
import { nanoid } from 'nanoid'

const RESUME_PATH = '/tmp/alex-rivera-test-resume.pdf'
const TARGET_URL = 'https://job-boards.greenhouse.io/hiddenlayer/jobs/5141513007?utm_source=startup.jobs&utm_medium=organic'

async function main() {
  if (!fs.existsSync(RESUME_PATH)) { console.error('No resume'); process.exit(1) }
  const resumeBase64 = `data:application/pdf;base64,${fs.readFileSync(RESUME_PATH).toString('base64')}`

  const profile = {
    firstName: 'Alex', lastName: 'Rivera',
    email: 'alex.rivera.chiaro.test@gmail.com', phone: '4155550192',
    linkedin: 'https://linkedin.com/in/alexrivera-test',
    github: 'https://github.com/alexrivera-test',
    location: 'Charlotte, NC', workAuth: 'US Citizen' as const,
    yearsExp: '3-5' as const, desiredSalary: '120000',
    resumeBase64, resumeFilename: 'alex-rivera-resume.pdf',
    bio: 'Full-stack software engineer with 4 years of experience in TypeScript, React, Node.js, and AWS. Built and shipped production systems serving 100k+ users.',
    applicationPassword: 'Chiaro2024!!',
  }

  const { browserApply } = await import('../src/lib/browserApply')
  const applicationId = `hl-test-${nanoid(8)}`
  console.log(`\nID: ${applicationId}\nURL: ${TARGET_URL}\n`)

  const result = await browserApply(TARGET_URL, profile, applicationId)

  console.log('\n═══════════════════════════════')
  console.log('Status   :', result.status)
  console.log('Bypass   :', result.bypassMethod)
  if (result.errorMessage) console.log('Error    :', result.errorMessage)
  if (result.screenshotUrl) console.log('Screenshot:', result.screenshotUrl)
  if (result.preSubmitScreenshotUrl) console.log('Pre-submit:', result.preSubmitScreenshotUrl)
  console.log('═══════════════════════════════\n')
}
main().catch(e => { console.error(e); process.exit(1) })
