/**
 * Interactive test of the Greenhouse Security-code fill logic against a live page.
 *
 * Flow:
 *   1. Launches a headed Chromium at the job URL.
 *   2. You manually fill the application form and click Submit yourself until the
 *      "A verification code was sent to ..." screen is visible.
 *   3. Press ENTER in the terminal.
 *   4. The script dumps what its DOM detector found (so we can see *which* tier
 *      matched) before doing anything destructive.
 *   5. Paste the 8-char code at the prompt and press ENTER.
 *   6. The script runs the EXACT same locator + fill + submit code that
 *      browserApply.ts uses, against this live page.
 *
 * Run:
 *   npx tsx scripts/test-verify-fill.ts
 *   APPLY_URL='...' npx tsx scripts/test-verify-fill.ts
 */
import { chromium, type Page } from 'playwright'
import * as readline from 'node:readline'

const URL = process.env.APPLY_URL ?? 'https://job-boards.eu.greenhouse.io/nice/jobs/4817745101?gh_jid=4817745101'

function ask(prompt: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, ans => { rl.close(); resolve(ans) })
  })
}

// ─── COPIED VERBATIM from src/lib/browserApply.ts so this test exercises the
// same code path. Keep in sync if you edit either copy.
async function locateGreenhouseCodeInputs(page: Page) {
  return page.evaluate(() => {
    const PERSONAL_FIELD_RE = /name|email|phone|address|city|state|zip|postal|country|linkedin|github|portfolio|website|school|university|company|title|resume|cover|location|gender|race|veteran|disability|pronoun|salary|referr/i
    function isPersonalInfoInput(el: HTMLInputElement): boolean {
      const blob = [el.name, el.id, el.placeholder, el.getAttribute('autocomplete') || '', el.getAttribute('aria-label') || ''].join(' ').toLowerCase()
      return PERSONAL_FIELD_RE.test(blob)
    }
    function isVisible(el: HTMLElement): boolean {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return false
      const style = window.getComputedStyle(el)
      return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
    }
    function isOtpCellShape(el: HTMLInputElement): boolean {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.width <= 100 && r.height > 0 && r.height <= 100
    }
    function inputType(el: HTMLInputElement): string { return (el.type || 'text').toLowerCase() }

    const ariaInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input')).filter(el => {
      if (!isVisible(el)) return false
      if (isPersonalInfoInput(el)) return false
      const label = (el.getAttribute('aria-label') || '').toLowerCase()
      return /(digit|character|code)\s*\d+\s*(of|\/)/.test(label)
    })
    if (ariaInputs.length >= 2) {
      const marker = 'gh-otp-' + Math.random().toString(36).slice(2, 9)
      ariaInputs.forEach((el, idx) => el.setAttribute('data-gh-otp', `${marker}-${idx}`))
      return { marker, count: ariaInputs.length, debug: `aria-labeled OTP cells (${ariaInputs.length})` }
    }

    const labelCandidates = Array.from(document.querySelectorAll('label, legend, h1, h2, h3, h4, h5, strong, span, p'))
    const labelEl = labelCandidates.find(el => {
      const t = (el.textContent || '').trim().toLowerCase()
      return t === 'security code' || t.startsWith('security code')
    }) as HTMLElement | undefined

    if (labelEl) {
      const labelRect = labelEl.getBoundingClientRect()
      const all = Array.from(document.querySelectorAll<HTMLInputElement>('input'))
        .filter(el => {
          if (!isVisible(el)) return false
          if (isPersonalInfoInput(el)) return false
          const t = inputType(el)
          if (!(t === 'text' || t === 'tel' || t === 'number' || t === 'password')) return false
          const r = el.getBoundingClientRect()
          if (r.top < labelRect.bottom - 4) return false
          if (r.top > labelRect.bottom + 200) return false
          return isOtpCellShape(el)
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect()
          if (Math.abs(ar.top - br.top) > 5) return ar.top - br.top
          return ar.left - br.left
        })
      if (all.length >= 2) {
        const marker = 'gh-otp-' + Math.random().toString(36).slice(2, 9)
        all.forEach((el, idx) => el.setAttribute('data-gh-otp', `${marker}-${idx}`))
        return { marker, count: all.length, debug: `${all.length} OTP cells found below "Security code" label` }
      }
      if (all.length === 1) {
        const marker = 'gh-otp-' + Math.random().toString(36).slice(2, 9)
        all[0].setAttribute('data-gh-otp', `${marker}-0`)
        return { marker, count: 1, debug: '1 combined input below "Security code" label' }
      }
    }

    const explicit = Array.from(document.querySelectorAll<HTMLInputElement>(
      'input[autocomplete="one-time-code"], input[maxlength="1"], input[maxlength="8"], input[inputmode="numeric"]'
    )).filter(el => isVisible(el) && !isPersonalInfoInput(el) && isOtpCellShape(el))
    if (explicit.length >= 1) {
      const marker = 'gh-otp-' + Math.random().toString(36).slice(2, 9)
      explicit.forEach((el, idx) => el.setAttribute('data-gh-otp', `${marker}-${idx}`))
      return { marker, count: explicit.length, debug: `${explicit.length} explicit-OTP inputs (fallback)` }
    }
    return null
  })
}

