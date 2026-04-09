import path from 'path'
import type { ApplicantData } from '../ats/types'
import type { SubmissionResult } from '../ats/types'
import { identifyFormFields, validateSelectors } from './claude-form-filler'

const MAX_RETRIES = 2
const PAGE_TIMEOUT = 30_000

export async function submitWithPlaywright(
  applyUrl: string,
  applicant: ApplicantData
): Promise<SubmissionResult> {
  // Dynamic import so Playwright is only loaded when needed
  let chromium: typeof import('playwright').chromium
  try {
    const pw = await import('playwright')
    chromium = pw.chromium
  } catch {
    return { success: false, error: 'Playwright is not installed. Run: npx playwright install chromium' }
  }

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  })
  const page = await context.newPage()

  try {
    await page.goto(applyUrl, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT })

    let attempt = 0
    while (attempt < MAX_RETRIES) {
      // Take screenshot
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: false })
      const screenshotBase64 = screenshotBuffer.toString('base64')

      // Get DOM
      const domHtml = await page.evaluate(() => document.body.innerHTML)

      // Ask Claude to identify fields
      const { fields, submitSelector } = await identifyFormFields(screenshotBase64, domHtml, applicant)

      // Validate selectors
      const validFields = await validateSelectors(fields, async (selector) => {
        try {
          const el = await page.$(selector)
          return el !== null
        } catch {
          return false
        }
      })

      if (validFields.length === 0) {
        attempt++
        if (attempt >= MAX_RETRIES) {
          return { success: false, error: 'Could not identify form fields after retries. Needs manual review.' }
        }
        continue
      }

      // Fill fields
      for (const field of validFields) {
        try {
          if (field.type === 'file' && applicant.resumePath) {
            const absolutePath = path.join(process.cwd(), 'public', applicant.resumePath.replace(/^\//, ''))
            await page.setInputFiles(field.selector, absolutePath)
          } else if (field.type === 'select') {
            await page.selectOption(field.selector, field.value)
          } else if (field.type === 'checkbox') {
            const checked = await page.$eval(field.selector, (el: HTMLInputElement) => el.checked)
            if (!checked && field.value === 'true') {
              await page.click(field.selector)
            }
          } else {
            await page.fill(field.selector, field.value)
          }
        } catch {
          // Non-fatal — continue with other fields
        }
      }

      // Submit
      if (submitSelector) {
        try {
          await page.click(submitSelector, { timeout: 5000 })
          await page.waitForNavigation({ timeout: 10000, waitUntil: 'networkidle' }).catch(() => {
            // Some forms use AJAX — navigation may not happen
          })
          return { success: true }
        } catch (err) {
          return { success: false, error: `Submit button click failed: ${err instanceof Error ? err.message : 'unknown'}` }
        }
      }

      // No submit selector found — mark for review
      return { success: false, error: 'Form filled but could not identify submit button. Needs manual review.' }
    }

    return { success: false, error: 'Max retries exceeded' }
  } finally {
    await browser.close()
  }
}
