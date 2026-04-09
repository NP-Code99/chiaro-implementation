import { chromium } from 'playwright'
import Anthropic from '@anthropic-ai/sdk'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { UserProfile } from './userProfile'
import type { ApplicationResult } from './applyEngine'

const TOTAL_TIMEOUT_MS = 30_000
const MAX_STEPS = 5

const SUCCESS_PATTERNS = [
  /thank\s*you/i,
  /application\s*received/i,
  /application\s*submitted/i,
  /successfully\s*applied/i,
  /we.ll\s*be\s*in\s*touch/i,
  /we\s*have\s*received\s*your/i,
]

const CAPTCHA_PATTERNS = /captcha|recaptcha|hcaptcha/i

interface FieldInfo {
  selector: string
  name: string | null
  id: string | null
  placeholder: string | null
  ariaLabel: string | null
  labelText: string | null
  tagName: string
  inputType: string | null
}

interface FieldMapping {
  selector: string
  value: string
  type: 'text' | 'select' | 'file' | 'checkbox'
}

async function extractFields(page: import('playwright').Page): Promise<FieldInfo[]> {
  return page.evaluate(() => {
    const results: FieldInfo[] = []
    const elements = document.querySelectorAll('input:not([type="hidden"]), textarea, select')

    for (const el of Array.from(elements)) {
      const htmlEl = el as HTMLElement
      const rect = htmlEl.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue // skip hidden

      // Find nearest label text
      let labelText: string | null = null
      const id = el.getAttribute('id')
      if (id) {
        const label = document.querySelector(`label[for="${id}"]`)
        if (label) labelText = label.textContent?.trim() ?? null
      }
      if (!labelText) {
        const parent = el.closest('label')
        if (parent) labelText = parent.textContent?.trim() ?? null
      }
      if (!labelText) {
        // look at previous sibling text
        const prev = el.previousElementSibling
        if (prev?.tagName === 'LABEL') labelText = prev.textContent?.trim() ?? null
      }

      results.push({
        selector: el.tagName === 'INPUT'
          ? (id ? `#${id}` : `input[name="${el.getAttribute('name')}"]`)
          : el.tagName === 'TEXTAREA'
            ? (id ? `#${id}` : `textarea[name="${el.getAttribute('name')}"]`)
            : (id ? `#${id}` : `select[name="${el.getAttribute('name')}"]`),
        name: el.getAttribute('name'),
        id,
        placeholder: el.getAttribute('placeholder'),
        ariaLabel: el.getAttribute('aria-label'),
        labelText,
        tagName: el.tagName.toLowerCase(),
        inputType: el.getAttribute('type'),
      })
    }

    return results
  })
}

interface FillabilityResult {
  canAutoFill: boolean
  blockerFields: string[]
}

async function checkFillability(fields: FieldInfo[]): Promise<FillabilityResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { canAutoFill: true, blockerFields: [] }

  const client = new Anthropic({ apiKey })

  const prompt = `Here are the form fields on a job application page:

${JSON.stringify(fields, null, 2)}

The applicant profile only has: full name, email, phone, LinkedIn URL, GitHub URL, location, and resume (file upload).

Return JSON with exactly this shape: { "canAutoFill": boolean, "blockerFields": string[] }

Set canAutoFill to false if any REQUIRED field (marked with *, "required", or clearly mandatory) cannot be filled from the profile above.

Examples of blocker fields: password, desired salary, years of experience, work authorization, cover letter, GPA, portfolio upload, security questions, custom essay questions.

Return ONLY the JSON object, no explanation.`

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return { canAutoFill: true, blockerFields: [] }

  try {
    return JSON.parse(jsonMatch[0]) as FillabilityResult
  } catch {
    return { canAutoFill: true, blockerFields: [] }
  }
}

async function askClaude(fields: FieldInfo[], profile: UserProfile): Promise<FieldMapping[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const client = new Anthropic({ apiKey })

  const profileForPrompt = { ...profile, resumeBase64: undefined }

  const prompt = `You are helping auto-fill a job application form. Here are the form fields on the page:

${JSON.stringify(fields, null, 2)}

Here is the applicant profile:

${JSON.stringify(profileForPrompt, null, 2)}

Return a JSON array where each item has:
- selector: CSS selector for the field (use the selector from the field list exactly)
- value: what to type or select
- type: "text", "select", "file", or "checkbox"

Only include fields you are confident about. Skip fields you do not recognize (like CAPTCHA, honeypot, or irrelevant fields).
For "file" type, only include if there is a resume/CV upload field.
Return ONLY the JSON array, no explanation.`

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []

  try {
    return JSON.parse(jsonMatch[0]) as FieldMapping[]
  } catch {
    return []
  }
}