async function dumpDiagnostics(page: Page) {
  const info = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label, legend, h1, h2, h3, h4, span, p'))
    const labelEl = labels.find(el => /^\s*security code/i.test((el.textContent || '').trim())) as HTMLElement | undefined
    return {
      labelFound: !!labelEl,
      labelText: labelEl?.textContent?.trim() ?? null,
      inputs: Array.from(document.querySelectorAll('input')).map(el => {
        const i = el as HTMLInputElement
        const r = i.getBoundingClientRect()
        return {
          name: i.name, id: i.id, type: i.type,
          ariaLabel: i.getAttribute('aria-label') || '',
          maxLength: i.getAttribute('maxlength') || '',
          autocomplete: i.getAttribute('autocomplete') || '',
          inputmode: i.getAttribute('inputmode') || '',
          w: Math.round(r.width), h: Math.round(r.height),
          visible: r.width > 0 && r.height > 0,
        }
      }).filter(x => x.visible),
    }
  })
  console.log('\n── DIAGNOSTICS ──')
  console.log('Security code label found:', info.labelFound, info.labelText ? `(text: "${info.labelText}")` : '')
  console.log('Visible inputs on page:')
  console.table(info.inputs)
}

async function main() {
  console.log(`Launching headed Chromium at ${URL}`)
  const browser = await chromium.launch({ headless: false, slowMo: 50 })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(URL, { waitUntil: 'domcontentloaded' })

  console.log('\n→ Manually fill the application and click Submit yourself.')
  console.log('→ Stop when you see the "A verification code was sent to ..." screen with 8 boxes.')
  await ask('\nPress ENTER when the verification screen is visible: ')

  await dumpDiagnostics(page)

  const located = await locateGreenhouseCodeInputs(page)
  if (!located) {
    console.error('\n❌ Detection failed — no safe OTP input matched. Check the diagnostics above.')
    await ask('\nPress ENTER to close browser: ')
    await browser.close()
    return
  }
  console.log(`\n✅ Detection matched: ${located.debug}`)

  const code = (await ask('\nPaste the 8-character code from your email: ')).trim()
  if (!code) {
    console.error('No code provided. Aborting.')
    await browser.close()
    return
  }

  const first = page.locator(`input[data-gh-otp="${located.marker}-0"]`)
  await first.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
  await first.click({ timeout: 3000 })

  const focusOk = await page.evaluate((marker: string) => {
    const active = document.activeElement as HTMLElement | null
    return !!(active && active.getAttribute('data-gh-otp')?.startsWith(marker))
  }, located.marker)
  if (!focusOk) {
    console.error('❌ Click did not focus the leftmost OTP cell — aborting type')
    await ask('Press ENTER to close: ')
    await browser.close()
    return
  }
  console.log('✅ Leftmost OTP cell focused')

  if (located.count === 1) {
    await page.keyboard.type(code, { delay: 80 })
  } else {
    for (const ch of code) await page.keyboard.type(ch, { delay: 80 })
  }
  console.log('✅ Typed code')

  await page.waitForTimeout(500)

  const candidates = [
    page.getByRole('button', { name: /^submit application$/i }),
    page.getByRole('button', { name: /submit application/i }),
    page.locator('button:has-text("Submit application")'),
    page.getByRole('button', { name: /^verify$/i }),
    page.getByRole('button', { name: /^confirm$/i }),
    page.getByRole('button', { name: /^continue$/i }),
  ]
  let clicked = false
  for (const c of candidates) {
    const btn = c.last()
    if (await btn.count().catch(() => 0) === 0) continue
    try {
      await btn.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {})
      await btn.click({ timeout: 4000 })
      clicked = true
      console.log('✅ Clicked submit button')
      break
    } catch { /* try next */ }
  }
  if (!clicked) console.error('❌ Could not click submit button')

  await ask('\nReview the result in the browser, then press ENTER to close: ')
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
