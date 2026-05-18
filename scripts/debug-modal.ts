import * as fs from 'fs'
import * as path from 'path'

const envPath = path.join(process.cwd(), '.env.local')
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const match = line.match(/^([^=#\s][^=]*)=(.*)$/)
  if (match) process.env[match[1].trim()] = match[2].trim()
}

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

async function main() {
  const { scrapflyFetch } = await import('../src/lib/scrapflyFetch')
  const { solveDataDome } = await import('../src/lib/capsolver')
  const { chromium } = await import('playwright-extra')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  chromium.use(require('puppeteer-extra-plugin-stealth')())

  const baseUrl = 'https://wellfound.com/jobs/4016092-software-engineer'
  const dir = path.join(process.cwd(), 'public', 'screenshots')
  fs.mkdirSync(dir, { recursive: true })

  console.log('Step 1: Getting Scrapfly cookies...')
  let cookies: Array<{ name: string; value: string; domain: string; path: string }> = []
  try {
    ({ cookies } = await scrapflyFetch(baseUrl))
    console.log(`  Got ${cookies.length} cookies: ${cookies.map(c => c.name).join(', ')}`)
  } catch (err) {
    console.log(`  Scrapfly failed: ${(err as Error).message} — continuing without`)
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  })
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  })

  if (cookies.length > 0) {
    const SECURE_PREFIXES = ['cf_clearance', '__Secure-', '__Host-', 'dd_']
    await context.addCookies(cookies.filter(c => c.name && c.value).map(c => ({
      name: c.name, value: c.value,
      domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
      path: c.path || '/',
      httpOnly: false,
      secure: SECURE_PREFIXES.some(p => c.name.startsWith(p)),
      sameSite: 'Lax' as const,
    })))
    console.log(`  Injected ${cookies.length} cookies`)
  }

  const page = await context.newPage()

  // Intercept the specific DataDome challenge page URL (geo.captcha-delivery.com/captcha/?)
  let ddCaptchaUrl: string | null = null
  page.on('request', (req: import('playwright').Request) => {
    const url = req.url()
    if (url.includes('captcha-delivery.com') || url.includes('dd-cf.com')) {
      console.log(`  [DataDome] Request: ${url.slice(0, 120)}`)
      // Only capture the main challenge URL, not static assets/fonts
      if (url.includes('geo.captcha-delivery.com/captcha/')) {
        ddCaptchaUrl = url
      }
    }
  })

  console.log('\nStep 2: Navigate to base URL...')
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: path.join(dir, 'modal-step2-base.png'), fullPage: false })

  const title = await page.title()
  const bodyText = (await page.evaluate(() => document.body.innerText)).slice(0, 200)
  console.log(`  Title: ${title}`)
  console.log(`  Body: ${bodyText.replace(/\n/g, ' ')}`)

  const isDD = bodyText.includes('Verification Required') ||
    bodyText.includes('Slide right') ||
    title === 'wellfound.com'

  console.log(`  DataDome challenge: ${isDD}`)
  console.log(`  DataDome captcha URL captured: ${ddCaptchaUrl ? 'yes' : 'no'}`)

  if (isDD) {
    // Wait a bit more for captcha-delivery.com request to come in
    await page.waitForTimeout(2000)
    console.log(`  Captcha URL (after wait): ${ddCaptchaUrl ? (ddCaptchaUrl as string).slice(0, 120) : 'still not captured'}`)

    // Also check the page HTML for the captcha URL
    const pageHtml = await page.content()
    const ddUrlMatch = pageHtml.match(/captcha-delivery\.com[^"'\s]*/)?.[0]
    if (!ddCaptchaUrl && ddUrlMatch) {
      ddCaptchaUrl = `https://${ddUrlMatch}`
      console.log(`  Captcha URL from HTML: ${ddCaptchaUrl}`)
    }

    const captchaUrl = ddCaptchaUrl || baseUrl
    console.log(`\nStep 3: Solving DataDome with CapSolver...`)
    console.log(`  Using captcha URL: ${captchaUrl.slice(0, 100)}`)

    const ddCookie = await solveDataDome(captchaUrl, USER_AGENT)
    console.log(`  CapSolver result: ${ddCookie ? ddCookie.slice(0, 60) + '...' : 'null (failed)'}`)

    if (ddCookie) {
      // Parse cookie (format: "datadome=VALUE; Path=/; ...")
      const cookieVal = ddCookie.includes('=')
        ? ddCookie.split('=').slice(1).join('=').split(';')[0].trim()
        : ddCookie.trim()

      console.log(`  Injecting datadome cookie: ${cookieVal.slice(0, 40)}...`)
      await context.addCookies([{
        name: 'datadome',
        value: cookieVal,
        domain: '.wellfound.com',
        path: '/',
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      }])

      console.log('\nStep 4: Reload with solved DataDome cookie...')
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForTimeout(3000)
      await page.screenshot({ path: path.join(dir, 'modal-step4-after-dd.png'), fullPage: false })

      const title4 = await page.title()
      const body4 = (await page.evaluate(() => document.body.innerText)).slice(0, 200)
      const isStillDD = body4.includes('Verification Required')
      console.log(`  Title: ${title4}`)
      console.log(`  Still blocked: ${isStillDD}`)
    } else {
      console.log('  CapSolver could not solve DataDome')
    }
  }

  // Check final state and try clicking Apply
  console.log('\nStep 5: Looking for Apply button...')
  const applyBtn = page.locator('[data-test="JobApplicationApplyButton"]').last()
  const visible = await applyBtn.isVisible({ timeout: 5000 }).catch(() => false)
  console.log(`  Apply button visible: ${visible}`)

  if (visible) {
    await applyBtn.scrollIntoViewIfNeeded()
    await applyBtn.click()
    await page.waitForTimeout(3000)
    await page.screenshot({ path: path.join(dir, 'modal-step5-after-apply.png'), fullPage: false })

    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, textarea')).map(i => {
        const el = i as HTMLInputElement
        return `${el.type}:${el.name || el.placeholder || '?'}`
      })
    )
    const modalInputs = inputs.filter(i => !i.startsWith('hidden'))
    console.log(`  Inputs after Apply click: ${modalInputs.join(' | ')}`)
    const hasForm = modalInputs.some(i => i.includes('name') || i.includes('email') || i.includes('password'))
    console.log(`  Application form open: ${hasForm}`)
  }

  await browser.close()
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
