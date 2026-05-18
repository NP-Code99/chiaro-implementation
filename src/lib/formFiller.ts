/**
 * formFiller.ts — Wellfound application form filler
 *
 * Strategy:
 *   1. Fill email, then detect login state (new_user | existing_wellfound |
 *      existing_google | unknown).
 *   2. Route to one of three pathway handlers:
 *        Pathway 1 — new_user / unknown: fill full form (existing logic)
 *        Pathway 2 — existing_wellfound: enter Wellfound password to log in
 *        Pathway 3 — existing_google: click Google button and fill Google login
 *   3. After login (pathways 2 & 3), re-fill any remaining application fields.
 *   4. Run pre-submit required-field verification.
 *   5. Take staged screenshots at every decision point.
 *
 * Does NOT touch Steel session creation, Scrapfly, CapSolver, or CF bypass.
 */

import Anthropic from '@anthropic-ai/sdk'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { UserProfile } from './userProfile'
import type { Page } from 'playwright'
import { getValidSession, saveSession, invalidateSession } from './sessionManager'
import { prisma } from './db'
import { ApplicationStatus } from './prismaEnums'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FormFillerJob {
  role: string
  company: string
  description: string
  location: string
}

export type LoginPathway = 'new_user' | 'existing_wellfound' | 'google' | 'unknown'
export type LoginState = 'new_user' | 'existing_wellfound' | 'existing_google' | 'unknown'

export interface FillResult {
  success: boolean
  unfilledFields: string[]
  loginPathway?: LoginPathway
  /** Human-readable message for needs_review status */
  message?: string
  error?: 'existing_account' | 'claude_mapping_failed' | 'no_fields_found' | 'verification_failed' | 'datadome' | string
  /** Set when error === 'datadome' — the intercepted captcha-delivery.com URL for CapSolver */
  dataDomeCaptchaUrl?: string
}

export type TwoFAType = 'email_code' | 'sms_code' | 'authenticator' | 'phone_prompt' | null

export interface TwoFAResult {
  required: boolean
  type: TwoFAType
}

// ── Constants ─────────────────────────────────────────────────────────────────

const SCREENSHOT_DIR = path.join(process.cwd(), 'public', 'screenshots')

const YEARS_EXP_MAP: Record<string, string> = {
  '0-1': '1 Year',
  '1-3': '3 Years',
  '3-5': '5 Years',
  '5-8': '8 Years',
  '8-12': '12 Years',
  '12+': '12 Years',
}

const EXISTING_ACCOUNT_PHRASES = [
  'already have an account',
  'already exists',
  'account already exists',
  'email already registered',
  'email already in use',
  'already registered',
  'existing account',
  'log in instead',
  'sign in instead',
  'user already exists',
  'welcome back',
  'log back in',
  'sign back in',
]

const NEW_USER_PHRASES = [
  'set a password',
  'create a password',
  'create your account',
  'confirm password',
  'set your password',
  'join wellfound',
  'new account',
]

const GOOGLE_PHRASES = [
  'continue with google',
  'sign in with google',
  'log in with google',
  'google account',
]

// ── 2FA detection ─────────────────────────────────────────────────────────────

const TWO_FA_EMAIL_PHRASES = [
  'verification code', 'check your email', 'code sent to',
  'enter the code', 'confirm your email', 'we emailed you',
]
const TWO_FA_SMS_PHRASES = [
  'text message', 'sms code', 'sent to your phone',
  'mobile number', 'phone number ending',
]
const TWO_FA_AUTH_PHRASES = [
  'authenticator app', 'google authenticator',
  'authy', 'totp', '6-digit code from your',
]
const TWO_FA_PHONE_PHRASES = [
  'check your phone', 'tap yes on your phone',
  'google prompt', 'phone notification',
  'sent a notification to your phone',
]

/**
 * Detects whether a 2FA/verification challenge is present on the page.
 * Pure function — unit-testable. Pass page.evaluate() result as pageText.
 */
export async function detect2FA(_page: Page, pageText: string): Promise<TwoFAResult> {
  const text = pageText.toLowerCase()

  if (TWO_FA_EMAIL_PHRASES.some(p => text.includes(p))) {
    return { required: true, type: 'email_code' }
  }
  if (TWO_FA_SMS_PHRASES.some(p => text.includes(p))) {
    return { required: true, type: 'sms_code' }
  }
  if (TWO_FA_AUTH_PHRASES.some(p => text.includes(p))) {
    return { required: true, type: 'authenticator' }
  }
  if (TWO_FA_PHONE_PHRASES.some(p => text.includes(p))) {
    return { required: true, type: 'phone_prompt' }
  }

  return { required: false, type: null }
}

/**
 * Returns a user-facing message explaining what verification action is needed.
 */
