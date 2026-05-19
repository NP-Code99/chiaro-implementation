/**
 * Greenhouse ATS test script.
 * Route: CloakBrowser (stealth Chromium) + CapSolver reCAPTCHA Enterprise
 *
 * Run:
 *   npx @dotenvx/dotenvx run -- npx tsx scripts/test-greenhouse.ts [url]
 *
 * Default URL is a Greenhouse job board. Pass any greenhouse.io URL as arg.
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { nanoid } from 'nanoid'
import * as fs from 'fs'

// Pass URL as CLI arg or use defaults
const TEST_URLS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'https://job-boards.greenhouse.io/natera/jobs/5995914004',
      'https://job-boards.greenhouse.io/mitratech/jobs/7939974',
    ]

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
  const { browserApply } = await import('../src/lib/browserApply')

  for (const url of TEST_URLS) {
    const applicationId = `test-greenhouse-${nanoid(8)}`
    console.log(`\n${'='.repeat(60)}`)
    console.log(`Application ID: ${applicationId}`)
    console.log(`URL: ${url}`)
    console.log('ATS: Greenhouse → CloakBrowser + CapSolver reCAPTCHA Enterprise')
    console.log('='.repeat(60))

    const result = await browserApply(url, profile, applicationId)

    console.log('\n=== RESULT ===')
    console.log('Status:', result.status)
    console.log('Bypass:', result.bypassMethod)
    if (result.errorMessage) console.log('Error:', result.errorMessage)
    if (result.skipReason) console.log('Skip reason:', result.skipReason)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
