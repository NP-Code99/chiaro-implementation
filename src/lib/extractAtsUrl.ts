import * as cheerio from 'cheerio'
import { scrapflyFetch, ScrapflyFetchError } from './scrapflyFetch'
import { prisma } from './db'

// Known external ATS domains — sorted by specificity
const ATS_PATTERNS = [
  { pattern: /boards\.greenhouse\.io|job-boards\.greenhouse\.io/i, ats: 'GREENHOUSE'     },
  { pattern: /jobs\.lever\.co/i,                                    ats: 'LEVER'         },
  { pattern: /apply\.workday\.com|myworkdayjobs\.com/i,             ats: 'WORKDAY'       },
  { pattern: /bamboohr\.com\/careers\//i,                           ats: 'BAMBOOHR'      },
  { pattern: /ashbyhq\.com\/jobs/i,                                  ats: 'CUSTOM'        },
  { pattern: /jobvite\.com\/jobs/i,                                  ats: 'CUSTOM'        },
  { pattern: /smartrecruiters\.com\/jobs/i,                          ats: 'CUSTOM'        },
  { pattern: /jobs\.rippling\.com/i,                                 ats: 'CUSTOM'        },
  { pattern: /apply\.breezy\.hr/i,                                   ats: 'CUSTOM'        },
  { pattern: /apply\.ashbyhq\.com/i,                                 ats: 'CUSTOM'        },
  { pattern: /jobs\.workable\.com/i,                                 ats: 'CUSTOM'        },
]

/**
 * Strips Wellfound tracking params to get the base job page URL.
 * e.g. https://wellfound.com/jobs/123-role?autoOpenApplication=true
 *   → https://wellfound.com/jobs/123-role
 */
function toBaseUrl(url: string): string {
  try {
    const u = new URL(url)
    u.search = ''
    return u.toString()
  } catch {
    return url.split('?')[0]
  }
}

/**
 * Searches a string (HTML or JSON text) for known external ATS URLs.
 * Returns all matches, deduped.
 */
function extractAtsUrlsFromText(text: string): string[] {
  const results: string[] = []
  // Broad regex to capture full URL from text (stops at whitespace or common delimiters)
  const urlRegex = /(https?:\/\/[^\s"'<>\\]+)/g
  let match: RegExpExecArray | null
  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[1]
    if (ATS_PATTERNS.some(({ pattern }) => pattern.test(url))) {
      results.push(url)
    }
  }
  return Array.from(new Set(results))
}

/**
 * Given a Wellfound job page HTML, finds the first external ATS apply link.
 * Searches <a href>, data attributes, and the __NEXT_DATA__ JSON blob.
 * Returns the URL string or null if none found.
 */
function findAtsLinkInHtml(html: string): string | null {
  const $ = cheerio.load(html)
  const candidates: string[] = []

  // 1. Check all <a href> links
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? ''
    if (ATS_PATTERNS.some(({ pattern }) => pattern.test(href))) {
      candidates.push(href)
    }
  })

  // 2. Check data attributes
  $('[data-apply-url], [data-url]').each((_, el) => {
    const val = $(el).attr('data-apply-url') ?? $(el).attr('data-url') ?? ''
    if (ATS_PATTERNS.some(({ pattern }) => pattern.test(val))) {
      candidates.push(val)
    }
  })

  // 3. Parse __NEXT_DATA__ JSON (Wellfound is a Next.js app — external apply URL
  //    is often embedded in the server-rendered page props under jobApplicationUrl,
  //    externalApplicationUrl, or similar keys)
  const nextDataEl = $('#__NEXT_DATA__')
  if (nextDataEl.length) {
    try {
      const jsonText = nextDataEl.text()
      const urls = extractAtsUrlsFromText(jsonText)
      candidates.push(...urls)
    } catch { /* ignore parse errors */ }
  }

  // 4. Search all <script> tags for embedded ATS URLs (catches inline JSON blobs)
  $('script').each((_, el) => {
    const content = $(el).text() ?? ''
    if (content.length > 50 && ATS_PATTERNS.some(({ pattern }) => pattern.test(content))) {
      const urls = extractAtsUrlsFromText(content)
      candidates.push(...urls)
    }
  })

  // 5. Check <iframe src> — Greenhouse and other ATS forms are often embedded as iframes
  // on company career pages. Protocol-relative URLs (//boards.greenhouse.io/...) are
  // normalized to https://.
  $('iframe[src]').each((_, el) => {
    const src = $(el).attr('src') ?? ''
    const normalizedSrc = src.startsWith('//') ? `https:${src}` : src
    if (ATS_PATTERNS.some(({ pattern }) => pattern.test(normalizedSrc))) {
      candidates.push(normalizedSrc)
    }
  })

  // Prefer direct apply links (contain /apply or /jobs/) over listing pages
  const direct = candidates.find(u => /\/apply|\/jobs\//i.test(u))
  return direct ?? candidates[0] ?? null
}

export interface AtsUrlResult {
  url: string
  isExternal: boolean   // true = Greenhouse/Lever/etc, false = native Wellfound
  atsType?: string
}

/**
 * Normalizes Greenhouse URLs extracted from embedded career pages.
 *
 * For embed URLs WITH a validityToken: keep as-is (navigate directly to the form).
 * The embed URL `boards.greenhouse.io/embed/job_app?for=company&validityToken=...&token=id`
 * bypasses company-configured custom domain redirects that would otherwise send the
 * browser to the company's own careers page (where the form is inside an iframe).
 *
 * For embed URLs WITHOUT a validityToken: convert to the standard apply URL
 * `boards.greenhouse.io/company/jobs/id`.
 */
function normalizeGreenhouseUrl(url: string): string {
  // Decode HTML entities first
  const decoded = url.replace(/&amp;/g, '&')
  try {
    const u = new URL(decoded.startsWith('http') ? decoded : `https://${decoded}`)
    if ((u.hostname === 'boards.greenhouse.io' || u.hostname === 'job-boards.greenhouse.io') &&
        u.pathname.includes('/embed/job_app')) {
      // If validityToken is present, navigate to the embed URL directly — this bypasses
      // any custom domain redirect the company may have configured.
      if (u.searchParams.has('validityToken')) {
        return decoded.startsWith('http') ? decoded : `https://${decoded}`
      }
      // No validity token — convert to standard job URL
      const company = u.searchParams.get('for')
      const token = u.searchParams.get('token')
      if (company && token) {
        return `https://${u.hostname}/${company}/jobs/${token}`
      }
    }
  } catch { /* ignore — return original */ }
  return decoded.startsWith('http') ? decoded : `https://${decoded}`
}

/**
 * Resolves the real application URL for a Wellfound or startup.jobs job.
 *
 * Strategy:
 * 1. If URL is already a direct ATS URL — use it as-is
 * 2. If startup.jobs/apply/ URL — use Scrapfly to follow the CF-protected redirect
 *    and extract the embedded ATS link from the company's careers page
 * 3. If wellfound.com URL — strip tracking params, fetch base page, extract ATS link
 * 4. Otherwise — use URL as-is
 */
export async function resolveApplyUrl(
  rawUrl: string,
  jobId: string,
): Promise<AtsUrlResult> {
  // Already a direct ATS URL — skip redirect resolution entirely
  const directMatch = ATS_PATTERNS.find(({ pattern }) => pattern.test(rawUrl))
  if (directMatch) {
    return { url: rawUrl, isExternal: true, atsType: directMatch.ats }
  }

  // startup.jobs wraps apply links behind a Cloudflare-protected redirect.
  // Steel.dev (with solveCaptcha + residential proxy) handles CF and follows
  // the redirect in-browser — no Scrapfly needed. Return the URL as-is; the
  // live recon step in browserApply extracts the real ATS URL after navigation.
  if (rawUrl.includes('startup.jobs/apply/')) {
    console.log(`[resolveApplyUrl] startup.jobs redirect — deferring to Steel.dev browser: ${rawUrl}`)
    return { url: rawUrl, isExternal: false }
  }

  // Not a Wellfound URL at all — use as-is
  if (!rawUrl.includes('wellfound.com')) {
    return { url: rawUrl, isExternal: false }
  }

  const baseUrl = toBaseUrl(rawUrl)
  console.log(`[resolveApplyUrl] Fetching base Wellfound page: ${baseUrl}`)

  try {
    const { html } = await scrapflyFetch(baseUrl)
    const atsLink = findAtsLinkInHtml(html)

    if (atsLink) {
      const match = ATS_PATTERNS.find(({ pattern }) => pattern.test(atsLink))
      console.log(`[resolveApplyUrl] Found external ATS link: ${atsLink}`)

      // Persist the resolved URL so retries skip this lookup
      await prisma.job.update({
        where: { id: jobId },
        data: {
          applyUrl: atsLink,
          atsType: (match?.ats as 'GREENHOUSE' | 'LEVER' | 'WORKDAY' | 'CUSTOM') ?? 'CUSTOM',
        },
      }).catch(() => {})

      return { url: atsLink, isExternal: true, atsType: match?.ats ?? 'CUSTOM' }
    }

    // No external link found — it's a native Wellfound application
    console.log(`[resolveApplyUrl] No external ATS link found — using base Wellfound URL`)
    return { url: baseUrl, isExternal: false }
  } catch (err) {
    if (err instanceof ScrapflyFetchError) {
      // Scrapfly couldn't fetch even the base page — return base URL and let
      // the apply pipeline handle the failure gracefully
      console.warn(`[resolveApplyUrl] Scrapfly failed on base page: ${err.message}`)
    }
    return { url: baseUrl, isExternal: false }
  }
}