export function getVerificationMessage(type: TwoFAType, company: string): string {
  switch (type) {
    case 'email_code':
      return `Verification required for ${company} application. Check your email for a verification code and enter it in the Chiaro dashboard within 10 minutes.`
    case 'sms_code':
      return `Verification required for ${company} application. Check your phone for an SMS code and enter it in the Chiaro dashboard within 10 minutes.`
    case 'authenticator':
      return `Your authenticator app is required to complete the ${company} application. Open your authenticator app and enter the 6-digit code in the Chiaro dashboard within 10 minutes.`
    case 'phone_prompt':
      return `Check your phone — a sign-in prompt was sent to verify the ${company} application. Tap Yes on your phone, then return to Chiaro.`
    default:
      return `Verification required for ${company} application. Please check the Chiaro dashboard within 10 minutes.`
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Classifies login state from page text and optional error text near email field.
 * Pure — unit-testable. Called internally by async detectLoginState().
 */
export function classifyLoginState(
  pageText: string,
  errorText: string,
): { state: LoginState; evidence: string } {
  const page = pageText.toLowerCase()
  const err = errorText.toLowerCase()

  // Check error text first — most reliable indicator on Wellfound
  if (EXISTING_ACCOUNT_PHRASES.some(p => err.includes(p))) {
    // If Google is also mentioned, it's a Google-linked account
    if (GOOGLE_PHRASES.some(p => page.includes(p))) {
      return { state: 'existing_google', evidence: `Error text: ${errorText}` }
    }
    return { state: 'existing_wellfound', evidence: `Error text: ${errorText}` }
  }

  // Fall back to full page content
  if (EXISTING_ACCOUNT_PHRASES.some(p => page.includes(p))) {
    if (GOOGLE_PHRASES.some(p => page.includes(p))) {
      return { state: 'existing_google', evidence: 'Page suggests Google login for existing account' }
    }
    return { state: 'existing_wellfound', evidence: 'Page content indicates existing account' }
  }

  if (NEW_USER_PHRASES.some(p => page.includes(p))) {
    return { state: 'new_user', evidence: 'New user form visible' }
  }

  return { state: 'unknown', evidence: 'Could not determine state' }
}

/** Parses Claude's JSON response, strips markdown fences. Pure — unit-testable. */
export function parseClaudeResponse(raw: string): string {
  const cleaned = raw.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/gi, '').trim()
  return cleaned
}

// ── Utilities ─────────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Detects whether DataDome's slider captcha is currently blocking the page.
 * DataDome renders inside an iframe so document.body.innerText is nearly empty,
 * but the outer HTML contains captcha-delivery.com script/frame src references.
 *
 * Returns the captcha-delivery.com URL to pass to CapSolver, or null if clear.
 * The URL is extracted from the iframe src — it contains the challenge parameters.
 */
async function detectDataDomeCaptchaUrl(page: Page): Promise<string | null> {
  try {
    const html = await page.content()
    const hasDd =
      html.includes('captcha-delivery.com') ||
      html.includes('datadome') ||
      html.toLowerCase().includes('slide right to secure')
    if (!hasDd) return null

    // Extract the full captcha-delivery.com URL (iframe src or script src)
    const match = html.match(/https?:\/\/[^"'\s]*captcha-delivery\.com[^"'\s]*/)?.[0]
    if (match) {
      // Strip any HTML-encoded ampersands
      return match.replace(/&amp;/g, '&')
    }
    // DataDome present but couldn't extract URL — return a sentinel
    return 'datadome-detected'
  } catch {
    return null
  }
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

async function snap(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true }).catch(() => {})
  console.log(`[formFiller] Screenshot saved: ${name}.png`)
}

async function humanType(page: Page, locator: import('playwright').Locator, text: string, delayMs = 60): Promise<void> {
  try {
    await locator.click({ timeout: 4000 })
    await sleep(300)
    await locator.selectText().catch(() => {})
    await page.keyboard.press('Delete')
    await sleep(100)
    for (const char of text) {
      await page.keyboard.type(char)
      await sleep(randomInt(Math.max(20, delayMs - 20), delayMs + 30))
    }
    await sleep(300)
  } catch {
    await locator.fill(text, { timeout: 4000 }).catch(() => {})
  }
}

async function findField(
  page: Page,
  strategies: Array<() => import('playwright').Locator>,
): Promise<import('playwright').Locator | null> {
  for (const strategy of strategies) {
    try {
      const loc = strategy()
      const visible = await loc.isVisible({ timeout: 1500 }).catch(() => false)
      if (visible) return loc
    } catch { /* try next */ }
  }
  return null
}

// ── Async login state detection ───────────────────────────────────────────────

/**
 * Detects login state by inspecting the live page after email entry.
 * Checks red/error text near the email field first, then falls back to page content.
 */
async function detectLoginState(page: Page): Promise<{ state: LoginState; evidence: string }> {
  await sleep(2000)

  // Extract error text near the email field
  const errorText = await page.evaluate(() => {
    const emailEl = document.querySelector(
      'input[type="email"], input[name*="email"], input[placeholder*="email"]'
    ) as HTMLElement | null
    if (!emailEl) return ''

    const parent = emailEl.closest('div, section, fieldset')
    if (!parent) return ''

    // Look for explicit error/hint elements
    const errorEl = parent.querySelector(
      '[class*="error"], [class*="invalid"], [class*="hint"], ' +
      '[class*="warning"], [role="alert"], [aria-live], ' +
      'p[style*="red"], span[style*="red"], small[style*="red"]'
    )
    if (errorEl) return errorEl.textContent?.trim() ?? ''

    // Fall back to scanning for red-colored text near the field
    const candidates = Array.from(parent.querySelectorAll('p, span, small, div'))
    for (const el of candidates) {
      const style = window.getComputedStyle(el)
      const color = style.color
      if (color && (color.includes('rgb(') || color.toLowerCase().includes('red'))) {
        const text = el.textContent?.trim() ?? ''
        if (text.length > 0 && text.length < 200) return text
      }
    }
    return ''
  }).catch(() => '')

  console.log('[formFiller] Error text near email field:', errorText || 'none')

  const pageText = await page.evaluate(() => document.body.innerText).catch(() => '')

  return classifyLoginState(pageText, errorText)
}

// ── Claude: cover letter generation ──────────────────────────────────────────

let _anthropicClient: Anthropic | null = null

function getAnthropicClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key || key.length < 20) {
    console.warn('[formFiller] ANTHROPIC_API_KEY missing or invalid — cover letter will use template fallback')
    return null
  }
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic({ apiKey: key })
  }
  return _anthropicClient
}

async function generateCoverLetter(profile: UserProfile, job: FormFillerJob): Promise<string> {
  const client = getAnthropicClient()

  if (client) {
    try {
      const prompt = `Write a 2-3 sentence answer for the question "What interests you about working for this company?" for a job application.

Candidate background: ${profile.bio || `${profile.yearsExp} years of experience, ${profile.workAuth}`}
Company: ${job.company}
Role: ${job.role}
Job description (first 800 chars): ${job.description.slice(0, 800)}

Rules:
- Be SPECIFIC to this company and role. Mention the company name.
- Do NOT use generic phrases like "I'm passionate about" or "I would love to".
- Speak directly from the candidate's background.
- 2-3 sentences maximum.

Return ONLY the answer text, nothing else.`

      const message = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      })

      const text = message.content[0].type === 'text' ? message.content[0].text.trim() : ''
      if (text) {
        console.log('[formFiller] Claude generated cover letter')
        return text
      }
    } catch (err) {
      console.warn('[formFiller] Claude cover letter generation failed:', err instanceof Error ? err.message : String(err))
    }
  }

  const bio = profile.bio
    ? `${profile.bio} `
    : `With ${profile.yearsExp} years of experience, `
  return `${bio}I'm drawn to ${job.company}'s work on the ${job.role} role and believe my background aligns well with what the team is building. I'm excited about the opportunity to contribute directly to the company's goals.`
}

