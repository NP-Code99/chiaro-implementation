import { AtsType } from '@/lib/prismaEnums'
import { classifyATS } from '@/lib/atsClassifier'
import type { WellfoundJob, FetchWellfoundParams } from '@/types/wellfound'

const ACTOR_ID = 'radeance~wellfound-job-listings-scraper'
const APIFY_BASE = 'https://api.apify.com/v2'

// Normalized Job shape matching Prisma Job model (minus id/createdAt which are DB-generated)
export interface NormalizedJob {
  company: string
  role: string
  description: string
  applyUrl: string
  atsType: AtsType
  location: string
  salaryMin: number | null
  salaryMax: number | null
  tags: string[]
  logoUrl: string | null
  // For upsert dedup — stable identifier from Wellfound
  wellfoundId: string
}

function toAtsType(raw: string): AtsType {
  switch (raw) {
    case 'greenhouse': return AtsType.GREENHOUSE
    case 'lever':      return AtsType.LEVER
    case 'workday':    return AtsType.WORKDAY
    default:           return AtsType.CUSTOM
  }
}

function normalizeJob(raw: WellfoundJob): NormalizedJob | null {
  // Filter: skip if no apply URL AND no company email — completely unactionable
  if (!raw.job_application_url && !raw.company.email) return null

  const applyUrl = raw.job_application_url ?? ''
  const atsRaw = classifyATS(applyUrl || null)
  const atsType = toAtsType(atsRaw)

  const location = raw.job_remote
    ? 'Remote'
    : raw.job_location.length > 0
      ? raw.job_location.join(', ')
      : 'Unknown'

  const tags: string[] = [
    ...(raw.skills ?? []),
    ...(raw.job_remote ? ['Remote'] : []),
    ...(raw.job_type ? [raw.job_type] : []),
  ].slice(0, 8)

  return {
    wellfoundId: raw.job_id,
    company: raw.company.name,
    role: raw.job_title,
    description: raw.job_description,
    applyUrl,
    atsType,
    location,
    salaryMin: raw.job_min_salary,
    salaryMax: raw.job_max_salary,
    tags,
    logoUrl: raw.company.logo_url,
  }
}

/**
 * Builds a Wellfound job search URL from params.
 * The actor requires at least one startUrl pointing to a Wellfound listing page.
 */
function buildWellfoundSearchUrl(params: FetchWellfoundParams): string {
  const base = 'https://wellfound.com/jobs'
  const parts: string[] = []
  if (params.searchQuery) parts.push(`query=${encodeURIComponent(params.searchQuery)}`)
  if (params.location) parts.push(`location=${encodeURIComponent(params.location)}`)
  if (params.remote) parts.push('remote=true')
  return parts.length > 0 ? `${base}?${parts.join('&')}` : base
}

export async function fetchWellfoundJobs(params: FetchWellfoundParams = {}): Promise<NormalizedJob[]> {
  const apiKey = process.env.WELLFOUND_API_KEY
  if (!apiKey) throw new Error('WELLFOUND_API_KEY not configured')

  const startUrl = buildWellfoundSearchUrl(params)

  const input: Record<string, unknown> = {
    startUrls: [{ url: startUrl }],
    maxResults: params.maxResults ?? 50,
  }

  const url = `${APIFY_BASE}/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${apiKey}&timeout=180`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Apify API error ${res.status}: ${text.slice(0, 200)}`)
  }

  const raw = await res.json() as WellfoundJob[]

  return raw
    .map(normalizeJob)
    .filter((j): j is NormalizedJob => j !== null)
}
