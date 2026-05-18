const CAPSOLVER_API = 'https://api.capsolver.com'
const POLL_INTERVAL_MS = 3000
const MAX_POLLS = 20 // 60s timeout

async function createAndPollTask(
  taskBody: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.CAPSOLVER_API_KEY
  if (!apiKey) {
    console.warn('[CapSolver] CAPSOLVER_API_KEY not set')
    return null
  }

  try {
    const createRes = await fetch(`${CAPSOLVER_API}/createTask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, task: taskBody }),
    })
    const createData = await createRes.json() as CapSolverTaskResponse
    if (createData.errorId !== 0 || !createData.taskId) {
      console.warn('[CapSolver] Task create failed:', createData.errorDescription)
      return null
    }
    console.log(`[CapSolver] Task created: ${createData.taskId}`)

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
      const getRes = await fetch(`${CAPSOLVER_API}/getTaskResult`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId: createData.taskId }),
      })
      const getData = await getRes.json() as CapSolverResultResponse
      if (getData.status === 'ready') {
        console.log('[CapSolver] Task solved')
        return getData.solution as unknown as Record<string, unknown> ?? null
      }
      if (getData.status === 'failed') {
        console.warn('[CapSolver] Task failed:', getData.errorDescription)
        return null
      }
      console.log(`[CapSolver] Processing... (${i + 1}/${MAX_POLLS})`)
    }
    console.warn('[CapSolver] Timed out')
    return null
  } catch (err) {
    console.warn('[CapSolver] Error:', err instanceof Error ? err.message : String(err))
    return null
  }
}

interface CapSolverTaskResponse {
  errorId: number
  taskId?: string
  errorDescription?: string
}

interface CapSolverResultResponse {
  errorId: number
  status: 'idle' | 'processing' | 'ready' | 'failed'
  solution?: { token: string }
  errorDescription?: string
}

/**
 * Solves a Cloudflare Turnstile widget using CapSolver.
 * Use for sitekeys that are plain Turnstile (0x4AAAAAAA prefix is managed challenge — use solveCloudflareChallenge instead).
 * Returns the token to inject into the page, or null on failure/timeout.
 */
export async function solveTurnstile(pageUrl: string, siteKey: string): Promise<string | null> {
  const solution = await createAndPollTask({
    type: 'AntiTurnstileTaskProxyLess',
    websiteURL: pageUrl,
    websiteKey: siteKey,
  })
  return (solution?.token as string) ?? null
}

/**
 * Solves a Cloudflare Managed Challenge (cf-mitigated: challenge) using CapSolver.
 * This is the challenge that fires when clicking "Apply Now" on Wellfound job pages.
 * Sitekeys starting with 0x4AAAAAAA are managed challenges, not plain Turnstile.
 * Returns the token to submit to the challenge form, or null on failure.
 */
export async function solveCloudflareChallenge(pageUrl: string, siteKey: string): Promise<string | null> {
  const solution = await createAndPollTask({
    type: 'AntiTurnstileTaskProxyLess',
    websiteURL: pageUrl,
    websiteKey: siteKey,
    action: 'managed',
  })
  return (solution?.token as string) ?? null
}

/**
 * Solves Cloudflare's interactive slider challenge ("Slide right to secure your access").
 * This is NOT the same as Turnstile or DataDome — it's Cloudflare's full challenge page.
 * CapSolver uses its own browser to solve it and returns cookies (cf_clearance) to inject.
 * Returns an array of cookies, or null on failure.
 */
export async function solveCloudflareInteractivePage(
  pageUrl: string,
): Promise<Array<{ name: string; value: string; domain: string; path: string }> | null> {
  const solution = await createAndPollTask({
    type: 'CloudflareChallengePage',
    websiteURL: pageUrl,
  })
  if (!solution) return null
  const cookies = solution.cookies as Array<{ name: string; value: string; domain: string; path: string }> | undefined
  return cookies && cookies.length > 0 ? cookies : null
}

/**
 * Solves a DataDome slider CAPTCHA using CapSolver.
 * Returns the solved datadome cookie value, or null on failure.
 *
 * Docs: https://docs.capsolver.com/en/guide/captcha/datadome/
 * - Task type: DatadomeSliderTask (exact casing from docs)
 * - UA must be Chrome 137-146 on Windows 10 x64 (CapSolver requirement)
 * - proxy is recommended for consistency; parsed from RESIDENTIAL_PROXY_URL if set
 * - captchaUrl must have t=fe (not t=bv which means IP ban)
 */
const DATADOME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'

/**
 * Converts a proxy URL (http://user:pass@host:port) to CapSolver's
 * colon-separated format (host:port:user:pass). Returns null if unparseable.
 */
function parseProxyUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim())
    const host = u.hostname
    const port = u.port || (u.protocol === 'https:' ? '443' : '80')
    const username = decodeURIComponent(u.username)
    const password = decodeURIComponent(u.password)
    if (host && port && username && password) {
      return `${host}:${port}:${username}:${password}`
    }
  } catch { /* malformed URL — fall through */ }
  return null
}

/**
 * Returns a CapSolver-formatted proxy string.
 * Checks DATADOME_PROXY_URL first (dedicated residential IP for DataDome tasks),
 * then falls back to RESIDENTIAL_PROXY_URL.
 */
function getProxyForCapSolver(): string | null {
  const raw = process.env.DATADOME_PROXY_URL ?? process.env.RESIDENTIAL_PROXY_URL
  if (!raw) return null
  const parsed = parseProxyUrl(raw)
  if (!parsed) console.warn('[CapSolver] Proxy URL could not be parsed — DataDome solve may be less reliable')
  return parsed
}

/**
 * Solves a Google reCAPTCHA v2 (checkbox or invisible) using CapSolver.
 * Returns the gRecaptchaResponse token to inject into the page, or null on failure.
 */
export async function solveRecaptchaV2(pageUrl: string, siteKey: string): Promise<string | null> {
  const solution = await createAndPollTask({
    type: 'ReCaptchaV2TaskProxyLess',
    websiteURL: pageUrl,
    websiteKey: siteKey,
  })
  return (solution?.gRecaptchaResponse as string) ?? null
}

/**
 * Solves a Google reCAPTCHA v3 (standard, non-enterprise) using CapSolver.
 * reCAPTCHA v3 is invisible and encodes a bot-likelihood score 0–1 in the token.
 * A score below ~0.5 triggers server-side challenges. minScore: 0.9 requests a
 * high-confidence human token.
 *
 * @param pageUrl  - The URL of the page that hosts the reCAPTCHA script
 * @param siteKey  - The reCAPTCHA v3 site key (from api.js?render=SITEKEY)
 * @param action   - The action string passed to grecaptcha.execute() — defaults to 'submit'
 */
export async function solveRecaptchaV3(
  pageUrl: string,
  siteKey: string,
  action = 'submit',
): Promise<string | null> {
  console.log(`[CapSolver] reCAPTCHA v3 — sitekey: ${siteKey}, action: ${action}, minScore: 0.9`)
  const solution = await createAndPollTask({
    type: 'ReCaptchaV3TaskProxyLess',
    websiteURL: pageUrl,
    websiteKey: siteKey,
    pageAction: action,
    minScore: 0.9,
  })
  return (solution?.gRecaptchaResponse as string) ?? null
}

/**
 * Solves a Google reCAPTCHA Enterprise v3 using CapSolver.
 * Greenhouse uses reCAPTCHA Enterprise (loads enterprise.js, not api.js).
 * Enterprise tokens also carry a bot score — minScore: 0.9 requests a human-level token.
 * The sitekey is embedded in the page JS bundle (not in a script ?render= URL param).
 *
 * @param pageUrl  - The URL of the page that hosts enterprise.js
 * @param siteKey  - The enterprise site key (6L... format, found in page JS config)
 * @param action   - The action string — defaults to 'submit'
 */
export async function solveRecaptchaEnterprise(
  pageUrl: string,
  siteKey: string,
  action = 'submit',
): Promise<string | null> {
  console.log(`[CapSolver] reCAPTCHA Enterprise — sitekey: ${siteKey}, action: ${action}, minScore: 0.9`)
  const solution = await createAndPollTask({
    type: 'ReCaptchaV3EnterpriseTaskProxyLess',
    websiteURL: pageUrl,
    websiteKey: siteKey,
    pageAction: action,
    minScore: 0.9,
  })
  return (solution?.gRecaptchaResponse as string) ?? null
}

export async function solveDataDome(
  captchaUrl: string,
  _userAgent?: string,
): Promise<string | null> {
  // Warn if the URL has t=bv — that signals an IP ban and the solve will fail
  if (captchaUrl.includes('t=bv')) {
    console.warn('[CapSolver] DataDome captchaUrl has t=bv — IP may be banned. CapSolver solve will likely fail.')
  }

  const proxy = getProxyForCapSolver()
  const taskBody: Record<string, unknown> = {
    type: 'DatadomeSliderTask',   // exact casing per CapSolver docs
    captchaUrl,
    userAgent: DATADOME_USER_AGENT,
  }
  if (proxy) {
    taskBody.proxy = proxy
  } else {
    console.warn('[CapSolver] No RESIDENTIAL_PROXY_URL set — DataDome solve may be less reliable without proxy')
  }

  const solution = await createAndPollTask(taskBody)
  return (solution?.cookie as string) ?? null
}