// ── Pre-submit verification ───────────────────────────────────────────────────

async function verifyRequiredFields(page: Page): Promise<{ allFilled: boolean; missingFields: string[] }> {
  const missing = await page.evaluate(() => {
    const missingFields: string[] = []

    document.querySelectorAll('input[required], textarea[required], select[required]').forEach(el => {
      const inputEl = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      const type = el.getAttribute('type')

      if (type === 'file') return

      if (type === 'radio') {
        const name = el.getAttribute('name') ?? ''
        const anyChecked = document.querySelector(`input[type="radio"][name="${name}"]:checked`)
        if (!anyChecked) {
          const id = el.getAttribute('id') || name
          const labelText = document.querySelector(`label[for="${id}"]`)?.textContent?.trim() || name
          if (!missingFields.includes(labelText)) missingFields.push(labelText)
        }
        return
      }

      const value = inputEl.value?.trim()
      if (!value || value === '' || value === 'Select') {
        const id = el.getAttribute('id') ?? ''
        const labelText = (
          document.querySelector(`label[for="${id}"]`)?.textContent?.trim() ||
          el.getAttribute('placeholder') ||
          el.getAttribute('name') ||
          'unknown field'
        )
        missingFields.push(labelText)
      }
    })

    return missingFields
  })

  return { allFilled: missing.length === 0, missingFields: missing }
}

/**
 * Runs required-field verification and returns a FillResult.
 * Called at the end of every pathway.
 */
async function verifyAndSubmit(
  page: Page,
  pfx: string,
  loginPathway: LoginPathway,
  coverLetterText: string,
  profile: UserProfile,
): Promise<FillResult> {
  // ── DataDome guard: last check before submit ──────────────────────────────
  // DataDome can appear after textarea/cover-letter interaction.
  {
    const ddUrl = await detectDataDomeCaptchaUrl(page)
    if (ddUrl) {
      console.warn('[formFiller] DataDome detected before submit — returning for CapSolver solve')
      await snap(page, `${pfx}-datadome-pre-submit`)
      return { success: false, error: 'datadome', dataDomeCaptchaUrl: ddUrl, unfilledFields: ['submit'] }
    }
  }

  const fullName = `${profile.firstName} ${profile.lastName}`.trim()
  const salary = profile.desiredSalary?.replace(/[^0-9]/g, '') || '120000'
  const verification = await verifyRequiredFields(page)
  console.log(`[formFiller] Verification: allFilled=${verification.allFilled}, missing=${JSON.stringify(verification.missingFields)}`)

  if (!verification.allFilled) {
    console.warn('[formFiller] Missing required fields:', verification.missingFields)
    await snap(page, `${pfx}-pre-submit-incomplete`)

    for (const missingLabel of verification.missingFields) {
      console.log(`[formFiller] Retry filling: "${missingLabel}"`)
      const retryField = await findField(page, [
        () => page.getByLabel(new RegExp(missingLabel, 'i')).first(),
        () => page.locator(`[placeholder*="${missingLabel}"]`).first(),
      ])
      if (retryField) {
        const tag = await retryField.evaluate(el => el.tagName.toLowerCase()).catch(() => 'input')
        if (tag === 'textarea') {
          await retryField.fill(coverLetterText).catch(() => {})
        } else {
          const fill = missingLabel.toLowerCase().includes('name') ? fullName
            : missingLabel.toLowerCase().includes('email') ? profile.email
            : missingLabel.toLowerCase().includes('salary') ? salary
            : missingLabel.toLowerCase().includes('location') ? profile.location
            : ''
          await retryField.fill(fill).catch(() => {})
        }
        await sleep(600)
      }
    }

    const retryCheck = await verifyRequiredFields(page)
    if (!retryCheck.allFilled) {
      console.warn('[formFiller] Still missing after retry:', retryCheck.missingFields)
      await snap(page, `${pfx}-pre-submit-still-incomplete`)
      return {
        success: false,
        unfilledFields: retryCheck.missingFields,
        loginPathway,
        error: 'verification_failed',
      }
    }
  }

  console.log('[formFiller] All required fields verified')
  await snap(page, `${pfx}-pre-submit`)
  return { success: true, unfilledFields: [], loginPathway }
}

// ── 2FA handler ───────────────────────────────────────────────────────────────

/**
 * Pauses the application in the DB, waits for the user to supply a verification
 * code via the dashboard (/api/applications/[id]/verify), then submits it.
 * Times out after 10 minutes and returns a needs_review result.
 */
