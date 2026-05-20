import { execFile } from 'child_process'
import path from 'path'
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

// ── Autofill orchestrator (routes to ATS-specific filler) ─────────────────────

const ORCHESTRATOR = path.resolve(process.cwd(), 'job-applications/autofill_orchestrator.py')
const VENV_PYTHON  = path.resolve(process.cwd(), 'applypilot/.venv/bin/python3')
const PYTHON       = process.env.PYTHON_BIN ?? VENV_PYTHON

function resolveResumePath(_profile: UserProfile): string {
  if (process.env.APPLY_RESUME_PATH) return process.env.APPLY_RESUME_PATH
  const home = process.env.HOME ?? '/Users/nandanpullakandam'
  // Check public/uploads first (uploaded via UI), then home directory fallback
  const uploadedPath = path.join(process.cwd(), 'public', 'uploads', 'resume-nandan-pullakandam.pdf')
  const fs = require('fs') as typeof import('fs')
  if (fs.existsSync(uploadedPath)) return uploadedPath
  return path.join(home, 'Nandan_Pullakandam_Resume.pdf')
}

function applyWithScrapfly(job: Job, profile: UserProfile): Promise<ApplicationResult> {
  const applyUrl = job.applyUrl ?? ''
  if (!applyUrl) return Promise.resolve({ status: 'failed', errorMessage: 'No apply URL', applyUrl: '' })

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SCRAPFLY_API_KEY:      process.env.SCRAPFLY_API_KEY ?? 'scp-live-443c714b108e4137bca2e6b561978171',
    RESIDENTIAL_PROXY_URL: process.env.RESIDENTIAL_PROXY_URL ?? 'http://djssmwzl:1ynfeqshcsup@p.webshare.io:80',
    ANTHROPIC_API_KEY:     process.env.ANTHROPIC_API_KEY ?? '',
    CAPSOLVER_API_KEY:     process.env.CAPSOLVER_API_KEY ?? 'CAP-3B64A18B30B50A0278278C10BD9E97D6FAD840D982632D2A061F4E121A6B7083',
    APPLY_FIRST_NAME:      profile.firstName,
    APPLY_LAST_NAME:       profile.lastName,
    APPLY_EMAIL:           profile.email,
    APPLY_PHONE:           profile.phone ?? '',
    APPLY_LINKEDIN:        profile.linkedin ?? '',
    APPLY_RESUME_PATH:     resolveResumePath(profile),
    APPLY_PROFILE_JSON:    JSON.stringify(profile),
  }

  console.log(`[Orchestrator] → ${applyUrl}`)

  return new Promise((resolve) => {
    execFile(
      PYTHON,
      [ORCHESTRATOR, '--url', applyUrl, '--submit'],
      { env, timeout: 360_000, cwd: path.dirname(ORCHESTRATOR) },
      (_err, stdout, stderr) => {
        const out = stdout + stderr
        console.log(`[Orchestrator] Output:\n${out.slice(-4000)}`)

        // Only the explicit sentinel counts — intermediate ✅ logs do NOT mean submitted.
        const confirmed   = out.includes('APPLICATION SUBMITTED')
        const needsReview = out.includes('MANUAL REVIEW REQUIRED')
        const needsInfo   = out.includes('NEEDS_INFO:') || out.includes('FORM_FILLED_NO_SUBMIT')
        const hardFailed  = out.includes('APPLICATION FAILED') || (_err !== null && !confirmed && !needsReview && !needsInfo)

        if (confirmed) {
          resolve({ status: 'applied', applyUrl })
        } else if (needsReview) {
          resolve({ status: 'needs_review', applyUrl })
        } else if (needsInfo || (!hardFailed && out.length > 100)) {
          resolve({ status: 'needs_review', errorMessage: 'Form filled but submission unconfirmed — needs manual review', applyUrl })
        } else {
          const errLine = out.split('\n').find(l =>
            l.includes('APPLICATION FAILED') || l.includes('❌') || l.includes('spam')
          ) ?? ''
          resolve({
            status: 'failed',
            errorMessage: errLine.slice(0, 300) || 'Orchestrator did not confirm submission',
            applyUrl,
          })
        }
      },
    )
  })
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function applyToJob(job: Job, profile: UserProfile, applicationId: string): Promise<ApplicationResult> {
  if (!job.applyUrl) {
    return {
      status: 'needs_review',
      errorMessage: 'No apply link — consider emailing the founder directly',
    }
  }

  // Greenhouse applications always go through CloakBrowser (browserApply).
  // This covers both direct greenhouse.io URLs and startup.jobs URLs that
  // resolve to Greenhouse ATS internally.
  const isGreenhouse = job.applyUrl.includes('greenhouse.io') || job.applyUrl.includes('startup.jobs/apply/')
  if (isGreenhouse) {
    return browserApply(job.applyUrl, profile, applicationId)
  }

  return applyWithScrapfly(job, profile)
}
