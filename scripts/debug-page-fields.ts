/**
 * Debug script: navigate to startup.jobs apply page with Steel and dump all
 * interactive elements (input, textarea, select, ARIA roles) to understand
 * what the form actually renders.
 *
 * Run: npx tsx scripts/debug-page-fields.ts
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import Steel from 'steel-sdk'
import { chromium } from 'playwright'

const TEST_URL = 'https://startup.jobs/apply/74f8158e-5a95-4ff1-be84-1fb13d3c010d'
const STEEL_API_KEY = process.env.STEEL_API_KEY!

async function main() {
  const steel = new Steel({ steelAPIKey: STEEL_API_KEY })

  console.log('Creating Steel session...')
  const session = await steel.sessions.create({
    useProxy: true,
    solveCaptcha: true,
  })
  console.log('Session ID:', session.id)

  const browser = await chromium.connectOverCDP(
    `wss://connect.steel.dev?apiKey=${STEEL_API_KEY}&sessionId=${session.id}`
  )
  const context = browser.contexts()[0]
  const page = context.pages()[0] ?? await context.newPage()

  try {
    console.log('Navigating to:', TEST_URL)
    await page.goto(TEST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })

    // Wait for CF challenge
    console.log('Waiting for CF challenge to clear...')
    await page.waitForFunction(
      () => !document.title.toLowerCase().includes('just a moment'),
      { timeout: 60000, polling: 2000 }
    ).catch(() => console.log('CF wait timed out'))

    // Wait for form
    await page.waitForSelector('input, textarea, select, [role="textbox"], [role="combobox"]', { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(3000)

    console.log('\nPage URL:', page.url())
    console.log('Page title:', await page.title())

    // Dump all interactive elements
    const elements = await page.evaluate(() => {
      const results: Array<{
        tag: string
        id: string
        name: string
        type: string
        role: string
        ariaLabel: string
        placeholder: string
        value: string
        visible: boolean
        readOnly: boolean
        disabled: boolean
        options?: string[]
      }> = []

      // Standard form elements
      document.querySelectorAll('input, textarea, select').forEach(el => {
        const e = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        const rect = e.getBoundingClientRect()
        const visible = rect.width > 0 && rect.height > 0
        const opts = e.tagName === 'SELECT'
          ? Array.from((e as HTMLSelectElement).options).map(o => o.text)
          : undefined
        results.push({
          tag: e.tagName.toLowerCase(),
          id: e.id || '',
          name: (e as HTMLInputElement).name || '',
          type: (e as HTMLInputElement).type || '',
          role: e.getAttribute('role') || '',
          ariaLabel: e.getAttribute('aria-label') || '',
          placeholder: (e as HTMLInputElement).placeholder || '',
          value: (e as HTMLInputElement).value?.slice(0, 100) || '',
          visible,
          readOnly: (e as HTMLInputElement).readOnly || false,
          disabled: e.disabled,
          options: opts,
        })
      })

      // ARIA role elements (Fluent UI, React custom components)
      const ariaRoles = ['textbox', 'combobox', 'listbox', 'radio', 'checkbox', 'spinbutton', 'slider']
      ariaRoles.forEach(role => {
        document.querySelectorAll(`[role="${role}"]`).forEach(el => {
          const e = el as HTMLElement
          const rect = e.getBoundingClientRect()
          const visible = rect.width > 0 && rect.height > 0
          const id = e.id || ''
          // Skip if already captured as standard element
          if (id && results.some(r => r.id === id)) return
          results.push({
            tag: e.tagName.toLowerCase(),
            id,
            name: e.getAttribute('name') || '',
            type: 'aria-' + role,
            role,
            ariaLabel: e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || '',
            placeholder: e.getAttribute('placeholder') || '',
            value: (e as HTMLInputElement).value?.slice(0, 100) || e.textContent?.slice(0, 100) || '',
            visible,
            readOnly: e.getAttribute('aria-readonly') === 'true' || (e as HTMLInputElement).readOnly || false,
            disabled: e.getAttribute('aria-disabled') === 'true' || (e as HTMLInputElement).disabled,
          })
        })
      })

      return results
    })

    console.log('\n=== ALL INTERACTIVE ELEMENTS ===')
    console.log(JSON.stringify(elements, null, 2))

    // Save page HTML
    const html = await page.content()
    const outPath = path.resolve(process.cwd(), 'public/debug-startup-form.html')
    fs.writeFileSync(outPath, html)
    console.log('\nFull HTML saved to:', outPath)

    // Count visible vs hidden
    const visible = elements.filter(e => e.visible && !e.disabled)
    const hidden = elements.filter(e => !e.visible || e.disabled)
    console.log(`\nTotal elements: ${elements.length} (${visible.length} visible, ${hidden.length} hidden/disabled)`)

  } finally {
    await browser.close()
    await steel.sessions.release(session.id).catch(() => {})
    console.log('\nSession released.')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