async function handle2FA(
  page: Page,
  profile: UserProfile,
  job: FormFillerJob,
  applicationId: string,
  pfx: string,
  verification: TwoFAResult,
): Promise<FillResult> {
  await snap(page, `${pfx}-2fa-detected`)
  console.log('[formFiller] 2FA required, type:', verification.type)

  const userMessage = getVerificationMessage(verification.type, job.company)

  // Mark the application as verification_pending and set a 10-minute window
  await prisma.application.update({
    where: { id: applicationId },
    data: {
      status: ApplicationStatus.VERIFICATION_PENDING,
      errorMessage: `2FA required: ${verification.type ?? 'unknown'}`,
      verificationCode: null,
      verificationExpiry: new Date(Date.now() + 10 * 60 * 1000),
    },
  }).catch(err => {
    // Non-fatal — log and continue polling (applicationId may be 'app' in dev)
    console.warn('[formFiller] Could not update application status to VERIFICATION_PENDING:', err instanceof Error ? err.message : String(err))
  })

  // Poll every 5 seconds for up to 10 minutes
  const startTime = Date.now()
  const timeoutMs = 10 * 60 * 1000
  let verificationCode: string | null = null

  while (Date.now() - startTime < timeoutMs) {
    await sleep(5000)

    try {
      const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { verificationCode: true },
      })
      if (app?.verificationCode) {
        verificationCode = app.verificationCode
        console.log('[formFiller] 2FA code received from user')
        break
      }
    } catch {
      // DB not accessible in this context — continue
    }
  }

  if (!verificationCode) {
    return {
      success: false,
      unfilledFields: [],
      loginPathway: 'unknown',
      error: 'existing_account',
      message: `${userMessage} Verification timed out after 10 minutes. Please apply manually.`,
    }
  }

  // Enter the verification code
  const codeInput = await page.$(
    'input[autocomplete="one-time-code"], input[name*="code"], ' +
    'input[placeholder*="code"], input[type="text"][maxlength]'
  )

  if (codeInput) {
    await codeInput.click()
    await sleep(300)
    for (const char of verificationCode) {
      await page.keyboard.type(char)
      await sleep(100)
    }
    await sleep(500)

    const submitBtn = await page.$(
      'button[type="submit"], button:has-text("Verify"), ' +
      'button:has-text("Continue"), button:has-text("Next")'
    )
    if (submitBtn) {
      await submitBtn.click()
      await sleep(3000)
      await snap(page, `${pfx}-2fa-submitted`)
    }

    // Save session after 2FA
    const allCookies = await page.context().cookies()
    await saveSession(profile.email, allCookies).catch(err => {
      console.warn('[formFiller] Could not save session after 2FA:', err instanceof Error ? err.message : String(err))
    })

    // Fill remaining fields
    const coverLetter = await generateCoverLetter(profile, job)
    const textareaField = await findField(page, [
      () => page.getByLabel(/interest|about working|why.*company|note.*company/i).first(),
      () => page.locator('textarea').first(),
    ])
    if (textareaField) {
      await textareaField.click({ timeout: 4000 }).catch(() => {})
      await sleep(400)
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Delete')
      for (const char of coverLetter) {
        await page.keyboard.type(char)
        await sleep(randomInt(30, 55))
      }
    }

    return verifyAndSubmit(page, pfx, 'existing_wellfound', coverLetter, profile)
  }

  return {
    success: false,
    unfilledFields: [],
    loginPathway: 'unknown',
    error: 'existing_account',
    message: userMessage,
  }
}

// ── Pathway 1: New user (standard fill) ──────────────────────────────────────

