/**
 * Launches a headed Chromium with CDP debugging on port 9222 and navigates to
 * the Greenhouse job. Keeps running until killed. Other scripts connect via
 * chromium.connectOverCDP('http://localhost:9222') to drive the same browser.
 */
import { chromium } from 'playwright'

const URL = process.env.APPLY_URL ?? 'https://job-boards.eu.greenhouse.io/nice/jobs/4817745101?gh_jid=4817745101'
const CDP_PORT = 9222

async function main() {
  console.log(`Launching headed Chromium with CDP on :${CDP_PORT}`)
  const browser = await chromium.launchPersistentContext('/tmp/gh-verify-test-profile', {
    headless: false,
    args: [`--remote-debugging-port=${CDP_PORT}`],
    viewport: { width: 1366, height: 850 },
  })
  const page = browser.pages()[0] ?? await browser.newPage()
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  console.log(`\n✅ Browser ready. CDP endpoint: http://localhost:${CDP_PORT}`)
  console.log(`→ Fill the form and click Submit yourself until the verification screen appears.`)
  console.log(`→ Tell me when you can see the 8 boxes, then paste the code.\n`)

  // Keep alive until killed
  await new Promise(() => {})
}

main().catch(e => { console.error(e); process.exit(1) })