async function fillFields(
  page: import('playwright').Page,
  mappings: FieldMapping[],
  profile: UserProfile,
  tempFiles: string[],
): Promise<void> {
  for (const mapping of mappings) {
    try {
      switch (mapping.type) {
        case 'text':
          await page.fill(mapping.selector, mapping.value, { timeout: 3000 })
          break
        case 'select':
          await page.selectOption(mapping.selector, mapping.value, { timeout: 3000 })
          break
        case 'checkbox':
          if (mapping.value === 'true' || mapping.value === 'check') {
            await page.check(mapping.selector, { timeout: 3000 })
          }
          break
        case 'file': {
          if (!profile.resumeBase64) break
          // Write base64 to temp file
          const [, b64] = profile.resumeBase64.split(',')
          if (!b64) break
          const tmpPath = path.join(os.tmpdir(), `chiaro-resume-${Date.now()}.pdf`)
          fs.writeFileSync(tmpPath, Buffer.from(b64, 'base64'))
          tempFiles.push(tmpPath)
          await page.setInputFiles(mapping.selector, tmpPath, { timeout: 3000 })
          break
        }
      }
    } catch {
      // Non-fatal — skip fields that can't be filled
    }
  }
}

export async function browserApply(
  applyUrl: string,
  profile: UserProfile,
  applicationId: string,
): Promise<ApplicationResult & { screenshotUrl?: string }> {
  const tempFiles: string[] = []
  let browser: import('playwright').Browser | null = null

  const run = async (): Promise<ApplicationResult & { screenshotUrl?: string }> => {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()

    // Navigate — use domcontentloaded; SPAs often never reach networkidle
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
    // Give JS frameworks a moment to render
    await page.waitForTimeout(2000).catch(() => {})

    // CAPTCHA check
    const bodyText = await page.evaluate(() => document.body.innerText)
    if (CAPTCHA_PATTERNS.test(bodyText)) {
      return {
        status: 'needs_review',
        errorMessage: 'CAPTCHA detected — complete manually',
        applyUrl,
      }
    }

    let submitted = false

    for (let step = 0; step < MAX_STEPS; step++) {
      const currentBodyText = await page.evaluate(() => document.body.innerText)

      // Check if we already landed on a success page
      if (SUCCESS_PATTERNS.some(p => p.test(currentBodyText))) {
        submitted = true
        break
      }

      // Extract fields
      const fields = await extractFields(page)
      if (fields.length === 0) break

      // Pre-flight: check if all required fields can be filled from basic profile
      if (step === 0) {
        const fillability = await checkFillability(fields)
        if (!fillability.canAutoFill) {
          const blockerList = fillability.blockerFields.join(', ')
          return {
            status: 'needs_review',
            errorMessage: `Application requires additional information — complete manually. Missing: ${blockerList}`,
            applyUrl,
            blockerFields: fillability.blockerFields,
          }
        }
      }

      const mappings = await askClaude(fields, profile)
      await fillFields(page, mappings, profile, tempFiles)

      // Look for Submit button first
      const submitBtn = await page.$(
        'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Apply")'
      )

      if (submitBtn) {
        await submitBtn.click()
        await page.waitForTimeout(2000)
        submitted = true
        break
      }

      // Look for Next/Continue to advance multi-step form
      const nextBtn = await page.$(
        'button:has-text("Next"), button:has-text("Continue"), button:has-text("Proceed"), a:has-text("Next")'
      )
      if (!nextBtn) break // No way forward

      await nextBtn.click()
      await page.waitForLoadState('networkidle').catch(() => {})
    }

    // Screenshot
    const screenshotsDir = path.join(process.cwd(), 'public', 'screenshots')
    fs.mkdirSync(screenshotsDir, { recursive: true })
    const screenshotPath = path.join(screenshotsDir, `${applicationId}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true })
    const screenshotUrl = `/screenshots/${applicationId}.png`

    // Check final page for success
    const finalText = await page.evaluate(() => document.body.innerText)
    const success = submitted && SUCCESS_PATTERNS.some(p => p.test(finalText))

    if (success) {
      return { status: 'applied', applyUrl, screenshotUrl }
    }

    if (submitted) {
      // Submitted but couldn't confirm — treat as needs_review with screenshot
      return {
        status: 'needs_review',
        errorMessage: 'Form submitted but could not confirm success — check screenshot',
        applyUrl,
        screenshotUrl,
      }
    }

    return {
      status: 'needs_review',
      errorMessage: 'Could not complete form — manual review required',
      applyUrl,
      screenshotUrl,
    }
  }

  try {
    const result = await Promise.race([
      run(),
      new Promise<ApplicationResult & { screenshotUrl?: string }>((resolve) =>
        setTimeout(
          () => resolve({ status: 'needs_review', errorMessage: 'Timed out after 30s', applyUrl }),
          TOTAL_TIMEOUT_MS,
        )
      ),
    ])
    return result
  } catch (err) {
    // Best-effort screenshot even on error
    let screenshotUrl: string | undefined
    try {
      const page = (browser as import('playwright').Browser | null)
        ?.contexts()[0]?.pages()[0]
      if (page) {
        const screenshotsDir = path.join(process.cwd(), 'public', 'screenshots')
        fs.mkdirSync(screenshotsDir, { recursive: true })
        const screenshotPath = path.join(screenshotsDir, `${applicationId}-err.png`)
        await page.screenshot({ path: screenshotPath, fullPage: true })
        screenshotUrl = `/screenshots/${applicationId}-err.png`
      }
    } catch { /* ignore screenshot errors */ }
    return {
      status: 'needs_review',
      errorMessage: err instanceof Error ? err.message.split('\n')[0] : 'Browser automation error',
      applyUrl,
      screenshotUrl,
    }
  } finally {
    await (browser as import('playwright').Browser | null)?.close()
    for (const f of tempFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
  }
}