async function handleNewUserPathway(
  page: Page,
  profile: UserProfile,
  job: FormFillerJob,
  pfx: string,
): Promise<FillResult> {
  console.log('[formFiller] PATHWAY 1: New user — filling full form')
  await snap(page, `${pfx}-04-pathway-start`)

  // ── DataDome guard: check before any field interaction ───────────────────
  // DataDome can appear as soon as the Apply modal finishes loading.
  // If we detect it here, bail out so CapSolver can solve it and retry.
  {
    const ddUrl = await detectDataDomeCaptchaUrl(page)
    if (ddUrl) {
      console.warn('[formFiller] DataDome detected at pathway start — returning for CapSolver solve')
      await snap(page, `${pfx}-datadome-pathway-start`)
      return { success: false, error: 'datadome', dataDomeCaptchaUrl: ddUrl, unfilledFields: ['all'] }
    }
  }

  const password = profile.applicationPassword || 'Chiaro2024!!'
  const fullName = `${profile.firstName} ${profile.lastName}`.trim()

  // Password fields
  const passwordFields = page.locator('input[type="password"]')
  const passwordCount = await passwordFields.count().catch(() => 0)
  console.log(`[formFiller] Found ${passwordCount} password field(s)`)

  if (passwordCount >= 1) {
    console.log('[formFiller] Filling password')
    await humanType(page, passwordFields.nth(0), password)
    await sleep(randomInt(600, 1000))
  }
  if (passwordCount >= 2) {
    console.log('[formFiller] Filling confirm password')
    await humanType(page, passwordFields.nth(1), password)
    await sleep(randomInt(600, 1000))
  }

  await snap(page, `${pfx}-p1-after-password`)

  // ── DataDome guard: check after passwords, before location/YoE ───────────
  // DataDome sometimes fires after the first field interaction triggers a request.
  {
    const ddUrl = await detectDataDomeCaptchaUrl(page)
    if (ddUrl) {
      console.warn('[formFiller] DataDome detected after password fill — returning for CapSolver solve')
      await snap(page, `${pfx}-datadome-post-password`)
      return { success: false, error: 'datadome', dataDomeCaptchaUrl: ddUrl, unfilledFields: ['location', 'yearsOfExperience', 'workAuth', 'coverLetter'] }
    }
  }

  // Location (Downshift autocomplete)
  const locationInput = page.locator('#downshift-0-input, [data-test="Downshift--input"]').first()
  const locationVisible = await locationInput.isVisible({ timeout: 5000 }).catch(() => false)
  if (locationVisible) {
    const city = profile.location.split(',')[0].trim()
    console.log(`[formFiller] Filling Location: ${profile.location} (typing city: "${city}")`)
    // Scroll into view and wait for any post-password animation to settle before clicking
    await locationInput.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
    await sleep(800)
    // Try click first; fall back to focus() if the element is covered during modal animation
    const clickOk = await locationInput.click({ timeout: 8000 }).then(() => true).catch(() => false)
    if (!clickOk) {
      console.warn('[formFiller] Location click timed out — trying focus() fallback')
      await locationInput.focus({ timeout: 5000 }).catch(() => {})
    }
    await sleep(300)
    await locationInput.fill('')
    await sleep(200)
    for (const ch of city) {
      await page.keyboard.type(ch)
      await sleep(randomInt(60, 120))
    }
    const suggSelector = '[role="option"], li[id*="downshift"]'
    const appeared = await page.waitForSelector(suggSelector, { timeout: 4000 }).catch(() => null)
    if (appeared) {
      const suggestions = page.locator(suggSelector)
      const suggCount = await suggestions.count()
      let clicked = false
      for (let si = 0; si < suggCount; si++) {
        const s = suggestions.nth(si)
        const text = (await s.innerText().catch(() => '')).trim()
        if (text.toLowerCase().includes(city.toLowerCase())) {
          await s.click().catch(() => {})
          console.log(`[formFiller] Clicked location suggestion: "${text}"`)
          clicked = true
          break
        }
      }
      if (!clicked) {
        const first = suggestions.first()
        const fallbackText = (await first.innerText().catch(() => '')).trim()
        await first.click().catch(() => {})
        console.log(`[formFiller] Clicked first location suggestion (fallback): "${fallbackText}"`)
      }
    } else {
      // Wait a bit more — suggestions can be slow on Steel's connection
      await sleep(2000)
      const retry = await page.waitForSelector(suggSelector, { timeout: 3000 }).catch(() => null)
      if (retry) {
        const first = page.locator(suggSelector).first()
        const retryText = (await first.innerText().catch(() => '')).trim()
        await first.click().catch(() => {})
        console.log(`[formFiller] Location suggestion appeared on retry: "${retryText}"`)
      } else {
        // Press Escape (not Enter) to close the Downshift dropdown without triggering form submission.
        // Enter on a Downshift input with no selection can submit the whole form unexpectedly.
        await page.keyboard.press('Escape')
        await sleep(300)
        console.warn('[formFiller] Location suggestions never appeared — leaving typed value, pressed Escape to close dropdown')
      }
    }
    // Extra wait after location so YoE React Select has time to become interactable
    await sleep(randomInt(800, 1200))
  } else {
    console.warn('[formFiller] Location input (Downshift) not found')
  }

  // Years of Experience (React Select)
  const yearsLabel = YEARS_EXP_MAP[profile.yearsExp] ?? profile.yearsExp
  const reactSelectControl = page.locator(
    '#form-input--yearsOfExperience .select__control, ' +
    '[id="form-input--yearsOfExperience"] .select__control'
  ).first()
  const yoeVisible = await reactSelectControl.isVisible({ timeout: 5000 }).catch(() => false)
  if (yoeVisible) {
    console.log('[formFiller] Opening Years of Experience React Select')
    await reactSelectControl.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
    await sleep(500)
    await reactSelectControl.click({ timeout: 8000 })
    await sleep(800)
    const option = page.locator('.select__option', { hasText: yearsLabel }).first()
    const optionVisible = await option.isVisible({ timeout: 5000 }).catch(() => false)
    if (optionVisible) {
      await option.click({ timeout: 5000 })
      console.log(`[formFiller] Selected years of experience: "${yearsLabel}"`)
    } else {
      const allOptions = await page.$$('.select__option')
      for (const opt of allOptions) {
        const text = (await opt.textContent() ?? '').trim()
        const normalised = text.replace(/\s/g, '').replace('–', '-')
        if (normalised.includes(profile.yearsExp) || profile.yearsExp.includes(normalised.slice(0, 3))) {
          await opt.click().catch(() => {})
          console.log(`[formFiller] Selected years (partial match): "${text}"`)
          break
        }
      }
    }
    await sleep(randomInt(600, 1000))
  } else {
    console.warn('[formFiller] React Select for yearsOfExperience not found')
  }

  // Desired Salary
  const salaryFallback: Record<string, string> = {
    '0-1': '80000', '1-3': '110000', '3-5': '140000',
    '5-8': '170000', '8-12': '200000', '12+': '230000',
  }
  const salary = profile.desiredSalary?.replace(/[^0-9]/g, '') || salaryFallback[profile.yearsExp] || '120000'
  const salaryField = await findField(page, [
    () => page.getByLabel(/salary|compensation/i).first(),
    () => page.locator('input[name*="salary"]').first(),
    () => page.getByPlaceholder(/usd|salary|amount|compensation/i).first(),
    () => page.locator('input[placeholder*="USD"], input[placeholder*="Salary"]').first(),
  ])
  if (salaryField) {
    console.log(`[formFiller] Filling Desired Salary: ${salary}`)
    await humanType(page, salaryField, salary)
    await sleep(randomInt(600, 1000))
  } else {
    console.warn('[formFiller] Salary field not found')
  }

  await snap(page, `${pfx}-p1-fields-complete`)

  // Work Authorization radios
  const isAuthorized = profile.workAuth !== 'Need Sponsorship'
  const needsSponsorship = profile.workAuth === 'Need Sponsorship' || profile.workAuth === 'H1B Visa'
  const authId = isAuthorized ? 'form-input--usAuthorized--true' : 'form-input--usAuthorized--false'
  console.log(`[formFiller] Work auth: selecting ${isAuthorized ? 'Yes' : 'No'} (id=${authId})`)
  try {
    const authLabel = page.locator(`label[for="${authId}"]`)
    const authLabelCount = await authLabel.count()
    if (authLabelCount > 0) {
      await authLabel.first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
      await authLabel.first().click({ timeout: 8000 })
    } else {
      await page.locator(`#${authId}`).click({ timeout: 8000 })
    }
    await sleep(randomInt(600, 1000))
  } catch (e) {
    console.warn('[formFiller] Work auth radio click failed:', e)
  }

  const sponsorId = needsSponsorship ? 'form-input--requireSponsorship--true' : 'form-input--requireSponsorship--false'
  console.log(`[formFiller] Visa sponsorship: selecting ${needsSponsorship ? 'Yes' : 'No'} (id=${sponsorId})`)
  try {
    const sponsorLabel = page.locator(`label[for="${sponsorId}"]`)
    const sponsorLabelCount = await sponsorLabel.count()
    if (sponsorLabelCount > 0) {
      await sponsorLabel.first().scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
      await sponsorLabel.first().click({ timeout: 8000 })
    } else {
      await page.locator(`#${sponsorId}`).click({ timeout: 8000 })
    }
    await sleep(randomInt(600, 1000))
  } catch (e) {
    console.warn('[formFiller] Visa sponsorship radio click failed:', e)
  }

  await snap(page, `${pfx}-p1-selects-complete`)

  // "What interests you" textarea
  const coverLetter = await generateCoverLetter(profile, job)
  console.log('[formFiller] Cover letter:', coverLetter.slice(0, 100) + '...')

  const textareaField = await findField(page, [
    () => page.getByLabel(/interest|about working|why.*company|note.*company/i).first(),
    () => page.locator('textarea[name*="cover"], textarea[name*="note"], textarea[name*="interest"]').first(),
    () => page.getByPlaceholder(/interest|note|tell us|why/i).first(),
    () => page.locator('textarea').first(),
  ])
  if (textareaField) {
    console.log('[formFiller] Filling cover letter textarea')
    await textareaField.click({ timeout: 4000 }).catch(() => {})
    await sleep(400)
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Delete')
    await sleep(200)
    for (const char of coverLetter) {
      await page.keyboard.type(char)
      await sleep(randomInt(30, 55))
    }
    await sleep(randomInt(600, 1000))
  } else {
    console.warn('[formFiller] Textarea / cover letter field not found')
  }

  await snap(page, `${pfx}-p1-textarea-filled`)

  // Resume upload
  if (profile.resumeBase64) {
    const fileInput = await page.$('input[type="file"]')
    if (fileInput) {
      console.log('[formFiller] Uploading resume')
      const base64 = profile.resumeBase64.includes(',')
        ? profile.resumeBase64.split(',')[1]
        : profile.resumeBase64
      const tmpPath = path.join(os.tmpdir(), `chiaro-resume-${Date.now()}.pdf`)
      fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'))
      await fileInput.setInputFiles(tmpPath).catch(() => {})
      await sleep(1500)
    } else {
      console.warn('[formFiller] Resume file input not found')
    }
  }

  return verifyAndSubmit(page, pfx, 'new_user', coverLetter, profile)
}

