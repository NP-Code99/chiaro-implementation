/**
 * BrightData hCaptcha solver test.
 * 1. Loads the Lever page headlessly to extract the hCaptcha sitekey.
 * 2. Submits a solve task to BrightData and polls for the token.
 *
 * Run:
 *   npx @dotenvx/dotenvx run -- npx tsx scripts/test-brightdata-hcaptcha.ts
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import { chromium } from 'playwright'

const LEVER_URL = 'https://jobs.lever.co/resilientco/40cde645-5638-4d08-9c33-61ee62f16d82/apply'
const BRIGHTDATA_API_KEY = process.env.BRIGHTDATA_API_KEY ?? '4280aa74-9b62-4a98-a7a9-dd5488bdfce8'

// ── Step 1: Extract hCaptcha sitekey from the Lever page ──────────────────────

async function extractHCaptchaSitekey(url: string): Promise<string | null> {
  console.log('[test] Launching headless Chromium to extract hCaptcha sitekey...')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(3000) // let widgets render

    const sitekey = await page.evaluate((): string | null => {
      // hCaptcha embeds its sitekey in data-sitekey or iframe src
      const el = document.querySelector('[data-sitekey]')
      if (el) return el.getAttribute('data-sitekey')

      const iframe = document.querySelector('iframe[src*="hcaptcha.com"]') as HTMLIFrameElement | null
      if (iframe) {
        const m = iframe.src.match(/sitekey=([^&]+)/)
        if (m) return m[1]
      }

      // Also check script tags for embedded config
      for (const s of Array.from(document.querySelectorAll('script:not([src])'))) {
        const m = s.textContent?.match(/"sitekey"\s*:\s*"([a-f0-9-]{36})"/)
        if (m) return m[1]
      }
      return null
    })

    console.log(`[test] hCaptcha sitekey: ${sitekey ?? '(not found on page)'}`)
    return sitekey
  } finally {
    await browser.close()
  }
}

// ── Step 2: BrightData CAPTCHA Solver API ─────────────────────────────────────
// Try multiple endpoint/payload variants to discover the correct format.

const POLL_INTERVAL_MS = 4000
const MAX_POLLS = 30  // 2 min max

interface BDCandidate {
  label: string
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function buildCandidates(pageUrl: string, sitekey: string): BDCandidate[] {
  const bearer = { 'Authorization': `Bearer ${BRIGHTDATA_API_KEY}`, 'Content-Type': 'application/json' }
  const apiKeyHeader = { 'x-api-key': BRIGHTDATA_API_KEY, 'Content-Type': 'application/json' }

  return [
    // Variant A — /captcha-solver/start (newer)
    {
      label: 'A: /captcha-solver/start',
      url: 'https://api.brightdata.com/captcha-solver/start',
      method: 'POST', headers: bearer,
      body: { url: pageUrl, captchaType: 'hCaptcha', siteKey: sitekey },
    },
    // Variant B — /captcha-solver/v1/solve
    {
      label: 'B: /captcha-solver/v1/solve',
      url: 'https://api.brightdata.com/captcha-solver/v1/solve',
      method: 'POST', headers: bearer,
      body: { url: pageUrl, captchaType: 'hCaptcha', siteKey: sitekey },
    },
    // Variant C — /captcha-solver with different payload shape
    {
      label: 'C: /captcha-solver (nested captcha obj)',
      url: 'https://api.brightdata.com/captcha-solver',
      method: 'POST', headers: bearer,
      body: { url: pageUrl, captcha: { type: 'hcaptcha', siteKey: sitekey } },
    },
    // Variant D — /captcha with x-api-key header
    {
      label: 'D: /captcha (x-api-key)',
      url: 'https://api.brightdata.com/captcha',
      method: 'POST', headers: apiKeyHeader,
      body: { url: pageUrl, type: 'hcaptcha', sitekey },
    },
    // Variant E — captcha.brightdata.com sub-domain
    {
      label: 'E: captcha.brightdata.com',
      url: 'https://captcha.brightdata.com/api/solve',
      method: 'POST', headers: bearer,
      body: { url: pageUrl, captchaType: 'hCaptcha', siteKey: sitekey },
    },
  ]
}

async function tryCreateTask(c: BDCandidate): Promise<{ taskId: string | null; rawBody: string; status: number }> {
  const res = await fetch(c.url, {
    method: c.method,
    headers: c.headers as HeadersInit,
    body: JSON.stringify(c.body),
  }).catch((e: unknown) => { throw new Error(String(e)) })

  const text = await res.text()
  console.log(`  ${c.label} → HTTP ${res.status}: ${text.slice(0, 300)}`)

  if (!res.ok) return { taskId: null, rawBody: text, status: res.status }

  try {
    const parsed = JSON.parse(text) as { id?: string; task_id?: string; taskId?: string }
    const taskId = parsed.id ?? parsed.task_id ?? parsed.taskId ?? null
    return { taskId: taskId ? String(taskId) : null, rawBody: text, status: res.status }
  } catch {
    return { taskId: null, rawBody: text, status: res.status }
  }
}

async function pollForToken(
  baseUrl: string,
  taskId: string,
  headers: Record<string, string>,
): Promise<string | null> {
  // Try both URL patterns for the result endpoint
  const resultUrls = [
    `${baseUrl}/${taskId}`,
    `${baseUrl}/result/${taskId}`,
    `${baseUrl}?id=${taskId}`,
  ]

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))

    for (const url of resultUrls) {
      const res = await fetch(url, { headers: headers as HeadersInit }).catch(() => null)
      if (!res) continue
      const body = await res.text()

      let data: Record<string, unknown>
      try { data = JSON.parse(body) as Record<string, unknown> } catch { continue }

      const status = (data.status as string) ?? ''
      if (i === 0) console.log(`  Poll ${i + 1}: status=${status} (url=${url})`)
      else console.log(`  Poll ${i + 1}: status=${status}`)

      if (status === 'solved' || data.token || data.solution) {
        const token = (data.token ?? (data.solution as Record<string, unknown>)?.token) as string | undefined
        return String(token ?? '')
      }
      if (status === 'failed' || status === 'error') {
        console.error(`  Failed: ${JSON.stringify(data)}`)
        return null
      }
    }
  }
  return null
}

async function solveHCaptchaViaBrightData(
  pageUrl: string,
  sitekey: string,
): Promise<string | null> {
  const candidates = buildCandidates(pageUrl, sitekey)

  console.log('[BrightData] Probing API endpoints...')
  for (const c of candidates) {
    try {
      const { taskId, status } = await tryCreateTask(c)
      if (taskId) {
        console.log(`\n[BrightData] ✓ Endpoint ${c.label} accepted (taskId=${taskId}) — polling...`)
        const token = await pollForToken(c.url.replace(/\/[^/]+$/, ''), taskId, c.headers)
        return token
      }
      // 2xx but no taskId means the token might be in the create response (synchronous API)
      if (status >= 200 && status < 300) {
        console.log(`  Note: ${c.label} returned 2xx but no taskId — may be synchronous API`)
      }
    } catch (err) {
      console.log(`  ${c.label} → Error: ${String(err).slice(0, 100)}`)
    }
  }

  console.error('\n[BrightData] All endpoint variants failed — none returned a taskId')
  return null
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nBrightData hCaptcha Solver Test`)
  console.log(`API Key: ${BRIGHTDATA_API_KEY.slice(0, 8)}...`)
  console.log(`Target:  ${LEVER_URL}\n`)

  const sitekey = await extractHCaptchaSitekey(LEVER_URL)

  if (!sitekey) {
    console.warn('[test] Could not extract sitekey from page — trying with known Lever sitekey...')
    // Lever's well-known hCaptcha sitekey
  }

  const effectiveSitekey = sitekey ?? 'a5f74b19-9e45-40e0-b45d-47ff91b7a6c2'
  console.log(`\n[test] Using sitekey: ${effectiveSitekey}`)

  const token = await solveHCaptchaViaBrightData(LEVER_URL, effectiveSitekey)

  if (token) {
    console.log('\n✅ BrightData hCaptcha solver WORKS')
    console.log(`   Token length: ${token.length} chars`)
  } else {
    console.log('\n❌ BrightData hCaptcha solver did not return a token')
    console.log('   Check the response logs above — may need different endpoint or payload format')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
