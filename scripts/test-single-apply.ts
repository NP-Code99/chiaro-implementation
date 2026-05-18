/**
 * Single-URL apply test. Run:
 *   npx tsx scripts/test-single-apply.ts
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { nanoid } from 'nanoid'

const TEST_URL = 'https://startup.jobs/apply/74f8158e-5a95-4ff1-be84-1fb13d3c010d'

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