// ── Pathway 2: Existing Wellfound account ─────────────────────────────────────

export async function handleExistingWellfoundPathway(
  page: Page,
  profile: UserProfile,
  job: FormFillerJob,
  pfx: string,
): Promise<FillResult> {
  console.log('[formFiller] PATHWAY 2: Existing Wellfound account — logging in')
  await snap(page, `${pfx}-04-pathway-start`)

  if (!profile.wellfoundPassword) {
    console.log('[formFiller] wellfoundPassword: [missing]')
    await snap(page, `${pfx}-p2-no-credentials`)
    return {
      success: false,
      unfilledFields: [],
      loginPathway: 'existing_wellfound',
      error: 'existing_account',
      message:
        'Your email already has a Wellfound account. ' +
        'Please add your Wellfound password in your profile under ' +
        'Account Credentials to enable automatic login.',
    }
  }

  console.log('[formFiller] wellfoundPassword: [present]')
  await sleep(1000)

  // Password field may not be visible yet — look for it or a Continue button
  let passwordField = await page.$('input[type="password"]')

  if (!passwordField) {
    const continueBtn = await page.$(
      'button:has-text("Continue"), button:has-text("Log in"), ' +
      'button:has-text("Sign in"), a:has-text("Log in instead")'
    )
    if (continueBtn) {
      await continueBtn.click()
      await sleep(2000)
      await snap(page, `${pfx}-p2-after-continue`)
    }
    await sleep(1500)
    passwordField = await page.$('input[type="password"]')
  }

  if (passwordField) {
    await passwordField.click()
    await sleep(300)
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Delete')
    const wellfoundPass = profile.wellfoundPassword
    for (const char of wellfoundPass) {
      await page.keyboard.type(char)
      await sleep(randomInt(40, 80))
    }
    await sleep(800)
    await snap(page, `${pfx}-p2-password-entered`)

    const loginBtn = await page.$(
      'button[type="submit"], button:has-text("Log in"), ' +
      'button:has-text("Sign in"), button:has-text("Continue")'
    )
    if (loginBtn) {
      await sleep(randomInt(800, 1500))
      await loginBtn.click()
      await sleep(3000)
      await snap(page, `${pfx}-p2-after-login`)
    }
  } else {
    console.warn('[formFiller] No password field found after Continue click')
    await snap(page, `${pfx}-p2-no-password-field`)
  }

  // Check for 2FA / verification challenge
  const postLoginText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '')
  const twoFA = await detect2FA(page, postLoginText)
  if (twoFA.required) {
    return handle2FA(page, profile, job, pfx, pfx, twoFA)
  }

  // Check if login failed
  const loginFailed = [
    'incorrect password', 'wrong password',
    'invalid credentials', 'login failed',
    'password is incorrect',
  ].some(p => postLoginText.includes(p))

  if (loginFailed) {
    await snap(page, `${pfx}-p2-login-failed`)
    return {
      success: false,
      unfilledFields: [],
      loginPathway: 'existing_wellfound',
      error: 'existing_account',
      message:
        'Wellfound login failed — password may be incorrect. ' +
        'Please update your Wellfound password in profile settings and try again.',
    }
  }

  // Login succeeded — capture and save session cookies for future applies
  const allCookiesP2 = await page.context().cookies().catch(() => [])
  await saveSession(profile.email, allCookiesP2).catch(err => {
    console.warn('[formFiller] Could not save session after Wellfound login:', err instanceof Error ? err.message : String(err))
  })

  // Login succeeded — fill remaining application fields
  console.log('[formFiller] Login succeeded — filling remaining application fields')
  await sleep(2000)
  await snap(page, `${pfx}-p2-post-login-form`)

  // Generate cover letter for remaining fields
  const coverLetter = await generateCoverLetter(profile, job)
  const textareaField = await findField(page, [
    () => page.getByLabel(/interest|about working|why.*company|note.*company/i).first(),
    () => page.locator('textarea[name*="cover"], textarea[name*="note"], textarea[name*="interest"]').first(),
    () => page.getByPlaceholder(/interest|note|tell us|why/i).first(),
    () => page.locator('textarea').first(),
  ])
  if (textareaField) {
    console.log('[formFiller] Filling textarea after login')
    await textareaField.click({ timeout: 4000 }).catch(() => {})
    await sleep(400)
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Delete')
    for (const char of coverLetter) {
      await page.keyboard.type(char)
      await sleep(randomInt(30, 55))
    }
    await sleep(randomInt(600, 1000))
  }

  if (profile.resumeBase64) {
    const fileInput = await page.$('input[type="file"]')
    if (fileInput) {
      console.log('[formFiller] Uploading resume after login')
      const base64 = profile.resumeBase64.includes(',')
        ? profile.resumeBase64.split(',')[1]
        : profile.resumeBase64
      const tmpPath = path.join(os.tmpdir(), `chiaro-resume-${Date.now()}.pdf`)
      fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'))
      await fileInput.setInputFiles(tmpPath).catch(() => {})
      await sleep(1500)
    }
  }

  return verifyAndSubmit(page, pfx, 'existing_wellfound', coverLetter, profile)
}

