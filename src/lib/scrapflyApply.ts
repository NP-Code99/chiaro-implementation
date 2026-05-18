/**
 * scrapflyApply.ts
 *
 * Fills and submits Wellfound's native application form entirely through
 * Scrapfly's js_scenario — bypasses Cloudflare + DataDome without Playwright.
 */

import { ScrapeConfig, ScrapeResult } from 'scrapfly-sdk'
import { scrapfly } from './scrapflyClient'
import { scrapflyFetch } from './scrapflyFetch'
import type { UserProfile } from './userProfile'

export interface ScrapflyApplyResult {
  status: 'applied' | 'needs_review' | 'failed'
  errorMessage?: string
  html?: string
  bypassMethod: 'scrapfly_only'
}

const YEARS_EXP_MAP: Record<string, string> = {
  '0-1': '0',
  '1-3': '1',
  '3-5': '3',
  '5-8': '5',
  '8-12': '8',
  '12+':  '12',
}

const SUCCESS_PATTERNS = [
  'thank you', 'application received', 'application submitted',
  'successfully applied', "we'll be in touch", 'we have received',
]

/**
 * Returns an `execute` instruction (Scrapfly's correct instruction type for JS evaluation).
 * Sets a React-controlled input's value and fires synthetic input/change events so React
 * picks up the new value — plain assignment does not trigger React's controlled component.
 */
function execSetInput(selector: string, value: string): Record<string, unknown> {
  const s = JSON.stringify(selector)
  const v = JSON.stringify(value)
  const script = `(function(){var e=document.querySelector(${s});if(!e)return;var niv=Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;niv.call(e,${v});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})();`
  return { execute: { script } }
}

function execClickRadio(name: string, indexToClick: number): Record<string, unknown> {
  const n = JSON.stringify(name)
  const script = `(function(){var r=document.querySelectorAll('input[type="radio"][name='+${n}+']');if(r[${indexToClick}])r[${indexToClick}].click();})();`
  return { execute: { script } }
}

function execScript(script: string): Record<string, unknown> {
  return { execute: { script } }
}

function waitMs(ms: number): Record<string, unknown> {
  return { wait: ms }
}

function waitForSelector(selector: string, timeout = 8000): Record<string, unknown> {
  return { wait_for_selector: { selector, timeout } }
}

