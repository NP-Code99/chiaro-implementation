import * as fs from 'fs'
import * as path from 'path'

const envPath = path.join(process.cwd(), '.env.local')
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const match = line.match(/^([^=#\s][^=]*)=(.*)$/)
  if (match) process.env[match[1].trim()] = match[2].trim()
}

async function main() {
  const { scrapflyFetch } = await import('../src/lib/scrapflyFetch')
  const { chromium } = await import('playwright')

  const applyUrl = 'https://wellfound.com/jobs/4016092-software-engineer?autoOpenApplication=true'
  const baseUrl  = 'https://wellfound.com/jobs/4016092-software-engineer'

  const dir = path.join(process.cwd(), 'public', 'screenshots')
  fs.mkdirSync(dir, { recursive: true })

  console.log('Step 1: Scrapfly fetch base URL for cookies...')
  const { cookies } = await scrapflyFetch(baseUrl)
  console.log(`  Got ${cookies.length} cookies`)

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => false }) })

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

  const page = await context.newPage()
  await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(5000)

  // Get full HTML source
  const fullHtml = await page.content()
  console.log('\nSearching for sitekey in page source...')

  // Pattern 1: data-sitekey attribute
  const dataSitekey = fullHtml.match(/data-sitekey="([^"]+)"/g)
  console.log(`  data-sitekey attributes: ${dataSitekey?.join(' | ') || 'none'}`)

  // Pattern 2: sitekey in scripts
  const scriptSitekey = fullHtml.match(/sitekey['":\s]+['"]([0-9a-zA-Z_\-]+)['"]/g)
  console.log(`  sitekey in scripts: ${scriptSitekey?.join(' | ') || 'none'}`)

  // Pattern 3: Turnstile JS params
  const turnstileParams = fullHtml.match(/turnstile[^'"]*['"]([0-9a-zA-Z_\-]{20,})['"]/gi)
  console.log(`  turnstile params: ${turnstileParams?.join(' | ') || 'none'}`)

  // Pattern 4: iframe src containing sitekey
  const iframeSrcs = fullHtml.match(/<iframe[^>]*src="([^"]*turnstile[^"]*)"[^>]*>/gi)
  console.log(`  turnstile iframes: ${iframeSrcs?.join(' | ') || 'none'}`)

  // Pattern 5: look for any 0x pattern (Cloudflare Turnstile keys start with 0x)
  const zeroXKeys = fullHtml.match(/0x[0-9a-fA-F]{20,}/g)
  console.log(`  0x... keys: ${Array.from(new Set(zeroXKeys || [])).join(' | ') || 'none'}`)

  // Pattern 6: check iframes in DOM
  const iframes = await page.evaluate(() =>
    Array.from(document.querySelectorAll('iframe')).map(f => f.src || f.getAttribute('src'))
  )
  console.log(`  DOM iframes: ${iframes.join(' | ') || 'none'}`)

  // Pattern 7: look in inline scripts
  const scripts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('script')).map(s => s.textContent?.slice(0, 200)).filter(Boolean)
  )
  console.log(`\n  Inline scripts (first 200 chars each):`)
  for (const s of scripts.slice(0, 5)) {
    console.log(`    ${s?.replace(/\n/g, ' ')}`)
  }

  // Save full HTML for inspection
  fs.writeFileSync(path.join(dir, 'challenge-page.html'), fullHtml)
  console.log('\n  Full HTML saved to public/screenshots/challenge-page.html')

  await browser.close()
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