// ── Pathway 3: Existing account via Google ────────────────────────────────────

export async function handleGoogleLoginPathway(
  page: Page,
  profile: UserProfile,
  job: FormFillerJob,
  pfx: string,
): Promise<FillResult> {
  console.log('[formFiller] PATHWAY 3: Google login pathway')
  await snap(page, `${pfx}-04-pathway-start`)

  if (!profile.googleEmail || !profile.googlePassword) {
    console.log('[formFiller] googleEmail/googlePassword: [missing]')
    await snap(page, `${pfx}-p3-no-google-credentials`)
    return {
      success: false,
      unfilledFields: [],
      loginPathway: 'google',
      error: 'existing_account',
      message:
        'Your Wellfound account uses Google login. ' +
        'Please add your Google email and password in your profile under ' +
        'Account Credentials to enable automatic Google sign-in. ' +
        'Note: if you have 2FA enabled on Google, you will need to apply manually.',
    }
  }

  console.log('[formFiller] googleEmail: [present], googlePassword: [present]')

  const googleBtn = await page.$(
    'button:has-text("Continue with Google"), button:has-text("Sign in with Google"), ' +
    'a:has-text("Continue with Google"), [class*="google-btn"], [aria-label*="Google"]'
  )

  if (!googleBtn) {
    await snap(page, `${pfx}-p3-no-google-button`)
    return {
      success: false,
      unfilledFields: [],
      loginPathway: 'google',
      error: 'existing_account',
      message: 'Could not find Google login button on page. Please apply manually.',
    }
  }

  await googleBtn.click()
  await sleep(3000)
  await snap(page, `${pfx}-p3-google-popup`)

  // Watch for popup or redirect
  const [googlePage] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null),
    sleep(2000),
  ])

  const googleLoginPage = googlePage ?? page
  await sleep(2000)
  const googleUrl = googleLoginPage.url()
  console.log('[formFiller] Google login URL:', googleUrl)

  if (!googleUrl.includes('accounts.google.com') && !googleUrl.includes('google.com')) {
    await snap(googleLoginPage, `${pfx}-p3-google-not-loaded`)
    return {
      success: false,
      unfilledFields: [],
      loginPathway: 'google',
      error: 'existing_account',
      message: 'Google login page did not load correctly. Please apply manually.',
    }
  }

  // Fill Google email
  const googleEmailField = await googleLoginPage.$('input[type="email"], input[name="identifier"]')
  if (googleEmailField) {
    await googleEmailField.click()
    await sleep(300)
    for (const char of profile.googleEmail) {
      await googleLoginPage.keyboard.type(char)
      await sleep(randomInt(50, 120))
    }
    await sleep(500)
    const nextBtn = await googleLoginPage.$('#identifierNext, button:has-text("Next")')
    if (nextBtn) {
      await nextBtn.click()
      await sleep(2500)
      await snap(googleLoginPage, `${pfx}-p3-google-email`)
    }
  }

  // Fill Google password
  const googlePasswordField = await googleLoginPage.$('input[type="password"], input[name="password"]')
  if (googlePasswordField) {
    await googlePasswordField.click()
    await sleep(300)
    for (const char of profile.googlePassword) {
      await googleLoginPage.keyboard.type(char)
      await sleep(randomInt(50, 120))
    }
    await sleep(500)
    const signInBtn = await googleLoginPage.$(
      '#passwordNext, button:has-text("Next"), button:has-text("Sign in")'
    )
    if (signInBtn) {
      await signInBtn.click()
      await sleep(4000)
      await snap(googleLoginPage, `${pfx}-p3-google-signed-in`)
    }
  }

  // Check for 2FA challenge using shared detect2FA
  const googlePageText = await googleLoginPage.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '')
  const googleTwoFA = await detect2FA(googleLoginPage, googlePageText)

  if (googleTwoFA.required) {
    await snap(googleLoginPage, `${pfx}-p3-google-2fa`)
    return handle2FA(googleLoginPage, profile, job, pfx, pfx, googleTwoFA)
  }

  // Check for wrong password
  const googleLoginFailed = [
    'wrong password', 'incorrect password',
    'account not found', 'could not sign you in',
  ].some(p => googlePageText.includes(p))

  if (googleLoginFailed) {
    await snap(googleLoginPage, `${pfx}-p3-google-login-failed`)
    return {
      success: false,
      unfilledFields: [],
      loginPathway: 'google',
      error: 'existing_account',
      message:
        'Google login failed — password may be incorrect. ' +
        'Please update your Google password in profile settings.',
    }
  }

  // Wait for redirect back to Wellfound
  await sleep(3000)
  await snap(page, `${pfx}-p3-back-on-wellfound`)

  // Save session cookies after successful Google login
  const allCookiesP3 = await page.context().cookies().catch(() => [])
  await saveSession(profile.email, allCookiesP3).catch(err => {
    console.warn('[formFiller] Could not save session after Google login:', err instanceof Error ? err.message : String(err))
  })

  console.log('[formFiller] Google login completed — filling remaining fields')

  // Fill remaining application fields
  const coverLetter = await generateCoverLetter(profile, job)
  const textareaField = await findField(page, [
    () => page.getByLabel(/interest|about working|why.*company|note.*company/i).first(),
    () => page.locator('textarea[name*="cover"], textarea[name*="note"], textarea[name*="interest"]').first(),
    () => page.getByPlaceholder(/interest|note|tell us|why/i).first(),
    () => page.locator('textarea').first(),
  ])
  if (textareaField) {
    console.log('[formFiller] Filling textarea after Google login')
    await textareaField.click({ timeout: 4000 }).catch(() => {})
    await sleep(400)
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Delete')
    for (const char of coverLetter) {
      await page.keyboard.type(char)
      await sleep(randomInt(30, 55))
    }
    await sleep(randomInt(600, 1000))
  }

  if (profile.resumeBase64) {
    const fileInput = await page.$('input[type="file"]')
    if (fileInput) {
      console.log('[formFiller] Uploading resume after Google login')
      const base64 = profile.resumeBase64.includes(',')
        ? profile.resumeBase64.split(',')[1]
        : profile.resumeBase64
      const tmpPath = path.join(os.tmpdir(), `chiaro-resume-${Date.now()}.pdf`)
      fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'))
      await fileInput.setInputFiles(tmpPath).catch(() => {})
      await sleep(1500)
    }
  }

  return verifyAndSubmit(page, pfx, 'google', coverLetter, profile)
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Fills the Wellfound application modal form that is already open in the browser.
 *
 * @param page          Playwright Page with the form visible
 * @param profile       Candidate profile
 * @param job           Job context
 * @param applicationId Used as screenshot filename prefix
 */
