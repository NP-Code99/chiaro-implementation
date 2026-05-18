import * as fs from 'fs'
import * as path from 'path'

const envPath = path.join(process.cwd(), '.env.local')
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const match = line.match(/^([^=#\s][^=]*)=(.*)$/)
  if (match) process.env[match[1].trim()] = match[2].trim()
}

async function main() {
  const { scrapflyFetch, isChallenged } = await import('../src/lib/scrapflyFetch')
  const { chromium } = await import('playwright-extra')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const StealthPlugin = require('puppeteer-extra-plugin-stealth')
  chromium.use(StealthPlugin())

  const baseUrl  = 'https://wellfound.com/jobs/4016092-software-engineer'
  const applyUrl = 'https://wellfound.com/jobs/4016092-software-engineer?autoOpenApplication=true'

  const dir = path.join(process.cwd(), 'public', 'screenshots')
  fs.mkdirSync(dir, { recursive: true })

  // Step 1 — Scrapfly fetches the BASE URL to get cookies for base domain
  console.log('Step 1: Scrapfly fetch BASE URL for cookies...')
  const { cookies, html: baseHtml } = await scrapflyFetch(baseUrl)
  console.log(`  cf_clearance: ${cookies.find(c => c.name === 'cf_clearance') ? 'yes' : 'no'}`)
  console.log(`  datadome: ${cookies.find(c => c.name === 'datadome') ? 'yes' : 'no'}`)
  console.log(`  _wellfound: ${cookies.find(c => c.name === '_wellfound') ? 'yes' : 'no'}`)
  console.log(`  total: ${cookies.length}`)
  console.log(`  base page challenged: ${isChallenged(baseHtml)}`)

  // Step 2 — launch Playwright with stealth + Scrapfly cookies
  console.log('\nStep 2: Launching stealth Playwright...')
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  })

  const SECURE_PREFIXES = ['cf_clearance', '__Secure-', '__Host-', 'dd_']
  const pwCookies = cookies.filter(c => c.name && c.value).map(c => ({
    name: c.name, value: c.value,
    domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
    path: c.path || '/',
    httpOnly: false,
    secure: SECURE_PREFIXES.some(p => c.name.startsWith(p)),
    sameSite: 'Lax' as const,
  }))
  await context.addCookies(pwCookies)
  console.log(`  Injected ${pwCookies.length} cookies`)

  const page = await context.newPage()

  // Step 3 — navigate to BASE URL (not the modal URL)
  console.log('\nStep 3: Navigating to BASE URL first...')
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(3000)

  const title3 = await page.title()
  const html3 = await page.content()
  const isCF3 = html3.includes('cf-turnstile') || html3.includes('Just a moment') || title3.includes('Just a moment')
  console.log(`  Title: ${title3}`)
  console.log(`  Cloudflare challenge: ${isCF3}`)
  await page.screenshot({ path: path.join(dir, 'debug-s3-base.png'), fullPage: false })

  if (isCF3) {
    console.log('  ⚠ Still blocked on BASE URL — even base URL is challenged')
    await browser.close()
    return
  }

  // Step 4 — navigate to modal URL by pushing URL state (client-side navigation)
  console.log('\nStep 4: Opening modal via URL state push + React navigation...')
  // Try 1: pushState + click Apply button
  await page.evaluate(() => {
    history.pushState(null, '', '?autoOpenApplication=true')
  })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: path.join(dir, 'debug-s4-after-pushstate.png'), fullPage: false })

  let html4 = await page.content()
  let hasForm4 = html4.includes('name="name"') || html4.includes('Send application') || html4.includes('Submit application')
  console.log(`  Modal form after pushState: ${hasForm4}`)

  // Try 2: click "Apply" button if modal not open
  if (!hasForm4) {
    console.log('  Trying to click Apply button...')
    const applyBtn = page.locator('button:has-text("Apply now"), button:has-text("Apply")').first()
    const btnVisible = await applyBtn.isVisible({ timeout: 3000 }).catch(() => false)
    if (btnVisible) {
      await applyBtn.click()
      await page.waitForTimeout(2000)
      html4 = await page.content()
      hasForm4 = html4.includes('name="name"') || html4.includes('Send application') || html4.includes('Submit application')
      console.log(`  Modal form after Apply click: ${hasForm4}`)
    } else {
      console.log('  Apply button not found')
    }
    await page.screenshot({ path: path.join(dir, 'debug-s4-after-click.png'), fullPage: false })
  }

  // Step 5 — navigate directly to applyUrl (the original approach, but starting from base)
  if (!hasForm4) {
    console.log('\nStep 5: Trying direct navigation to apply URL...')
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(4000)

    const title5 = await page.title()
    const html5 = await page.content()
    const isCF5 = html5.includes('Just a moment') || title5.includes('Just a moment')
    const hasForm5 = html5.includes('name="name"') || html5.includes('Send application')
    console.log(`  Title: ${title5}`)
    console.log(`  Cloudflare challenge: ${isCF5}`)
    console.log(`  Modal form: ${hasForm5}`)
    await page.screenshot({ path: path.join(dir, 'debug-s5-direct-nav.png'), fullPage: false })
  }

  // Final check
  console.log('\nFinal page state:')
  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)
  )
  const inputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map(i => `${i.type}:${i.name || i.placeholder || '?'}`)
  )
  console.log(`  Buttons: ${buttons.slice(0, 8).join(' | ')}`)
  console.log(`  Inputs: ${inputs.filter(i => !i.startsWith('hidden')).slice(0, 10).join(' | ')}`)

  await browser.close()
  console.log('\nDone. Screenshots in /public/screenshots/')
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
