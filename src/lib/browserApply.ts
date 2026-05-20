import { chromium as chromiumExtra } from 'playwright-extra'
import { chromium } from 'playwright'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
chromiumExtra.use(StealthPlugin())
import Steel from 'steel-sdk'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { UserProfile } from './userProfile'
import type { ApplicationResult } from './applyEngine'
import { extractResumeText } from './resumeParser'
import { claudeFormMapping, fallbackFormMapping } from './aiFormFill'
import { fillApplicationForm } from './formFiller'
import { prisma } from './db'
import { ApplicationStatus } from '@/lib/prismaEnums'
import { scrapflyFetch, ScrapflyFetchError, isChallenged, extractTurnstileSitekey } from './scrapflyFetch'
import { extractFieldsFromHtml } from './scrapflyFormExtract'
import { solveTurnstile, solveDataDome, solveCloudflareChallenge, solveCloudflareInteractivePage, solveRecaptchaV2, solveRecaptchaV3, solveRecaptchaEnterprise } from './capsolver'
import { resolveApplyUrl } from './extractAtsUrl'
import { scrapflyApplyWellfound } from './scrapflyApply'

const TOTAL_TIMEOUT_MS = 600_000  // 10 min — warm-up (homepage→jobs→job page) + CF/DataDome + form fill
const MAX_STEPS = 8


const SUCCESS_PATTERNS = [
  /thank\s*you/i,
  /application\s*received/i,
  /application\s*submitted/i,
  /successfully\s*applied/i,
  /we.ll\s*be\s*in\s*touch/i,
  /we\s*have\s*received\s*your/i,
  /your\s*application\s*was\s*submitted/i,
  /application\s*complete/i,
  /successfully\s*submitted/i,
  /submission\s*confirmed/i,
  /you.ve\s*applied/i,
  /we\s*received\s*your\s*application/i,
]

// ── Field descriptor ─────────────────────────────────────────────────────────

export interface FieldDescriptor {
  selector: string
  label: string
  tagName: string
  inputType: string | null
  required: boolean
  options?: string[]
}

// ── Screenshot helper ─────────────────────────────────────────────────────────

async function takeScreenshot(
  page: import('playwright').Page,
  name: string,
): Promise<string> {
  const dir = path.join(process.cwd(), 'public', 'screenshots')
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${name}.png`)
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => {})
  return `/screenshots/${name}.png`
}

// ── Human-like delay ──────────────────────────────────────────────────────────

function humanDelay(): Promise<void> {
  const ms = 800 + Math.random() * 1700 // 800–2500ms
  return new Promise(r => setTimeout(r, ms))
}

function randomDelay(min: number, max: number): Promise<void> {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)))
}

async function humanType(
  page: import('playwright').Page,
  selector: string,
  value: string,
): Promise<void> {
  await page.click(selector, { timeout: 3000 }).catch(() => {})
  if (value.length > 60) {
    // For long text (cover letters, bios): use page.fill() — a single RPC call that is
    // dramatically faster than page.type() over Steel's remote browser connection.
    // page.type() sends one keystroke per network round-trip; at 100-500ms RTT that turns
    // a 200-char bio into 20-100 seconds per field. page.fill() avoids this entirely.
    await page.fill(selector, value, { timeout: 10000 }).catch(async () => {
      // fallback: character-by-character for sites that block fill() (React controlled inputs)
      await page.type(selector, value, { delay: 30 }).catch(() => {})
    })
  } else {
    for (const ch of value) {
      await page.keyboard.type(ch)
      await randomDelay(40, 100)
    }
  }
}

async function humanClick(
  page: import('playwright').Page,
  locator: import('playwright').Locator,
): Promise<void> {
  const box = await locator.boundingBox().catch(() => null)
  if (box) {
    const x = box.x + box.width / 2 + (Math.random() - 0.5) * 10
    const y = box.y + box.height / 2 + (Math.random() - 0.5) * 6
    await page.mouse.move(x, y, { steps: 12 })
    await randomDelay(80, 220)
  }
  await locator.click({ timeout: 10000 }).catch(() =>
    locator.click({ force: true, timeout: 5000 }).catch(() => {}),
  )
}

async function humanScroll(page: import('playwright').Page): Promise<void> {
  // Pass as a raw string so tsx/esbuild never processes the inner code — avoids the
  // `__name is not defined` ReferenceError that occurs when esbuild wraps named
  // functions inside page.evaluate with its own __name() helper at compile time.
  await page.evaluate(`(async () => {
    var appEl = document.querySelector('#application');
    var mainEl = document.querySelector('main');
    function ovScrollable(el) {
      if (!el) return false;
      var ov = getComputedStyle(el).overflowY;
      return (ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight + 10;
    }
    var container = ovScrollable(appEl) ? appEl : ovScrollable(mainEl) ? mainEl : null;
    var steps = 16;
    for (var i = 1; i <= steps; i++) {
      var winH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      window.scrollTo(0, (winH / steps) * i);
      if (container) container.scrollTop = (container.scrollHeight / steps) * i;
      await new Promise(function(r) { setTimeout(r, 120 + Math.random() * 130); });
    }
  })()`)
}

// ── Fill a single field in Playwright ────────────────────────────────────────

async function fillField(
  page: import('playwright').Page,
  selector: string,
  value: string,
  fieldType: string,
  profile: UserProfile,
  tempFiles: string[],
): Promise<void> {
  try {
    await humanDelay()

    if (fieldType === 'file' || value === '__RESUME__') {
      let tmpPath: string
      if (profile.resumeBase64) {
        const base64 = profile.resumeBase64.includes(',')
          ? profile.resumeBase64.split(',')[1]
          : profile.resumeBase64
        tmpPath = path.join(os.tmpdir(), `chiaro-resume-${Date.now()}.pdf`)
        fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'))
        tempFiles.push(tmpPath)
      } else {
        // Fall back to filesystem resume (set via APPLY_RESUME_PATH or ~/Nandan_Pullakandam_Resume.pdf)
        const fsPath = process.env.APPLY_RESUME_PATH
          ?? path.join(process.env.HOME ?? os.homedir(), 'Nandan_Pullakandam_Resume.pdf')
        if (!fs.existsSync(fsPath)) {
          console.warn('[browserApply] No resume available (resumeBase64 empty, filesystem path missing)')
          return
        }
        tmpPath = fsPath
      }
      // Try specific selector first, then broad fallback for custom upload widgets (e.g. Greenhouse new board)
      const uploaded = await page.setInputFiles(selector, tmpPath, { timeout: 5000 }).then(() => true).catch(() => false)
      if (!uploaded) {
        await page.setInputFiles('input[type="file"]', tmpPath, { timeout: 5000 }).catch(() => {})
      }
      return
    }

    if (fieldType === 'select') {
      // Expand 2-letter US state abbreviations to full names for ATS dropdowns (e.g. BambooHR Fabric UI)
      const US_STATES: Record<string, string> = {
        AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
        CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
        HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
        KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
        MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
        MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
        NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
        OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
        SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
        VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
        DC: 'District of Columbia',
      }
      const fullStateName = US_STATES[value.trim().toUpperCase()] ?? null
      const valuesToTry = fullStateName ? [value, fullStateName] : [value]

      // First: try native Playwright selectOption (works for visible native <select>)
      let selectedOk = false
      for (const attempt of valuesToTry) {
        const byLabel = await page.selectOption(selector, { label: attempt }, { timeout: 2000 })
          .then(() => true).catch(() => false)
        if (byLabel) { selectedOk = true; break }
        const byValue = await page.selectOption(selector, attempt, { timeout: 1000 })
          .then(() => true).catch(() => false)
        if (byValue) { selectedOk = true; break }
      }

      if (!selectedOk) {
        // Second: force-set via evaluate — works even on hidden native <select> elements
        // (e.g. BambooHR Fabric UI Dropdown hides the native <select> for accessibility)
        const forceSet = await page.evaluate(({ sel, targets }: { sel: string; targets: string[] }) => {
          const el = document.querySelector(sel) as HTMLSelectElement | null
          if (!el) return false
          for (const target of targets) {
            const tl = target.toLowerCase()
            const option = Array.from(el.options).find(o =>
              o.text.trim().toLowerCase() === tl ||
              o.value.trim().toLowerCase() === tl
            )
            if (option) {
              el.value = option.value
              el.dispatchEvent(new Event('change', { bubbles: true }))
              el.dispatchEvent(new Event('input', { bubbles: true }))
              return true
            }
          }
          return false
        }, { sel: selector, targets: valuesToTry })

        if (!forceSet) {
          // Third: Fabric UI Dropdown — click the visible button trigger adjacent to the hidden select,
          // wait for the dropdown Callout to appear, then click the matching [role="option"] item.
          await page.evaluate(({ sel }: { sel: string }) => {
            const el = document.querySelector(sel) as HTMLElement | null
            if (!el) return
            // Walk up to the Fabric UI container and click the visible button/trigger
            const container = el.closest('[class*="Dropdown"], [class*="dropdown"], [class*="Select"], [data-automationid]')
            const trigger = container?.querySelector('button, [role="combobox"], [role="listbox"]') as HTMLElement | null
            if (trigger) trigger.click()
            else {
              // Fallback: click a visible sibling/parent button
              let parent = el.parentElement
              while (parent && parent !== document.body) {
                const btn = parent.querySelector('button:not([aria-hidden])') as HTMLElement | null
                if (btn) { btn.click(); break }
                parent = parent.parentElement
              }
            }
          }, { sel: selector })
          await page.waitForTimeout(500)
          // After dropdown opens, click the matching option
          const clickedOption = await page.evaluate((targets: string[]) => {
            const options = Array.from(document.querySelectorAll('[role="option"]'))
            for (const target of targets) {
              const tl = target.toLowerCase()
              for (const opt of options) {
                const text = (opt.textContent ?? '').trim().toLowerCase()
                if (text === tl || text.includes(tl) || tl.includes(text)) {
                  ;(opt as HTMLElement).click()
                  return true
                }
              }
            }
            return false
          }, valuesToTry)
          if (!clickedOption) {
            // Last resort: type to filter and click
            const typeValue = fullStateName ?? value
            await page.keyboard.type(typeValue, { delay: 50 }).catch(() => {})
            await page.waitForTimeout(400)
            await page.locator(`[role="option"]:has-text("${typeValue}")`).first().click({ timeout: 2000 }).catch(() => {})
          }
        }
      }
      return
    }

    if (fieldType === 'checkbox') {
      if (['true', 'yes', 'check', 'other'].includes(value.toLowerCase())) {
        await page.check(selector, { timeout: 3000 }).catch(() => {})
      }
      return
    }

    if (fieldType === 'radio') {
      await page.check(`${selector}[value="${value}"]`, { timeout: 3000 }).catch(async () => {
        // Try clicking a label that contains the value text
        await page.locator(`label:has-text("${value}")`).first().click({ timeout: 3000 }).catch(() => {})
      })
      return
    }

    if (fieldType === 'password') {
      await humanType(page, selector, value)
      return
    }

    // tel inputs — use fill() atomically to avoid intl-tel-input stealing the first digit
    if (fieldType === 'tel') {
      const telLoc = page.locator(selector).first()
      await telLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
      await telLoc.click({ timeout: 3000 }).catch(() => {})
      await telLoc.fill(value, { timeout: 5000 }).catch(async () => {
        await page.keyboard.type(value, { delay: 30 }).catch(() => {})
      })
      return
    }

    // text / textarea — check for location autocomplete
    const isLocation = /location|city/i.test(selector)
    if (isLocation) {
      // Greenhouse location uses a React-controlled autocomplete. pressSequentially fires
      // real keyboard events so React updates its state; then we click the first suggestion.
      const loc = page.locator(selector).first()
      await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
      await loc.click({ timeout: 3000 }).catch(() => {})
      await loc.fill('', { timeout: 2000 }).catch(() => {})
      await loc.pressSequentially(value, { delay: 80 }).catch(async () => {
        // Fallback: page.type fires real keyboard events too
        await page.type(selector, value, { delay: 80 }).catch(() => {})
      })
      await page.waitForTimeout(1000)
      // Click the first autocomplete suggestion if one appeared
      const suggestion = page.locator('[role="option"], [class*="autocomplete"] li, [class*="suggestion"], [class*="pac-item"]').first()
      const suggestionVisible = await suggestion.isVisible({ timeout: 800 }).catch(() => false)
      if (suggestionVisible) {
        await suggestion.click({ timeout: 2000 }).catch(() => {})
      } else {
        // No suggestion — press Tab to commit the typed value and move focus away
        await page.keyboard.press('Tab').catch(() => {})
      }
      return
    }

    // For BambooHR Fabric UI TextFields, use locator.pressSequentially() which handles
    // focus + trusted keystrokes atomically — more reliable than page.click() + keyboard.type()
    // over Steel.dev's remote browser where click coordinates can miss.
    if (page.url().includes('bamboohr.com') && selector.match(/^#Fabric|^#fab-|^#FabricText|^#desiredPay|^#websiteUrl|^#linkedinUrl|^#desiredPay|^#customQuestion/i)) {
      const locator = page.locator(selector).first()
      await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
      await locator.click({ timeout: 3000, force: true }).catch(() => {})
      await locator.fill('', { timeout: 2000 }).catch(() => {}) // clear first
      await locator.pressSequentially(value, { delay: 30 }).catch(async () => {
        // fallback: fill directly
        await locator.fill(value, { timeout: 3000 }).catch(() => {})
      })
      return
    }

    await humanType(page, selector, value)
  } catch {
    // Non-fatal — skip fields we can't fill
  }
}


export interface BrowserApplyResult extends ApplicationResult {
  screenshotUrl?: string
  preSubmitScreenshotUrl?: string
  pendingQuestions?: Array<{ fieldLabel: string; fieldType: string; selector: string }>
  bypassMethod?: 'scrapfly_only' | 'scrapfly_plus_capsolver' | 'cloak_browser' | 'cloak_browser_plus_capsolver' | 'steel' | 'steel_plus_capsolver' | 'failed'
  skipped?: boolean
  skipReason?: string
}

// ── Broken job message lookup ─────────────────────────────────────────────────

function getBrokenJobMessage(code: string, company: string): string {
  const messages: Record<string, string> = {
    B1: `${company}'s application page timed out and couldn't be reached. Please apply manually at the link provided.`,
    B2: `${company}'s job posting returned an error (page not found). The listing may have been removed.`,
    B3: `${company}'s position appears to be closed or no longer accepting applications.`,
    B4: `${company}'s application requires you to log in first. Please apply manually.`,
    B5: `${company}'s application page did not load correctly. Please apply manually.`,
    B6: `${company}'s apply link doesn't lead to an application form. Please apply manually from their careers page.`,
    B7: `There was a technical error opening ${company}'s application. Please apply manually.`,
    B8: `${company}'s website is blocking automated access. Please apply manually.`,
  }
  return messages[code] ?? `Could not submit application to ${company}. Please apply manually.`
}

// ── Broken job skip handler ───────────────────────────────────────────────────

async function handleBrokenJobPosting(
  applicationId: string,
  reason: string,
  brokenCode: string,
  screenshotPath?: string,
): Promise<BrowserApplyResult> {
  /*
   * FUTURE IMPROVEMENTS FOR BROKEN JOB HANDLING:
   *
   * B1 (timeout): Implement retry with a different proxy region
   *    (US → EU → APAC) before giving up
   *
   * B3 (job closed): Auto-remove from card deck and mark job
   *    as inactive in database so it never appears again
   *
   * B4 (login wall): Build the existing account login flow —
   *    user provides Wellfound credentials once, stored encrypted,
   *    used automatically for sites requiring login
   *
   * B8 (permanent block): Implement session warm-up — visit
   *    company homepage and browse 2-3 pages before attempting
   *    the apply URL to build trust score with DataDome
   *
   * GENERAL: Add a retry queue — broken jobs get retried once
   *    per day for 3 days before being permanently marked as
   *    manual-only
   */

  // Look up job info for the user-facing message
  const appRecord = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { job: true },
  }).catch(() => null)

  const company = appRecord?.job?.company ?? 'Unknown company'
  const applyUrl = appRecord?.job?.applyUrl ?? ''
  const jobId = appRecord?.jobId ?? ''

  const userMessage = getBrokenJobMessage(brokenCode, company)

  // Update application to needs_review with errorCode
  await prisma.application.update({
    where: { id: applicationId },
    data: {
      status: 'NEEDS_REVIEW',
      errorMessage: userMessage,
      errorCode: brokenCode,
    },
  }).catch(() => {})

  // Mark job as broken so it won't be re-selected in future runs
  if (jobId) {
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'broken' },
    }).catch(() => {})
  }

  console.log(`[SKIP] ${company} — ${reason} (${brokenCode})`)

  return {
    status: 'needs_review',
    errorMessage: userMessage,
    applyUrl,
    screenshotUrl: screenshotPath,
    skipped: true,
    skipReason: brokenCode,
  }
}

/**
 * Parses RESIDENTIAL_PROXY_URL (format: http://user:pass@host:port) into the
 * Playwright proxy config object. Returns undefined if the env var is not set.
 */
function buildProxyConfig(): { server: string; username?: string; password?: string } | undefined {
  const raw = process.env.RESIDENTIAL_PROXY_URL
  if (!raw) return undefined
  try {
    const u = new URL(raw)
    return {
      server: `${u.protocol}//${u.host}`,
      username: u.username || undefined,
      password: u.password || undefined,
    }
  } catch {
    console.warn('[browserApply] RESIDENTIAL_PROXY_URL is set but could not be parsed — skipping proxy')
    return undefined
  }
}

