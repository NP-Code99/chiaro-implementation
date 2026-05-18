import { ScrapeConfig, ScrapeResult, errors } from 'scrapfly-sdk'
import { scrapfly } from './scrapflyClient'

export interface ScrapflyFetchResult {
  html: string
  cookies: Array<{ name: string; value: string; domain: string; path: string }>
  responseHeaders: Record<string, string>
  creditCost: number
}

export class ScrapflyFetchError extends Error {
  constructor(
    message: string,
    public readonly code: 'needs_review' | 'failed',
    public readonly originalError?: unknown,
  ) {
    super(message)
    this.name = 'ScrapflyFetchError'
  }
}

// Patterns that indicate Cloudflare/Turnstile is still showing a challenge
const CHALLENGE_PATTERNS = [
  'cf-turnstile',
  'Just a moment',
  'challenge-form',
  'Checking your browser',
  'Checking if the site connection is secure',
  'Verify you are human',
  'turnstile-widget',
  'cf-turnstile-response',
  'Enable JavaScript and cookies',
  'Ray ID:',  // Cloudflare error pages always contain this
]

/**
 * Returns true if the HTML looks like a Cloudflare challenge page
 * rather than the actual target page.
 */
export function isChallenged(html: string): boolean {
  return CHALLENGE_PATTERNS.some(p => html.includes(p))
}

/**
 * Extracts the Turnstile sitekey from challenge page HTML.
 * Returns null if no sitekey found.
 */
export function extractTurnstileSitekey(html: string): string | null {
  const match = html.match(/data-sitekey="([^"]+)"/)
  return match?.[1] ?? null
}

async function fetchOnce(url: string, sessionId?: string): Promise<ScrapflyFetchResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configOpts: any = {
    url,
    asp: true,
    render_js: true,
    proxy_pool: 'public_residential_pool',  // required to bypass DataDome IP reputation checks
    country: 'US',
    rendering_wait: 3000,
    cache: !sessionId,  // never cache when using a session (apply flows)
    cache_ttl: 3600,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    },
  }
  // Sessions preserve DataDome/CF cookies across requests — critical for multi-step apply flow
  if (sessionId) {
    configOpts.session = sessionId
  }
  const config = new ScrapeConfig(configOpts)

  const raw = await scrapfly.scrape(config)

  if (!(raw instanceof ScrapeResult)) {
    throw new ScrapflyFetchError('Scrapfly returned a raw Response instead of ScrapeResult', 'failed')
  }

  const { result } = raw

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const creditCost = typeof (result as any).cost === 'number' ? (result as any).cost : 0

  const html = result.content ?? ''
  const cookies = (result.cookies ?? []).map(c => ({
    name: c.name ?? '',
    value: c.value ?? '',
    domain: c.domain ?? new URL(url).hostname,
    path: c.path ?? '/',
  }))
  const responseHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(result.response_headers ?? {})) {
    responseHeaders[k] = String(v)
  }

  const headerCost = responseHeaders['x-scrapfly-api-cost'] ?? responseHeaders['X-Scrapfly-Api-Cost'] ?? 'n/a'
  console.log(`[Scrapfly] ${url} — header cost: ${headerCost}, sdk cost: ${creditCost} credits, status: ${result.status_code}`)

  if (result.status_code !== 200) {
    throw new ScrapflyFetchError(
      `Scrapfly returned HTTP ${result.status_code} for ${url}`,
      'failed',
    )
  }

  return { html, cookies, responseHeaders, creditCost }
}

/**
 * Fetch a Cloudflare-protected URL through Scrapfly.
 * Pass sessionId to reuse an established DataDome/CF session across requests.
 * Retries once on timeout, then throws ScrapflyFetchError on failure.
 */
export async function scrapflyFetch(url: string, sessionId?: string): Promise<ScrapflyFetchResult> {
  try {
    return await fetchOnce(url, sessionId)
  } catch (err) {
    if (err instanceof errors.ScrapflyError && err.message?.includes('TIMEOUT')) {
      console.warn(`[Scrapfly] Timeout on ${url} — retrying once`)
      try {
        return await fetchOnce(url, sessionId)
      } catch (retryErr) {
        throw new ScrapflyFetchError('Scrapfly timed out after retry', 'needs_review', retryErr)
      }
    }

    if (err instanceof errors.UpstreamHttpError) {
      throw new ScrapflyFetchError(
        `ERR::SCRAPE::BAD_UPSTREAM_RESPONSE — ${err.message}`,
        'needs_review',
        err,
      )
    }

    if (err instanceof ScrapflyFetchError) throw err

    throw new ScrapflyFetchError(
      err instanceof Error ? err.message : 'Scrapfly unknown error',
      'failed',
      err,
    )
  }
}
