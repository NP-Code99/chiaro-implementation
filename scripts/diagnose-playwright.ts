/**
 * Tests the Playwright path: ScrapFly fetches base URL → extracts DataDome cookies
 * → Playwright navigates to apply URL using those cookies.
 * Stops at the first failure, does NOT submit any form.
 *
 * Run: npx tsx scripts/diagnose-playwright.ts
 */
import * as fs from 'fs'
import * as path from 'path'

// Load .env.local
const envPath = path.join(process.cwd(), '.env.local')
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const match = line.match(/^([^=#\s][^=]*)=(.*)$/)
  if (match) process.env[match[1].trim()] = match[2].trim()
}

const BASE_URL  = 'https://wellfound.com/jobs/3000325-software-engineer'
const APPLY_URL = 'https://wellfound.com/jobs/3000325-software-engineer?autoOpenApplication=true'
const SCREENSHOT_DIR = path.join(process.cwd(), 'public', 'screenshots')

function section(title: string) {
  console.log('\n' + '═'.repeat(60))
  console.log(`  ${title}`)
  console.log('═'.repeat(60))
}

async function diagnose() {
  section('STEP 1 — ScrapFly: fetch base URL, extract DataDome cookies')

  const { scrapflyFetch, isChallenged } = await import('../src/lib/scrapflyFetch')

  let dataDomeCookies: Array<{ name: string; value: string; domain: string; path: string }> = []

  try {
    const result = await scrapflyFetch(BASE_URL)
    const challenged = isChallenged(result.html)
    console.log(`Status: ${challenged ? '❌ Still challenged' : '✅ Clean page'}`)
    console.log(`Bytes returned: ${result.html.length}`)

    dataDomeCookies = result.cookies.filter(c =>
      c.name.startsWith('dd_') ||
      c.name === 'datadome' ||
      c.name.startsWith('cf_') ||
      c.name.startsWith('__Secure-')
    )
    console.log(`DataDome/CF cookies found: ${dataDomeCookies.length}`)
    dataDomeCookies.forEach(c => console.log(`  ${c.name} = ${c.value.slice(0, 40)}...`))

    if (challenged) {
      console.log('\n❌ STOP: ScrapFly base URL fetch is still challenged. Residential proxy not helping.')
      process.exit(1)
    }
    if (dataDomeCookies.length === 0) {
      console.log('\n⚠️  No DataDome cookies in ScrapFly response — Playwright will navigate without them.')
    }
  } catch (e) {
    console.log(`❌ ScrapFly fetch failed: ${(e as Error).message}`)
    process.exit(1)
  }

  section('STEP 2 — Launch Playwright with injected cookies')

  // Use playwright-extra + stealth (same as browserApply.ts)
  const { chromium: chromiumExtra } = await import('playwright-extra')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const StealthPlugin = require('puppeteer-extra-plugin-stealth')
  chromiumExtra.use(StealthPlugin())

  const browser = await chromiumExtra.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--window-size=1920,1080',
    ],
  })

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    })

    // Patch webdriver flag + chrome stub
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).chrome = { runtime: {} }
    })

    // Inject ScrapFly DataDome/CF cookies
    if (dataDomeCookies.length > 0) {
      const playwrightCookies = dataDomeCookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
        path: c.path || '/',
        httpOnly: false,
        secure: c.name.startsWith('__Secure-') || c.name.startsWith('cf_') || c.name === 'datadome',
        sameSite: 'Lax' as const,
      }))
      await context.addCookies(playwrightCookies)
      console.log(`✅ Injected ${playwrightCookies.length} cookies into Playwright context`)
    }

    const page = await context.newPage()

    section('STEP 3 — Navigate to apply URL, check for challenge')

    console.log(`Navigating to: ${APPLY_URL}`)
    await page.goto(APPLY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(3000)

    const title = await page.title().catch(() => '')
    const bodyText = await page.content().catch(() => '')
    console.log(`Page title: "${title}"`)

    // Take screenshot
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
    const screenshotPath = path.join(SCREENSHOT_DIR, 'playwright-apply-test.png')
    await page.screenshot({ path: screenshotPath, fullPage: false })
    console.log(`Screenshot saved: public/screenshots/playwright-apply-test.png`)

    const isChallenge =
      title.includes('Just a moment') ||
      title.includes('Attention Required') ||
      bodyText.includes('cf-turnstile') ||
      bodyText.includes('challenge-form') ||
      bodyText.includes('Checking your browser') ||
      bodyText.includes('datadome') && bodyText.includes('captcha')

    if (isChallenge) {
      console.log('\n❌ Playwright hit a challenge page even with DataDome cookies injected.')
      console.log('   DataDome cookies from ScrapFly are tied to ScrapFly\'s browser fingerprint.')
      console.log('   Playwright\'s different fingerprint causes DataDome to reject the session.')
      console.log('\n   CONCLUSION: Need a browser with matching fingerprint to ScrapFly, OR')
      console.log('   need Steel.dev paid plan (real Chrome + residential proxy in one process).')
    } else {
      const hasForm = await page.locator('input, textarea, button[type="submit"]').count().catch(() => 0)
      const hasModal = bodyText.includes('Apply') || bodyText.includes('application') || bodyText.includes('cover')

      console.log(`\n✅ No challenge detected!`)
      console.log(`   Form elements visible: ${hasForm}`)
      console.log(`   Application content present: ${hasModal ? 'yes' : 'no'}`)

      if (hasForm > 0) {
        console.log('\n🎉 Playwright successfully reached the application form with ScrapFly cookie injection!')
        console.log('   The full apply flow should work.')
      } else {
        console.log('\n⚠️  Page loaded but no form found yet — modal may need more time to open.')
        // Wait longer and check again
        await page.waitForTimeout(3000)
        const hasFormDelayed = await page.locator('input, textarea, button[type="submit"]').count().catch(() => 0)
        console.log(`   Form elements after extra wait: ${hasFormDelayed}`)

        const screenshotPath2 = path.join(SCREENSHOT_DIR, 'playwright-apply-test-delayed.png')
        await page.screenshot({ path: screenshotPath2, fullPage: false })
        console.log('   Screenshot saved: public/screenshots/playwright-apply-test-delayed.png')
      }
    }
  } finally {
    await browser.close()
  }
}

diagnose().catch(e => {
  console.error('\n💥 Uncaught error:', e.message)
  process.exit(1)
})
