import { chromium } from 'playwright'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { UserProfile } from './userProfile'
import type { ApplicationResult } from './applyEngine'
import { extractResumeText } from './resumeParser'
import { generateFieldAnswer, generateSalaryAnswer } from './aiFormFill'
import { prisma } from './db'
import { ApplicationStatus } from '@prisma/client'

const TOTAL_TIMEOUT_MS = 60_000
const MAX_STEPS = 8

const SUCCESS_PATTERNS = [
  /thank\s*you/i,
  /application\s*received/i,
  /application\s*submitted/i,
  /successfully\s*applied/i,
  /we.ll\s*be\s*in\s*touch/i,
  /we\s*have\s*received\s*your/i,
]

const CAPTCHA_PATTERNS = /captcha|recaptcha|hcaptcha|verify you are human|checking if the site connection is secure|just a moment|enable javascript and cookies/i
const CLOUDFLARE_PATTERNS = /checking if the site connection is secure|verify you are human|ray id:/i

// ── Field descriptor ─────────────────────────────────────────────────────────

export interface FieldDescriptor {
  selector: string
  label: string
  tagName: string
  inputType: string | null
  required: boolean
  options?: string[]           // for <select> and radio groups
}

type Bucket = 'A' | 'B' | 'C'

interface ClassifiedField {
  field: FieldDescriptor
  bucket: Bucket
  // Bucket A: direct value from profile
  profileValue?: string
  // Bucket B: question to pass to Claude
  question?: string
  // Bucket C: label to show the user
}

// ── Bucket A pattern matching ────────────────────────────────────────────────

const BUCKET_A_PATTERNS: Array<{
  pattern: RegExp
  resolve: (p: UserProfile) => string
}> = [
  { pattern: /first\s*name/i,                 resolve: p => p.firstName },
  { pattern: /last\s*name/i,                  resolve: p => p.lastName },
  { pattern: /full\s*name|your\s*name/i,      resolve: p => `${p.firstName} ${p.lastName}` },
  { pattern: /email/i,                        resolve: p => p.email },
  { pattern: /phone|mobile/i,                 resolve: p => p.phone },
  { pattern: /linkedin/i,                     resolve: p => p.linkedin },
  { pattern: /github/i,                       resolve: p => p.github },
  { pattern: /location|city|where\s*are\s*you/i, resolve: p => p.location },
  { pattern: /password|confirm\s*pass/i,      resolve: p => p.applicationPassword ?? '' },
]

const BUCKET_B_PATTERNS: RegExp[] = [
  /years?\s*of\s*exp/i,
  /salary|compensation|pay\s*expect/i,
  /work\s*auth|authorized\s*to\s*work|sponsorship/i,
  /why\s*(do\s*you\s*want|are\s*you\s*interested|[a-z]+\?)/i,
  /what\s*interests\s*you/i,
  /tell\s*us\s*about/i,
  /describe\s*your/i,
  /how\s*did\s*you\s*(hear|find|learn)/i,
  /relocat/i,
  /visa/i,
  /cover\s*letter/i,
  /about\s*yourself/i,
  /culture|values/i,
  /background/i,
  /experience\s*with/i,
  /greatest\s*strength/i,
  /challenge/i,
  /accomplishment/i,
]

// Fields that are 100% impossible to auto-generate
const BUCKET_C_PATTERNS: RegExp[] = [
  /reference|referenc/i,
  /portfolio\s*url|portfolio\s*link/i,
  /current\s*employer|current\s*company/i,
  /manager.s?\s*name|supervisor/i,
]

// ── Field extraction ─────────────────────────────────────────────────────────

async function extractAllFields(page: import('playwright').Page): Promise<FieldDescriptor[]> {
  return page.evaluate(() => {
    const results: FieldDescriptor[] = []
    const seen = new Set<string>()

    const elements = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select'
    )

    for (const el of Array.from(elements)) {
      const htmlEl = el as HTMLElement
      const rect = htmlEl.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue

      const id = el.getAttribute('id') ?? ''
      const name = el.getAttribute('name') ?? ''
      const inputType = el.getAttribute('type')
      const tagName = el.tagName.toLowerCase()

      // Build a stable selector
      let selector = ''
      if (id) {
        selector = `#${CSS.escape(id)}`
      } else if (name) {
        selector = `${tagName}[name="${name}"]`
      } else {
        continue // can't reliably target this element
      }

      if (seen.has(selector)) continue
      seen.add(selector)

      // Resolve label text
      let label = el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? ''
      if (!label && id) {
        const lbl = document.querySelector(`label[for="${id}"]`)
        if (lbl) label = lbl.textContent?.trim() ?? ''
      }
      if (!label) {
        const parent = el.closest('label')
        if (parent) label = parent.textContent?.trim() ?? ''
      }
      if (!label) {
        const prev = el.previousElementSibling
        if (prev?.tagName === 'LABEL') label = prev.textContent?.trim() ?? ''
      }

      const required =
        el.hasAttribute('required') ||
        el.getAttribute('aria-required') === 'true' ||
        !!el.closest('[data-required]') ||
        !!(el.previousElementSibling?.textContent?.includes('*'))

      // Collect options for selects
      const options: string[] = []
      if (tagName === 'select') {
        for (const opt of Array.from((el as HTMLSelectElement).options)) {
          if (opt.value) options.push(opt.text.trim())
        }
      }

      results.push({ selector, label, tagName, inputType, required, options })
    }

    return results
  })
}