export async function browserApply(
  applyUrl: string,
  profile: UserProfile,
  applicationId: string,
  userAnswers: Record<string, string> = {},
): Promise<BrowserApplyResult> {
  const tempFiles: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null
  let steelSessionId: string | null = null

  const run = async (): Promise<BrowserApplyResult> => {

    // ── STEP 0: Resolve real apply URL ────────────────────────────────────────
    // Strips ?autoOpenApplication=true from Wellfound URLs, fetches the base
    // job page, and extracts a direct Greenhouse/Lever link if one exists.
    // If no external link is found we fall through to native Wellfound apply.
    const jobId = await prisma.application
      .findUnique({ where: { id: applicationId }, select: { jobId: true } })
      .then(a => a?.jobId ?? '')
      .catch(() => '')

    // resolveApplyUrl handles startup.jobs/apply/ URLs by fetching via Scrapfly (ASP+JS render)
    // to extract the embedded Greenhouse/Lever/etc. URL, then CloakBrowser applies directly
    // to that ATS URL — no Cloudflare challenge to deal with.
    const resolved = await resolveApplyUrl(applyUrl, jobId)
    const effectiveUrl = resolved.url

    const isNativeWellfound = !resolved.isExternal && applyUrl.includes('wellfound.com')
    const proxyConfig = buildProxyConfig()
    const useResidentialProxy = !!proxyConfig

    if (isNativeWellfound) {
      const bypassStrategy = useResidentialProxy ? 'residential proxy (Path A)' : 'Scrapfly js_scenario'
      console.log(`[browserApply] Native Wellfound apply — using ${bypassStrategy}`)
    } else if (resolved.isExternal) {
      console.log(`[browserApply] Resolved to external ATS: ${effectiveUrl}`)
    }

    // ── Native Wellfound: try Scrapfly js_scenario first (bypasses DataDome) ──
    // Skip when RESIDENTIAL_PROXY_URL is set (residential IP handles it directly).
    // Scrapfly js_scenario fails on Wellfound's apply endpoint regardless of settings.
    if (isNativeWellfound && !useResidentialProxy) {
      const appForCL = await prisma.application.findUnique({
        where: { id: applicationId },
        include: { job: true },
      }).catch(() => null)
      const jobForCL = appForCL?.job
      const coverLetter = profile.bio
        ? `${profile.bio} I'm excited about the ${jobForCL?.role ?? 'role'} opportunity at ${jobForCL?.company ?? 'your company'} and believe my background is a strong match.`
        : `I'm excited about the ${jobForCL?.role ?? 'role'} opportunity at ${jobForCL?.company ?? 'your company'} and would love to bring my ${profile.yearsExp} years of experience to your team.`

      const scrapResult = await scrapflyApplyWellfound(applyUrl, profile, coverLetter)

      if (scrapResult.status === 'applied') {
        await prisma.application.update({
          where: { id: applicationId },
          data: { status: ApplicationStatus.APPLIED, bypassMethod: scrapResult.bypassMethod },
        }).catch(() => {})
        return { status: 'applied', applyUrl, bypassMethod: scrapResult.bypassMethod }
      }

      if (scrapResult.status === 'needs_review' && !scrapResult.errorMessage?.includes('failed')) {
        // Scrapfly submitted but we can't confirm success — return needs_review
        await prisma.application.update({
          where: { id: applicationId },
          data: { status: ApplicationStatus.NEEDS_REVIEW, bypassMethod: scrapResult.bypassMethod },
        }).catch(() => {})
        return { status: 'needs_review', errorMessage: scrapResult.errorMessage, applyUrl, bypassMethod: scrapResult.bypassMethod }
      }

      // Scrapfly failed with a hard error (wrong format, blocked, etc.)
      // Fall through to Playwright path with Scrapfly session cookie injection
      console.log(`[browserApply] Scrapfly js_scenario failed (${scrapResult.errorMessage}) — falling back to Playwright`)
    }

    // ── STEP 1: Scrapfly reconnaissance ──────────────────────────────────────
    // Skip for native Wellfound when a residential proxy is configured — Playwright
    // will handle the full session itself (residential IP + stealth fingerprint).
    // For external ATS or when no proxy is set, Scrapfly recon is still needed to
    // extract form fields and obtain DataDome/CF cookies for injection.
    const scrapflyTarget = isNativeWellfound ? applyUrl.split('?')[0] : effectiveUrl

    // Sentinel empty result used when we skip ScrapFly recon
    const emptyRecon = { html: '', cookies: [] as Array<{ name: string; value: string; domain: string; path: string }>, responseHeaders: {} as Record<string, string>, creditCost: 0 }

    let scrapflyResult: Awaited<ReturnType<typeof scrapflyFetch>>

    if ((isNativeWellfound && useResidentialProxy) || !isNativeWellfound) {
      // Residential proxy (Wellfound) or CloakBrowser (non-Wellfound) — skip ScrapFly recon.
      // Each of these handles bot detection internally; Scrapfly is not needed.
      scrapflyResult = emptyRecon
    } else {
      try {
        scrapflyResult = await scrapflyFetch(scrapflyTarget)
      } catch (err) {
        if (err instanceof ScrapflyFetchError) {
          await prisma.application.update({
            where: { id: applicationId },
            data: { bypassMethod: 'failed' },
          }).catch(() => {})
          return { status: err.code, errorMessage: err.message, applyUrl, bypassMethod: 'failed' }
        }
        throw err
      }
    }

    const { html, cookies } = scrapflyResult

    // ── STEP 2: Check for challenge page ─────────────────────────────────────
    let capsolvToken: string | null = null
    let bypassMethod: 'scrapfly_only' | 'scrapfly_plus_capsolver' | 'cloak_browser' | 'cloak_browser_plus_capsolver' | 'steel' | 'steel_plus_capsolver' = isNativeWellfound ? 'scrapfly_only' : 'cloak_browser'

    if (isChallenged(html)) {
      console.log('[browserApply] Scrapfly returned a challenge page — triggering CapSolver')

      // ── STEP 3: CapSolver Turnstile fallback ─────────────────────────────
      const siteKey = extractTurnstileSitekey(html)
      if (siteKey) {
        capsolvToken = await solveTurnstile(scrapflyTarget, siteKey)
        if (capsolvToken) {
          bypassMethod = 'scrapfly_plus_capsolver'
        } else {
          await prisma.application.update({
            where: { id: applicationId },
            data: { bypassMethod: 'failed' },
          }).catch(() => {})
          return {
            status: 'needs_review',
            errorMessage: 'Turnstile challenge could not be solved — complete manually',
            applyUrl,
            bypassMethod: 'failed',
          }
        }
      }
    }

    // ── STEP 4: Extract form fields from HTML ─────────────────────────────────
    // For non-Wellfound sites html is '' (emptyRecon) — rawFields will be empty
    // and repopulated after CloakBrowser navigates (live recon step below).
    let rawFields = extractFieldsFromHtml(html)

    // ── STEP 5: Claude API form fill mapping ──────────────────────────────────
    const resumeText = await extractResumeText(profile.resumeBase64 ?? '')

    const job = { role: '', company: '', description: '', location: '' }
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

    let fillMapping: import('./aiFormFill').FilledField[] = []
    if (rawFields.length > 0) {
      const _claudeMapped = await claudeFormMapping(rawFields, profile, job, resumeText)
      const _fallbackMapped = fallbackFormMapping(rawFields, profile)
      const _claudeSelectors = new Set(_claudeMapped.map(f => f.selector))
      fillMapping = [..._fallbackMapped.filter(f => !_claudeSelectors.has(f.selector)), ..._claudeMapped]
      console.log(`[browserApply] Using merged mapping: ${_claudeMapped.length} Claude + ${_fallbackMapped.filter(f => !_claudeSelectors.has(f.selector)).length} fallback = ${fillMapping.length} total`)
    }

    // Check for fields that still need user input (not in mapping + required)
    const unmappedRequired = rawFields.filter(f =>
      f.required &&
      f.inputType !== 'hidden' &&
      !fillMapping.some(m => m.selector === f.selector) &&
      !userAnswers[f.label]
    )

    if (unmappedRequired.length > 0) {
      const pendingQuestions = unmappedRequired.map(f => ({
        fieldLabel: f.label,
        fieldType: f.inputType ?? f.tagName,
        selector: f.selector,
      }))

      await prisma.pausedApplication.upsert({
        where: { applicationId },
        update: {
          pendingQuestions: JSON.stringify(pendingQuestions),
          pageUrl: applyUrl,
          cookieState: JSON.stringify(cookies),
        },
        create: {
          applicationId,
          jobId: (await prisma.application.findUnique({ where: { id: applicationId }, select: { jobId: true } }))?.jobId ?? '',
          pendingQuestions: JSON.stringify(pendingQuestions),
          pageUrl: applyUrl,
          cookieState: JSON.stringify(cookies),
        },
      })

      await prisma.application.update({
        where: { id: applicationId },
        data: { status: ApplicationStatus.NEEDS_INFO, bypassMethod },
      })

      return {
        status: 'needs_review',
        errorMessage: 'Needs your input — answer the questions in your dashboard to continue',
        applyUrl,
        pendingQuestions,
        bypassMethod,
      }
    }

    // ── STEP 6: Browser launch — route by ATS type ───────────────────────────────
    // Browser routing:
    //   • Greenhouse  → CloakBrowser + CapSolver (reCAPTCHA Enterprise requires C++-patched browser)
    //   • Everything else (Lever, BambooHR, Workday, Ashby, etc.) → Steel.dev + CapSolver
    //   • Native Wellfound → CloakBrowser (DataDome path — unchanged)
    //
    // Use ALL available signals — effectiveUrl may still be a startup.jobs URL if Scrapfly
    // failed to resolve it, so fall back to the DB atsType and the original applyUrl.
    const dbAtsType = await prisma.application.findUnique({
      where: { id: applicationId },
      include: { job: { select: { atsType: true } } },
    }).then(a => a?.job?.atsType ?? null).catch(() => null)

    const isGreenhouseUrl =
      effectiveUrl.includes('greenhouse.io') ||
      applyUrl.includes('greenhouse.io') ||
      resolved.atsType === 'GREENHOUSE' ||
      dbAtsType === 'GREENHOUSE'

    const isStartupJobsNative = effectiveUrl.includes('startup.jobs')
    const steelApiKey = process.env.STEEL_API_KEY
    const useSteel = !isGreenhouseUrl && !isNativeWellfound && !!steelApiKey
    console.log(`[browserApply] ATS routing: db=${dbAtsType ?? 'unknown'} resolved=${resolved.atsType ?? '?'} → ${useSteel ? 'Steel.dev' : 'CloakBrowser'} (url: ${effectiveUrl.slice(0, 60)})`)

    let context: import('playwright').BrowserContext

    if (useSteel) {
      console.log('[browserApply] Launching Steel.dev cloud browser...')
      const steel = new Steel({ steelAPIKey: steelApiKey })
      const session = await steel.sessions.create({
        useProxy: true,      // Steel's built-in residential proxy pool
        solveCaptcha: true,  // auto-solve Cloudflare Turnstile
        timeout: 600000,     // 10 min — CF bypass alone can take 80s
      })
      console.log('[browserApply] Steel: useProxy=true + solveCaptcha=true')
      steelSessionId = session.id
      bypassMethod = 'steel'
      console.log(`[browserApply] Steel session created: ${steelSessionId}`)

      const cdpUrl = `${session.websocketUrl}&apiKey=${steelApiKey}`
      browser = await chromium.connectOverCDP(cdpUrl)
      context = browser.contexts()[0] ?? await browser.newContext()
      console.log('[browserApply] Steel browser connected via CDP')
    } else {
      // CloakBrowser patches Chromium at the C++ source level (49 patches) — removes
      // all automation signals, spoofs canvas/WebGL/GPU fingerprints, and auto-resolves
      // Cloudflare Turnstile without CapSolver. Drop-in Playwright API.
      console.log('[browserApply] Launching CloakBrowser stealth Chromium...')
      const { launch: cloakLaunch } = await import('cloakbrowser')
      // Only pass proxy for Wellfound (DataDome needs it). For all other sites, CloakBrowser
      // uses the machine's native IP — shared proxy IPs are flagged by CF and make things worse.
      const cloakProxy = isNativeWellfound && proxyConfig?.server && proxyConfig?.username
        ? { proxy: `${proxyConfig.server.replace('://', `://${proxyConfig.username}:${proxyConfig.password}@`)}` }
        : {}
      browser = await cloakLaunch({
        headless: false,
        humanize: true,
        ...cloakProxy,
      })
      console.log('[browserApply] CloakBrowser launched')

      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        // 1366×768 matches the most common laptop resolution and is what Greenhouse's
        // centered form layout is tuned for.  1920px was too wide — combined with
        // CloakBrowser's Retina pixel ratio it caused forms to appear left-shifted.
        // 1366×768 matches the most common laptop resolution Greenhouse is tuned for.
        // Note: deviceScaleFactor is intentionally omitted — CloakBrowser crashes if set.
        viewport: { width: 1366, height: 768 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
      })
    }
    console.log(`[browserApply] Browser context created (${useSteel ? 'Steel' : 'CloakBrowser'})`)

    // #4 — navigator.webdriver + window.chrome stub
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).chrome = { runtime: {} }
    })

    // #5 — Canvas fingerprint noise
    await context.addInitScript(() => {
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL
      HTMLCanvasElement.prototype.toDataURL = function (...args: unknown[]) {
        const ctx = this.getContext('2d')
        if (ctx) {
          const img = ctx.getImageData(0, 0, this.width, this.height)
          for (let i = 0; i < img.data.length; i += 97) {
            img.data[i] = img.data[i] ^ 1
          }
          ctx.putImageData(img, 0, 0)
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (origToDataURL as any).apply(this, args)
      }
    })

    // #6 — WebGL vendor/renderer spoof
    await context.addInitScript(() => {
      const origGetParameter = WebGLRenderingContext.prototype.getParameter
      WebGLRenderingContext.prototype.getParameter = function (param: number) {
        if (param === 37445) return 'Intel Inc.'
        if (param === 37446) return 'Intel Iris OpenGL Engine'
        return origGetParameter.call(this, param)
      }
    })

    // Inject ALL Scrapfly cookies: cf_clearance (Cloudflare), dd_* (DataDome),
    // and any other session cookies the server accepted.
    const SECURE_COOKIE_PREFIXES = ['cf_clearance', '__Secure-', '__Host-', 'dd_']
    const playwrightCookies = cookies
      .filter(c => c.name && c.value)
      .map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
        path: c.path || '/',
        httpOnly: false,
        secure: SECURE_COOKIE_PREFIXES.some(p => c.name.startsWith(p)),
        sameSite: 'Lax' as const,
      }))

    if (playwrightCookies.length > 0) {
      await context.addCookies(playwrightCookies)
    }

    // #7 (user session) — Inject wellfoundCookies pasted from Chrome DevTools
    // These are the user's own authenticated session cookies and are the most
    // reliable signal to DataDome/Cloudflare that the request is from a real user.
    if (profile.wellfoundCookies?.trim()) {
      const userCookies = profile.wellfoundCookies
        .split(';')
        .map(c => c.trim())
        .filter(Boolean)
        .map(c => {
          const eqIdx = c.indexOf('=')
          if (eqIdx === -1) return null
          const name = c.slice(0, eqIdx).trim()
          const value = c.slice(eqIdx + 1).trim()
          return {
            name,
            value,
            domain: '.wellfound.com',
            path: '/',
            httpOnly: false,
            secure: name.startsWith('__Secure-') || name.startsWith('__Host-'),
            sameSite: 'Lax' as const,
          }
        })
        .filter((c): c is NonNullable<typeof c> => c !== null && c.name.length > 0)
      if (userCookies.length > 0) {
        await context.addCookies(userCookies)
        console.log(`[browserApply] Injected ${userCookies.length} user session cookies from profile`)
      }
    }

    const page = await context.newPage()

    // Block Google's gapi.js proxy page from taking over the main frame.
    // startup.jobs loads gapi.js (Google Sign-In / reCAPTCHA), which creates an
    // iframe at content.googleapis.com/static/proxy.html. In some Steel sessions
    // this URL leaks into the main browsing context and navigates the main window
    // there, leaving a blank white page instead of the job form.
    if (isStartupJobsNative) {
      await page.route('**/content.googleapis.com/static/proxy.html**', (route) => {
        console.log('[browserApply] Blocked Google API proxy navigation in main frame')
        route.abort('aborted').catch(() => {})
      })
    }

    // Inject CapSolver token if we solved a Turnstile
    if (capsolvToken) {
      await page.addInitScript((token: string) => {
        Object.defineProperty(window, '__capsolver_token__', { value: token })
      }, capsolvToken)
    }

    // ── Greenhouse reCAPTCHA Enterprise intercept ──────────────────────────────
    // Greenhouse uses reCAPTCHA Enterprise in explicit mode: their submit handler
    // calls grecaptcha.enterprise.execute() to get a fresh token right before posting.
    // Steel's built-in solver runs ONCE at page load and earns a low score (~0.1-0.3).
    // That low-score token gets submitted and Greenhouse sends an email verification.
    //
    // Fix: intercept execute() BEFORE enterprise.js loads (addInitScript runs first),
    // so EVERY execute() call — at load time AND submit time — returns a CapSolver
    // high-score token instead of Steel's token. exposeFunction bridges the browser
    // context to Node.js where we call the CapSolver API.
    //
    // IMPORTANT: Also install for startup.jobs URLs — many startup.jobs/apply/ pages
    // redirect to Greenhouse. addInitScript persists across navigations in the context,
    // so it fires on the Greenhouse page even though applyUrl is a startup.jobs URL.
    // Without this, the startup.jobs→Greenhouse flow submits with Steel's low-score token.
    if (applyUrl.includes('greenhouse.io') || effectiveUrl.includes('greenhouse.io') || applyUrl.includes('startup.jobs') || effectiveUrl.includes('startup.jobs')) {
      // Expose the CapSolver solver to the browser page context
      await page.exposeFunction(
        '__capsolverEnterpriseExecute',
        async (pageUrl: string, sitekey: string, action: string): Promise<string> => {
          console.log(`[browserApply] Greenhouse execute() intercepted — calling CapSolver Enterprise (action: ${action})`)
          const token = await solveRecaptchaEnterprise(pageUrl, sitekey || '6LfmcbcpAAAAAChNTbhUShzUOAMj_wY9LQIvLFX0', action || 'submit')
          console.log(token ? '[browserApply] CapSolver Enterprise token obtained via execute() intercept' : '[browserApply] CapSolver Enterprise failed in execute() intercept')
          return token ?? ''
        },
      )

      // Patch window.grecaptcha before any page script runs.
      // enterprise.js sets window.grecaptcha multiple times (stub → full impl).
      // WeakSet tracks each distinct enterprise object so every assignment is patched,
      // matching the same fix applied to the Trakstar v3 intercept.
      await page.addInitScript(() => {
        const GH_FALLBACK_KEY = '6LfmcbcpAAAAAChNTbhUShzUOAMj_wY9LQIvLFX0'
        let _grecaptcha: Record<string, unknown> | null = null
        const _patchedObjs = new WeakSet<object>()

        function patchExecute(obj: Record<string, unknown>): void {
          const enterprise = obj.enterprise as Record<string, unknown> | undefined
          if (!enterprise?.execute) return
          if (_patchedObjs.has(enterprise as object)) return
          _patchedObjs.add(enterprise as object)

          const origExecute = (enterprise.execute as Function).bind(enterprise)
          enterprise.execute = async (sitekey: string, opts: { action?: string } = {}) => {
            try {
              const token: string = await (window as unknown as Record<string, Function>)
                .__capsolverEnterpriseExecute(window.location.href, sitekey || GH_FALLBACK_KEY, opts?.action || 'submit')
              if (token) {
                // Sync ALL g-recaptcha-response textareas with this token so Steel's
                // auto-solved low-score token cannot compete with CapSolver's token.
                document.querySelectorAll('[id^="g-recaptcha-response"]').forEach(el => {
                  ;(el as HTMLTextAreaElement).value = token
                })
                return token
              }
            } catch {
              // CapSolver failed — fall through to original
            }
            return origExecute(sitekey, opts)
          }
        }

        Object.defineProperty(window, 'grecaptcha', {
          configurable: true,
          get() { return _grecaptcha },
          set(val: Record<string, unknown>) {
            _grecaptcha = val
            if (val) patchExecute(val)
          },
        })
      })

      console.log('[browserApply] Greenhouse: reCAPTCHA Enterprise execute() intercept installed')
    }

    // ── Trakstar reCAPTCHA v3 intercept ───────────────────────────────────────
    // Trakstar uses standard reCAPTCHA v3 (api.js, NOT enterprise.js).
    // On form submit it calls grecaptcha.execute(sitekey, {action:'hosted_site'}).
    // We intercept execute() via addInitScript so our CapSolver token is returned
    // instead of whatever Steel injects at a low bot-score.
    if (applyUrl.includes('trakstar.com')) {
      const TRAKSTAR_SITEKEY = '6LeH04UUAAAAADE9wHZVTWG944Agpm1vN71xquU8'

      await page.exposeFunction(
        '__capsolverV3Execute',
        async (pageUrl: string, sitekey: string, action: string): Promise<string> => {
          console.log(`[browserApply] Trakstar grecaptcha.execute() intercepted — calling CapSolver v3 (action: ${action})`)
          const token = await solveRecaptchaV3(pageUrl, sitekey || TRAKSTAR_SITEKEY, action || 'hosted_site')
          console.log(token
            ? '[browserApply] Trakstar: CapSolver v3 token obtained'
            : '[browserApply] Trakstar: CapSolver v3 failed — falling back to native')
          return token ?? ''
        },
      )

      await page.addInitScript((fallbackKey: string) => {
        let _grecaptcha: Record<string, unknown> | null = null
        // Track patched objects by identity so we patch EVERY new grecaptcha object.
        // api.js sets window.grecaptcha twice: first a stub, then the full impl.
        // A per-call boolean flag would mark "patched" after the stub, then skip
        // the real impl. WeakSet tracks each distinct object independently.
        const _patchedObjs = new WeakSet<object>()

        function patchExecute(obj: Record<string, unknown>): void {
          if (typeof obj?.execute !== 'function') return
          if (_patchedObjs.has(obj as object)) return  // already patched this exact object
          _patchedObjs.add(obj as object)

          const origExecute = (obj.execute as Function).bind(obj)
          obj.execute = async (sitekey: unknown, opts: Record<string, unknown> = {}) => {
            try {
              const token: string = await (window as unknown as Record<string, Function>)
                .__capsolverV3Execute(window.location.href, sitekey || fallbackKey, opts?.action || 'hosted_site')
              if (token) return token
            } catch { /* fall through to original */ }
            return origExecute(sitekey, opts)
          }
        }

        Object.defineProperty(window, 'grecaptcha', {
          configurable: true,
          get() { return _grecaptcha },
          set(val: Record<string, unknown>) {
            _grecaptcha = val
            if (val) patchExecute(val)
          },
        })
      }, TRAKSTAR_SITEKEY)

      console.log('[browserApply] Trakstar: reCAPTCHA v3 execute() intercept installed')
    }

    const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

    // Intercept DataDome captcha challenge requests so we can solve them
    let dataDomeCaptchaUrl: string | null = null
    page.on('request', (req: import('playwright').Request) => {
      const url = req.url()
      if (url.includes('captcha-delivery.com') || url.includes('dd-cf.com/js')) {
        dataDomeCaptchaUrl = url
      }
    })

    // ── FIX 1: Progressive warm-up through Wellfound's URL hierarchy ────────────
    // DataDome builds a behavioral profile per-URL-pattern. A single homepage visit
    // is insufficient — it blocks /jobs/:id pages with "Please enable JS and disable
    // any ad blocker" even with the homepage datadome cookie in place. We need to
    // build up clearance by visiting progressively deeper paths.
    if (isNativeWellfound && useResidentialProxy) {
      // Step 1: Homepage — retry twice on timeout; if still failing, skip warm-up and
      // proceed directly to the job URL. Warm-up is best-effort — CF clearance helps
      // but is not strictly required for every session.
      console.log('[browserApply] Warm-up step 1/3 — wellfound.com homepage...')
      let warmupOk = false
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await page.goto('https://wellfound.com', { waitUntil: 'domcontentloaded', timeout: 60000 })
          warmupOk = true
          break
        } catch {
          console.warn(`[browserApply] Homepage warm-up timeout (attempt ${attempt}/3)`)
          if (attempt < 3) await page.waitForTimeout(3000)
        }
      }
      if (!warmupOk) {
        console.warn('[browserApply] Homepage warm-up failed after 3 attempts — skipping to job URL')
      }
      await page.waitForTimeout(5000)
      const warmTitle1 = await page.title().catch(() => '')
      console.log(`[browserApply] Homepage title: "${warmTitle1}"`)
      if (warmTitle1.includes('Just a moment') || warmTitle1.includes('Attention Required')) {
        console.log('[browserApply] Homepage CF challenge — waiting 20s for challenge to clear')
        await page.waitForFunction(
          () => !document.title.includes('Just a moment') && !document.title.includes('Attention Required'),
          { timeout: 20_000 },
        ).catch(() => {})
        await page.waitForTimeout(2000)
      }

      // Step 2: Jobs listing — builds DataDome clearance for the /jobs/ path pattern
      console.log('[browserApply] Warm-up step 2/3 — wellfound.com/jobs listing...')
      let warmup2Ok = false
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await page.goto('https://wellfound.com/jobs', { waitUntil: 'domcontentloaded', timeout: 60000 })
          warmup2Ok = true
          break
        } catch {
          console.warn(`[browserApply] Jobs listing warm-up timeout (attempt ${attempt}/3)`)
          if (attempt < 3) await page.waitForTimeout(3000)
        }
      }
      if (!warmup2Ok) {
        console.warn('[browserApply] Jobs listing warm-up failed after 3 attempts — skipping to job URL')
      }
      await page.waitForTimeout(5000)
      const warmTitle2 = await page.title().catch(() => '')
      console.log(`[browserApply] Jobs listing title: "${warmTitle2}"`)
      if (warmTitle2.includes('Just a moment') || warmTitle2.includes('Attention Required') || warmTitle2.includes('wellfound.com')) {
        // Still challenged or not rendered — wait for DataDome/CF to clear
        await page.waitForFunction(
          () => !document.title.includes('Just a moment') && !document.title.includes('wellfound.com'),
          { timeout: 15_000 },
        ).catch(() => {})
        await page.waitForTimeout(3000)
      }

      // Wait for DataDome to resolve on the jobs listing if it fires there.
      // Steel's auto-captcha solver handles this but needs time.
      const warmup2Text = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).toLowerCase()
      const warmup2Html = await page.content().catch(() => '')
      const warmup2DataDome =
        dataDomeCaptchaUrl !== null ||
        warmup2Html.includes('captcha-delivery.com') ||
        warmup2Html.includes('datadome') ||
        warmup2Text.includes('slide right to secure')
      if (warmup2DataDome) {
        console.log('[browserApply] DataDome on /jobs listing — waiting up to 30s for challenge to clear...')
        // Steel's solveCaptcha:true should auto-dismiss the slider
        for (let i = 0; i < 6; i++) {
          await page.waitForTimeout(5000)
          const t = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).toLowerCase()
          if (!t.includes('slide right') && !t.includes('verification required')) {
            console.log('[browserApply] DataDome cleared on /jobs listing')
            break
          }
          console.log(`[browserApply] DataDome still present on /jobs — waiting (${(i + 1) * 5}s)...`)
        }
        await page.waitForTimeout(3000)
      }

      // Step 3: Navigate to the specific job via client-side navigation from the jobs listing.
      // Using window.location.href instead of page.goto() preserves the Referer header
      // (wellfound.com/jobs) and all existing DataDome/CF cookies, making the request look
      // like an organic click rather than a cold browser launch. This is critical — a direct
      // page.goto() to the job URL bypasses this referrer chain and triggers DataDome again.
      const jobPageUrl = applyUrl.split('?')[0]
      console.log(`[browserApply] Warm-up step 3/3 — client-side nav to job page: ${jobPageUrl}`)
      // Reset before navigating so we capture a fresh DataDome challenge URL specifically
      // for the job page (not stale URLs from /jobs listing in step 2).
      dataDomeCaptchaUrl = null
      await page.evaluate((url: string) => { window.location.href = url }, jobPageUrl)
      // Wait for domcontentloaded equivalent — waitForNavigation or a short fixed wait
      await page.waitForTimeout(8000)
      const warmTitle3 = await page.title().catch(() => '')
      console.log(`[browserApply] Job page title after warm-up nav: "${warmTitle3}"`)

      // If DataDome fires on the job page itself, wait for Steel to auto-solve
      const warmup3Text = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).toLowerCase()
      const warmup3Html = await page.content().catch(() => '')
      const warmup3DataDome =
        dataDomeCaptchaUrl !== null ||
        warmup3Html.includes('captcha-delivery.com') ||
        warmup3Html.includes('datadome') ||
        warmup3Text.includes('slide right to secure') ||
        warmup3Text.includes('verification required')
      if (warmup3DataDome) {
        console.log('[browserApply] DataDome on job page — waiting up to 30s for challenge to clear...')
        for (let i = 0; i < 6; i++) {
          await page.waitForTimeout(5000)
          const t = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).toLowerCase()
          if (!t.includes('slide right') && !t.includes('verification required')) {
            console.log('[browserApply] DataDome cleared on job page')
            break
          }
          console.log(`[browserApply] DataDome still present on job page — waiting (${(i + 1) * 5}s)...`)
        }
        await page.waitForTimeout(2000)
        // Only reset if DataDome is actually gone — if it's still showing, B5 will need
        // this URL. Unconditionally resetting here was the root cause of B5 broken-blank:
        // the iframe request already fired (no repeat), so B5 had no URL to pass CapSolver.
        const warmup3BodyText = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).toLowerCase()
        const warmup3Solved = !warmup3BodyText.includes('slide right') && !warmup3BodyText.includes('verification required')
        if (warmup3Solved) dataDomeCaptchaUrl = null
        else console.log('[browserApply] DataDome still active after warm-up — preserving captcha URL for B5 handler')
      }
    }

    // Navigation strategy:
    // • Steel / residential proxy + native Wellfound: warm-up step 3 above already
    //   performed client-side navigation (window.location.href) to the job page from
    //   wellfound.com/jobs, preserving the Referer chain. We are already on the job
    //   page — skip page.goto() to avoid a second cold navigation that re-triggers DataDome.
    // • No proxy + native Wellfound: use the apply URL directly (ScrapFly cookies
    //   provide the DataDome token).
    // • External ATS: navigate directly to the resolved ATS URL.
    const alreadyOnJobPage = isNativeWellfound && useResidentialProxy
    const navigateTo = isNativeWellfound
      ? (useResidentialProxy ? applyUrl.split('?')[0] : applyUrl)
      : effectiveUrl

    // ── B1: Navigation timeout detection (retry once) ────────────────────────
    // Skip if warm-up step 3 already navigated us to the job page client-side.
    let navResponse: import('playwright').Response | null = null
    let navTimedOut = false
    if (!alreadyOnJobPage) {
      try {
        // Use 'load' (not 'domcontentloaded') so CF managed-challenge JS has time to execute
        // and set cf_clearance before CloakBrowser follows the redirect to the real page.
        navResponse = await page.goto(navigateTo, { waitUntil: 'load', timeout: 60000 })
      } catch {
        console.warn('[browserApply] Navigation attempt 1 timed out — retrying in 3s...')
        navTimedOut = true
      }
      if (navTimedOut) {
        await page.waitForTimeout(3000)
        try {
          navResponse = await page.goto(navigateTo, { waitUntil: 'load', timeout: 60000 })
          navTimedOut = false
        } catch {
          const ss = await takeScreenshot(page, `${applicationId}-broken-timeout`)
          await browser?.close().catch(() => {})
          browser = null
          return handleBrokenJobPosting(applicationId, 'Navigation timed out twice', 'B1', ss)
        }
      }

      // ── B2: HTTP error response (404, 410, 500, 503) ─────────────────────────
      if (navResponse && [404, 410, 500, 503].includes(navResponse.status())) {
        const ss = await takeScreenshot(page, `${applicationId}-broken-http${navResponse.status()}`)
        await browser?.close().catch(() => {})
        browser = null
        return handleBrokenJobPosting(applicationId, `HTTP ${navResponse.status()} response`, 'B2', ss)
      }

      await page.waitForTimeout(3000)
    }

    // ── B3: Job posting is closed / expired ──────────────────────────────────
    const postNavText = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).toLowerCase()
    const CLOSED_PHRASES = [
      'job is no longer available', 'position has been filled',
      'listing has expired', 'no longer accepting applications',
      'job has been closed', 'position is closed',
      'this job is not available', 'job expired', 'applications are closed',
    ]
    if (CLOSED_PHRASES.some(p => postNavText.includes(p))) {
      const ss = await takeScreenshot(page, `${applicationId}-broken-closed`)
      await browser?.close().catch(() => {})
      browser = null
      return handleBrokenJobPosting(applicationId, 'Job posting is closed or expired', 'B3', ss)
    }

    // ── B5: Blank page ────────────────────────────────────────────────────────
    // IMPORTANT: DataDome's slider challenge renders entirely inside an iframe.
    // document.body.innerText on the outer page returns < 100 chars even when
    // DataDome is fully visible. Without this guard, B5 fires and exits BEFORE
    // the DataDome handler runs, making the captcha permanently unresolvable.
    // DO NOT remove this DataDome check — it is what makes DataDome work.
    if (postNavText.length < 100) {
      // BambooHR is a React SPA — the initial HTML shell has < 100 chars.
      // Wait for the app to hydrate before declaring B5.
      if (page.url().includes('bamboohr.com')) {
        await page.waitForSelector('body > *:not(script):not(style):not(noscript)', { timeout: 15000 }).catch(() => {})
        await page.waitForTimeout(3000)
        const bambooText = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).toLowerCase()
        if (bambooText.length >= 50) {
          // BambooHR content loaded — skip B5 and continue
        } else {
          const ss = await takeScreenshot(page, `${applicationId}-broken-blank`)
          await browser?.close().catch(() => {})
          browser = null
          return handleBrokenJobPosting(applicationId, 'BambooHR page loaded blank', 'B5', ss)
        }
      } else {
      // Give DataDome's captcha request interceptor time to fire (it's async)
      await page.waitForTimeout(5000)
      const refreshedText = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).toLowerCase()

      // Detect DataDome before declaring the page blank.
      // Check both the intercepted captcha URL and HTML content as fallbacks.
      const b5Html = await page.content().catch(() => '')
      const isDataDomePage =
        dataDomeCaptchaUrl !== null ||
        b5Html.includes('captcha-delivery.com') ||
        b5Html.includes('datadome') ||
        refreshedText.includes('slide right to secure')

      if (isDataDomePage) {
        // Recover the captcha URL if our request listener missed it.
        // When warm-up step 3 reset the variable after auto-solving, and DataDome
        // re-fires on the job page, the iframe request already fired and won't repeat.
        // Extract the URL directly from the page HTML (it's in the iframe src).
        if (!dataDomeCaptchaUrl) {
          const htmlForExtract = b5Html || await page.content().catch(() => '')
          const m = htmlForExtract.match(/https?:\/\/[^"'\s]*captcha-delivery\.com[^"'\s]*/i)
          if (m) {
            dataDomeCaptchaUrl = m[0].replace(/&amp;/g, '&')
            console.log('[browserApply] DataDome captcha URL extracted from page HTML:', dataDomeCaptchaUrl!.slice(0, 80))
          }
        }
        // If still null (iframe not yet rendered), poll up to 10s for the request event
        if (!dataDomeCaptchaUrl) {
          console.log('[browserApply] Waiting up to 10s for DataDome captcha URL from request listener...')
          for (let w = 0; w < 10 && !dataDomeCaptchaUrl; w++) {
            await page.waitForTimeout(1000)
          }
        }

        if (dataDomeCaptchaUrl) {
          console.log('[browserApply] DataDome blocking job listing — invoking CapSolver DataDomeSliderTask')
          const ddCookie = await solveDataDome(dataDomeCaptchaUrl, USER_AGENT)
          if (ddCookie) {
            bypassMethod = 'cloak_browser_plus_capsolver'
            const ddName = ddCookie.split('=')[0] ?? 'datadome'
            const ddValue = ddCookie.includes('=') ? ddCookie.split('=').slice(1).join('=') : ddCookie
            await context.addCookies([{
              name: ddName,
              value: ddValue.split(';')[0],
              domain: '.wellfound.com',
              path: '/',
              httpOnly: false,
              secure: false,
              sameSite: 'Lax',
            }])
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
            await page.waitForTimeout(2000)
            console.log('[browserApply] DataDome solved on listing page — continuing')
            // Do NOT return B5 — fall through to the rest of the flow
          } else {
            console.warn('[browserApply] CapSolver could not solve DataDome on listing page')
            await browser?.close().catch(() => {})
            browser = null
            return {
              status: 'needs_review',
              errorMessage: 'DataDome slider on Wellfound job listing — CapSolver could not solve it. Please try again later.',
              applyUrl,
              bypassMethod: 'failed',
            }
          }
        } else {
          // DataDome detected but no captcha URL intercepted — page is genuinely blank or broken
          console.warn('[browserApply] DataDome suspected but no captcha URL captured — treating as blank page')
          const ss = await takeScreenshot(page, `${applicationId}-broken-blank`)
          await browser?.close().catch(() => {})
          browser = null
          return handleBrokenJobPosting(applicationId, 'Page loaded blank (DataDome suspected)', 'B5', ss)
        }
      } else if (refreshedText.length < 100) {
        // Genuinely blank — no DataDome detected
        const ss = await takeScreenshot(page, `${applicationId}-broken-blank`)
        await browser?.close().catch(() => {})
        browser = null
        return handleBrokenJobPosting(applicationId, 'Page loaded blank', 'B5', ss)
      }
      } // close else (non-BambooHR) block
    }

    // ── B6: Redirected away from apply page ───────────────────────────────────
    let finalUrlAfterNav = page.url()

    // Recovery: if a Google API proxy URL hijacked the main frame (gapi.js side effect),
    // navigate back to the original target URL before checking B6.
    const GOOGLE_API_PATTERNS = ['content.googleapis.com', 'accounts.google.com/gsi', 'apis.google.com/js']
    if (isStartupJobsNative && GOOGLE_API_PATTERNS.some(p => finalUrlAfterNav.includes(p))) {
      console.log(`[browserApply] Google API redirect detected (${finalUrlAfterNav.slice(0, 80)}) — navigating back to startup.jobs`)
      await page.goto(navigateTo, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
      await page.waitForTimeout(5000)
      finalUrlAfterNav = page.url()
    }

    const APPLY_PATH_PATTERNS = [
      '/jobs/', '/careers/', '/careers?', '/apply', '/position', '/role',
      '/opening', '/vacancy', '/opportunity', 'greenhouse.io',
      'lever.co', 'workday.com', 'ashbyhq.com', 'wellfound.com',
      'trakstar.com', 'gh_jid=', 'startup.jobs',
    ]
    const isOnApplyPage = APPLY_PATH_PATTERNS.some(p => finalUrlAfterNav.toLowerCase().includes(p))
    if (!isOnApplyPage && finalUrlAfterNav !== navigateTo) {
      console.log('[browserApply] Redirected away from apply page:', finalUrlAfterNav)
      const ss = await takeScreenshot(page, `${applicationId}-broken-redirect`)
      await browser?.close().catch(() => {})
      browser = null
      return handleBrokenJobPosting(applicationId, 'Redirected away from job application', 'B6', ss)
    }

    // Log page state after navigation so we can debug button-not-found issues
    if (isNativeWellfound && useResidentialProxy) {
      const navTitle = await page.title().catch(() => '')
      const navUrl = page.url()
      console.log(`[browserApply] Job listing page — title: "${navTitle}", url: ${navUrl}`)
      await takeScreenshot(page, `${applicationId}-listing`)

      // Detect 404 early — job no longer exists, nothing to apply to
      if (navTitle.includes('404') || navTitle.toLowerCase().includes('page not found') || navTitle.toLowerCase().includes('not found')) {
        await browser.close().catch(() => {})
        browser = null
        return {
          status: 'needs_review',
          errorMessage: 'Job posting no longer exists (404)',
          applyUrl,
          bypassMethod,
        }
      }

      // If still on CF challenge, wait up to 20s for Steel to resolve
      if (navTitle.includes('Just a moment') || navTitle.includes('Attention Required')) {
        console.log('[browserApply] CF challenge on job listing — waiting 20s for challenge to clear...')
        await page.waitForFunction(
          () => !document.title.includes('Just a moment') && !document.title.includes('Attention Required'),
          { timeout: 20_000 },
        ).catch(() => {})
        await page.waitForTimeout(2000)
      }
    }

    // ── FIX 2: Click "Apply Now" in Steel path as well as residential proxy path ─
    // Previously the click only ran for useResidentialProxy. Steel also needs it:
    // navigating directly to ?autoOpenApplication=true fires a CF managed challenge
    // (cf-mitigated: challenge) that Steel cannot auto-solve. Clicking the button
    // from the listing page triggers the same URL change client-side via React
    // router, which reuses the established cf_clearance cookie without a fresh CF
    // check.
    let fix2ApplyClicked = false
    if (isNativeWellfound && useResidentialProxy) {
      console.log('[browserApply] Clicking Apply Now to open modal (client-side navigation)...')

      // Wait for the page to settle and the Apply button to appear
      await page.waitForSelector(
        '[data-test="JobApplicationApplyButton"], button:has-text("Apply"), button:has-text("Easy Apply"), a:has-text("Apply Now")',
        { timeout: 12000 },
      ).catch(() => {})
      await page.waitForTimeout(1000)

      // Try Playwright locator (handles React-rendered buttons that lack onclick attributes)
      const applyBtnLocator = page.locator(
        '[data-test="JobApplicationApplyButton"], ' +
        'button:has-text("Easy Apply"), ' +
        'button:has-text("Apply Now"), ' +
        'button:has-text("Apply"), ' +
        'a:has-text("Apply Now")'
      ).first()

      const applyBtnVisible = await applyBtnLocator.isVisible({ timeout: 5000 }).catch(() => false)
      if (applyBtnVisible) {
        console.log('[browserApply] Apply Now button found — clicking...')
        await applyBtnLocator.scrollIntoViewIfNeeded().catch(() => {})
        await randomDelay(300, 700)
        await applyBtnLocator.click().catch(() => {})
        fix2ApplyClicked = true
        console.log('[browserApply] Apply Now clicked — waiting for modal URL...')
        await page.waitForURL(/autoOpenApplication/, { timeout: 15000 }).catch(() => {})
        await page.waitForTimeout(2000)
      } else {
        // Button not found — fall back to direct navigation
        console.log('[browserApply] Apply Now button not found — navigating directly to apply URL')
        await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
        await page.waitForTimeout(2000)
      }
    }

    // ── FIX 3: Wait up to 30s for CF managed challenge after Apply Now click ────
    // The ?autoOpenApplication=true URL fires a CF managed challenge (cf-mitigated:
    // challenge) with sitekey 0x4AAAAAAA. Steel's built-in solver may handle it
    // within ~15s. We wait the full 30s before escalating to CapSolver.
    const cfTitlePost = await page.title().catch(() => '')
    const cfHtmlPost = await page.content().catch(() => '')
    const isCfChallenge = cfTitlePost.includes('Just a moment') ||
      cfTitlePost.includes('Attention Required') ||
      cfHtmlPost.includes('challenge-form') ||
      cfHtmlPost.includes('cf-turnstile') ||
      cfHtmlPost.includes('Checking your browser')

    if (isCfChallenge) {
      // Three-phase CF managed challenge resolution:
      //   Phase 1 — Give Steel's built-in solver 30s to auto-clear
      //   Phase 2 — Escalate to CapSolver (AntiTurnstileTaskProxyLess, action: managed)
      //   Phase 3 — Give Steel another 60s after CapSolver token injection
      // Only mark B8 if all three phases fail.
      //
      // IMPORTANT: Do NOT check for 'cf-turnstile' or 'challenge-form' in page HTML
      // to determine if the challenge is still active. The Wellfound application form
      // itself embeds an invisible Turnstile widget, so those strings appear in the HTML
      // even after the CF challenge is resolved. Checking only title and body text is
      // the reliable signal: CF challenge pages show "Just a moment..." in the title
      // and "Checking if the site connection is secure" in body text.
      const WELLFOUND_CF_SITEKEY = '0x4AAAAAAADnPIDROrmt1Wwj'

      const isStillOnCfChallenge = async (): Promise<boolean> => {
        const t = await page.title().catch(() => '')
        const b = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')
        return (
          t.includes('Just a moment') ||
          t.includes('Attention Required') ||
          b.includes('Checking your browser') ||
          b.includes('Verifying you are human') ||
          b.includes('Checking if the site connection is secure')
        )
      }

      // ── Phase 1: poll 18 × 5s = 90s for CloakBrowser/challenge to clear ────────
      // CloakBrowser's CF managed-challenge bypass runs JS in the background and
      // sets cf_clearance before redirecting. Give it 90s to complete.
      console.log('[browserApply] CF challenge detected — Phase 1: polling 90s for CloakBrowser to clear...')
      let cfCleared = false
      for (let p = 0; p < 18; p++) {
        await page.waitForTimeout(5000)
        if (!(await isStillOnCfChallenge())) {
          console.log(`[browserApply] CF cleared after ~${(p + 1) * 5}s (Phase 1)`)
          cfCleared = true
          break
        }
        if ((p + 1) % 6 === 0) {
          console.log(`[browserApply] Phase 1 still waiting... ${(p + 1) * 5}s elapsed`)
        }
      }

      // ── Phase 2: CapSolver CloudflareChallengePage ───────────────────────────
      // For full managed challenges (not embeddable Turnstile), CapSolver spins up
      // its own browser, solves the challenge, and returns a cf_clearance cookie.
      // We inject the cookie and reload — bypassing the challenge entirely.
      if (!cfCleared) {
        const urlBeforeCapSolver = page.url()
        console.log('[browserApply] Phase 1 timed out — escalating to CapSolver CloudflareChallengePage...')
        const cfCookies = await solveCloudflareInteractivePage(urlBeforeCapSolver)

        // Re-check: challenge may have cleared while CapSolver was working
        if (!(await isStillOnCfChallenge())) {
          console.log('[browserApply] CF cleared during CapSolver processing — skipping injection')
          cfCleared = true
        } else if (cfCookies && cfCookies.length > 0) {
          bypassMethod = 'cloak_browser_plus_capsolver'
          console.log(`[browserApply] Injecting ${cfCookies.length} CapSolver CF cookies (cf_clearance)...`)
          await context.addCookies(cfCookies.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
            path: c.path || '/',
            httpOnly: false,
            secure: true,
            sameSite: 'Lax' as const,
          })))
          await page.reload({ waitUntil: 'load', timeout: 30000 }).catch(() => {})
          await page.waitForTimeout(2000)
          if (!(await isStillOnCfChallenge())) {
            console.log('[browserApply] CF cleared by CapSolver cookie injection (Phase 2)')
            cfCleared = true
          }
        } else {
          console.warn('[browserApply] CapSolver CloudflareChallengePage returned null — proceeding to Phase 3 poll')
        }
      }

      // ── Phase 3: Steel follow-up poll, 12 × 5s = 60s ────────────────────────
      if (!cfCleared) {
        console.log('[browserApply] Phase 3: polling another 60s after CapSolver attempt...')
        for (let p = 0; p < 12; p++) {
          await page.waitForTimeout(5000)
          if (!(await isStillOnCfChallenge())) {
            console.log(`[browserApply] CF cleared after ~${(p + 1) * 5}s (Phase 3)`)
            cfCleared = true
            break
          }
          if ((p + 1) % 4 === 0) {
            console.log(`[browserApply] Phase 3 still waiting... ${(p + 1) * 5}s elapsed`)
          }
        }
      }

      if (!cfCleared) {
        // ── B8: Permanent anti-bot block — all three phases exhausted ────────
        console.warn('[browserApply] CF challenge not cleared after all phases — skipping as permanent block (B8)')
        const ss = await takeScreenshot(page, `${applicationId}-broken-blocked`)
        await browser?.close().catch(() => {})
        browser = null
        return handleBrokenJobPosting(
          applicationId,
          'Anti-bot challenge not bypassed after 30s poll + CapSolver + 60s poll',
          'B8',
          ss,
        )
      }
      await page.waitForTimeout(2000)
    }

    // ── Check for slider challenge (DataDome OR Cloudflare interactive) ────────
    const pageBodyText = await page.evaluate(() => document.body.innerText).catch(() => '')
    const hasSliderText = pageBodyText.includes('Slide right to secure your access') ||
      pageBodyText.includes('Verification Required')
    const isDataDomeSlider = hasSliderText && dataDomeCaptchaUrl !== null
    const isCfInteractiveSlider = hasSliderText && dataDomeCaptchaUrl === null

    if (isDataDomeSlider) {
      console.log('[browserApply] DataDome slider detected — invoking CapSolver DataDomeSliderTask')
      const ddCookie = await solveDataDome(dataDomeCaptchaUrl!, USER_AGENT)
      if (ddCookie) {
        bypassMethod = isNativeWellfound ? 'scrapfly_plus_capsolver' : 'cloak_browser_plus_capsolver'
        const ddName = ddCookie.split('=')[0] ?? 'datadome'
        const ddValue = ddCookie.includes('=') ? ddCookie.split('=').slice(1).join('=') : ddCookie
        await context.addCookies([{
          name: ddName,
          value: ddValue.split(';')[0],
          domain: '.wellfound.com',
          path: '/',
          httpOnly: false,
          secure: false,
          sameSite: 'Lax',
        }])
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
        await page.waitForTimeout(2000)
      } else {
        await browser.close().catch(() => {})
        browser = null
        return {
          status: 'needs_review',
          errorMessage: 'DataDome slider on Wellfound — CapSolver could not solve it',
          applyUrl,
          bypassMethod: 'failed',
        }
      }
    } else if (isCfInteractiveSlider) {
      // Cloudflare's interactive "Slide right to secure your access" challenge.
      // This is NOT Turnstile — it requires CloudflareChallengePage task type which
      // returns cf_clearance cookies to inject, then we reload the page.
      console.log('[browserApply] Cloudflare interactive slider detected — invoking CapSolver CloudflareChallengePage')
      const cfCookies = await solveCloudflareInteractivePage(page.url())
      if (cfCookies && cfCookies.length > 0) {
        bypassMethod = 'cloak_browser_plus_capsolver'
        await context.addCookies(cfCookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain || '.wellfound.com',
          path: c.path || '/',
          httpOnly: false,
          secure: true,
          sameSite: 'Lax' as const,
        })))
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
        await page.waitForTimeout(2000)
      } else {
        // CapSolver couldn't solve it — wait 15s and let Steel's built-in solver retry
        console.warn('[browserApply] CapSolver CloudflareChallengePage failed — waiting 15s for challenge to clear')
        await page.waitForTimeout(15000)
      }
    }

    // ── Check for remaining Cloudflare Turnstile (non-managed, on external ATS) ──
    const pageHtml = await page.content().catch(() => '')
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '')
    if (
      pageText.includes('Verify you are human') ||
      pageText.includes('Checking if the site connection is secure') ||
      pageHtml.includes('cf-turnstile')
    ) {
      console.log('[browserApply] Cloudflare Turnstile challenge — invoking CapSolver')
      const liveSiteKey = await page.evaluate(() => {
        const el = document.querySelector('[data-sitekey]')
        if (el) return el.getAttribute('data-sitekey')
        const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]')
        if (iframe) {
          const src = iframe.getAttribute('src') ?? ''
          const m = src.match(/[?&]sitekey=([^&]+)/)
          if (m) return decodeURIComponent(m[1])
        }
        return null
      })
      if (liveSiteKey) {
        const token = await solveTurnstile(navigateTo, liveSiteKey)
        if (token) {
          bypassMethod = isNativeWellfound ? 'scrapfly_plus_capsolver' : 'cloak_browser_plus_capsolver'
          capsolvToken = token
          await page.evaluate((t: string) => {
            const field = document.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]')
            if (field) field.value = t
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(window as any).cfCallback?.(t)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(window as any).turnstileCallback?.(t)
            const form = document.getElementById('challenge-form') as HTMLFormElement | null
            if (form) form.submit()
          }, token)
          await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
          await page.waitForTimeout(2000)
        } else {
          await browser.close().catch(() => {})
          browser = null
          await prisma.application.update({ where: { id: applicationId }, data: { bypassMethod: 'failed' } }).catch(() => {})
          return { status: 'needs_review', errorMessage: 'Turnstile challenge — CapSolver could not solve it', applyUrl, bypassMethod: 'failed' }
        }
      } else {
        console.log('[browserApply] No Turnstile sitekey found — waiting 20s for challenge to clear')
        await page.waitForFunction(
          () => !document.body?.innerHTML?.includes('cf-turnstile') && !document.body?.innerHTML?.includes('challenge-form'),
          { timeout: 20_000 },
        ).catch(() => {})
        await page.waitForTimeout(2000)
      }
    } else if (capsolvToken) {
      await page.evaluate((token: string) => {
        const field = document.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]')
        if (field) field.value = token
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(window as any).cfCallback?.(token)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(window as any).turnstileCallback?.(token)
        const form = document.getElementById('challenge-form') as HTMLFormElement | null
        if (form) form.submit()
      }, capsolvToken)
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
      await page.waitForTimeout(1000)
    }

    // ── CloakBrowser live recon (external ATS only) ───────────────────────────
    // Scrapfly recon was skipped for non-Wellfound sites (CloakBrowser handles bypass).
    // Extract fields from the live page HTML now that the browser has navigated past
    // any protection, then re-run Claude mapping.
    if (!isNativeWellfound && fillMapping.length === 0) {
      // Dismiss OneTrust / cookie-consent banners before looking for the real form.
      // Oscar Insurance (and others) show a cookie modal whose inputs are
      // accidentally captured as "form fields", blocking real form detection.
      // Two-pass OneTrust dismiss:
      //   Pass 1 — simple banner ("Accept All", "Accept All Cookies", etc.)
      //   Pass 2 — detailed vendor modal ("Confirm My Choices", "Save & Close")
      //            Oscar Insurance shows the full vendor-selection modal, not the simple banner.
      const oneTrustDismissed = await page.locator(
        '#onetrust-accept-btn-handler, ' +
        'button:has-text("Accept All Cookies"), ' +
        'button:has-text("Accept All"), ' +
        'button:has-text("I Accept"), ' +
        'button:has-text("Agree"), ' +
        '[id*="accept"][id*="cookie"], ' +
        '[class*="accept-all"]'
      ).first().click({ timeout: 3000 }).then(() => true).catch(() => false)

      // Pass 2: detailed consent modal (Oscar Insurance, etc.)
      const oneTrustConfirmed = oneTrustDismissed ? false : await page.locator(
        'button:has-text("Confirm My Choices"), ' +
        'button:has-text("Save & Close"), ' +
        'button:has-text("Save and Close"), ' +
        'button:has-text("Save Preferences"), ' +
        '#accept-recommended-btn-handler, ' +
        '[class*="save-preference"], ' +
        '[class*="confirm-choice"]'
      ).first().click({ timeout: 3000 }).then(() => true).catch(() => false)

      const dismissed = oneTrustDismissed || oneTrustConfirmed
      console.log(`[browserApply] OneTrust dismiss: ${dismissed ? `clicked (${oneTrustDismissed ? 'banner' : 'detailed modal'})` : 'not found / already dismissed'}`)
      if (dismissed) await page.waitForTimeout(800)

      // ── Pre-check: startup.jobs apply pages are redirect/link pages, not native forms.
      // They render a single read-only input whose value IS the external ATS URL
      // (e.g. truegenics.bamboohr.com/careers/167). Detect that and navigate directly.
      // Also check for embedded ATS iframes as a fallback.
      if (page.url().includes('startup.jobs')) {
        // Wait briefly for React to render the readonly link field
        await page.waitForSelector('input[readonly]', { timeout: 5000 }).catch(() => {})
        await page.waitForTimeout(500)

        const externalAtsUrl = await page.evaluate(() => {
          const ATS_PATTERN = /bamboohr\.com|greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com|icims\.com|taleo\.net|jobvite\.com/i
          const GOOGLE_PATTERN = /googleapis\.com|accounts\.google\.com|google\.com\/gsi/i
          const inputs = Array.from(document.querySelectorAll('input[readonly]'))
          for (const input of inputs) {
            const val = (input as HTMLInputElement).value ?? ''
            // Only match if the ATS domain appears in the origin/path, not just in a hash fragment
            const valNoHash = val.split('#')[0]
            if (GOOGLE_PATTERN.test(valNoHash)) continue
            if (ATS_PATTERN.test(valNoHash)) return val
          }
          // Also check iframes as fallback
          const iframes = Array.from(document.querySelectorAll('iframe'))
          for (const f of iframes) {
            const src = (f as HTMLIFrameElement).src || f.getAttribute('src') || ''
            const srcNoHash = src.split('#')[0]
            if (GOOGLE_PATTERN.test(srcNoHash)) continue
            if (ATS_PATTERN.test(srcNoHash)) return src
          }
          return null
        }).catch(() => null)

        const earlyFrame = page.frames().find((f: import('playwright').Frame) => {
          const fUrl = f.url()
          if (fUrl === 'about:blank') return false
          // Exclude Google API proxy frames — their URL contains ATS domains only in the hash fragment
          if (/googleapis\.com|google\.com\/gsi|accounts\.google\.com/i.test(fUrl.split('#')[0])) return false
          return /greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com|bamboohr\.com/i.test(fUrl)
        })
        const earlyAtsUrl = externalAtsUrl || earlyFrame?.url() || null
        if (earlyAtsUrl && earlyAtsUrl !== page.url()) {
          console.log(`[browserApply] startup.jobs redirect link — navigating to ATS: ${earlyAtsUrl}`)
          await page.goto(earlyAtsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
          await page.waitForTimeout(2000)
          await page.waitForSelector('input[type="text"], input[type="email"], textarea, input[name]', { timeout: 8000 }).catch(() => {})
          await page.waitForTimeout(1000)
        }
      }

      // Wait for JS-rendered form content to appear before extracting fields.
      // Pages like startup.jobs render the application form client-side after CF
      // bypass; calling page.content() immediately may capture empty shell HTML.
      await page.waitForSelector('input, textarea, select', { timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(1500)
      const liveHtml = await page.content().catch(() => '')
      if (liveHtml) {
        rawFields = extractFieldsFromHtml(liveHtml)
        // Strip cookie-consent fields (OneTrust) — they are never job-application inputs
        rawFields = rawFields.filter(f => !/^#ot-|^#onetrust-|ot-group|ot-sub-group|vendor-search|#chkbox-id|select-all-.*-handler/i.test(f.selector))
        // BambooHR listing page detection — "Link to This Job" is the only field on the
        // listing page. Click the Apply button to open the real application form.
        const isBambooHrListing = page.url().includes('bamboohr.com') &&
          rawFields.length <= 2 &&
          rawFields.some(f => /link to this job/i.test(f.label ?? ''))
        if (isBambooHrListing) {
          console.log('[browserApply] BambooHR listing detected — clicking Apply button')
          const bambooApplyBtn = page.locator(
            'a:has-text("Apply"), button:has-text("Apply"), ' +
            'a:has-text("Apply Now"), button:has-text("Apply Now"), ' +
            '[data-testid*="apply"], [class*="apply-btn"], [class*="ApplyButton"]'
          ).first()
          const bambooApplyVisible = await bambooApplyBtn.isVisible({ timeout: 5000 }).catch(() => false)
          if (bambooApplyVisible) {
            await bambooApplyBtn.click().catch(() => {})
            await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
            // BambooHR Fabric UI renders inputs asynchronously — wait for React to hydrate
            await page.waitForSelector(
              'input:not([type="hidden"]), textarea, select',
              { timeout: 20000 }
            ).catch(() => {})
            await page.waitForTimeout(3000)
          } else {
            // Fallback: navigate directly to /apply
            const applyFormUrl = page.url().replace(/\/apply\/?$/, '').replace(/\?.*$/, '') + '/apply'
            console.log(`[browserApply] BambooHR Apply button not found — navigating directly: ${applyFormUrl}`)
            await page.goto(applyFormUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
            await page.waitForSelector(
              'input:not([type="hidden"]), textarea, select',
              { timeout: 20000 }
            ).catch(() => {})
            await page.waitForTimeout(4000)
          }
          // BambooHR Fabric UI renders inputs via React — use live DOM query instead of HTML parse
          const bambooLiveFields = await page.$$eval(
            'input:not([type="hidden"]):not([type="submit"]):not([readonly]), textarea:not([readonly]), select',
            (els) => {
              let fileIndex = 0
              return els.map((el) => {
                const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
                const id = input.id || ''
                const name = (input as HTMLInputElement).name || ''
                const type = (input as HTMLInputElement).type || ''
                // For file inputs with no id/name, generate a stable nth-of-type selector
                let sel = id ? `#${id}` : name ? `[name="${name}"]` : ''
                if (!sel && type === 'file') {
                  sel = `input[type="file"]:nth-of-type(${++fileIndex})`
                }
                if (!sel) return null
                // Find associated label
                let label = ''
                if (id) {
                  const lbl = document.querySelector(`label[for="${id}"]`)
                  if (lbl) label = lbl.textContent?.trim() ?? ''
                }
                if (!label) {
                  const closest = input.closest('label, [class*="field"], [class*="Field"]')
                  if (closest) label = closest.textContent?.replace(input.value, '').trim() ?? ''
                }
                if (!label && type === 'file') label = 'Resume'
                const required = input.required || input.getAttribute('aria-required') === 'true'
                return { selector: sel, label, inputType: type || input.tagName.toLowerCase(), tagName: input.tagName.toLowerCase(), required }
              }).filter(Boolean)
            }
          ).catch(() => [])

          if (bambooLiveFields.length > 0) {
            rawFields = (bambooLiveFields as typeof rawFields)
              .filter(f => !/link to this job/i.test(f.label ?? ''))
          } else {
            // Final fallback: parse from HTML
            const bambooHtml = await page.content().catch(() => '')
            rawFields = extractFieldsFromHtml(bambooHtml)
              .filter(f => !/^#ot-|^#onetrust-|ot-group|ot-sub-group|vendor-search|#chkbox-id|select-all-.*-handler|link to this job/i.test(f.label ?? f.selector))
          }
          console.log('[browserApply] BambooHR form fields:', JSON.stringify(rawFields.map(f => ({ sel: f.selector, label: f.label, type: f.inputType, tag: f.tagName, req: f.required }))))
        }

        if (rawFields.length > 0) {
          console.log('[browserApply] Raw fields:', JSON.stringify(rawFields.map(f => ({ sel: f.selector, label: f.label, type: f.inputType, tag: f.tagName, req: f.required }))))
          {
            const _c = await claudeFormMapping(rawFields, profile, job, resumeText)
            const _fb = fallbackFormMapping(rawFields, profile)
            const _cs = new Set(_c.map(f => f.selector))
            fillMapping = [..._fb.filter(f => !_cs.has(f.selector)), ..._c]
            console.log(`[browserApply] Live recon: ${rawFields.length} fields found, ${_c.length} Claude + ${_fb.filter(f => !_cs.has(f.selector)).length} fallback = ${fillMapping.length} merged`)
          }
        } else {
          const diagTitle = await page.title().catch(() => '')
          const diagUrl = page.url()
          console.log(`[browserApply] Steel live recon: no form fields detected — title="${diagTitle}" url=${diagUrl}`)

          // ── Strategy 1: Detect ATS iframe and navigate directly to it ──────────
          // Greenhouse, Ashby, Lever, etc. are often embedded as cross-origin iframes
          // on company career pages.  page.content() only returns main-frame HTML, so
          // fields inside these iframes are invisible to extractFieldsFromHtml.
          // Navigating directly to the iframe URL puts the form in the main frame.
          const atsIframeSrc = await page.evaluate(() => {
            const iframes = Array.from(document.querySelectorAll('iframe'))
            for (const f of iframes) {
              const src = (f as HTMLIFrameElement).src || f.getAttribute('src') || ''
              if (/greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com|icims\.com|taleo\.net|jobvite\.com|bamboohr\.com/i.test(src)) {
                return src
              }
            }
            // Also check frames already loaded (Playwright frame API picks them up)
            return null
          }).catch(() => null)

          // Also check via Playwright's own frame list (catches dynamically-added iframes)
          const atsFrame = page.frames().find((f: import('playwright').Frame) =>
            /greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com|bamboohr\.com/i.test(f.url()) && f.url() !== 'about:blank'
          )
          const atsDirectUrl = atsIframeSrc || atsFrame?.url() || null

          if (atsDirectUrl && atsDirectUrl !== page.url()) {
            console.log(`[browserApply] ATS iframe detected — navigating directly: ${atsDirectUrl}`)
            await page.goto(atsDirectUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
            await page.waitForTimeout(2000)
            // Give JS-rendered forms a moment to paint
            await page.waitForSelector('input[type="text"], input[type="email"], textarea, input[name]', { timeout: 8000 }).catch(() => {})
            await page.waitForTimeout(1000)
            const atsHtml = await page.content().catch(() => '')
            const atsFields = extractFieldsFromHtml(atsHtml)
              .filter(f => !/^#ot-|^#onetrust-|ot-group|ot-sub-group|vendor-search|chkbox-id|select-all-.*-handler/i.test(f.selector))
            if (atsFields.length > 0) {
              rawFields = atsFields
              console.log('[browserApply] ATS iframe direct nav: fields found:', JSON.stringify(rawFields.map(f => ({ sel: f.selector, label: f.label }))))
              {
                const _c = await claudeFormMapping(rawFields, profile, job, resumeText)
                const _fb = fallbackFormMapping(rawFields, profile)
                const _cs = new Set(_c.map(f => f.selector))
                fillMapping = [..._fb.filter(f => !_cs.has(f.selector)), ..._c]
                console.log(`[browserApply] ATS iframe: ${rawFields.length} fields, ${_c.length} Claude + ${_fb.filter(f => !_cs.has(f.selector)).length} fallback = ${fillMapping.length} merged`)
              }
            }
          }

          // ── Strategy 2: If we landed on a job description page, click Apply ────
          // Oscar Insurance / Talent ATS: startup.jobs redirects to the job posting page,
          // not directly to the application form.  The form only appears after clicking Apply.
          if (rawFields.length === 0) {
            const applyBtnLocator = page.locator(
              'a:has-text("Apply Now"), button:has-text("Apply Now"), ' +
              'a:has-text("Apply"), button:has-text("Apply"), ' +
              '[data-testid="apply-button"], .apply-button, [class*="apply-btn"]'
            ).first()
            const applyBtnVisible = await applyBtnLocator.isVisible({ timeout: 3000 }).catch(() => false)
            if (applyBtnVisible) {
              console.log('[browserApply] Apply button found on job description page — clicking to open form')
              await humanClick(page, applyBtnLocator)
              // Wait for the application form to load (or ATS redirect)
              await page.waitForSelector('input[type="text"], input[type="email"], textarea', { timeout: 15000 }).catch(() => {})
              await page.waitForTimeout(1500)
              const formHtml = await page.content().catch(() => '')
              if (formHtml) {
                let newFields = extractFieldsFromHtml(formHtml)
                newFields = newFields.filter(f => !/^#ot-|^#onetrust-|ot-group|ot-sub-group|vendor-search|chkbox-id|select-all-.*-handler/i.test(f.selector))
                if (newFields.length > 0) {
                  rawFields = newFields
                  console.log('[browserApply] Found form after Apply click:', JSON.stringify(rawFields.map(f => ({ sel: f.selector, label: f.label }))))
                  {
                    const _c = await claudeFormMapping(rawFields, profile, job, resumeText)
                    const _fb = fallbackFormMapping(rawFields, profile)
                    const _cs = new Set(_c.map(f => f.selector))
                    fillMapping = [..._fb.filter(f => !_cs.has(f.selector)), ..._c]
                    console.log(`[browserApply] Post-Apply-click: ${rawFields.length} fields, ${_c.length} Claude + ${_fb.filter(f => !_cs.has(f.selector)).length} fallback = ${fillMapping.length} merged`)
                  }
                }
              }
            }
          }
        }
      }
    }

    // ── For native Wellfound: open the modal by clicking Apply button ─────────
    // The ?autoOpenApplication=true URL triggers Cloudflare. Instead, load the
    // base URL and click the Apply button — React opens the modal client-side.
    // If fix2ApplyClicked is true, FIX 2 already clicked Apply — skip re-click and
    // wait for the form/CF resolution to settle.
    if (isNativeWellfound) {
      if (fix2ApplyClicked) {
        console.log('[browserApply] Apply already clicked in FIX 2 — waiting for form to appear...')
        // Wait up to 60s for form fields to appear (Steel may still be solving CF)
        await page.waitForSelector(
          'input[name="name"], input[name="email"], input[type="password"], textarea, button:has-text("Send application")',
          { timeout: 60000 }
        ).catch(() => {})
        await page.waitForTimeout(1000)
      } else {
        console.log('[browserApply] Waiting for page to fully render...')
        // Wait for either the Apply button or the form to be present
        await page.waitForSelector(
          '[data-test="JobApplicationApplyButton"], button:has-text("Apply"), button:has-text("Easy Apply"), input[name="name"], input[name="email"]',
          { timeout: 15000 }
        ).catch(() => {})
        await page.waitForTimeout(1000)
      }

      // Check if modal is already open (from ?autoOpenApplication=true in URL)
      const formAlreadyOpen = await page.locator('input[name="name"], input[name="email"], textarea').isVisible({ timeout: 2000 }).catch(() => false)

      if (!formAlreadyOpen && !fix2ApplyClicked) {
        console.log('[browserApply] Opening modal by clicking Apply button...')
        // Try multiple selectors for the Apply button
        const applyBtnLocator = page.locator(
          '[data-test="JobApplicationApplyButton"], ' +
          'button:has-text("Easy Apply"), ' +
          'button:has-text("Apply Now"), ' +
          'a:has-text("Apply")'
        ).first()

        const applyVisible = await applyBtnLocator.isVisible({ timeout: 5000 }).catch(() => false)
        if (applyVisible) {
          await applyBtnLocator.scrollIntoViewIfNeeded().catch(() => {})
          await randomDelay(400, 800)
          await applyBtnLocator.click()
          // Wait for React to render the modal form
          await page.waitForSelector(
            'input[name="name"], input[name="email"], input[type="password"], button:has-text("Send application"), button:has-text("Submit application")',
            { timeout: 15000 }
          ).catch(() => {})
          await page.waitForTimeout(1500)
        } else {
          // Button not found — try navigating directly with ?autoOpenApplication=true
          // (risk of CF challenge but better than failing silently)
          console.log('[browserApply] Apply button not found — trying direct modal URL')
          const modalUrl = applyUrl.includes('?') ? applyUrl : applyUrl + '?autoOpenApplication=true'
          await page.goto(modalUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
          await page.waitForTimeout(4000)

          // Modal URL can trigger a second Cloudflare challenge — handle it with CapSolver
          const cfTitleModal = await page.title().catch(() => '')
          if (cfTitleModal.includes('Just a moment') || cfTitleModal.includes('Attention Required')) {
            console.log('[browserApply] Cloudflare interstitial on modal URL — waiting up to 30s for auto-resolve')
            await page.waitForFunction(
              () => !document.title.includes('Just a moment') && !document.title.includes('Attention Required'),
              { timeout: 30_000 },
            ).catch(() => {})
            await page.waitForTimeout(2000)
          }
          const modalBodyHtml = await page.content().catch(() => '')
          const modalPageText = await page.evaluate(() => document.body.innerText).catch(() => '')
          if (
            modalPageText.includes('Verify you are human') ||
            modalPageText.includes('Checking if the site connection is secure') ||
            modalBodyHtml.includes('cf-turnstile') ||
            modalBodyHtml.includes('challenge-form')
          ) {
            console.log('[browserApply] CF Turnstile on modal URL — invoking CapSolver')
            // Look for sitekey on main page OR inside the Turnstile iframe src URL
            const modalSiteKey = await page.evaluate(() => {
              const el = document.querySelector('[data-sitekey]')
              if (el) return el.getAttribute('data-sitekey')
              const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]')
              if (iframe) {
                const src = iframe.getAttribute('src') ?? ''
                const m = src.match(/[?&]sitekey=([^&]+)/)
                if (m) return decodeURIComponent(m[1])
              }
              return null
            })
            // CF managed challenge sitekey is injected via JS — fall back to known Wellfound sitekey
            const WELLFOUND_CF_MANAGED_SITEKEY = '0x4AAAAAAADnPIDROrmt1Wwj'
            const resolvedModalSiteKey = modalSiteKey ?? WELLFOUND_CF_MANAGED_SITEKEY
            if (resolvedModalSiteKey) {
              // Use solveCloudflareChallenge (action: 'managed') for Wellfound's managed challenge sitekey
              const modalToken = await solveCloudflareChallenge(modalUrl, resolvedModalSiteKey)
              if (modalToken) {
                bypassMethod = 'cloak_browser_plus_capsolver'
                capsolvToken = modalToken
                await page.evaluate((t: string) => {
                  const field = document.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]')
                  if (field) field.value = t
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ;(window as any).cfCallback?.(t)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  ;(window as any).turnstileCallback?.(t)
                  // Submit challenge form to trigger CF clearance cookie
                  const form = document.getElementById('challenge-form') as HTMLFormElement | null
                  if (form) form.submit()
                }, modalToken)
                // Wait for navigation away from CF challenge
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {})
                await page.waitForTimeout(2000)
              } else {
                console.log('[browserApply] CapSolver could not solve CF managed challenge on modal URL — waiting 15s for challenge to clear')
                await page.waitForFunction(
                  () => !document.body?.innerHTML?.includes('cf-turnstile') && !document.body?.innerHTML?.includes('challenge-form'),
                  { timeout: 15_000 },
                ).catch(() => {})
                await page.waitForTimeout(2000)
              }
            }
          }
        }
      } else if (!fix2ApplyClicked) {
        console.log('[browserApply] Modal already open on page load')
      }
    }

    // ── Native Wellfound: fill the modal that was opened above ───────────────
    if (isNativeWellfound) {
      // The modal was opened by clicking Apply above; give it a moment to settle
      await page.waitForTimeout(500)

      // Guard: if still on Cloudflare challenge page, abort rather than attempting to fill
      const preFormTitle = await page.title().catch(() => '')
      const preFormText = await page.evaluate(() => document.body.innerText).catch(() => '')
      const stillOnCF = preFormTitle.includes('Just a moment') ||
        preFormTitle.includes('Attention Required') ||
        preFormText.includes('Checking if the site connection is secure') ||
        preFormText.includes('Verify you are human')
      if (stillOnCF) {
        const cfScreenshot = await takeScreenshot(page, applicationId)
        await prisma.application.update({ where: { id: applicationId }, data: { bypassMethod } }).catch(() => {})
        return {
          status: 'needs_review',
          errorMessage: 'Cloudflare challenge could not be resolved — manual review needed',
          applyUrl,
          screenshotUrl: cfScreenshot,
          bypassMethod,
        }
      }

      // Reset zoom to 100% — CloakBrowser can launch with a non-1.0 device scale
      // that makes Greenhouse render at ~50% width ("half screen" bug).
      if (page.url().includes('greenhouse.io')) {
        await page.evaluate(() => {
          document.documentElement.style.zoom = '1'
          document.body.style.zoom = '1'
          document.body.style.transform = ''
          document.body.style.transformOrigin = ''
        })
        await page.waitForTimeout(300)
      }

      // Scroll to simulate reading before filling
      await humanScroll(page)

      // Fetch job data for context
      const nativeJob = { role: '', company: '', description: '', location: '' }
      try {
        const appRecord = await prisma.application.findUnique({
          where: { id: applicationId },
          include: { job: true },
        })
        if (appRecord?.job) {
          nativeJob.role = appRecord.job.role
          nativeJob.company = appRecord.job.company
          nativeJob.description = appRecord.job.description
          nativeJob.location = appRecord.job.location
        }
      } catch { /* non-fatal */ }

      // ── DataDome mid-form solver ──────────────────────────────────────────
      // Two-phase approach:
      //   Phase 1 — give Steel's built-in solver 15s to auto-dismiss the overlay
      //             (Steel has solveCaptcha:true + residential proxy active)
      //   Phase 2 — escalate to CapSolver with the DATADOME_PROXY_URL proxy
      //             and inject the solved cookie directly without reloading the page
      //             (DataDome JS detects the fresh cookie and dismisses the overlay)
      const isDataDomeGone = async (): Promise<boolean> => {
        const t = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')).toLowerCase()
        return !t.includes('slide right') && !t.includes('verification required') && !t.includes('datadome')
      }

      const injectDataDomeCookie = async (ddCookie: string): Promise<void> => {
        const eqIdx = ddCookie.indexOf('=')
        const ddName = eqIdx > 0 ? ddCookie.slice(0, eqIdx) : 'datadome'
        const ddValue = eqIdx > 0 ? ddCookie.slice(eqIdx + 1).split(';')[0] : ddCookie
        await context.addCookies([{
          name: ddName, value: ddValue,
          domain: '.wellfound.com', path: '/',
          httpOnly: false, secure: false, sameSite: 'Lax',
        }])
        await page.evaluate((n: string, v: string) => {
          document.cookie = `${n}=${v}; path=/; domain=.wellfound.com`
        }, ddName, ddValue).catch(() => {})
      }

      const solveMidFormDataDome = async (captchaUrl: string): Promise<boolean> => {
        await takeScreenshot(page, `${applicationId}-datadome-midform`)

        // CapSolver with residential proxy
        // Prefer the current intercepted URL; fall back to what was captured earlier
        const urlToSolve = (captchaUrl !== 'datadome-detected' ? captchaUrl : null)
          ?? dataDomeCaptchaUrl
          ?? (() => {
               // Last resort: extract from current page HTML
               const src = page.url()
               return src.includes('captcha-delivery.com') ? src : null
             })()

        if (!urlToSolve) {
          console.warn('[browserApply] DataDome mid-form: no captcha URL available for CapSolver')
          return false
        }

        console.log('[browserApply] DataDome mid-form: Phase 2 — CapSolver with proxy...')
        const ddCookie = await solveDataDome(urlToSolve, USER_AGENT)
        if (!ddCookie) {
          console.warn('[browserApply] CapSolver DataDome mid-form solve returned null')
          return false
        }

        bypassMethod = 'cloak_browser_plus_capsolver'
        await injectDataDomeCookie(ddCookie)
        // Give DataDome JS time to re-check and dismiss the overlay
        await page.waitForTimeout(4000)
        dataDomeCaptchaUrl = null

        if (await isDataDomeGone()) {
          console.log('[browserApply] DataDome overlay dismissed after CapSolver cookie injection')
          return true
        }
        // Overlay still present — CapSolver returned a valid cookie but DataDome re-challenged
        console.warn('[browserApply] DataDome still present after CapSolver injection')
        return false
      }

      // Fill the form — retry once if DataDome interrupts
      let fillResult = await fillApplicationForm(page, profile, nativeJob, applicationId)

      if (!fillResult.success && fillResult.error === 'datadome') {
        console.log('[browserApply] DataDome interrupted form fill — solving and retrying once...')
        const solved = await solveMidFormDataDome(fillResult.dataDomeCaptchaUrl ?? 'datadome-detected')
        if (solved) {
          console.log('[browserApply] DataDome solved — retrying fillApplicationForm...')
          await takeScreenshot(page, `${applicationId}-datadome-solved-retry`)
          fillResult = await fillApplicationForm(page, profile, nativeJob, applicationId)
        } else {
          const screenshotUrl = await takeScreenshot(page, `${applicationId}-datadome-unsolvable`)
          await prisma.application.update({ where: { id: applicationId }, data: { bypassMethod } }).catch(() => {})
          return {
            status: 'needs_review',
            errorMessage: 'DataDome captcha appeared during form fill and could not be solved automatically. Please apply manually.',
            applyUrl,
            screenshotUrl,
            bypassMethod,
          }
        }
      }

      if (!fillResult.success) {
        const screenshotUrl = await takeScreenshot(page, applicationId)
        await prisma.application.update({ where: { id: applicationId }, data: { bypassMethod } }).catch(() => {})

        if (fillResult.error === 'existing_account') {
          return {
            status: 'needs_review',
            errorMessage: 'Existing Wellfound account detected — manual login required',
            applyUrl,
            screenshotUrl,
            bypassMethod,
          }
        }

        return {
          status: 'needs_review',
          errorMessage: fillResult.unfilledFields.length > 0
            ? `Could not fill required fields: ${fillResult.unfilledFields.join(', ')}`
            : `Form fill failed: ${fillResult.error ?? 'unknown'}`,
          applyUrl,
          screenshotUrl,
          bypassMethod,
        }
      }

      // Force scroll to the absolute bottom — use three complementary methods so
      // Greenhouse's lazy-rendered disability/EEO sections are fully in the DOM
      // before we try to click Submit:
      //   1. window.scrollTo to the full document height
      //   2. #application container scroll (Greenhouse's own overflow wrapper)
      //   3. keyboard End key — guaranteed to reach page bottom regardless of overflow
      await page.evaluate(() => {
        // Reset horizontal scroll so the form stays centered (prevents left-shift)
        window.scrollTo(0, 0)
        document.documentElement.scrollLeft = 0
        document.body.scrollLeft = 0
      })
      await page.waitForTimeout(150)
      await page.evaluate(() => {
        const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
        window.scrollTo(0, h)
        const container = document.querySelector('#application') as HTMLElement | null
        if (container) container.scrollTop = container.scrollHeight
      })
      // Keyboard End key as a guaranteed fallback — scrolls whatever element has focus
      await page.keyboard.press('End')
      await page.waitForTimeout(800)

      // Find the submit button — Greenhouse uses #submit_app specifically.
      // page.evaluate only accepts native CSS selectors; Playwright :has-text is used separately.
      const submitNativeSelector = await page.evaluate((): string | null => {
        // Priority: Greenhouse-specific ID → disabled-free type → text match → any type
        const byId = document.querySelector('#submit_app')
        if (byId) return '#submit_app'
        const SUBMIT_TEXT = ['submit application', 'send application', 'apply now', 'complete application', 'submit app']
        const allBtns = Array.from(document.querySelectorAll('button, input[type="submit"]'))
        for (const btn of allBtns) {
          const txt = (btn.textContent ?? (btn as HTMLInputElement).value ?? '').trim().toLowerCase()
          if (SUBMIT_TEXT.some(t => txt.includes(t))) {
            return btn.id ? `#${btn.id}` : btn.getAttribute('type') === 'submit' ? 'button[type="submit"]' : null
          }
        }
        const noDisabled = document.querySelector('button[type="submit"]:not([disabled]), input[type="submit"]:not([disabled])')
        if (noDisabled) return noDisabled.tagName === 'BUTTON' ? 'button[type="submit"]:not([disabled])' : 'input[type="submit"]:not([disabled])'
        if (document.querySelector('button[type="submit"]')) return 'button[type="submit"]'
        if (document.querySelector('input[type="submit"]')) return 'input[type="submit"]'
        return null
      })

      if (!submitNativeSelector) {
        const screenshotUrl = await takeScreenshot(page, applicationId)
        await prisma.application.update({ where: { id: applicationId }, data: { bypassMethod } }).catch(() => {})
        const btns = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).filter(Boolean)
        )
        return {
          status: 'needs_review',
          errorMessage: `Could not find Submit button. Buttons found: ${btns.slice(0, 5).join(', ')}`,
          applyUrl,
          screenshotUrl,
          bypassMethod,
        }
      }

      // Scroll the button into view using the element's own scrollIntoView —
      // works even when the scrollable container is not window/body.
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, submitNativeSelector)
      await page.waitForTimeout(800)

      const submitLocator = page.locator(submitNativeSelector).first()
      await submitLocator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
      await page.waitForTimeout(400)

      // Take pre-submit screenshot
      const preSubmitUrl = await takeScreenshot(page, `pre-submit-${applicationId}`)

      // Human-like pause before clicking submit
      await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000))

      await humanClick(page, submitLocator)
      await page.waitForTimeout(4000)

      let screenshotUrl = await takeScreenshot(page, `submitted-${applicationId}`)
      let finalText = await page.evaluate(() => document.body.innerText)

      // ── Post-submit: detect red validation errors and re-fill ─────────────────
      // Greenhouse shows red field labels + inline error messages for unfilled required
      // fields. Detect them, re-fill, and resubmit once.
      const GH_ERROR_PATTERNS = [/please fill in/i, /required field/i, /field is required/i, /this field is required/i, /invalid email/i, /please enter/i, /select a country/i]
      // Greenhouse server-side error shown when reCAPTCHA token is rejected or
      // there is a transient server error. Retry submit once — reCAPTCHA execute()
      // is called fresh on each submit click so a new valid token is obtained.
      const GH_SERVER_ERROR = /there was an error processing your application/i
      const hasServerError = GH_SERVER_ERROR.test(finalText) && page.url().includes('greenhouse.io')
      if (hasServerError) {
        console.log('[browserApply] GH server error after submit — waiting 4s and retrying once')
        await page.waitForTimeout(4000)
        const retrySel = await page.evaluate((): string | null => {
          if (document.querySelector('#submit_app')) return '#submit_app'
          const btn = document.querySelector('button[type="submit"]:not([disabled]), input[type="submit"]:not([disabled])')
          return btn ? (btn.tagName === 'BUTTON' ? 'button[type="submit"]' : 'input[type="submit"]') : null
        })
        if (retrySel) {
          const retryLoc = page.locator(retrySel).first()
          await retryLoc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
          await page.waitForTimeout(1000)
          await humanClick(page, retryLoc)
          await page.waitForTimeout(5000)
          screenshotUrl = await takeScreenshot(page, `retry-submitted-${applicationId}`)
          finalText = await page.evaluate(() => document.body.innerText)
          console.log('[browserApply] GH retry submitted')
        }
      }

      const hasValidationErrors = GH_ERROR_PATTERNS.some(p => p.test(finalText))

      if (hasValidationErrors && page.url().includes('greenhouse.io')) {
        console.log('[browserApply] GH post-submit: validation errors detected — re-filling and resubmitting')
        await takeScreenshot(page, `post-submit-errors-${applicationId}`)

        // Collect which fields have visible error messages (red inline text)
        const errorFields = await page.evaluate(() => {
          const errors: Array<{ selector: string; label: string; errorText: string }> = []
          // Greenhouse renders inline errors as small red text with class names containing 'error'
          // OR as red-colored labels for the field above them
          const errorEls = Array.from(document.querySelectorAll(
            '[class*="error"]:not([class*="error-page"]), .field-error, [role="alert"]'
          ))
          for (const el of errorEls) {
            const txt = (el.textContent ?? '').trim()
            if (!txt || txt.length > 100) continue
            // Find the associated input by walking up to the field container
            const container = el.closest('.field, [class*="field-"], [class*="Field"], section') ?? el.parentElement
            const inp = container?.querySelector('input:not([type="hidden"]):not([type="submit"]), textarea, select') as HTMLInputElement | null
            if (inp && inp.id) {
              errors.push({ selector: `#${inp.id}`, label: inp.id, errorText: txt })
            }
          }
          // Also check for red-border fields (Greenhouse adds red border on invalid)
          const invalidInputs = Array.from(document.querySelectorAll('input[aria-invalid="true"], select[aria-invalid="true"]')) as HTMLInputElement[]
          for (const inp of invalidInputs) {
            if (inp.id && !errors.find(e => e.selector === `#${inp.id}`)) {
              errors.push({ selector: `#${inp.id}`, label: inp.id, errorText: 'invalid' })
            }
          }
          return errors
        }).catch(() => [] as Array<{ selector: string; label: string; errorText: string }>)

        console.log(`[browserApply] GH post-submit errors:`, errorFields.map(e => `${e.selector}: "${e.errorText}"`).join(', '))

        // Re-fill problematic fields
        for (const errField of errorFields) {
          const sel = errField.selector
          const label = errField.label.toLowerCase()

          if (sel === '#country' || label.includes('country')) {
            // Re-trigger country supplementary fill
            await page.keyboard.press('Escape').catch(() => {})
            await page.waitForTimeout(150)
            const countryOpened = await page.evaluate(() => {
              const input = document.getElementById('country')
              if (!input) return false
              let el: Element | null = input
              while (el) {
                const cls = el.className?.toString() ?? ''
                if (cls.includes('select__control') || cls.includes('select__container')) {
                  ;(el as HTMLElement).click()
                  return true
                }
                el = el.parentElement
              }
              return false
            }).catch(() => false)
            if (countryOpened) {
              await page.waitForTimeout(800)
              const opts = await page.locator('[class*="select__option"]').all()
              for (const opt of opts) {
                const t = (await opt.textContent().catch(() => '')).trim()
                if (/united states/i.test(t)) { await opt.click().catch(() => {}); break }
              }
            }
          } else if (sel === '#candidate-location' || label.includes('location')) {
            const loc = page.locator('#candidate-location').first()
            await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
            await loc.click({ timeout: 3000 }).catch(() => {})
            await loc.fill('', { timeout: 2000 }).catch(() => {})
            await loc.pressSequentially(profile.location?.split(',')[0]?.trim() ?? 'Charlotte', { delay: 80 }).catch(() => {})
            await page.waitForTimeout(1000)
            const sug = page.locator('[role="option"], [class*="autocomplete"] li, [class*="suggestion"]').first()
            if (await sug.isVisible({ timeout: 800 }).catch(() => false)) {
              await sug.click({ timeout: 2000 }).catch(() => {})
            } else {
              await page.keyboard.press('Tab').catch(() => {})
            }
          } else if (sel === '#phone' || label.includes('phone')) {
            const phoneLoc = page.locator('#phone').first()
            await phoneLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
            await phoneLoc.click({ timeout: 2000 }).catch(() => {})
            await phoneLoc.fill(profile.phone ?? '', { timeout: 3000 }).catch(() => {})
          }
        }

        if (errorFields.length > 0) {
          await page.waitForTimeout(1000)
          // Scroll to submit and resubmit
          const resubmitSel = await page.evaluate((): string | null => {
            const byId = document.querySelector('#submit_app')
            if (byId) return '#submit_app'
            const btn = document.querySelector('button[type="submit"]:not([disabled]), input[type="submit"]:not([disabled])')
            return btn ? (btn.id ? `#${btn.id}` : 'button[type="submit"]') : null
          })
          if (resubmitSel) {
            const resubmitLoc = page.locator(resubmitSel).first()
            await resubmitLoc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
            await page.waitForTimeout(500)
            await takeScreenshot(page, `pre-resubmit-${applicationId}`)
            await humanClick(page, resubmitLoc)
            await page.waitForTimeout(4000)
            screenshotUrl = await takeScreenshot(page, `resubmitted-${applicationId}`)
            finalText = await page.evaluate(() => document.body.innerText)
          }
        }
      }

      await prisma.application.update({ where: { id: applicationId }, data: { bypassMethod } }).catch(() => {})

      if (SUCCESS_PATTERNS.some(p => p.test(finalText))) {
        return { status: 'applied', applyUrl, screenshotUrl, preSubmitScreenshotUrl: preSubmitUrl, bypassMethod }
      }

      // Greenhouse redirects back to the job listing page on success — no "thank you" page.
      // Detect by: still on greenhouse.io URL + no validation error + no server error visible.
      const postSubmitUrl = page.url()
      if (
        (effectiveUrl.includes('greenhouse.io') || postSubmitUrl.includes('greenhouse.io')) &&
        !GH_ERROR_PATTERNS.some(p => p.test(finalText)) &&
        !GH_SERVER_ERROR.test(finalText)
      ) {
        return { status: 'applied', applyUrl, screenshotUrl, preSubmitScreenshotUrl: preSubmitUrl, bypassMethod }
      }

      return {
        status: 'needs_review',
        errorMessage: 'Submitted — confirm success in screenshot',
        applyUrl,
        screenshotUrl,
        preSubmitScreenshotUrl: preSubmitUrl,
        bypassMethod,
      }
    }

    // ── STEP 7–8: Fill form fields + handle multi-step (external ATS) ─────────
    for (let step = 0; step < MAX_STEPS; step++) {
      // #12 — Scroll before first field fill to simulate reading
      if (step === 0) {
        // Reset zoom so Greenhouse doesn't render at half-width
        if (page.url().includes('greenhouse.io')) {
          await page.evaluate(() => {
            document.documentElement.style.zoom = '1'
            document.body.style.zoom = '1'
            document.body.style.transform = ''
            document.body.style.transformOrigin = ''
          })
          await page.waitForTimeout(300)
        }
        await humanScroll(page)
      }

      const currentText = await page.evaluate(() => document.body.innerText)

      if (SUCCESS_PATTERNS.some(p => p.test(currentText))) {
        const screenshotUrl = await takeScreenshot(page, applicationId)
        await prisma.application.update({
          where: { id: applicationId },
          data: { bypassMethod },
        }).catch(() => {})
        return { status: 'applied', applyUrl, screenshotUrl, bypassMethod }
      }

      // Fill all mapped fields
      // On Greenhouse new board, question_* selectors are React Select hidden inputs —
      // typing into them does nothing useful (values are set by the supplementary fill
      // dropdown interaction below).  Skipping them here avoids a 10-minute CDP
      // keystroke-by-keystroke hang on every "N/A" typed into a hidden input.
      const isGreenhouse = page.url().includes('greenhouse.io')
      // EEO fields (#gender, #hispanic_ethnicity, #veteran_status, #disability_status, and
      // numeric-ID variants like #4000681004 used by Grafana) are React Select dropdowns —
      // typing text into them (page.fill) filters to "No options".
      // Skip them in the first pass; they're handled by the supplementary EEO section below.
      // Also skip #country — it's a React Select and handled by supplementary section 2 below.
      // Also skip education dropdowns (#school--0, #degree--0) — React Select, handled below.
      const GH_EEO_LABEL_RE = /gender.*identity|what.*gender|race\b|ethnicit|transgender|hispanic|veteran.*status|disability.*status/i
      const GH_EEO_SELECTORS = new Set([
        '#gender', '#hispanic_ethnicity', '#veteran_status', '#disability_status',
        // Grafana / other companies use pure numeric IDs for EEO — detect them by label
        ...rawFields
          .filter(f => /^\d+$/.test(f.selector.replace(/^#/, '')) && GH_EEO_LABEL_RE.test(f.label ?? ''))
          .map(f => f.selector),
      ])
      const fieldsToFill = isGreenhouse
        ? fillMapping.filter(f =>
            !f.selector.includes('question_') &&
            !GH_EEO_SELECTORS.has(f.selector) &&
            f.selector !== '#country' &&
            !/^#(school|degree)--\d+$/.test(f.selector)
          )
        : fillMapping
      for (const field of fieldsToFill) {
        // Also apply any user-provided answers that override
        const value = userAnswers[field.selector] ?? field.value
        console.log(`[browserApply] Filling field: ${field.selector} (${field.fieldType}) = "${value.slice(0, 40)}"`)
        await fillField(page, field.selector, value, field.fieldType, profile, tempFiles)
      }

      if (isGreenhouse) {
        await takeScreenshot(page, `phase-post-basic-fill-${applicationId}`)
      }

      // ── Greenhouse new board supplementary fill ──────────────────────────────
      // job-boards.greenhouse.io uses React Select for question_* dropdowns.
      // These render as styled <div> containers (.select__control) wrapping a
      // hidden <input type="text">.  page.fill() into the hidden input doesn't
      // trigger React state; we must click the visible control to open the menu,
      // then click [role="option"].  We use rawFields label data to pick values.
      //
      // Also handles Greenhouse checkbox groups: technical skills and background.
      if (isGreenhouse) {
        console.log('[browserApply] Greenhouse — supplementary React Select + checkbox fill')
        try {
          // ── 1a-pre. Standard text fields that are sometimes missed by Claude mapping ──
          // Fill #preferred_name (present on all new Greenhouse board forms) and other
          // well-known fields that aren't covered by the question_ pattern below.
          const prefNameEl = rawFields.find(f => f.selector === '#preferred_name')
          if (prefNameEl) {
            await page.fill('#preferred_name', profile.firstName, { timeout: 3000 }).catch(() => {})
            console.log(`[browserApply] GH #preferred_name → "${profile.firstName}"`)
          }

          // ── 1a. Plain-text question_ inputs (LinkedIn, GitHub, URL, salary, etc.) ──
          // Greenhouse renders some supplementary fields as plain text inputs (not React
          // Select). These are backed by question_* IDs but have inputType "text". We must
          // fill them directly with page.fill() before trying the dropdown path.
          for (const field of rawFields) {
            const hint = (field.label ?? '').toLowerCase()
            const sel = field.selector
            if (!sel.includes('question_') || field.tagName.toUpperCase() !== 'INPUT') continue
            if (field.inputType === 'checkbox' || field.inputType === 'radio') continue
            // Only handle plain text / URL / number inputs (not React Select hidden inputs)
            if (field.inputType !== 'text' && field.inputType !== 'url' && field.inputType !== 'number' && field.inputType !== null) continue
            // Skip if this is a React-Select-backed hidden input (its visible sibling will be a styled div)
            const isReactSelectBacked = await page.evaluate((id: string) => {
              const el = document.getElementById(id)
              if (!el) return false
              const parent = el.parentElement
              return !!(parent?.classList.contains('select__value-container') ||
                parent?.closest('[class*="select__"]') ||
                el.getAttribute('readonly') === '' ||
                el.getAttribute('aria-hidden') === 'true' ||
                getComputedStyle(el).display === 'none')
            }, sel.replace(/^#/, '')).catch(() => false)
            if (isReactSelectBacked) continue

            const profileState = (profile.location ?? '').split(',')[1]?.trim() ?? ''
            const profileCity  = (profile.location ?? '').split(',')[0]?.trim() ?? ''

            let directValue = ''
            if (/linkedin/i.test(hint))                                             directValue = profile.linkedin ?? ''
            else if (/github/i.test(hint))                                          directValue = profile.github ?? ''
            else if (/portfolio|personal.*site|website/i.test(hint))               directValue = profile.github ?? ''
            else if (/salary|compensation|desired.*pay|expected.*pay/i.test(hint)) directValue = profile.desiredSalary ?? ''
            else if (/\bcity\b/i.test(hint))                                        directValue = profileCity
            else if (/state.*reside|reside.*state|which state|select.*state|state.*located/i.test(hint)) directValue = profileState
            else if (/\bstate\b|\bprovince\b/i.test(hint))                          directValue = profileState
            else if (/current.*company|employer.*if.*applic|current.*employer/i.test(hint)) directValue = profile.currentCompany ?? ''
            else if (/current.*company|employer|organization/i.test(hint))          directValue = profile.currentCompany ?? 'N/A'
            else if (/country.*time.*zone|time.*zone.*country|what.*country.*based|where.*based.*time/i.test(hint)) directValue = 'United States, Eastern Time (ET)'
            else if (/how long.*remote|remote.*how long|100.*remote.*job/i.test(hint)) directValue = profile.yearsExp ? `${profile.yearsExp} years` : '2 years'
            else if (/npi\s*number/i.test(hint))                                    directValue = 'N/A'
            else if (/how.*hear|source|referral|where.*find|learn.*about|first.*hear/i.test(hint)) directValue = 'Startup.jobs'
            // Behavioral / preference questions that are plain text inputs (not React Select)
            else if (/management.*style|style.*management|prefer.*supervisor|supervisor.*prefer/i.test(hint)) directValue = 'Collaborative and direct feedback'
            else if (/unexpected.*challenge|challenge.*approach|first.*approach.*challenge/i.test(hint))      directValue = 'Break it down into smaller pieces and collaborate with teammates'
            else if (/comfort.*escalat|escalat.*comfort|roadblock.*escalat/i.test(hint))                     directValue = 'High — I escalate early with context'
            else if (/program.*language|language.*proficient|most.*proficient/i.test(hint))                  directValue = 'TypeScript'
            else if (/ai.*tool|llm.*familiar|familiar.*llm|familiar.*ai/i.test(hint))                       directValue = 'Claude'
            else if (/ask.*ai.*tool|use.*ai.*tool|ai.*input.*feedback/i.test(hint))                         directValue = 'Yes — I use AI tools throughout my workflow'
            // "Do you have experience with [specific tool/platform]?" → No unless it's a common one
            else if (/do you have experience|experience.*owning|experience.*administering|experience.*managing/i.test(hint)) directValue = 'No'
            // Prior employer checks (Alphabet/Google, specific companies)
            else if (/alphabet|google.*employee|employee.*alphabet|contractor.*alphabet/i.test(hint))        directValue = 'No'
            else if (/previously.*employee|employee.*previously|prior.*employee|been.*employee/i.test(hint)) directValue = 'No'
            // Medicaid / CAQH / NPI / clinical checks — fallback to "No" / "N/A"
            else if (/medicaid|caqh|enrolled|enrollment/i.test(hint))               directValue = 'No'

            if (!directValue) continue
            await page.fill(sel, directValue, { timeout: 3000 }).catch(() => {})
            console.log(`[browserApply] GH plain-text question "${hint.slice(0, 40)}" → "${directValue.slice(0, 60)}"`)
          }

          // ── 1b. Dropdowns (React Select): click control → click option ─────────
          // Map each question_ text input to a target value using its label.
          // Also handles education dropdowns (#school--N, #degree--N) and any
          // numeric-ID React Select fields (Grafana EEO: #4000681004 etc.).
          // Note: field.tagName comes from Cheerio in lowercase ("input"), so compare
          // case-insensitively.
          for (const field of rawFields) {
            const hint = (field.label ?? '').toLowerCase()
            const sel = field.selector

            const isQuestionDropdown = sel.includes('question_')
            const isEducationDropdown = /^#(school|degree)--\d+$/.test(sel)
            // Numeric-ID React Select fields that are NOT in the EEO set (those are
            // handled by section 5 below). Skip pure-EEO numeric IDs here.
            const isNumericDropdown = /^#\d+$/.test(sel) && !GH_EEO_SELECTORS.has(sel)

            // Only handle question_, education, or non-EEO numeric-ID inputs
            if (!isQuestionDropdown && !isEducationDropdown && !isNumericDropdown) continue
            if (field.tagName.toUpperCase() !== 'INPUT') continue
            if (field.inputType === 'checkbox' || field.inputType === 'radio') continue

            const profileStateDropdown = (profile.location ?? '').split(',')[1]?.trim() ?? ''

            let targetValue = ''

            // ── Education dropdowns ─────────────────────────────────────────────
            if (isEducationDropdown) {
              if (/school/i.test(sel)) {
                // Type university name to filter the autocomplete, then pick first result
                const schoolName = profile.education?.split(',')[0]?.trim() ?? 'University of North Carolina'
                const inputEl = page.locator(sel).first()
                await inputEl.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
                await inputEl.click({ timeout: 2000 }).catch(() => {})
                await inputEl.type(schoolName.slice(0, 12), { delay: 60 }).catch(() => {})
                await page.waitForTimeout(800)
                const firstOpt = page.locator('[role="option"], [class*="select__option"]').filter({ visible: true }).first()
                if (await firstOpt.isVisible({ timeout: 1000 }).catch(() => false)) {
                  await firstOpt.click({ force: true }).catch(() => {})
                  console.log(`[browserApply] GH education school → first option`)
                }
                await page.keyboard.press('Escape').catch(() => {})
                continue
              }
              if (/degree/i.test(sel)) targetValue = 'Bachelor'
            }

            if (targetValue) {
              // Handle degree via normal dropdown path below
            } else {

            // ── Question_ and numeric-ID dropdown patterns ──────────────────────
            // IMPORTANT: Check "by submitting" FIRST — its long legal text contains
            // "interview engineer" and would false-match the "previously" pattern below.
            if (/submitting.*application.*represent|represent.*warrant.*penalty/i.test(hint))              targetValue = 'I Agree'
            // "Have you previously been an Interview Engineer?" — uses ^have you to avoid
            // matching the long "By submitting" legal declaration text.
            else if (/^have you previously|previously been an interview engineer/i.test(hint))             targetValue = 'No'
            else if (/currently.*going.*interview.*process|interview.*process.*another/i.test(hint))      targetValue = 'No'
            else if (/located.*egypt|reside.*egypt|egypt/i.test(hint))                                    targetValue = 'I am not in Egypt'
            else if (/background.*check|willing.*background/i.test(hint))                                 targetValue = 'Yes'
            else if (/fluent.*english|english.*fluent|written.*spoken.*english/i.test(hint))              targetValue = 'Yes'
            else if (/year.*professional.*experience|year.*experience.*software/i.test(hint))             targetValue = '3-5 years'
            else if (/how.*many.*interview.*per.*week|interview.*per.*week|60.minute.*per.*week/i.test(hint)) targetValue = '5'
            // "How did you hear" — Startup.jobs as source (Grafana and others use this as dropdown)
            else if (/how.*hear|source|referral|where.*find|learn.*about|first.*hear/i.test(hint))        targetValue = 'Other'
            else if (/sponsor|visa|h1b/i.test(hint))                                                      targetValue = 'No'
            else if (/authoriz|eligible|work.*permit|legal.*work/i.test(hint))                            targetValue = 'Yes'
            else if (/located.*follow.*countr|which.*countr.*located|countr.*you.*located/i.test(hint))   targetValue = 'Yes'
            // "Are you based in the United States?" / "Do you currently reside in the US?" → Yes
            else if (/based.*united states|reside.*united states|currently.*reside.*us|us.*resident/i.test(hint)) targetValue = 'Yes'
            else if (/country/i.test(hint))                                                               targetValue = 'United States'
            // State where you reside — try abbreviated then full name
            else if (/state.*reside|reside.*state|select.*state|which.*state|state.*located/i.test(hint)) targetValue = profileStateDropdown
            else if (/gender|pronoun/i.test(hint))                                                        targetValue = 'Decline to self-identify'
            else if (/race|ethnic/i.test(hint))                                                           targetValue = 'Decline to self-identify'
            else if (/veteran|military/i.test(hint))                                                      targetValue = 'I am not a protected veteran'
            else if (/disabilit/i.test(hint))                                                             targetValue = 'No, I do not have a disability'
            // Prior/current employer checks
            else if (/alphabet|google.*employee|employee.*alphabet|contractor.*alphabet/i.test(hint))     targetValue = 'No'
            else if (/previously.*employee|been.*employee|prior.*contractor/i.test(hint))                 targetValue = 'No'
            // "Do you have experience with [specific tool]?" → No
            else if (/do you have experience|experience.*owning|experience.*administering/i.test(hint))   targetValue = 'No'
            // Behavioral/preference dropdowns — map to reasonable first-pass values
            else if (/management.*style|style.*management|prefer.*supervisor/i.test(hint))                targetValue = 'Collaborative'
            else if (/unexpected.*challenge|challenge.*approach/i.test(hint))                             targetValue = 'Collaborate'
            else if (/comfort.*escalat|escalat.*comfort/i.test(hint))                                     targetValue = 'High'
            else if (/program.*language|language.*proficient/i.test(hint))                                targetValue = 'TypeScript'
            else if (/ai.*tool|llm.*familiar|familiar.*llm/i.test(hint))                                  targetValue = 'ChatGPT'
            else if (/ask.*ai.*tool|use.*ai.*tool|ai.*input.*feedback/i.test(hint))                      targetValue = 'Yes'
            // Medicaid / CAQH / NPI / clinical
            else if (/medicaid|caqh|enrolled/i.test(hint))                                                targetValue = 'No'

            } // end else (non-education or non-degree path)

            // If no pattern matched AND the field is required, fall through to first-option picker below
            const hasPattern = !!targetValue
            if (!hasPattern && !field.required) continue
            if (!hasPattern) {
              // Required field with no pattern — open dropdown and pick first available option
              const inputIdFallback = sel.replace(/^#/, '')
              await page.keyboard.press('Escape').catch(() => {})
              await page.waitForTimeout(150)
              const lblFallback = page.locator(`label[for="${inputIdFallback}"] + div`)
              const fbClicked = await lblFallback.click({ timeout: 2000 }).then(() => true).catch(() => false)
              if (!fbClicked) await page.locator(sel).locator('xpath=..').click({ timeout: 2000 }).catch(() => {})
              await page.waitForTimeout(600)
              const fbListbox = page.locator(
                '[role="listbox"]:not([class*="iti"]):not([class*="country-list"]), [class*="select__menu"]'
              ).first()
              const fbVisible = await fbListbox.isVisible({ timeout: 1500 }).catch(() => false)
              if (fbVisible) {
                const fbOpts = await fbListbox.locator('[role="option"], li').all()
                // Skip placeholder "Select..." option (index 0 is often a placeholder)
                const firstReal = fbOpts.find(async o => {
                  const t = (await o.textContent().catch(() => '')).trim().toLowerCase()
                  return t && t !== 'select' && !t.startsWith('select...')
                }) ?? fbOpts[1] ?? fbOpts[0]
                if (firstReal) {
                  const picked = (await firstReal.textContent().catch(() => '')).trim()
                  await firstReal.click().catch(() => {})
                  console.log(`[browserApply] GH dropdown fallback "${hint.slice(0, 40)}" → first option "${picked}"`)
                }
              }
              await page.keyboard.press('Escape').catch(() => {})
              await page.waitForTimeout(300)
              continue
            }

            if (!targetValue) continue

            const inputId = sel.replace(/^#/, '')

            // Close any stray open picker (phone country list, previous dropdown, etc.)
            await page.keyboard.press('Escape').catch(() => {})
            await page.waitForTimeout(150)

            // Click the Greenhouse dropdown trigger.
            // Strategy 1: `label[for="X"] + div` — the div immediately after the label
            //   is the React Select container on Greenhouse new board.
            // Strategy 2: fall back to label's parent → first child div.
            const labelPlusSibling = page.locator(`label[for="${inputId}"] + div`)
            const triggerClicked = await labelPlusSibling.click({ timeout: 2000 })
              .then(() => true).catch(() => false)

            if (!triggerClicked) {
              // Fallback: click the parent element of the hidden input
              await page.locator(sel).locator('xpath=..').click({ timeout: 2000 }).catch(() => {})
            }
            await page.waitForTimeout(600)

            // Scope option search to a NON-phone-picker listbox.
            // intl-tel-input renders its country list as [class*="iti__country-list"].
            // We look for any other role="listbox" or React Select menu.
            const ghListbox = page.locator(
              '[role="listbox"]:not([class*="iti"]):not([class*="country-list"]), ' +
              '[class*="select__menu"], [class*="dropdown-menu"]:visible'
            ).first()

            const listboxVisible = await ghListbox.isVisible({ timeout: 2000 }).catch(() => false)

            if (listboxVisible) {
              const allOptions = await ghListbox.locator('[role="option"], li').all()
              let selected = ''
              // Pass 1: exact text match (case-insensitive)
              for (const opt of allOptions) {
                const text = (await opt.textContent().catch(() => '')).trim()
                if (text.toLowerCase() === targetValue.toLowerCase()) {
                  await opt.click().catch(() => {})
                  selected = text
                  break
                }
              }
              // Pass 2: starts-with (for multi-word values like "3-5 years")
              if (!selected) {
                for (const opt of allOptions) {
                  const text = (await opt.textContent().catch(() => '')).trim()
                  if (
                    text.toLowerCase().startsWith(targetValue.toLowerCase()) ||
                    targetValue.toLowerCase().startsWith(text.toLowerCase())
                  ) {
                    await opt.click().catch(() => {})
                    selected = text
                    break
                  }
                }
              }
              // Pass 3: word-boundary prefix match — handles "No, I am not in Egypt" with target "No"
              if (!selected) {
                const tvLower = targetValue.toLowerCase()
                const prefixRe = new RegExp(`^${tvLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[\\s,\\.!]|$)`, 'i')
                for (const opt of allOptions) {
                  const text = (await opt.textContent().catch(() => '')).trim()
                  if (prefixRe.test(text)) {
                    await opt.click().catch(() => {})
                    selected = text
                    break
                  }
                }
              }
              // Pass 4: expand 2-letter US state abbreviation to full name
              // (Greenhouse state dropdowns list full names like "North Carolina")
              if (!selected && /^[A-Z]{2}$/.test(targetValue.trim())) {
                const US_STATES_EXPAND: Record<string, string> = {
                  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
                  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
                  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
                  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
                  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
                  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
                  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
                  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
                  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
                  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
                  DC: 'District of Columbia',
                }
                const fullName = US_STATES_EXPAND[targetValue.trim().toUpperCase()]
                if (fullName) {
                  for (const opt of allOptions) {
                    const text = (await opt.textContent().catch(() => '')).trim()
                    if (text.toLowerCase() === fullName.toLowerCase() || text.toLowerCase().startsWith(fullName.toLowerCase())) {
                      await opt.click().catch(() => {})
                      selected = text
                      break
                    }
                  }
                }
              }
              if (selected) {
                console.log(`[browserApply] GH dropdown "${hint.slice(0, 40)}" → "${selected}"`)
              } else {
                // No text match — fall back to picking the first non-placeholder option.
                // This handles numbered choices ("1 - Hands-on: ...", "1 - Very Comfortable: ...")
                // that don't contain our target keyword.
                for (const opt of allOptions) {
                  const t = (await opt.textContent().catch(() => '')).trim().toLowerCase()
                  if (t && t !== 'select' && !t.startsWith('select...') && t !== '') {
                    const optText = (await opt.textContent().catch(() => '')).trim()
                    await opt.click().catch(() => {})
                    console.log(`[browserApply] GH dropdown fallback "${hint.slice(0, 40)}" → first option "${optText.slice(0, 60)}"`)
                    selected = optText
                    break
                  }
                }
                if (!selected) {
                  const optTexts: string[] = []
                  for (const opt of allOptions) {
                    const t = (await opt.textContent().catch(() => '')).trim()
                    if (t) optTexts.push(`"${t}"`)
                  }
                  console.log(`[browserApply] GH dropdown "${hint.slice(0, 40)}" → no match for "${targetValue}" | options: ${optTexts.join(', ')}`)
                }
              }
            } else {
              console.log(`[browserApply] GH dropdown "${hint.slice(0, 40)}" → listbox not visible after click`)
            }
            // Always press Escape after each dropdown attempt to close any open listbox
            await page.keyboard.press('Escape').catch(() => {})
            await page.waitForTimeout(300)
          }
          await takeScreenshot(page, `phase-post-question-dropdowns-${applicationId}`)

          // ── 2. Country dropdown (React Select) ────────────────────────────────
          // The #country field on Greenhouse new board is a React Select hidden input.
          // Traverse up the DOM from #country to find the .select__control ancestor,
          // then click that to open the dropdown — avoids accidentally clicking the
          // phone intl-tel-input country flag (which also appears near the Country label).
          const countryField = rawFields.find(f => f.selector === '#country')
          if (countryField) {
            await page.keyboard.press('Escape').catch(() => {})
            await page.waitForTimeout(150)

            // Use Playwright XPath locators (same approach as EEO fix — evaluate-based
            // .click() doesn't reliably open React Select dropdowns in CloakBrowser).
            const countryTriggers = [
              'xpath=//input[@id="country"]/ancestor::div[contains(@class,"select__control") or contains(@class,"select__container")][1]',
              'label[for="country"] + div',
              'label[for="country"] ~ div',
            ]
            let countryMenuOpen = false
            for (const trySel of countryTriggers) {
              if (countryMenuOpen) break
              const trigger = page.locator(trySel).first()
              const cnt = await trigger.count().catch(() => 0)
              if (cnt === 0) continue
              await trigger.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
              await trigger.click({ timeout: 3000, force: true }).catch(() => {})
              await page.waitForTimeout(700)
              const menuVis = await page.locator('[class*="select__menu"], [class*="select__option"]').first().isVisible({ timeout: 1500 }).catch(() => false)
              if (menuVis) { countryMenuOpen = true; break }
              await page.keyboard.press('Escape').catch(() => {})
              await page.waitForTimeout(200)
            }

            if (countryMenuOpen) {
              const opts = await page.locator('[class*="select__option"]').all()
              let found = false
              for (const opt of opts) {
                const text = (await opt.textContent().catch(() => '')).trim()
                if (/^united states$/i.test(text)) {
                  await opt.click().catch(() => {})
                  console.log(`[browserApply] GH country → "${text}"`)
                  found = true
                  break
                }
              }
              if (!found) {
                // Type to filter, then pick first result
                const countrySearchInput = page.locator('[class*="select__input"] input').first()
                await countrySearchInput.type('United States', { delay: 50 }).catch(() => {})
                await page.waitForTimeout(600)
                const filtered = page.locator('[class*="select__option"]').first()
                if (await filtered.isVisible({ timeout: 1000 }).catch(() => false)) {
                  const filteredText = (await filtered.textContent().catch(() => '')).trim()
                  await filtered.click().catch(() => {})
                  console.log(`[browserApply] GH country (typed) → "${filteredText}"`)
                }
              }
              await page.keyboard.press('Escape').catch(() => {})
            } else {
              console.log('[browserApply] GH country: could not open dropdown — Country field may stay empty')
            }
          }

          // ── 3. Phone country code (intl-tel-input) ────────────────────────────
          // Set the flag/dial-code prefix to US (+1) via the iti JS API if available,
          // otherwise skip (Steel defaults to US in US datacenters).
          await page.evaluate(() => {
            try {
              const phoneEl = document.getElementById('phone') as HTMLInputElement | null
              if (!phoneEl) return
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const iti = (window as any).intlTelInputGlobals?.getInstance(phoneEl)
              if (iti) iti.setCountry('us')
            } catch { /* ignore */ }
          }).catch(() => {})

          // ── 4. Checkboxes: check relevant technical skill boxes ──────────────
          await page.keyboard.press('Escape').catch(() => {})
          const CHECKBOX_LABELS_TO_CHECK = [
            /full.?stack/i,
            /back.?end/i,
            /front.?end/i,
            /system.?design/i,
            /complex.*code.*review/i,
          ]
          for (const field of rawFields) {
            if (field.inputType !== 'checkbox') continue
            const label = (field.label ?? '').toLowerCase()
            const shouldCheck = CHECKBOX_LABELS_TO_CHECK.some(pat => pat.test(label))
            if (shouldCheck) {
              await page.check(field.selector, { timeout: 3000 }).catch(() => {})
              console.log(`[browserApply] GH checkbox checked: "${field.label}"`)
            }
          }

          // ── 5. EEO dropdowns (#gender, #hispanic_ethnicity, #veteran_status, #disability_status,
          //        plus Grafana numeric-ID fields: #4000681004, #4000682004, #4000691004) ──
          // These are React Select dropdowns. We must click the styled trigger div,
          // then pick an option from the listbox. Typing text directly causes "No options"
          // because React Select filters by typed text.
          await takeScreenshot(page, `phase-pre-eeo-${applicationId}`)
          const STANDARD_EEO: Array<{ id: string; preferred: string[] }> = [
            { id: 'gender',             preferred: ['decline', 'prefer not', "don't wish", 'not to say', 'not listed'] },
            { id: 'hispanic_ethnicity', preferred: ['decline', 'prefer not', "don't wish", 'not to say', 'no'] },
            { id: 'veteran_status',     preferred: ['not a protected', 'decline', 'prefer not', "don't wish", 'not to say'] },
            { id: 'disability_status',  preferred: ['no, i do not', 'do not have', 'decline', 'prefer not', "don't wish", 'not to say'] },
          ]
          // Discover numeric-ID EEO fields by label (Grafana, and others that use similar patterns)
          const NUMERIC_EEO_LABEL_MAP: Array<{ re: RegExp; preferred: string[] }> = [
            { re: /gender.*identity|what.*gender/i,           preferred: ['decline', 'prefer not', 'not listed', 'non-binary'] },
            { re: /\brace\b/i,                                preferred: ['decline', 'prefer not', 'not wish', 'not listed'] },
            { re: /transgender/i,                             preferred: ['decline', 'prefer not', 'not wish', 'no'] },
            { re: /hispanic|latino/i,                         preferred: ['decline', 'prefer not', 'not wish', 'no'] },
            { re: /veteran/i,                                 preferred: ['not a protected', 'decline', 'prefer not', 'not to say'] },
            { re: /disabilit/i,                               preferred: ['no, i do not', 'do not have', 'decline', 'prefer not'] },
          ]
          const numericEeoFields: Array<{ id: string; preferred: string[] }> = []
          for (const rf of rawFields) {
            // Only numeric IDs that are in the GH_EEO_SELECTORS set
            if (!GH_EEO_SELECTORS.has(rf.selector)) continue
            if (!/^#\d+$/.test(rf.selector)) continue  // already covered by STANDARD_EEO
            const id = rf.selector.replace(/^#/, '')
            const lbl = rf.label ?? ''
            const match = NUMERIC_EEO_LABEL_MAP.find(m => m.re.test(lbl))
            numericEeoFields.push({ id, preferred: match?.preferred ?? ['decline', 'prefer not', 'not to say'] })
          }
          const EEO_FIELDS = [...STANDARD_EEO, ...numericEeoFields]
          for (const eeoField of EEO_FIELDS) {
            const eeoEl = rawFields.find(f => f.selector === `#${eeoField.id}`)
            if (!eeoEl) continue

            await page.keyboard.press('Escape').catch(() => {})
            await page.waitForTimeout(150)

            // Scroll input into view first
            await page.locator(`#${eeoField.id}`).scrollIntoViewIfNeeded({ timeout: 3000 }).catch(async () => {
              await page.locator(`label[for="${eeoField.id}"]`).scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
            })
            await page.waitForTimeout(400)

            // Match React Select menu/options — must filter to VISIBLE because 250+ hidden
            // option elements from other dropdowns also match this selector in the DOM
            const EEO_MENU_SEL = '[role="option"], .select__option, [class*="__option"], .select__menu, [class*="__menu"]'
            const isEeoMenuOpen = async (): Promise<boolean> =>
              page.locator(EEO_MENU_SEL).filter({ visible: true }).first().isVisible({ timeout: 500 }).catch(() => false)

            // Strategy 1: Click select__control div (depth 3 from input) without force, then
            //             dispatch native mousedown which React Select actually listens to
            let opened = false
            const controlLoc3 = page.locator(`xpath=//input[@id="${eeoField.id}"]/../../..`).first()
            const ctrl3Count = await controlLoc3.count().catch(() => 0)
            if (ctrl3Count > 0) {
              await controlLoc3.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
              await page.waitForTimeout(200)
              // Dispatch native mousedown (React Select opens on mousedown, not click)
              await page.evaluate((id: string) => {
                const input = document.getElementById(id)
                const ctrl = input?.parentElement?.parentElement?.parentElement
                if (ctrl) {
                  ctrl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, buttons: 1 }))
                  ctrl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, buttons: 0 }))
                  ctrl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                }
              }, eeoField.id)
              await page.waitForTimeout(800)
              if (await isEeoMenuOpen()) opened = true
            }

            // Strategy 2: Playwright locator click (full event sequence)
            if (!opened) {
              await page.keyboard.press('Escape').catch(() => {})
              await page.waitForTimeout(150)
              await controlLoc3.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
              await controlLoc3.click({ timeout: 3000 }).catch(async () => {
                await controlLoc3.click({ force: true, timeout: 2000 }).catch(() => {})
              })
              await page.waitForTimeout(800)
              if (await isEeoMenuOpen()) opened = true
            }

            // Strategy 3: mouse.click at exact bounding box coordinates
            if (!opened) {
              await page.keyboard.press('Escape').catch(() => {})
              await page.waitForTimeout(150)
              const box = await controlLoc3.boundingBox().catch(() => null)
              if (box && box.width > 40) {
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
                await page.waitForTimeout(800)
                if (await isEeoMenuOpen()) opened = true
              }
            }

            if (!opened) {
              console.log(`[browserApply] GH EEO #${eeoField.id}: could not open dropdown`)
              continue
            }

            // Select preferred option from VISIBLE options only (filter avoids hidden options
            // from other dropdowns that share the same [role="option"] selector)
            const eeoOpts = await page.locator('[role="option"], .select__option, [class*="__option"]').filter({ visible: true }).all()
            let selected = ''

            for (const keyword of eeoField.preferred) {
              if (selected) break
              for (const opt of eeoOpts) {
                const text = (await opt.textContent().catch(() => '')).trim().toLowerCase()
                if (text.includes(keyword)) {
                  const optText = (await opt.textContent().catch(() => '')).trim()
                  await opt.click({ force: true }).catch(() => {})
                  selected = optText
                  break
                }
              }
            }

            if (!selected && eeoOpts.length > 0) {
              for (const opt of eeoOpts) {
                const t = (await opt.textContent().catch(() => '')).trim().toLowerCase()
                if (t && t !== 'select' && !t.startsWith('select...')) {
                  const optText = (await opt.textContent().catch(() => '')).trim()
                  await opt.click({ force: true }).catch(() => {})
                  selected = optText
                  break
                }
              }
            }

            if (selected) {
              console.log(`[browserApply] GH EEO #${eeoField.id} → "${selected}"`)
            } else {
              console.log(`[browserApply] GH EEO #${eeoField.id}: no option selected`)
            }
            await page.keyboard.press('Escape').catch(() => {})
            await page.waitForTimeout(300)
          }
          await takeScreenshot(page, `phase-post-eeo-${applicationId}`)

        } catch (err) {
          console.warn('[browserApply] Greenhouse supplementary fill error:', err instanceof Error ? err.message : String(err))
        }
      }

      // ── Trakstar native select supplementary fill ──────────────────────────
      // Trakstar uses native <select> elements. The fallback mapper may produce
      // values that don't exactly match option labels, or may miss the certification
      // select entirely. Explicitly set known selects here using selectOption()
      // which works reliably on native <select> elements.
      if (page.url().includes('trakstar.com')) {
        try {
          // Pronouns — default to They/Them (neutral)
          await page.selectOption(
            'select[id*="pronoun"], select[id*="pron"]',
            { label: 'They/Them' },
            { timeout: 2000 },
          ).catch(async () => {
            // Try value-based selection as fallback
            await page.selectOption('select[id*="pronoun"], select[id*="pron"]', 'they_them', { timeout: 1000 }).catch(() => {})
          })

          // Visa sponsorship — No
          await page.selectOption(
            'select[id*="sponsor"], select[id*="visa"]',
            { label: 'No' },
            { timeout: 2000 },
          ).catch(async () => {
            await page.selectOption('select[id*="sponsor"], select[id*="visa"]', 'no', { timeout: 1000 }).catch(() => {})
          })

          // Certification / consent select — select the first non-empty option (agrees/yes)
          const certSelector = 'select[id*="certif"], select[id*="by_submitting"]'
          const certOption = await page.evaluate((sel: string) => {
            const el = document.querySelector(sel) as HTMLSelectElement | null
            if (!el) return null
            // First option after the blank/placeholder is typically "Yes" / agreement
            const nonBlank = Array.from(el.options).find(o => o.value && o.value !== '')
            return nonBlank?.value ?? null
          }, certSelector)
          if (certOption) {
            await page.selectOption(certSelector, certOption, { timeout: 2000 }).catch(() => {})
          }

          // English level (Xideral job) — Proficient
          await page.selectOption(
            'select[id*="english"]',
            { label: 'Proficient' },
            { timeout: 2000 },
          ).catch(async () => {
            // Try "Advanced" as fallback if "Proficient" not available
            await page.selectOption('select[id*="english"]', { label: 'Advanced' }, { timeout: 1000 }).catch(() => {})
          })

          console.log('[browserApply] Trakstar: native selects filled')
        } catch (err) {
          console.warn('[browserApply] Trakstar supplementary fill warning:', err instanceof Error ? err.message : String(err))
        }
      }

      // Find Submit button in DOM first (no viewport requirement), then scroll to it.
      // Trakstar: narrow to #job_application_form to avoid "Apply with Indeed/LinkedIn" buttons.
      // Greenhouse: #submit_app is the specific ID; fallback to generic selectors.
      const isTrakstarPage = page.url().includes('trakstar.com')
      const foundAtsSelector = await page.evaluate((isTrakstar: boolean): string | null => {
        if (isTrakstar) {
          if (document.querySelector('#job_application_form button[type="submit"]')) return '#job_application_form button[type="submit"]'
          if (document.querySelector('#job_application_form input[type="submit"]')) return '#job_application_form input[type="submit"]'
          return null
        }
        if (document.querySelector('#submit_app')) return '#submit_app'
        const SUBMIT_TEXT = ['submit application', 'send application', 'apply now', 'complete application']
        const allBtns = Array.from(document.querySelectorAll('button, input[type="submit"]'))
        for (const btn of allBtns) {
          const txt = (btn.textContent ?? (btn as HTMLInputElement).value ?? '').trim().toLowerCase()
          if (SUBMIT_TEXT.some(t => txt.includes(t))) {
            return btn.id ? `#${btn.id}` : 'button[type="submit"]'
          }
        }
        const noDisabled = document.querySelector('button[type="submit"]:not([disabled]), input[type="submit"]:not([disabled])')
        if (noDisabled) return noDisabled.tagName === 'BUTTON' ? 'button[type="submit"]:not([disabled])' : 'input[type="submit"]:not([disabled])'
        if (document.querySelector('button[type="submit"]')) return 'button[type="submit"]'
        if (document.querySelector('input[type="submit"]')) return 'input[type="submit"]'
        return null
      }, isTrakstarPage)

      // Scroll to the absolute bottom before checking/clicking submit:
      // 1. Reset horizontal scroll so Greenhouse form stays centered
      // 2. Scroll window + #application container to bottom
      // 3. keyboard End as guaranteed fallback for overflow containers
      if (page.url().includes('greenhouse.io')) {
        await page.evaluate(() => {
          window.scrollTo(0, 0)
          document.documentElement.scrollLeft = 0
          document.body.scrollLeft = 0
        })
        await page.waitForTimeout(150)
        await page.evaluate(() => {
          const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
          window.scrollTo(0, h)
          const container = document.querySelector('#application') as HTMLElement | null
          if (container) container.scrollTop = container.scrollHeight
        })
        await page.keyboard.press('End')
        await page.waitForTimeout(600)
      }

      // Scroll the specific button into view before checking visibility
      if (foundAtsSelector) {
        await page.evaluate((sel: string) => {
          const el = document.querySelector(sel)
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }, foundAtsSelector)
        await page.waitForTimeout(600)
      }

      const submitLocatorAts = foundAtsSelector
        ? page.locator(foundAtsSelector).first()
        : page.locator('button[type="submit"], input[type="submit"]').first()

      if (foundAtsSelector) {
        await submitLocatorAts.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
      }

      const atsSubmitVisible = foundAtsSelector
        ? await submitLocatorAts.isVisible({ timeout: 3000 }).catch(() => false)
        : false

      if (atsSubmitVisible) {
        // ── STEP 9: Submit ──────────────────────────────────────────────────
        // Wait for reCAPTCHA / hCaptcha to be solved by Steel before submitting.
        // Google reCAPTCHA writes the solved token into hidden textarea(s) with
        // id starting with "g-recaptcha-response".  Submitting before the token
        // is populated causes the server to reject the form without a clear
        // "captcha" keyword in the page text.
        const hasRecaptcha = await page.$('[id^="g-recaptcha-response"], [id^="h-captcha-response"]').catch(() => null)
        if (hasRecaptcha) {
          console.log('[browserApply] reCAPTCHA detected — waiting up to 30s for it to be solved')
          const steelSolved = await page.waitForFunction(
            () => {
              const fields = document.querySelectorAll('[id^="g-recaptcha-response"], [id^="h-captcha-response"]')
              return Array.from(fields).some(f => (f as HTMLTextAreaElement).value?.length > 10)
            },
            { timeout: 30000 },
          ).then(() => true).catch(() => false)

          if (!steelSolved) {
            // Greenhouse uses reCAPTCHA Enterprise (enterprise.js). Use Enterprise task.
            // All other sites fall back to v2.
            const isGreenhousePage = page.url().includes('greenhouse.io')
            console.log(`[browserApply] reCAPTCHA not auto-solved — escalating to CapSolver ${isGreenhousePage ? 'reCAPTCHA Enterprise' : 'reCAPTCHA v2'}`)

            // For Enterprise: scan inline scripts for 6L... sitekey; fallback to known key
            // For v2: extract from .g-recaptcha / data-sitekey element
            const extractedKey = await page.evaluate((isEnterprise: boolean): string | null => {
              if (isEnterprise) {
                const scripts = Array.from(document.querySelectorAll('script:not([src])'))
                for (const s of scripts) {
                  const m = s.textContent?.match(/6L[a-zA-Z0-9_-]{38}/)
                  if (m) return m[0]
                }
                const srcScripts = Array.from(document.querySelectorAll('script[src]')) as HTMLScriptElement[]
                for (const s of srcScripts) {
                  const m = s.src.match(/[?&]render=([^&]+)/)
                  if (m && m[1] !== 'explicit') return decodeURIComponent(m[1])
                }
              }
              const el = document.querySelector('.g-recaptcha, [data-sitekey]')
              return el?.getAttribute('data-sitekey') ?? null
            }, isGreenhousePage)

            const siteKey = extractedKey ?? (isGreenhousePage ? '6LfmcbcpAAAAAChNTbhUShzUOAMj_wY9LQIvLFX0' : null)

            if (siteKey) {
              console.log(`[browserApply] reCAPTCHA sitekey: ${siteKey}`)
              const rcToken = isGreenhousePage
                ? await solveRecaptchaEnterprise(page.url(), siteKey, 'submit')
                : await solveRecaptchaV2(page.url(), siteKey)
              if (rcToken) {
                console.log('[browserApply] CapSolver reCAPTCHA solved — injecting token')
                await page.evaluate((token: string) => {
                  document.querySelectorAll('[id^="g-recaptcha-response"], [id^="h-captcha-response"]').forEach(el => {
                    ;(el as HTMLTextAreaElement).value = token
                    ;(el as HTMLElement).style.display = 'block'
                    el.dispatchEvent(new Event('change', { bubbles: true }))
                    el.dispatchEvent(new Event('input', { bubbles: true }))
                  })
                  // Trigger grecaptcha callback if available
                  const cfg = (window as unknown as Record<string, unknown>).___grecaptcha_cfg as Record<string, unknown> | undefined
                  if (cfg?.clients) {
                    Object.values(cfg.clients as Record<string, unknown>).forEach((c: unknown) => {
                      const client = c as Record<string, unknown>
                      const cb = (client.D as Record<string, unknown>)?.callback ??
                                 (client.l as Record<string, unknown>)?.callback ??
                                 (client.m as Record<string, unknown>)?.callback
                      if (typeof cb === 'function') { try { cb(token) } catch { /* ignore */ } }
                    })
                  }
                }, rcToken)
                await page.waitForTimeout(500)
                bypassMethod = 'cloak_browser_plus_capsolver'
              } else {
                // CapSolver failed — do NOT submit with an unsolved reCAPTCHA.
                // Submitting without a valid token causes the server to reject the form silently.
                // The step loop would then retry 8 times, each burning another 90s.
                // Fast-fail here instead.
                console.warn('[browserApply] CapSolver reCAPTCHA solve failed — returning needs_review (not submitting)')
                const captchaScreenshot = await takeScreenshot(page, `captcha-unsolved-${applicationId}`)
                return {
                  status: 'needs_review',
                  errorMessage: 'reCAPTCHA unsolvable — complete manually',
                  applyUrl,
                  screenshotUrl: captchaScreenshot,
                  bypassMethod,
                }
              }
            } else {
              // No sitekey found — cannot solve. Fast-fail.
              console.warn('[browserApply] No sitekey found for reCAPTCHA — returning needs_review')
              const captchaScreenshot = await takeScreenshot(page, `captcha-nositekey-${applicationId}`)
              return {
                status: 'needs_review',
                errorMessage: 'reCAPTCHA detected but no sitekey found — complete manually',
                applyUrl,
                screenshotUrl: captchaScreenshot,
                bypassMethod,
              }
            }
          } else {
            console.log('[browserApply] reCAPTCHA auto-solved')

            // On Greenhouse, a low reCAPTCHA Enterprise bot-score (~0.1–0.3) triggers an
            // email verification code. Override any auto-solved token with a CapSolver
            // Enterprise token (minScore: 0.9) so Greenhouse treats the session as human.
            //
            // Greenhouse uses reCAPTCHA *Enterprise* (loads enterprise.js), so the correct
            // task type is ReCaptchaV3EnterpriseTaskProxyLess. The sitekey is embedded in
            // the JS bundle config (not as a ?render= URL param), confirmed as:
            // 6LfmcbcpAAAAAChNTbhUShzUOAMj_wY9LQIvLFX0
            if (page.url().includes('greenhouse.io')) {
              console.log('[browserApply] Greenhouse: replacing reCAPTCHA Enterprise token with CapSolver high-score token')
              // Extract the enterprise sitekey from the page's embedded JS config object
              const enterpriseSiteKey = await page.evaluate((): string | null => {
                // Method 1: scan all inline script content for the 6L... key pattern
                const scripts = Array.from(document.querySelectorAll('script:not([src])'))
                for (const s of scripts) {
                  const m = s.textContent?.match(/6L[a-zA-Z0-9_-]{38}/)
                  if (m) return m[0]
                }
                // Method 2: check script src ?render= param (standard v3 fallback)
                const srcScripts = Array.from(document.querySelectorAll('script[src]')) as HTMLScriptElement[]
                for (const s of srcScripts) {
                  const m = s.src.match(/[?&]render=([^&]+)/)
                  if (m && m[1] !== 'explicit') return decodeURIComponent(m[1])
                }
                // Method 3: data-sitekey attribute
                return document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') ?? null
              })

              // Hard-coded fallback: Greenhouse job boards consistently use this enterprise key
              const siteKey = enterpriseSiteKey ?? '6LfmcbcpAAAAAChNTbhUShzUOAMj_wY9LQIvLFX0'
              console.log(`[browserApply] Greenhouse reCAPTCHA Enterprise sitekey: ${siteKey}`)

              // Call CapSolver directly and overwrite the token in all g-recaptcha-response
              // fields before submitting to guarantee a high-score token.
              const ghToken = await solveRecaptchaEnterprise(page.url(), siteKey, 'submit')
              if (ghToken) {
                await page.evaluate((token: string) => {
                  // Overwrite all g-recaptcha-response textareas with the high-score token.
                  document.querySelectorAll('[id^="g-recaptcha-response"]').forEach(el => {
                    ;(el as HTMLTextAreaElement).value = token
                    ;(el as HTMLElement).style.display = 'block'
                  })
                  // Also freeze enterprise.execute() so any submit-time call returns this token.
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const rc = (window as any).grecaptcha
                  if (rc?.enterprise?.execute) {
                    rc.enterprise.execute = () => Promise.resolve(token)
                  }
                }, ghToken)
                bypassMethod = 'cloak_browser_plus_capsolver'
                console.log('[browserApply] Greenhouse: CapSolver Enterprise token injected into g-recaptcha-response fields')
                await page.waitForTimeout(500)
              } else {
                console.warn('[browserApply] Greenhouse: CapSolver Enterprise solve failed — submitting with existing token (may trigger email verification)')
              }
            }

            // ── Trakstar: ensure a high-score reCAPTCHA v3 token ──────────────────
            // Trakstar's server-side spam filter rejects submissions with scores below its
            // threshold, showing "Our servers thought this was a spam application."
            // Fix: call CapSolver (ReCaptchaV3TaskProxyLess, minScore:0.9) and overwrite
            // the token in g-recaptcha-response before clicking submit.
            if (page.url().includes('trakstar.com')) {
              console.log('[browserApply] Trakstar: replacing reCAPTCHA v3 token with CapSolver high-score token')
              const trakstarToken = await solveRecaptchaV3(
                page.url(),
                '6LeH04UUAAAAADE9wHZVTWG944Agpm1vN71xquU8',
                'hosted_site',
              )
              if (trakstarToken) {
                await page.evaluate((token: string) => {
                  // Inject into all g-recaptcha-response fields (Trakstar has two: -100000 and -100001).
                  // Set value ONLY — do NOT dispatch change/input events, as that can trigger
                  // Trakstar's reCAPTCHA callback and auto-submit the form before we click Submit.
                  document.querySelectorAll('[id^="g-recaptcha-response"]').forEach(el => {
                    ;(el as HTMLTextAreaElement).value = token
                    ;(el as HTMLElement).style.display = 'block'
                  })
                  // Also override grecaptcha.execute() so any submit-time call returns this token.
                  // The addInitScript intercept already handles this, but belt-and-suspenders here.
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const rc = (window as any).grecaptcha
                  if (rc?.execute) {
                    rc.execute = () => Promise.resolve(token)
                  }
                }, trakstarToken)
                bypassMethod = 'cloak_browser_plus_capsolver'
                console.log('[browserApply] Trakstar: CapSolver v3 token injected into g-recaptcha-response fields')
                await page.waitForTimeout(500)
              } else {
                console.warn('[browserApply] Trakstar: CapSolver v3 solve failed — submitting with existing token (may be rejected)')
              }
            }
          }

          // Re-fill all fields after reCAPTCHA solve — CAPTCHA interaction can
          // reset form values (e.g. on Trakstar), so we fill again right before submit.
          // Use page.fill() for text/textarea to REPLACE (not append like page.type() does).
          //
          // BambooHR: Fabric UI re-renders after CAPTCHA, generating new FabricTextField-* IDs.
          // Re-detect live fields and rebuild the fill mapping with fresh selectors.
          if (page.url().includes('bamboohr.com')) {
            const refreshedFields = await page.$$eval(
              'input:not([type="hidden"]):not([type="submit"]):not([readonly]), textarea:not([readonly]), select',
              (els) => {
                let fileIndex = 0
                return els.map((el) => {
                  const input = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
                  const id = input.id || ''
                  const name = (input as HTMLInputElement).name || ''
                  const type = (input as HTMLInputElement).type || ''
                  let sel = id ? `#${id}` : name ? `[name="${name}"]` : ''
                  if (!sel && type === 'file') sel = `input[type="file"]:nth-of-type(${++fileIndex})`
                  if (!sel) return null
                  let label = ''
                  if (id) {
                    const lbl = document.querySelector(`label[for="${id}"]`)
                    if (lbl) label = lbl.textContent?.trim() ?? ''
                  }
                  if (!label) {
                    const closest = input.closest('label, [class*="field"], [class*="Field"]')
                    if (closest) label = closest.textContent?.replace(input.value, '').trim() ?? ''
                  }
                  if (!label && type === 'file') label = 'Resume'
                  const required = input.required || input.getAttribute('aria-required') === 'true'
                  return { selector: sel, label, inputType: type || input.tagName.toLowerCase(), tagName: input.tagName.toLowerCase(), required }
                }).filter(Boolean)
              }
            ).catch(() => [] as typeof fillMapping)
            // Rebuild fillMapping with fresh selectors — carry values from old mapping
            if (refreshedFields.length > 0) {
              const oldValMap = new Map(fillMapping.map(f => [f.label?.trim().toLowerCase().replace(/\s*\*$/, ''), f]))
              const newMapping = []
              for (const rf of refreshedFields) {
                const labelKey = (rf.label ?? '').trim().toLowerCase().replace(/\s*\*$/, '')
                const old = oldValMap.get(labelKey)
                if (old) newMapping.push({ ...old, selector: rf.selector })
              }
              if (newMapping.length > 0) {
                console.log(`[browserApply] BambooHR post-CAPTCHA: refreshed ${newMapping.length} field selectors`)
                fillMapping = newMapping
              }
            }
          }
          console.log('[browserApply] Re-filling fields post-reCAPTCHA solve')
          await Promise.race([
            (async () => {
              for (const field of fillMapping) {
                const value = userAnswers[field.selector] ?? field.value
                if (field.fieldType === 'text' || field.fieldType === 'textarea') {
                  const isBambooFabric = page.url().includes('bamboohr.com') && field.selector.match(/^#Fabric|^#fab-|^#FabricText|^#desiredPay|^#websiteUrl|^#linkedinUrl|^#customQuestion/i)
                  if (isBambooFabric) {
                    const loc = page.locator(field.selector).first()
                    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
                    await loc.click({ timeout: 3000, force: true }).catch(() => {})
                    await loc.fill('', { timeout: 2000 }).catch(() => {})
                    await loc.pressSequentially(value, { delay: 30 }).catch(async () => {
                      await loc.fill(value, { timeout: 3000 }).catch(() => {})
                    })
                  } else {
                    await page.fill(field.selector, value, { timeout: 3000 }).catch(() => {})
                  }
                } else {
                  await Promise.race([
                    fillField(page, field.selector, value, field.fieldType, profile, tempFiles),
                    new Promise<void>(r => setTimeout(r, 6000)),
                  ]).catch(() => {})
                }
              }
            })(),
            new Promise<void>(r => setTimeout(r, 45_000)), // never block more than 45s total on re-fill
          ])

          // On Greenhouse, re-check checkboxes that reCAPTCHA solving may have reset
          if (page.url().includes('greenhouse.io')) {
            const GH_CHECKBOX_PATTERNS = [/full.?stack/i, /back.?end/i, /front.?end/i, /system.?design/i, /complex.*code.*review/i]
            for (const field of rawFields) {
              if (field.inputType !== 'checkbox') continue
              if (GH_CHECKBOX_PATTERNS.some(pat => pat.test(field.label ?? ''))) {
                await page.check(field.selector, { timeout: 3000 }).catch(() => {})
              }
            }
            console.log('[browserApply] GH post-CAPTCHA: checkboxes re-checked')
          }

          await page.waitForTimeout(500)
        }

        // Close any stray open dropdowns before clicking submit
        await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(300)

        const preSubmitUrl = await takeScreenshot(page, `pre-submit-${applicationId}`)
        await humanClick(page, submitLocatorAts)

        // Wait for navigation after submit, then poll for success/CAPTCHA/error for up to 20s.
        // A flat 3s wait misses slow confirmation pages and post-submit verification flows.
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
        await page.waitForTimeout(2000)

        let finalText = await page.evaluate(() => document.body.innerText).catch(() => '')
        let postSubmitUrl = await takeScreenshot(page, `submitted-${applicationId}`)

        // Detect cross-domain redirects post-submit. Oscar forms start ON greenhouse.io, so
        // we only want to flag it when the domain changes from the submit-time domain.
        // Capture the URL at submit time (before polling), then check if we left it.
        const submitTimeUrl = page.url()
        const submitTimeDomain = (() => {
          try { return new URL(submitTimeUrl).hostname } catch { return '' }
        })()
        const isThirdPartyRedirect = () => {
          try {
            const currentHost = new URL(page.url()).hostname
            // Only flag if we navigated away from the page we submitted on
            if (currentHost === submitTimeDomain) return false
            return /indeed\.com|linkedin\.com|lever\.co|ashbyhq\.com/.test(currentHost)
          } catch { return false }
        }
        // A standalone CAPTCHA challenge page — not just the form's embedded reCAPTCHA widget.
        // Only fires if the URL changed (we were redirected to a challenge page) OR if the
        // page shows human-verification UI that the original form didn't have.
        const hasCaptchaChallenge = (text: string) => {
          const urlChanged = page.url() !== submitTimeUrl
          if (!urlChanged) return false  // still on the form page; reCAPTCHA widget is normal
          return /verify you are human|please complete.*security|not a robot|prove you are human/i.test(text)
        }

        // Poll up to 20s for a success pattern, redirect, or new CAPTCHA challenge
        const pollStart = Date.now()
        while (Date.now() - pollStart < 20000) {
          if (SUCCESS_PATTERNS.some(p => p.test(finalText))) break
          // Stop polling if we've been redirected to a third-party ATS/auth domain
          if (isThirdPartyRedirect()) break
          // Only break for CAPTCHA if it's a new challenge page (not the form's own widget)
          if (hasCaptchaChallenge(finalText)) break
          // Only click obvious modal-style confirmation buttons — NOT "Continue" (too broad,
          // matches multi-step forms and third-party sign-in pages like Indeed).
          const confirmBtn = await page.$('button:has-text("OK"), button:has-text("Got it"), button:has-text("Done")').catch(() => null)
          if (confirmBtn) {
            console.log('[browserApply] Post-submit confirmation dialog — clicking OK/Got it/Done')
            await confirmBtn.click().catch(() => {})
            await page.waitForTimeout(2000)
          }
          await page.waitForTimeout(2000)
          finalText = await page.evaluate(() => document.body.innerText).catch(() => '')
          postSubmitUrl = await takeScreenshot(page, `submitted-${applicationId}`)
        }

        console.log(`[browserApply] Post-submit page text (first 400): ${finalText.slice(0, 400).replace(/\s+/g, ' ')}`)

        await prisma.application.update({
          where: { id: applicationId },
          data: { bypassMethod },
        }).catch(() => {})

        if (SUCCESS_PATTERNS.some(p => p.test(finalText))) {
          console.log('[browserApply] SUCCESS pattern matched post-submit')
          return {
            status: 'applied',
            applyUrl,
            screenshotUrl: postSubmitUrl,
            preSubmitScreenshotUrl: preSubmitUrl,
            bypassMethod,
          }
        }

        // Trakstar redirects to Indeed after a successful submission for optional
        // candidate profile linking. The application IS submitted to Trakstar at this point.
        if (/indeed\.com/i.test(page.url())) {
          console.log('[browserApply] Post-submit redirect to Indeed — application submitted to Trakstar successfully')
          return {
            status: 'applied',
            applyUrl,
            screenshotUrl: postSubmitUrl,
            preSubmitScreenshotUrl: preSubmitUrl,
            bypassMethod,
          }
        }

        // ── Trakstar in-place submit detection ────────────────────────────────
        // Trakstar submits the form without a page redirect — on success it resets
        // all form fields to empty and may show a brief toast.  Success is detected
        // by confirming the first required field is now blank AND no spam error is shown.
        if (submitTimeDomain.includes('trakstar.com')) {
          const firstNameEmpty = await page.evaluate((): boolean => {
            const el = document.querySelector('#id_candidate_first_name') as HTMLInputElement | null
            return el !== null && (el.value === '' || el.value === undefined)
          }).catch(() => false)
          const isSpamError = /spam application|something went wrong/i.test(finalText)

          if (isSpamError) {
            console.warn('[browserApply] Trakstar spam error detected — reCAPTCHA score may still be too low')
            return {
              status: 'needs_review',
              errorMessage: 'Trakstar flagged the application as spam — reCAPTCHA score too low. Please apply manually.',
              applyUrl,
              screenshotUrl: postSubmitUrl,
              preSubmitScreenshotUrl: preSubmitUrl,
              bypassMethod,
            }
          }

          if (firstNameEmpty) {
            console.log('[browserApply] Trakstar: form fields reset to empty post-submit — application submitted successfully')
            return {
              status: 'applied',
              applyUrl,
              screenshotUrl: postSubmitUrl,
              preSubmitScreenshotUrl: preSubmitUrl,
              bypassMethod,
            }
          }
        }

        // Check for a new CAPTCHA challenge that appeared after submit.
        // hasCaptchaChallenge() only fires if the URL changed (redirected away from form).
        if (hasCaptchaChallenge(finalText)) {
          return {
            status: 'needs_review',
            errorMessage: 'CAPTCHA challenge appeared after submission — complete manually',
            applyUrl,
            screenshotUrl: postSubmitUrl,
            bypassMethod,
          }
        }

        // Greenhouse email verification challenge — triggered on submit when reCAPTCHA score
        // is low or as standard email confirmation.  The user must enter the 8-char code
        // from their email inbox to complete submission.
        if (/verification code was sent|enter the 8.character code|security code/i.test(finalText)) {
          console.log('[browserApply] Greenhouse email verification required — user must enter code from inbox')
          return {
            status: 'needs_review',
            errorMessage: 'Greenhouse sent a verification code to your email — enter it to complete submission',
            applyUrl,
            screenshotUrl: postSubmitUrl,
            preSubmitScreenshotUrl: preSubmitUrl,
            bypassMethod,
          }
        }

        // ATS-specific success detection (all use Steel or CloakBrowser generic path).
        // These ATSes don't show a standard "Thank you" page that SUCCESS_PATTERNS can match.
        const VALIDATION_ERROR_PATTERNS = [/please fill in/i, /required field/i, /field is required/i, /this field is required/i, /invalid email/i, /please enter/i, /cannot be blank/i]
        const hasValidationError = VALIDATION_ERROR_PATTERNS.some(p => p.test(finalText))
        const postSubmitPageUrl = page.url()

        // Greenhouse: check if the application form is still present with filled values.
        // If #first_name still has a value, we're still on the form (validation errors
        // blocked submission). If the form is gone or first_name is empty, submission succeeded.
        if (submitTimeDomain.includes('greenhouse.io') || postSubmitPageUrl.includes('greenhouse.io')) {
          const ghFormStillShowing = await page.evaluate((): boolean => {
            const fn = document.getElementById('first_name') as HTMLInputElement | null
            // Form still showing if first_name input exists and has a non-empty value
            return fn !== null && fn.value.trim().length > 0
          }).catch(() => false)

          if (ghFormStillShowing) {
            // Form is still on screen — validation errors blocked submission.
            // Collect error messages and attempt to fix + resubmit.
            const ghErrors = await page.evaluate(() => {
              const texts: string[] = []
              document.querySelectorAll('[class*="error"], [aria-invalid="true"], label[style*="color"]').forEach(el => {
                const t = (el.textContent ?? '').trim()
                if (t && t.length < 100) texts.push(t)
              })
              // Also grab any inline validation messages
              document.querySelectorAll('small, .field-error, [role="alert"]').forEach(el => {
                const t = (el.textContent ?? '').trim()
                if (t && t.length < 100) texts.push(t)
              })
              return Array.from(new Set(texts))
            }).catch(() => [] as string[])
            console.log('[browserApply] GH submit blocked — form still showing. Errors:', ghErrors.slice(0, 5))

            // Re-fill country if still empty
            const countryEmpty = await page.evaluate(() => {
              const el = document.getElementById('country') as HTMLInputElement | null
              return el ? el.value.trim() === '' : false
            }).catch(() => false)
            if (countryEmpty) {
              const countryTriggers2 = [
                'xpath=//input[@id="country"]/ancestor::div[contains(@class,"select__control") or contains(@class,"select__container")][1]',
                'label[for="country"] + div',
              ]
              for (const trySel of countryTriggers2) {
                const trigger = page.locator(trySel).first()
                if (await trigger.count().catch(() => 0) === 0) continue
                await trigger.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
                await trigger.click({ timeout: 3000, force: true }).catch(() => {})
                await page.waitForTimeout(700)
                const opts = await page.locator('[class*="select__option"]').all()
                for (const opt of opts) {
                  if (/^united states$/i.test((await opt.textContent().catch(() => '')).trim())) {
                    await opt.click().catch(() => {})
                    console.log('[browserApply] GH country retry → "United States"')
                    break
                  }
                }
                if (opts.length > 0) break
                await page.keyboard.press('Escape').catch(() => {})
              }
            }

            // Re-fill location if still empty
            const locationEmpty = await page.evaluate(() => {
              const el = document.getElementById('candidate-location') as HTMLInputElement | null
              return el ? el.value.trim() === '' : false
            }).catch(() => false)
            if (locationEmpty) {
              const locLoc = page.locator('#candidate-location').first()
              await locLoc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
              await locLoc.click({ timeout: 3000 }).catch(() => {})
              const city = (profile.location ?? 'Charlotte').split(',')[0].trim()
              await locLoc.pressSequentially(city, { delay: 80 }).catch(() => {})
              await page.waitForTimeout(1000)
              const sug = page.locator('[role="option"]').first()
              if (await sug.isVisible({ timeout: 800 }).catch(() => false)) {
                await sug.click({ timeout: 2000 }).catch(() => {})
              } else {
                await page.keyboard.press('Tab').catch(() => {})
              }
              console.log(`[browserApply] GH location retry → "${city}"`)
            }

            // Scroll to submit and resubmit
            await page.waitForTimeout(1000)
            const ghResubmitSel = foundAtsSelector ?? '#submit_app'
            const ghResubmitLoc = page.locator(ghResubmitSel).first()
            await ghResubmitLoc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
            await takeScreenshot(page, `pre-resubmit-${applicationId}`)
            await page.waitForTimeout(800)
            await humanClick(page, ghResubmitLoc)
            await page.waitForTimeout(5000)
            postSubmitUrl = await takeScreenshot(page, `resubmitted-${applicationId}`)
            finalText = await page.evaluate(() => document.body.innerText)
            console.log(`[browserApply] GH resubmit page text: ${finalText.slice(0, 200).replace(/\s+/g, ' ')}`)

            // Check again if form is still showing
            const stillOnForm = await page.evaluate((): boolean => {
              const fn = document.getElementById('first_name') as HTMLInputElement | null
              return fn !== null && fn.value.trim().length > 0
            }).catch(() => false)
            if (stillOnForm) {
              return {
                status: 'needs_review',
                errorMessage: `GH form still showing after resubmit — errors: ${ghErrors.slice(0, 3).join('; ')}`,
                applyUrl,
                screenshotUrl: postSubmitUrl,
                preSubmitScreenshotUrl: preSubmitUrl,
                bypassMethod,
              }
            }
          }

          return { status: 'applied', applyUrl, screenshotUrl: postSubmitUrl, preSubmitScreenshotUrl: preSubmitUrl, bypassMethod }
        }

        if (!hasValidationError) {
          // Lever: redirects away from /apply URL on success, shows confirmation text, or
          // stays on /apply but shows the uploaded resume (confirmation with same URL).
          if (submitTimeDomain.includes('lever.co') && (
            /application.*submit|thank you for applying|we.ve received|your application has been/i.test(finalText) ||
            postSubmitPageUrl.includes('/confirmation') ||
            postSubmitPageUrl.includes('/thanks') ||
            !postSubmitPageUrl.includes('/apply') ||
            /\.pdf\s+success|resume.*success|cv.*success/i.test(finalText)
          )) {
            return { status: 'applied', applyUrl, screenshotUrl: postSubmitUrl, preSubmitScreenshotUrl: preSubmitUrl, bypassMethod }
          }
          // BambooHR: redirects to /success or shows confirmation text.
          if (submitTimeDomain.includes('bamboohr.com') && (
            /thank you|application received|successfully submitted|we.ll be in touch/i.test(finalText) ||
            postSubmitPageUrl.includes('/success') ||
            postSubmitPageUrl.includes('confirmationToken')
          )) {
            return { status: 'applied', applyUrl, screenshotUrl: postSubmitUrl, preSubmitScreenshotUrl: preSubmitUrl, bypassMethod }
          }
        }

        return {
          status: 'needs_review',
          errorMessage: 'Submitted — confirm success in screenshot',
          applyUrl,
          screenshotUrl: postSubmitUrl,
          preSubmitScreenshotUrl: preSubmitUrl,
          bypassMethod,
        }
      }

      // Look for Next/Continue (multi-step)
      const nextBtn = await page.$(
        'button:has-text("Next"), button:has-text("Continue"), ' +
        'button:has-text("Proceed"), a:has-text("Next")'
      )
      if (!nextBtn) break

      await nextBtn.click()
      await page.waitForLoadState('domcontentloaded').catch(() => {})
      await page.waitForTimeout(2000)

      // Re-extract fields on new step and extend fillMapping
      const newPageHtml = await page.content()
      const newFields = extractFieldsFromHtml(newPageHtml)
      if (newFields.length > 0) {
        {
          const _c = await claudeFormMapping(newFields, profile, job, resumeText)
          const _fb = fallbackFormMapping(newFields, profile)
          const _cs = new Set(_c.map(f => f.selector))
          const newMapping = [..._fb.filter(f => !_cs.has(f.selector)), ..._c]
          fillMapping.push(...newMapping)
        }
      }
    }

    // ── STEP 10: Fallback — retry with fresh Scrapfly cookies if re-blocked ──
    const bodyText = await page.evaluate(() => document.body.innerText)
    const screenshotUrl = await takeScreenshot(page, applicationId)

    if (bodyText.includes('Just a moment') || bodyText.includes('Checking your browser')) {
      // Re-fetch fresh cookies from Scrapfly and retry
      console.warn('[browserApply] Cloudflare re-challenged — retrying with fresh Scrapfly cookies')
      await browser.close().catch(() => {})
      browser = null

      try {
        const fresh = await scrapflyFetch(effectiveUrl)
        if (!isChallenged(fresh.html)) {
          return browserApply(applyUrl, profile, applicationId, userAnswers)
        }
      } catch { /* non-fatal — fall through to needs_review */ }

      await prisma.application.update({
        where: { id: applicationId },
        data: { bypassMethod: 'failed' },
      }).catch(() => {})

      return {
        status: 'needs_review',
        errorMessage: 'Cloudflare re-challenged after cookie injection — complete manually',
        applyUrl,
        screenshotUrl,
        bypassMethod: 'failed',
      }
    }

    await prisma.application.update({
      where: { id: applicationId },
      data: { bypassMethod },
    }).catch(() => {})

    return {
      status: 'needs_review',
      errorMessage: 'Could not complete form — check screenshot',
      applyUrl,
      screenshotUrl,
      bypassMethod,
    }
  }

  try {
    return await Promise.race([
      run(),
      new Promise<BrowserApplyResult>(resolve =>
        setTimeout(
          () => resolve({ status: 'needs_review', errorMessage: 'Timed out after 10 minutes', applyUrl }),
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
    await browser?.close().catch(() => {})
    if (steelSessionId && process.env.STEEL_API_KEY) {
      const steel = new Steel({ steelAPIKey: process.env.STEEL_API_KEY })
      await steel.sessions.release(steelSessionId).catch(() => {})
    }
    for (const f of tempFiles) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
  }
}