export async function fillApplicationForm(
  page: Page,
  profile: UserProfile,
  job: FormFillerJob,
  applicationId = 'app',
): Promise<FillResult> {
  const pfx = applicationId

  // 0. Check for a stored, valid session — skip login entirely if found
  const session = await getValidSession(profile.email).catch(() => null)
  if (session?.hasValidSession && session.cookies.length > 0) {
    console.log('[formFiller] Valid stored session found — injecting cookies, skipping login')
    const context = page.context()
    const validSameSite = ['Strict', 'Lax', 'None'] as const
    type SameSite = typeof validSameSite[number]
    await context.addCookies(
      session.cookies.map(c => ({
        ...c,
        domain: c.domain ?? '.wellfound.com',
        sameSite: (validSameSite as readonly string[]).includes(c.sameSite ?? '')
          ? (c.sameSite as SameSite)
          : undefined,
      }))
    ).catch(() => {})
    await snap(page, `${pfx}-00-session-injected`)

    // Verify the session is still valid by checking page text for expiry signals
    const sessionPageText = await page.evaluate(() => document.body.innerText.toLowerCase()).catch(() => '')
    const sessionExpired = ['session expired', 'please log in', 'sign in to continue'].some(
      p => sessionPageText.includes(p)
    )
    if (sessionExpired) {
      console.log('[formFiller] Injected session was rejected — invalidating and falling back to login')
      await invalidateSession(profile.email).catch(() => {})
      // Fall through to normal login flow
    } else {
      // Session valid — skip name/email/login, go straight to remaining form fields
      const coverLetterForSession = await generateCoverLetter(profile, job)
      const textareaForSession = await findField(page, [
        () => page.getByLabel(/interest|about working|why.*company|note.*company/i).first(),
        () => page.locator('textarea').first(),
      ])
      if (textareaForSession) {
        await textareaForSession.click({ timeout: 4000 }).catch(() => {})
        await sleep(400)
        await page.keyboard.press('Control+A')
        await page.keyboard.press('Delete')
        for (const char of coverLetterForSession) {
          await page.keyboard.type(char)
          await sleep(randomInt(30, 55))
        }
        await sleep(randomInt(600, 1000))
      }
      if (profile.resumeBase64) {
        const fileInputSession = await page.$('input[type="file"]')
        if (fileInputSession) {
          const base64s = profile.resumeBase64.includes(',')
            ? profile.resumeBase64.split(',')[1]
            : profile.resumeBase64
          const tmpPathSession = require('path').join(require('os').tmpdir(), `chiaro-resume-${Date.now()}.pdf`)
          require('fs').writeFileSync(tmpPathSession, Buffer.from(base64s, 'base64'))
          await fileInputSession.setInputFiles(tmpPathSession).catch(() => {})
          await sleep(1500)
        }
      }
      return verifyAndSubmit(page, pfx, 'existing_wellfound', coverLetterForSession, profile)
    }
  }

  // 1. Before-fill screenshot
  await snap(page, `${pfx}-01-form-loaded`)

  // 2. Full Name
  const fullName = `${profile.firstName} ${profile.lastName}`.trim()
  const nameField = await findField(page, [
    () => page.getByLabel(/full name/i).first(),
    () => page.locator('input[name="name"]').first(),
    () => page.getByPlaceholder(/full name|jane doe/i).first(),
    () => page.locator('input[placeholder*="Name"]').first(),
  ])
  if (nameField) {
    console.log('[formFiller] Filling Full Name')
    await humanType(page, nameField, fullName)
    await sleep(randomInt(600, 1000))
  } else {
    console.warn('[formFiller] Full Name field not found')
  }

  // 3. Email
  const emailField = await findField(page, [
    () => page.getByLabel(/email/i).first(),
    () => page.locator('input[type="email"]').first(),
    () => page.locator('input[name="email"]').first(),
  ])
  if (emailField) {
    console.log('[formFiller] Filling Email')
    await humanType(page, emailField, profile.email)
    await sleep(randomInt(600, 1000))
  } else {
    console.warn('[formFiller] Email field not found')
  }

  await snap(page, `${pfx}-02-email-entered`)

  // 4. Detect login state
  const { state, evidence } = await detectLoginState(page)
  console.log(`[formFiller] Login state: ${state} | ${evidence}`)
  await snap(page, `${pfx}-03-login-state-${state}`)

  // 5. Route to pathway
  if (state === 'existing_google') {
    return handleGoogleLoginPathway(page, profile, job, pfx)
  }

  if (state === 'existing_wellfound') {
    return handleExistingWellfoundPathway(page, profile, job, pfx)
  }

  // new_user or unknown → standard fill
  return handleNewUserPathway(page, profile, job, pfx)
}