// ── Bucket classification ─────────────────────────────────────────────────────

function classifyFields(fields: FieldDescriptor[], profile: UserProfile): ClassifiedField[] {
  return fields.map(field => {
    const label = field.label || field.selector

    // File upload → always Bucket A (resume)
    if (field.inputType === 'file') {
      return { field, bucket: 'A' as Bucket, profileValue: '__RESUME__' }
    }

    // Check Bucket C first (impossible to generate)
    for (const pattern of BUCKET_C_PATTERNS) {
      if (pattern.test(label)) {
        return { field, bucket: 'C' as Bucket }
      }
    }

    // Check Bucket A (direct from profile)
    for (const { pattern, resolve } of BUCKET_A_PATTERNS) {
      if (pattern.test(label)) {
        return { field, bucket: 'A' as Bucket, profileValue: resolve(profile) }
      }
    }

    // Check Bucket B (AI generated)
    for (const pattern of BUCKET_B_PATTERNS) {
      if (pattern.test(label)) {
        return { field, bucket: 'B' as Bucket, question: label }
      }
    }

    // Unknown required field → Bucket C
    if (field.required) {
      return { field, bucket: 'C' as Bucket }
    }

    // Unknown optional field → Bucket B (attempt with AI)
    return { field, bucket: 'B' as Bucket, question: label }
  })
}

// ── Wellfound-specific field map ─────────────────────────────────────────────

function classifyWellfoundFields(profile: UserProfile): ClassifiedField[] {
  const make = (selector: string, label: string, bucket: Bucket, profileValue?: string, question?: string): ClassifiedField => ({
    field: { selector, label, tagName: 'input', inputType: 'text', required: true },
    bucket,
    profileValue,
    question,
  })

  return [
    make('input[name="name"]',            'Full Name',                   'A', `${profile.firstName} ${profile.lastName}`),
    make('input[name="email"]',           'Email',                       'A', profile.email),
    make('input[name="password"]',        'Password',                    'A', profile.applicationPassword),
    make('input[name="password_confirmation"]', 'Confirm Password',      'A', profile.applicationPassword),
    make('input[name="location"]',        'Location',                    'A', profile.location),
    make('input[name="linkedin_url"]',    'LinkedIn',                    'A', profile.linkedin),
    make('select[name="years_experience"]', 'Years of Experience',       'B', undefined, 'Years of experience'),
    make('input[name="salary"]',          'Desired Salary',              'B', undefined, 'Desired salary'),
    make('textarea[name="why_company"]',  'Why this company?',           'B', undefined, 'Why are you interested in this company?'),
    make('textarea[name="culture_fit"]',  'Culture question',            'B', undefined, 'How do you fit our culture?'),
    make('textarea[name="visa_sponsorship"]', 'Visa sponsorship',        'B', undefined, 'Do you need visa sponsorship? Please explain.'),
    make('input[type="file"]',            'Resume',                      'A', '__RESUME__'),
  ]
}

// ── Fill a single field ───────────────────────────────────────────────────────