/**
 * Build js_scenario as a flat array using Scrapfly's correct instruction format.
 *
 * Strategy: start the scenario on the BASE URL (no ?autoOpenApplication=true).
 * DataDome clears the base URL via ASP + residential proxy. Then we navigate
 * WITHIN the same browser session to ?autoOpenApplication=true — DataDome
 * treats this as a legitimate same-session user action (clicking "Apply Now").
 * The apply URL is passed in so the navigation script can reference it.
 *
 * Correct instruction types (Scrapfly docs):
 *   { wait_for_selector: { selector: "...", timeout: N } }
 *   { execute: { script: "..." } }
 *   { wait: N }            — milliseconds, plain number
 *   { wait_for_navigation: { timeout: N } }
 *   { click: { selector: "..." } }
 *
 * Budget: 25 seconds total — waits are intentionally minimal.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildScenario(profile: UserProfile, coverLetter: string, isLoggedIn: boolean, applyUrl: string): any[] {
  const fullName = `${profile.firstName} ${profile.lastName}`.trim()
  const salary = profile.desiredSalary?.replace(/[^0-9]/g, '') || '130000'
  const isAuthorized = profile.workAuth !== 'Need Sponsorship'
  const needsSponsorship = profile.workAuth === 'Need Sponsorship' || profile.workAuth === 'H1B Visa'
  const yoePrefix = YEARS_EXP_MAP[profile.yearsExp] ?? '3'

  const instructions: Record<string, unknown>[] = []

  // ── Phase 1: Navigate from base page → apply modal ───────────────────────
  // Wait for the base page to be interactive (Apply Now button present)
  instructions.push(waitForSelector('button', 6000))

  // Click the "Apply Now" button — this is exactly what a real user does.
  // Wellfound's onclick handler sets window.location.href to ?autoOpenApplication=true.
  // DataDome sees this as a normal same-session navigation, not a new bot request.
  instructions.push(execScript(
    `(function(){` +
    `var b=document.querySelector('button[onclick*="autoOpenApplication"]');` +
    `if(b){b.click();return;}` +
    // Fallback: navigate directly (mimics the onclick handler)
    `window.location.href=${JSON.stringify(applyUrl)};` +
    `})();`
  ))

  // Wait for the navigation to complete and React to hydrate the modal
  instructions.push({ wait_for_navigation: { timeout: 10000 } })
  instructions.push(waitMs(1500))

  // ── Phase 2: Fill the application form ───────────────────────────────────
  // Wait for at least one form input to appear
  instructions.push(waitForSelector('input', 6000))

  if (!isLoggedIn) {
    // Full Name
    instructions.push(execSetInput('input[name="name"]', fullName))
    instructions.push(waitMs(150))

    // Email
    instructions.push(execSetInput('input[name="email"]', profile.email))
    instructions.push(waitMs(150))

    // Password fields
    const pwd = profile.applicationPassword || 'Chiaro12345678!'
    instructions.push(execSetInput('input[name="password"]', pwd))
    instructions.push(waitMs(100))
    instructions.push(execSetInput('input[name="passwordConfirmation"]', pwd))
    instructions.push(waitMs(150))

    // Location — focus the field, set value, wait for autocomplete, accept first suggestion
    const locSel = 'input[name="downshift-0-input"]'
    instructions.push(execScript(`(function(){var e=document.querySelector(${JSON.stringify(locSel)});if(e){e.focus();e.click();}})();`))
    instructions.push(waitMs(150))
    instructions.push(execSetInput(locSel, profile.location))
    instructions.push(waitMs(800))
    instructions.push(execScript(`(function(){var o=document.querySelector('[role="option"]');if(o){o.click();}else{var e=document.querySelector(${JSON.stringify(locSel)});if(e)e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}})();`))
    instructions.push(waitMs(200))

    // Years of experience — open React dropdown, select matching option
    instructions.push(execScript(`(function(){var e=document.querySelector('input[id*="yearsOfExperience"]');if(e){e.focus();e.click();}})();`))
    instructions.push(waitMs(300))
    instructions.push(execScript(`(function(){var opts=document.querySelectorAll('[class*="option"]');for(var i=0;i<opts.length;i++){if(opts[i].textContent&&opts[i].textContent.trim().startsWith(${JSON.stringify(yoePrefix)})){opts[i].click();return;}}})();`))
    instructions.push(waitMs(150))

    // Desired salary
    instructions.push(execSetInput('input[name="desiredSalary"]', salary))
    instructions.push(waitMs(100))
  }

  // Work authorization radios (present whether logged in or not)
  instructions.push(execClickRadio('"usAuthorized"', isAuthorized ? 0 : 1))
  instructions.push(waitMs(100))
  instructions.push(execClickRadio('"requireSponsorship"', needsSponsorship ? 0 : 1))
  instructions.push(waitMs(100))

  // Cover letter textarea
  instructions.push(execSetInput('textarea', coverLetter))
  instructions.push(waitMs(150))

  // ── Phase 3: Submit ───────────────────────────────────────────────────────
  instructions.push(execScript('window.scrollTo(0,document.body.scrollHeight);'))
  instructions.push(waitMs(300))
  instructions.push(execScript(
    `(function(){` +
    `var b=document.querySelector('button[type="submit"]');` +
    `if(!b){var btns=Array.from(document.querySelectorAll('button'));` +
    `b=btns.find(function(x){return /send application|submit application/i.test(x.textContent||'');});}` +
    `if(b)b.click();` +
    `})();`
  ))
  instructions.push(waitMs(3000))

  return instructions
}

/**
 * Apply to a Wellfound native job using Scrapfly's js_scenario.
 *
 * Strategy — why we start the scenario on the BASE URL:
 *   Scrapfly's ASP + residential proxy (`public_residential_pool`) successfully
 *   bypasses DataDome when fetching the base job page. The `?autoOpenApplication=true`
 *   endpoint triggers a stricter DataDome check when it is the STARTING URL of a new
 *   browser session. By starting on the base URL (which DataDome allows) and then
 *   navigating WITHIN the same session via the "Apply Now" onclick handler, DataDome
 *   sees a legitimate user action — not a bot starting fresh on the modal endpoint.
 */
