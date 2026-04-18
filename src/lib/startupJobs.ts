import { AtsType } from '@/lib/prismaEnums'
import { classifyATS } from '@/lib/atsClassifier'

const ACTOR_ID = 'shahidirfan~Startup-Jobs-Scraper'
const APIFY_BASE = 'https://api.apify.com/v2'

// Raw response shape from Apify shahidirfan~Startup-Jobs-Scraper
// Field names verified against live API response 2026-04-18
export interface StartupJobsRaw {
  id: string
  title: string
  company: string
  location: string
  job_type: string | null
  salary: string | null
  posted_at: string
  description_text: string
  description_html: string
  company_logo: string | null
  apply_link: string
  url: string
  tags: string[]
  workplace_type: string | null
  employment_type: string | null
  salary_min: number | null
  salary_max: number | null
  salary_currency: string | null
  city: string | null
  country: string | null
  company_slug: string
}

export interface FetchStartupJobsParams {
  maxResults?: number
}

// Normalized shape matching the Prisma Job model (minus id/createdAt — DB-generated)
export interface NormalizedStartupJob {
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
  sourceUrl: string  // stable dedup key: the startup.jobs job page URL
  source: 'startup.jobs'
}

function toAtsType(raw: string): AtsType {
  switch (raw) {
    case 'greenhouse':          return AtsType.GREENHOUSE
    case 'lever':               return AtsType.LEVER
    case 'workday':             return AtsType.WORKDAY
    case 'ashby':               return AtsType.ASHBY
    case 'bamboohr':            return AtsType.BAMBOOHR
    case 'smartrecruiters':     return AtsType.SMARTRECRUITERS
    case 'jobvite':             return AtsType.JOBVITE
    case 'icims':               return AtsType.ICIMS
    case 'taleo':               return AtsType.TALEO
    case 'startup_jobs_native': return AtsType.STARTUP_JOBS_NATIVE
    default:                    return AtsType.CUSTOM
  }
}

function normalizeJob(raw: StartupJobsRaw): NormalizedStartupJob | null {
  if (!raw.apply_link || !raw.url) return null

  const atsRaw = classifyATS(raw.apply_link)
  const atsType = toAtsType(atsRaw)

  const location =
    raw.workplace_type === 'remote'
      ? 'Remote'
      : raw.location && raw.location !== 'Remote'
        ? raw.location
        : raw.country
          ? raw.country
          : 'Unknown'

  const tags: string[] = [
    ...(raw.tags ?? []),
    ...(raw.workplace_type === 'remote' ? ['Remote'] : []),
    ...(raw.employment_type ? [raw.employment_type] : []),
  ].slice(0, 8)

  return {
    company:     raw.company,
    role:        raw.title,
    description: raw.description_text,
    applyUrl:    raw.apply_link,
    atsType,
    location,
    salaryMin:   raw.salary_min,
    salaryMax:   raw.salary_max,
    tags,
    logoUrl:     raw.company_logo,
    sourceUrl:   raw.url,
    source:      'startup.jobs',
  }
}

export async function fetchStartupJobs(
  params: FetchStartupJobsParams = {}
): Promise<NormalizedStartupJob[]> {
  const apiKey = process.env.STARTUP_JOBS_API_KEY
  if (!apiKey) throw new Error('STARTUP_JOBS_API_KEY not configured')

  const input = { maxItems: params.maxResults ?? 50 }

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

  const raw = (await res.json()) as StartupJobsRaw[]

  return raw
    .map(normalizeJob)
    .filter((j): j is NormalizedStartupJob => j !== null)
}