async function fillField(
  page: import('playwright').Page,
  classified: ClassifiedField,
  profile: UserProfile,
  resumeText: string,
  job: { role: string; company: string; description: string; location: string },
  tempFiles: string[],
  userAnswers: Record<string, string>,
): Promise<void> {
  const { field, bucket, profileValue, question } = classified
  const { selector } = field

  try {
    let value = ''

    if (bucket === 'A') {
      if (profileValue === '__RESUME__') {
        if (!profile.resumeBase64) return
        const base64 = profile.resumeBase64.includes(',')
          ? profile.resumeBase64.split(',')[1]
          : profile.resumeBase64
        const tmpPath = path.join(os.tmpdir(), `chiaro-resume-${Date.now()}.pdf`)
        fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'))
        tempFiles.push(tmpPath)
        await page.setInputFiles(selector, tmpPath, { timeout: 5000 })
        return
      }
      value = profileValue ?? ''
    } else if (bucket === 'B') {
      // Check if this is a salary question
      if (/salary|compensation|pay/i.test(question ?? '')) {
        value = await generateSalaryAnswer(job.role, job.location, profile.yearsExp)
      } else if (/years?\s*of\s*exp/i.test(question ?? '')) {
        // Map yearsExp range to a number for dropdowns
        const map: Record<string, string> = {
          '0-1': '0', '1-3': '2', '3-5': '4', '5-8': '6', '8-12': '10', '12+': '12'
        }
        value = map[profile.yearsExp] ?? '3'
      } else if (/work\s*auth|authorized/i.test(question ?? '')) {
        value = profile.workAuth === 'Need Sponsorship'
          ? 'No, I require sponsorship'
          : 'Yes, I am authorized to work in the United States'
      } else {
        value = await generateFieldAnswer(
          question ?? field.label,
          resumeText,
          job.description,
          job.role,
          job.company,
          profile,
        )
      }
    } else if (bucket === 'C') {
      // User-provided answers passed in
      value = userAnswers[field.label] ?? ''
      if (!value) return
    }

    if (!value) return

    // Fill based on field type
    if (field.tagName === 'select') {
      await page.selectOption(selector, { label: value }, { timeout: 3000 }).catch(async () => {
        // Try matching by value if label fails
        await page.selectOption(selector, value, { timeout: 3000 }).catch(() => {})
      })
    } else if (field.inputType === 'checkbox') {
      if (value === 'true' || value === 'yes' || value === 'check') {
        await page.check(selector, { timeout: 3000 })
      }
    } else if (field.inputType === 'radio') {
      await page.check(`${selector}[value="${value}"]`, { timeout: 3000 }).catch(() => {})
    } else {
      await page.fill(selector, value, { timeout: 3000 })
    }
  } catch {
    // Non-fatal — skip fields we can't fill
  }
}

// ── Screenshot helper ─────────────────────────────────────────────────────────

async function takeScreenshot(page: import('playwright').Page, applicationId: string): Promise<string> {
  const screenshotsDir = path.join(process.cwd(), 'public', 'screenshots')
  fs.mkdirSync(screenshotsDir, { recursive: true })
  const screenshotPath = path.join(screenshotsDir, `${applicationId}.png`)
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
  return `/screenshots/${applicationId}.png`
}

// ── Main entry ────────────────────────────────────────────────────────────────

export interface BrowserApplyResult extends ApplicationResult {
  screenshotUrl?: string
  pendingQuestions?: Array<{ fieldLabel: string; fieldType: string; selector: string }>
}

