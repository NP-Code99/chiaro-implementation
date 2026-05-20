/**
 * LTK (ShopLTK) Greenhouse form test — job-boards.greenhouse.io/shopltk/jobs/7733334003
 *
 * Fields on this form:
 *   first_name, last_name, preferred_name, email, country, phone, resume
 *   question_30730080003  — How did you hear about this role? (React Select, required)
 *   question_30730081003  — Spoke with someone at LTK? (text, optional)
 *   question_30730082003  — Salary expectations (text, required)
 *   question_30730083003[] — Privacy Notice checkbox (required)
 *   question_30730084003  — Current employer (text)
 *   question_30730085003  — Current job title (text)
 *   question_30730086003  — Require visa sponsorship? (React Select)
 *   question_30730087003  — LinkedIn URL (text)
 *   question_30730088003  — Which US state do you reside in? (React Select)
 *   question_30730089003  — Non-compete agreements? (React Select)
 *   question_30730090003  — Relatives employed by LTK? (React Select)
 *   question_30730091003  — Previously employed by LTK? (React Select)
 *   question_30730092003  — Previously interviewed at LTK? (React Select)
 *
 * Run:
 *   npx tsx scripts/test-ltk-greenhouse.ts
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { nanoid } from 'nanoid'

const RESUME_PATH = path.resolve(process.cwd(), 'public/uploads/resume-nandan-pullakandam.pdf')
const TARGET_URL = 'https://job-boards.greenhouse.io/shopltk/jobs/7733334003?utm_source=startup.jobs&utm_medium=organic'

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
    bio: 'Product and marketing professional with 4 years of experience driving go-to-market strategy, creator economy growth, and cross-functional initiatives. Skilled at translating complex products into compelling narratives that resonate with influencers, brands, and consumers.',
    applicationPassword: 'Chiaro99999999!',
    currentCompany: 'UNC Chapel Hill',
    education: 'University of North Carolina, Chapel Hill, B.S. Computer Science',
    addressZip: '28201',
    gender: 'Prefer not to say' as const,
    ethnicity: 'Asian' as const,
    veteranStatus: 'I am not a protected veteran' as const,
    disabilityStatus: 'No, I do not have a disability' as const,
  }

  const { browserApply } = await import('../src/lib/browserApply')

  const applicationId = `ltk-gh-test-${nanoid(8)}`
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