export async function scrapflyApplyWellfound(
  applyUrl: string,
  profile: UserProfile,
  coverLetter: string,
  isLoggedIn = false,
): Promise<ScrapflyApplyResult> {
  const baseUrl = applyUrl.split('?')[0]
  // Derive a stable session ID — scoped to the job URL so retries reuse the same session
  const sessionId = `chiaro-wf-${Buffer.from(baseUrl).toString('base64').slice(0, 16).replace(/[^a-z0-9]/gi, '')}`

  try {
    // Step 1: Warm the session — plain fetch of the base URL establishes a DataDome-cleared
    // session in Scrapfly's residential proxy pool. The datadome cookie is stored in the
    // session and will be sent automatically when the js_scenario later navigates.
    console.log(`[scrapflyApply] Warming session ${sessionId} on ${baseUrl}`)
    await scrapflyFetch(baseUrl, sessionId).catch(err => {
      console.warn(`[scrapflyApply] Session warm-up failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    })

    // Step 2: Run the form-fill scenario — start on BASE URL, navigate to apply URL internally
    const scenario = buildScenario(profile, coverLetter, isLoggedIn, applyUrl)
    console.log(`[scrapflyApply] Running ${scenario.length}-step scenario starting on ${baseUrl} (session: ${sessionId})`)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const configOpts: any = {
      url: baseUrl,                            // Start on the base URL — DataDome clears this
      asp: true,                               // Scrapium browser handles TLS/canvas/WebGL fingerprints
      render_js: true,                         // Required for React hydration + DataDome JS checks
      proxy_pool: 'public_residential_pool',   // Residential IPs pass DataDome's IP reputation check
      country: 'US',
      rendering_wait: 2000,   // Base page load wait; scenario handles apply modal timing itself
      cache: false,           // Never cache — apply is a write action
      session: sessionId,     // Reuse warmed session so datadome cookie carries over
      js_scenario: scenario,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    }

    const config = new ScrapeConfig(configOpts)

    const raw = await scrapfly.scrape(config)

    if (!(raw instanceof ScrapeResult)) {
      return { status: 'needs_review', errorMessage: 'Scrapfly returned non-ScrapeResult', bypassMethod: 'scrapfly_only' }
    }

    const html = raw.result.content ?? ''
    const statusCode = raw.result.status_code

    if (statusCode !== 200) {
      return { status: 'failed', errorMessage: `Scrapfly HTTP ${statusCode}`, bypassMethod: 'scrapfly_only' }
    }

    const bodyText = html.toLowerCase()
    const succeeded = SUCCESS_PATTERNS.some(p => bodyText.includes(p))
    if (succeeded) {
      return { status: 'applied', bypassMethod: 'scrapfly_only', html }
    }

    return {
      status: 'needs_review',
      errorMessage: 'Submitted via Scrapfly — confirm success in dashboard',
      bypassMethod: 'scrapfly_only',
      html,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[scrapflyApply] Error:', msg)
    // Surface Scrapfly ASP failures as needs_review so user can apply manually
    if (msg.includes('ASP shield') || msg.includes('Unable to bypass') || msg.includes('BAD_UPSTREAM')) {
      return {
        status: 'needs_review',
        errorMessage: 'Wellfound blocked automated access — apply manually at ' + applyUrl,
        bypassMethod: 'scrapfly_only',
      }
    }
    return { status: 'failed', errorMessage: msg, bypassMethod: 'scrapfly_only' }
  }
}
