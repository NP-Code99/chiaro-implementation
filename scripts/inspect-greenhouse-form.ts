/**
 * Headed inspection of the live Nice/Greenhouse application form.
 *
 * Opens the URL, dumps the form-field structure, then keeps the browser open so
 * a human can manually drive to the post-submit Security code screen. Once the
 * verification UI is visible, press ENTER in the terminal — the script will dump
 * the exact DOM of the security-code field so we can confirm/refine selectors.
 */
import { chromium } from 'playwright'
import * as readline from 'node:readline'

const URL = process.env.APPLY_URL ?? 'https://job-boards.eu.greenhouse.io/nice/jobs/4817745101?gh_jid=4817745101'

function waitForEnter(prompt: string): Promise<void> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(prompt, () => { rl.close(); resolve() })
  })
}

async function main() {
  console.log(`Launching headed Chromium at ${URL}`)
  const browser = await chromium.launch({ headless: false, slowMo: 50 })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})

  // Initial form dump
  const formInfo = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input, textarea, select')) as HTMLElement[]
    return inputs.slice(0, 30).map(el => {
      const r = el.getBoundingClientRect()
      const i = el as HTMLInputElement
      return {
        tag: el.tagName.toLowerCase(),
        type: (i.type || ''),
        name: i.name || '',
        id: i.id || '',
        placeholder: i.placeholder || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        maxLength: el.getAttribute('maxlength') || '',
        visible: r.width > 0 && r.height > 0,
      }
    })
  })
  console.log('\n── Initial form inputs (first 30) ──')
  console.table(formInfo)

  console.log('\nManually fill the form and click Submit to reach the "Security code" screen.')
  console.log('When you see the 8 boxes, come back here and press ENTER to dump them.\n')
  await waitForEnter('Press ENTER when the Security code screen is visible: ')

  // Dump anything that looks like an OTP cell or sits below a "Security code" label
  const dump = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label, legend, h1, h2, h3, h4, span, p'))
    const labelEl = labels.find(el => /^\s*security code\s*$/i.test((el.textContent || '').trim())) as HTMLElement | undefined
    const labelRect = labelEl?.getBoundingClientRect()

    const all = Array.from(document.querySelectorAll('input')) as HTMLInputElement[]
    return {
      labelFound: !!labelEl,
      labelRect: labelRect ? { top: labelRect.top, bottom: labelRect.bottom, left: labelRect.left } : null,
      inputs: all.map(el => {
        const r = el.getBoundingClientRect()
        return {
          name: el.name || '',
          id: el.id || '',
          type: el.type || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          autocomplete: el.getAttribute('autocomplete') || '',
          inputmode: el.getAttribute('inputmode') || '',
          maxLength: el.getAttribute('maxlength') || '',
          placeholder: el.placeholder || '',
          dataAttrs: Object.fromEntries(
            Array.from(el.attributes)
              .filter(a => a.name.startsWith('data-'))
              .map(a => [a.name, a.value]),
          ),
          rect: { top: r.top, left: r.left, w: Math.round(r.width), h: Math.round(r.height) },
          visible: r.width > 0 && r.height > 0,
        }
      }),
    }
  })
  console.log('\n── Post-submit DOM dump ──')
  console.log(JSON.stringify(dump, null, 2))

  await waitForEnter('\nPress ENTER to close the browser: ')
  await browser.close()
}

main().catch(e => { console.error(e); process.exit(1) })
