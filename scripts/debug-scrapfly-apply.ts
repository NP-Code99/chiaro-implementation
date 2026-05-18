/**
 * Tests the scrapflyApplyWellfound() function against a live Wellfound job.
 * Verifies that Scrapfly's js_scenario can fill and attempt to submit the form.
 */
import * as fs from 'fs'
import * as path from 'path'

const envPath = path.join(process.cwd(), '.env.local')
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const match = line.match(/^([^=#\s][^=]*)=(.*)$/)
  if (match) process.env[match[1].trim()] = match[2].trim()
}

async function main() {
  const { scrapflyApplyWellfound } = await import('../src/lib/scrapflyApply')

  const applyUrl = 'https://wellfound.com/jobs/4016092-software-engineer?autoOpenApplication=true'

  const profile = {
    firstName: 'Nandan',
    lastName: 'Pullakandam',
    email: 'test@example.com',
    phone: '+1 415 555 0100',
    linkedin: 'https://linkedin.com/in/nandan',
    github: 'https://github.com/nandan',
    location: 'San Francisco, CA',
    workAuth: 'US Citizen',
    yearsExp: '3-5',
    desiredSalary: '150000',
    resumeBase64: '',
    resumeFilename: '',
    bio: 'Experienced full-stack engineer with a passion for building scalable products.',
    applicationPassword: 'Chiaro12345678!',
  }

  const coverLetter = `${profile.bio} I'm excited about this Software Engineer opportunity at Macro and believe my background is a strong match for what you're looking for.`

  console.log('Testing Scrapfly js_scenario apply...')
  console.log(`URL: ${applyUrl}`)
  console.log()

  const result = await scrapflyApplyWellfound(applyUrl, profile as any, coverLetter)

  console.log('Result:', JSON.stringify({ status: result.status, errorMessage: result.errorMessage, bypassMethod: result.bypassMethod }, null, 2))

  // Save result HTML for inspection
  if (result.html) {
    const dir = path.join(process.cwd(), 'public', 'screenshots')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'scrapfly-apply-result.html'), result.html)
    console.log('\nResult HTML saved to public/screenshots/scrapfly-apply-result.html')
    console.log(`HTML length: ${result.html.length}`)

    // Check for success indicators
    const lower = result.html.toLowerCase()
    const successWords = ['thank you', 'received', 'submitted', 'success']
    const foundSuccess = successWords.filter(w => lower.includes(w))
    console.log(`Success indicators found: ${foundSuccess.join(', ') || 'none'}`)
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
