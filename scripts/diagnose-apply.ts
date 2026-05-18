/**
 * Diagnostic script — tests each layer of the apply stack one at a time.
 * Stops at the first failure and prints a clear diagnosis.
 *
 * Run: npx tsx scripts/diagnose-apply.ts
 */
import * as fs from 'fs'
import * as path from 'path'

// Load .env.local
const envPath = path.join(process.cwd(), '.env.local')
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const match = line.match(/^([^=#\s][^=]*)=(.*)$/)
  if (match) process.env[match[1].trim()] = match[2].trim()
}

// Use the first available job from DB
const TEST_URL = 'https://wellfound.com/jobs/3000325-software-engineer?autoOpenApplication=true'
const BASE_URL  = 'https://wellfound.com/jobs/3000325-software-engineer'

async function section(title: string) {
  console.log('\n' + '═'.repeat(60))
  console.log(`  ${title}`)
  console.log('═'.repeat(60))
}

async function diagnose() {
  section('LAYER 1 — CapSolver API key check')
  const capKey = process.env.CAPSOLVER_API_KEY
  if (!capKey) {
    console.log('❌ CAPSOLVER_API_KEY is not set — CapSolver disabled')
  } else {
    console.log(`✅ CAPSOLVER_API_KEY is set (${capKey.slice(0, 8)}...)`)
    // Quick balance check
    try {
      const res = await fetch('https://api.capsolver.com/getBalance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: capKey }),
      })
      const data = await res.json() as { errorId: number; balance?: number; errorDescription?: string }
      if (data.errorId === 0) {
        console.log(`   Balance: $${data.balance}`)
      } else {
        console.log(`   ⚠️  Balance check error: ${data.errorDescription}`)
      }
    } catch (e) {
      console.log(`   ⚠️  Could not reach CapSolver: ${(e as Error).message}`)
    }
  }

  section('LAYER 2 — ScrapFly API key check')
  const sfKey = process.env.SCRAPFLY_API_KEY
  if (!sfKey) {
    console.log('❌ SCRAPFLY_API_KEY is not set — STOP. Nothing will work without this.')
    process.exit(1)
  }
  console.log(`✅ SCRAPFLY_API_KEY is set (${sfKey.slice(0, 8)}...)`)

  section('LAYER 3 — Raw Scrapfly fetch (can we GET the page?)')
  const { scrapflyFetch, isChallenged, extractTurnstileSitekey } = await import('../src/lib/scrapflyFetch')

  console.log(`Fetching: ${BASE_URL}`)
  let html = ''
  try {
    const result = await scrapflyFetch(BASE_URL)
    html = result.html
    console.log(`✅ Scrapfly returned ${html.length} bytes, credit cost: ${result.creditCost}`)
  } catch (e) {
    console.log(`❌ Scrapfly fetch failed: ${(e as Error).message}`)
    console.log('\n  DIAGNOSIS: ScrapFly cannot reach Wellfound. Possible causes:')
    console.log('  - Invalid/expired API key')
    console.log('  - ScrapFly account out of credits')
    console.log('  - Scrapfly configuration error')
    process.exit(1)
  }

  section('LAYER 4 — Cloudflare challenge detection')
  if (isChallenged(html)) {
    const sitekey = extractTurnstileSitekey(html)
    console.log('❌ Cloudflare challenge is still present in the response HTML')
    console.log(`   Turnstile sitekey: ${sitekey ?? 'not found'}`)
    console.log('\n  DIAGNOSIS: ScrapFly ASP mode is NOT bypassing Cloudflare.')
    console.log('  The page returned is a Cloudflare challenge page, not the actual Wellfound page.')
    console.log('\n  What ASP mode sends (render_js: true, asp: true) is not enough.')
    console.log('\n  Options to try:')
    console.log('  1. ScrapFly "anti_scraping_protection" with a residential proxy rotation')
    console.log('  2. Switch to Steel.dev (already integrated in the codebase) — it runs')
    console.log('     a real Chrome browser in the cloud with fingerprint randomization')
    console.log('  3. Use a CAPTCHA relay service (CapSolver 2Captcha) but also need')
    console.log('     residential proxies for the IP fingerprint, not just the token')

    // Save challenge HTML for inspection
    const dir = path.join(process.cwd(), 'public', 'screenshots')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'challenge-response.html'), html)
    console.log('\n  Challenge HTML saved to public/screenshots/challenge-response.html')
    process.exit(1)
  }

  console.log('✅ No Cloudflare challenge detected — page looks like real Wellfound content')

  // Spot-check some expected content
  const hasJobTitle = html.includes('Software Engineer') || html.includes('job') || html.includes('apply')
  console.log(`   Content check (job keywords): ${hasJobTitle ? '✅ found' : '⚠️  not found — may be wrong page'}`)

  section('LAYER 5 — Scrapfly js_scenario apply test')
  console.log('Testing the full form-fill js_scenario...')
  console.log('(This will attempt to fill the Wellfound modal form via Scrapfly)')
  console.log()

  const { scrapflyApplyWellfound } = await import('../src/lib/scrapflyApply')
  const profile = {
    firstName: 'Test',
    lastName: 'User',
    email: 'test@example.com',
    phone: '+1 415 555 0100',
    linkedin: 'https://linkedin.com/in/test',
    github: 'https://github.com/test',
    location: 'San Francisco, CA',
    workAuth: 'US Citizen',
    yearsExp: '3-5',
    desiredSalary: '150000',
    resumeBase64: '',
    resumeFilename: 'resume.pdf',
    bio: 'Experienced full-stack engineer.',
    applicationPassword: 'Chiaro12345678!',
  }

  try {
    // Hard timeout — don't loop forever
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('TIMEOUT: js_scenario took > 90 seconds')), 90_000)
    )

    const result = await Promise.race([
      scrapflyApplyWellfound(TEST_URL, profile as Parameters<typeof scrapflyApplyWellfound>[1], 'Test scenario cover letter — do not submit'),
      timeout,
    ])

    console.log(`Result status: ${result.status}`)
    console.log(`Error message: ${result.errorMessage ?? 'none'}`)

    if (result.html) {
      const dir = path.join(process.cwd(), 'public', 'screenshots')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'scenario-result.html'), result.html)
      console.log(`HTML saved to public/screenshots/scenario-result.html`)

      const lower = result.html.toLowerCase()
      if (isChallenged(result.html)) {
        console.log('❌ After js_scenario, page is STILL a Cloudflare challenge')
        console.log('  DIAGNOSIS: The apply URL specifically triggers a harder challenge')
        console.log('  The warm-up fetch may bypass the base page but ?autoOpenApplication=true')
        console.log('  triggers additional bot protection')
      } else {
        const successWords = ['thank you', 'received', 'submitted', 'success', 'application']
        const found = successWords.filter(w => lower.includes(w))
        if (found.length > 0) {
          console.log(`✅ Page contains success-related words: ${found.join(', ')}`)
        } else {
          console.log(`⚠️  No success keywords. Form may not have been submitted.`)
        }
      }
    }
  } catch (e) {
    console.log(`❌ js_scenario failed: ${(e as Error).message}`)
    if ((e as Error).message.includes('TIMEOUT')) {
      console.log('\n  DIAGNOSIS: Scrapfly took too long — likely still waiting for a challenge to resolve')
    } else if ((e as Error).message.includes('ASP') || (e as Error).message.includes('bypass')) {
      console.log('\n  DIAGNOSIS: Scrapfly ASP explicitly failed to bypass protection')
    }
  }

  section('SUMMARY')
  console.log('If Layer 4 failed: ScrapFly ASP cannot bypass Wellfound Cloudflare')
  console.log('If Layer 5 failed: ScrapFly CAN load the page but the js_scenario fails')
  console.log('  (this may mean the form selectors are wrong, not a Cloudflare issue)')
}

diagnose().catch(e => {
  console.error('\n💥 Uncaught error:', e.message)
  process.exit(1)
})