export async function browserApply(
  applyUrl: string,
  profile: UserProfile,
  applicationId: string,
  userAnswers: Record<string, string> = {},
): Promise<BrowserApplyResult> {
  const tempFiles: string[] = []
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null

  const run = async (): Promise<BrowserApplyResult> => {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
      ],
    })
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })

    // Spoof navigator.webdriver before any page script runs
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Array
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Promise
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).cdc_adoQpoasnfa76pfcZLmcfl_Symbol
    })

    const page = await context.newPage()

    // Navigate
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(3000).catch(() => {})

    // Cloudflare / CAPTCHA check
    const bodyText = await page.evaluate(() => document.body.innerText)
    if (CLOUDFLARE_PATTERNS.test(bodyText)) {
      const screenshotUrl = await takeScreenshot(page, applicationId)
      return {
        status: 'needs_review',
        errorMessage: 'Cloudflare bot protection blocked the request — Wellfound requires a real browser session. Complete this application manually.',
        applyUrl,
        screenshotUrl,
      }
    }
    if (CAPTCHA_PATTERNS.test(bodyText)) {
      return { status: 'needs_review', errorMessage: 'CAPTCHA detected — complete manually', applyUrl }
    }

    // Extract resume text once
    const resumeText = await extractResumeText(profile.resumeBase64 ?? '')

    const job = {
      role: '',
      company: '',
      description: '',
      location: '',
    }

    // Try to pull job info from DB for AI context
    try {
      const app = await prisma.application.findUnique({
        where: { id: applicationId },
        include: { job: true },
      })
      if (app?.job) {
        job.role = app.job.role
        job.company = app.job.company
        job.description = app.job.description
        job.location = app.job.location
      }
    } catch { /* non-fatal */ }

    for (let step = 0; step < MAX_STEPS; step++) {
      const currentText = await page.evaluate(() => document.body.innerText)

      // Success check
      if (SUCCESS_PATTERNS.some(p => p.test(currentText))) {
        const screenshotUrl = await takeScreenshot(page, applicationId)
        return { status: 'applied', applyUrl, screenshotUrl }
      }

      // Extract and classify fields (generic for all sites)
      const rawFields = await extractAllFields(page)

      if (rawFields.length === 0) break

      const classified = classifyFields(rawFields, profile)

      // Check for Bucket C fields
      const bucketC = classified.filter(c => c.bucket === 'C')
      const unansweredC = bucketC.filter(c => !userAnswers[c.field.label])

      if (unansweredC.length > 0) {
        const pendingQuestions = unansweredC.map(c => ({
          fieldLabel: c.field.label,
          fieldType: c.field.inputType ?? c.field.tagName,
          selector: c.field.selector,
        }))

        // Save cookies + URL for potential session context
        const cookies = await page.context().cookies()
        await prisma.pausedApplication.upsert({
          where: { applicationId },
          update: {
            pendingQuestions: JSON.stringify(pendingQuestions),
            pageUrl: page.url(),
            cookieState: JSON.stringify(cookies),
          },
          create: {
            applicationId,
            jobId: (await prisma.application.findUnique({ where: { id: applicationId }, select: { jobId: true } }))?.jobId ?? '',
            pendingQuestions: JSON.stringify(pendingQuestions),
            pageUrl: page.url(),
            cookieState: JSON.stringify(cookies),
          },
        })

        await prisma.application.update({
          where: { id: applicationId },
          data: { status: ApplicationStatus.NEEDS_INFO },
        })

        return {
          status: 'needs_review',
          errorMessage: 'Needs your input — answer the questions in your dashboard to continue',
          applyUrl,
          pendingQuestions,
        }
      }

      // Fill all Bucket A and B fields
      for (const c of classified.filter(c => c.bucket !== 'C')) {
        await fillField(page, c, profile, resumeText, job, tempFiles, userAnswers)
      }

      // Also fill any Bucket C fields that have user answers
      for (const c of bucketC.filter(c => userAnswers[c.field.label])) {
        await fillField(page, c, profile, resumeText, job, tempFiles, userAnswers)
      }

      // Look for Submit
      const submitBtn = await page.$(
        'button[type="submit"], input[type="submit"], ' +
        'button:has-text("Submit"), button:has-text("Apply Now"), button:has-text("Send Application"), ' +
        'button:has-text("Apply"), button:has-text("Submit Application"), button:has-text("Send"), ' +
        'button:has-text("Complete Application"), button:has-text("Finish")'
      )
      if (submitBtn) {
        await submitBtn.click()
        await page.waitForTimeout(3000)
        const finalText = await page.evaluate(() => document.body.innerText)
        const screenshotUrl = await takeScreenshot(page, applicationId)
        if (SUCCESS_PATTERNS.some(p => p.test(finalText))) {
          return { status: 'applied', applyUrl, screenshotUrl }
        }
        return {
          status: 'needs_review',
          errorMessage: 'Submitted — confirm success in screenshot',
          applyUrl,
          screenshotUrl,
        }
      }

      // Look for Next/Continue
      const nextBtn = await page.$(
        'button:has-text("Next"), button:has-text("Continue"), button:has-text("Proceed"), a:has-text("Next")'
      )
      if (!nextBtn) break
      await nextBtn.click()
      await page.waitForLoadState('domcontentloaded').catch(() => {})
      await page.waitForTimeout(1500)
    }

    const screenshotUrl = await takeScreenshot(page, applicationId)
    return {
      status: 'needs_review',
      errorMessage: 'Could not complete form — check screenshot',
      applyUrl,
      screenshotUrl,
    }
  }

  try {
    return await Promise.race([
      run(),
      new Promise<BrowserApplyResult>(resolve =>
        setTimeout(
          () => resolve({ status: 'needs_review', errorMessage: 'Timed out after 60s', applyUrl }),
          TOTAL_TIMEOUT_MS,
        )
      ),
    ])
  } catch (err) {
    return {
      status: 'failed',
      errorMessage: err instanceof Error ? err.message.split('\n')[0] : 'Browser error',
      applyUrl,
    }
  } finally {
    await (browser as Awaited<ReturnType<typeof chromium.launch>> | null)?.close()
    for (const f of tempFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
  }
}
