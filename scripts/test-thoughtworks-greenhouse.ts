/**
 * Thoughtworks Greenhouse form test
 * job-boards.greenhouse.io/thoughtworksreferral/jobs/7947134
 *
 * Run:
 *   npx tsx scripts/test-thoughtworks-greenhouse.ts
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { nanoid } from 'nanoid'

const RESUME_PATH = path.resolve(process.cwd(), 'public/uploads/resume-nandan-pullakandam.pdf')
const TARGET_URL = 'http://job-boards.greenhouse.io/thoughtworksreferral/jobs/7947134?utm_source=startup.jobs&utm_medium=organic'

async function main() {
  if (!fs.existsSync(RESUME_PATH)) {
    console.error(`Resume not found at ${RESUME_PATH}`)
    process.exit(1)
  }
  const resumeBytes = fs.readFileSync(RESUME_PATH)
  const resumeBase64 = `data:application/pdf;base64,${resumeBytes.toString('base64')}`
  console.log(`Resume loaded: ${Math.round(resumeBytes.length / 1024)}KB`)

  const profile = {
    firstName: 'Nandan',
    lastName: 'Pullakandam',
    email: 'nandanpu@unc.edu',
    phone: '9196600905',
    phoneCountryCode: '+1',
    linkedin: 'https://www.linkedin.com/in/nandan-pullakandam/',
    github: '',
    location: 'Charlotte, NC',
    workAuth: 'US Citizen' as const,
    yearsExp: '3-5' as const,
    desiredSalary: '130000',
    resumeBase64,
    resumeFilename: 'resume-nandan-pullakandam.pdf',
    bio: 'Full-stack software engineer with 4 years of experience building scalable web applications and AI-powered products. Strong background in TypeScript, React, Node.js, and cloud infrastructure. Passionate about clean code, agile development practices, and delivering software that makes a real impact.',
    applicationPassword: 'Chiaro99999999!',
    currentCompany: 'UNC Chapel Hill',
    currentTitle: 'Software Engineer',
    education: 'University of North Carolina, Chapel Hill, B.S. Computer Science',
    addressZip: '28201',
    gender: 'Prefer not to say' as const,
    ethnicity: 'Asian' as const,
    veteranStatus: 'I am not a protected veteran' as const,
    disabilityStatus: 'No, I do not have a disability' as const,
  }

  const { browserApply } = await import('../src/lib/browserApply')

  const applicationId = `tw-gh-test-${nanoid(8)}`
  console.log(`\nApplication ID: ${applicationId}`)
  console.log(`URL: ${TARGET_URL}`)
  console.log('Using CloakBrowser (Greenhouse → C++-patched browser)\n')

  const result = await browserApply(TARGET_URL, profile as any, applicationId)

  console.log('\n═══════════════════════════════')
  console.log('           RESULT')
  console.log('═══════════════════════════════')
  console.log('Status   :', result.status)
  console.log('Bypass   :', result.bypassMethod)
  if (result.errorMessage) console.log('Error    :', result.errorMessage)
  if ((result as any).skipReason) console.log('Skip     :', (result as any).skipReason)
  if (result.screenshotUrl) console.log('Screenshot:', result.screenshotUrl)
  if (result.preSubmitScreenshotUrl) console.log('Pre-submit:', result.preSubmitScreenshotUrl)
  console.log('═══════════════════════════════\n')
}

main().catch(e => { console.error(e); process.exit(1) })
