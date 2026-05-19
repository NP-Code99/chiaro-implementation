/**
 * Single-URL apply test. Run:
 *   npx tsx scripts/test-single-apply.ts
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { nanoid } from 'nanoid'

const TEST_URL = 'https://startup.jobs/apply/060b1813-29ab-433a-9cd7-711646841fd7'

import * as fs from 'fs'
const resumePath = '/Users/nandanpullakandam/Nandan_Pullakandam_Resume.pdf'
const resumeBase64 = fs.existsSync(resumePath)
  ? fs.readFileSync(resumePath).toString('base64')
  : ''

const profile = {
  firstName: 'Nandan',
  lastName: 'Pullakandam',
  email: 'nandan.pullakandam12@gmail.com',
  phone: '7046251688',
  phoneCountryCode: '+1',
  linkedin: 'https://www.linkedin.com/in/nandan-pullakandam',
  github: 'https://github.com/NP-Code99',
  location: 'Charlotte, NC',
  workAuth: 'US Citizen' as const,
  yearsExp: '1-3' as const,
  desiredSalary: '100000',
  resumeBase64,
  resumeFilename: 'Nandan_Pullakandam_Resume.pdf',
  bio: "Software engineer with experience in TypeScript, Python, React, Next.js, and Node.js. Strong background in building full-stack applications and automation systems.",
  applicationPassword: 'Chiaro10346488!',
  wellfoundCookies: '',
  gender: 'Male' as const,
  ethnicity: 'Asian' as const,
  veteranStatus: 'I am not a protected veteran' as const,
  disabilityStatus: 'No, I do not have a disability' as const,
}

async function main() {
  // Dynamic import so dotenv has time to run before modules throw on missing env vars
  const { browserApply } = await import('../src/lib/browserApply')

  const applicationId = `test-single-${nanoid(8)}`
  console.log(`Application ID: ${applicationId}`)
  console.log(`URL: ${TEST_URL}`)
  console.log('Using: Steel.dev (solveCaptcha:true) for native startup.jobs form\n')

  const result = await browserApply(TEST_URL, profile, applicationId)

  console.log('\n=== RESULT ===')
  console.log('Status:', result.status)
  console.log('Bypass:', result.bypassMethod)
  if (result.errorMessage) console.log('Error:', result.errorMessage)
  if (result.skipReason) console.log('Skip reason:', result.skipReason)
}

main().catch(e => { console.error(e); process.exit(1) })
