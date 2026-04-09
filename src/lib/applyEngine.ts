import type { Job } from '@prisma/client'
import type { UserProfile } from './userProfile'
import { browserApply } from './browserApply'

export type ApplicationStatus = 'applied' | 'failed' | 'needs_review'

export interface ApplicationResult {
  status: ApplicationStatus
  errorMessage?: string
  applyUrl?: string
  screenshotUrl?: string
  blockerFields?: string[]
}

// ── URL parsers ──────────────────────────────────────────────────────────────

function parseGreenhouseUrl(url: string): { companySlug: string; jobId: string } | null {
  const m = url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/)
  if (!m) return null
  return { companySlug: m[1], jobId: m[2] }
}

function parseLeverUrl(url: string): { company: string; postingId: string } | null {
  const m = url.match(/lever\.co\/([^/]+)\/([a-f0-9-]{36})/)
  if (!m) return null
  return { company: m[1], postingId: m[2] }
}

function base64ToBlob(dataUrl: string, filename: string): Blob | null {
  try {
    const [, b64] = dataUrl.split(',')
    if (!b64) return null
    // Use Buffer on Node.js (server-side); fall back to atob in browser
    const bytes =
      typeof Buffer !== 'undefined'
        ? Buffer.from(b64, 'base64')
        : Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    return new Blob([bytes], { type: 'application/pdf' })
  } catch {
    return null
  }
}

// ── Submitters ───────────────────────────────────────────────────────────────

async function applyGreenhouse(job: Job, profile: UserProfile): Promise<ApplicationResult> {
  const parsed = parseGreenhouseUrl(job.applyUrl ?? '')
  if (!parsed) return { status: 'failed', errorMessage: 'Could not parse Greenhouse URL', applyUrl: job.applyUrl ?? undefined }

  const { companySlug, jobId } = parsed
  const endpoint = `https://boards-api.greenhouse.io/v1/boards/${companySlug}/jobs/${jobId}`

  try {
    const fd = new FormData()
    fd.append('first_name', profile.firstName)
    fd.append('last_name', profile.lastName)
    fd.append('email', profile.email)
    if (profile.phone) fd.append('phone', profile.phone)
    if (profile.linkedin) fd.append('question_linkedin_profile_url', profile.linkedin)
    if (profile.resumeBase64) {
      const blob = base64ToBlob(profile.resumeBase64, profile.resumeFilename || 'resume.pdf')
      if (blob) fd.append('resume', blob, profile.resumeFilename || 'resume.pdf')
    }

    const res = await fetch(endpoint, { method: 'POST', body: fd })
    if (res.ok) return { status: 'applied', applyUrl: job.applyUrl ?? undefined }
    const errText = await res.text()
    return { status: 'failed', errorMessage: `Greenhouse ${res.status}: ${errText.slice(0, 200)}`, applyUrl: job.applyUrl ?? undefined }
  } catch (err) {
    return { status: 'failed', errorMessage: err instanceof Error ? err.message : 'Unknown error', applyUrl: job.applyUrl ?? undefined }
  }
}

async function applyLever(job: Job, profile: UserProfile): Promise<ApplicationResult> {
  const parsed = parseLeverUrl(job.applyUrl ?? '')
  if (!parsed) return { status: 'failed', errorMessage: 'Could not parse Lever URL', applyUrl: job.applyUrl ?? undefined }

  const { company, postingId } = parsed
  const endpoint = `https://jobs.lever.co/${company}/apply/${postingId}`

  try {
    const fd = new FormData()
    fd.append('name', `${profile.firstName} ${profile.lastName}`.trim())
    fd.append('email', profile.email)
    if (profile.phone) fd.append('phone', profile.phone)
    if (profile.linkedin) fd.append('org', profile.linkedin)
    if (profile.resumeBase64) {
      const blob = base64ToBlob(profile.resumeBase64, profile.resumeFilename || 'resume.pdf')
      if (blob) fd.append('resume', blob, profile.resumeFilename || 'resume.pdf')
    }

    const res = await fetch(endpoint, { method: 'POST', body: fd })
    if (res.ok) return { status: 'applied', applyUrl: job.applyUrl ?? undefined }
    const errText = await res.text()
    return { status: 'failed', errorMessage: `Lever ${res.status}: ${errText.slice(0, 200)}`, applyUrl: job.applyUrl ?? undefined }
  } catch (err) {
    return { status: 'failed', errorMessage: err instanceof Error ? err.message : 'Unknown error', applyUrl: job.applyUrl ?? undefined }
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function applyToJob(job: Job, profile: UserProfile, applicationId: string): Promise<ApplicationResult> {
  if (!job.applyUrl) {
    return {
      status: 'needs_review',
      errorMessage: 'No apply link — consider emailing the founder directly',
    }
  }

  switch (job.atsType) {
    case 'GREENHOUSE':
      return applyGreenhouse(job, profile)
    case 'LEVER':
      return applyLever(job, profile)
    case 'WORKDAY':
    case 'CUSTOM':
    default:
      return browserApply(job.applyUrl, profile, applicationId)
  }
}
