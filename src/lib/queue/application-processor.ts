import { execFile } from 'child_process'
import path from 'path'
import { prisma } from '@/lib/db'
import { ApplicationStatus } from '@/lib/prismaEnums'

const CONCURRENCY = 2
let processing = 0
let isRunning = false

// ── Paths ─────────────────────────────────────────────────────────────────────
const PROJECT_ROOT      = process.cwd()
const ORCHESTRATOR      = path.resolve(PROJECT_ROOT, 'job-applications/autofill_orchestrator.py')
const VENV_PYTHON       = path.resolve(PROJECT_ROOT, 'applypilot/.venv/bin/python3')
const PYTHON            = process.env.PYTHON_BIN ?? VENV_PYTHON

// ── Resume path resolution ────────────────────────────────────────────────────
// Priority: env var → user.resumePath stored in DB → well-known local files
function resolveResumePath(dbPath: string | null | undefined): string {
  if (process.env.APPLY_RESUME_PATH) return process.env.APPLY_RESUME_PATH
  if (dbPath) return dbPath
  const home = process.env.HOME ?? '/Users/nandanpullakandam'
  return path.join(home, 'Nandan_Pullakandam_Resume.pdf')
}

// ── Universal Scrapfly apply ──────────────────────────────────────────────────

interface ScrapflyResult {
  success: boolean
  error?: string
}

function applyWithOrchestrator(
  applyUrl: string,
  user: { name: string | null; email: string; phone: string | null; linkedinUrl: string | null; githubUrl: string | null; resumePath: string | null },
  profileSnapshot: string | null,
): Promise<ScrapflyResult> {
  if (!applyUrl) return Promise.resolve({ success: false, error: 'No apply URL' })

  const nameParts = (user.name ?? '').trim().split(' ')
  const firstName = nameParts[0] ?? ''
  const lastName  = nameParts.slice(1).join(' ') || ''

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SCRAPFLY_API_KEY:      process.env.SCRAPFLY_API_KEY ?? 'scp-live-443c714b108e4137bca2e6b561978171',
    RESIDENTIAL_PROXY_URL: process.env.RESIDENTIAL_PROXY_URL ?? 'http://djssmwzl:1ynfeqshcsup@p.webshare.io:80',
    ANTHROPIC_API_KEY:     process.env.ANTHROPIC_API_KEY ?? '',
    CAPSOLVER_API_KEY:     process.env.CAPSOLVER_API_KEY ?? 'CAP-3B64A18B30B50A0278278C10BD9E97D6FAD840D982632D2A061F4E121A6B7083',
    // Basic fields (fallback when profile JSON is unavailable)
    APPLY_FIRST_NAME:      firstName,
    APPLY_LAST_NAME:       lastName,
    APPLY_EMAIL:           user.email,
    APPLY_PHONE:           user.phone ?? '',
    APPLY_LINKEDIN:        user.linkedinUrl ?? '',
    APPLY_RESUME_PATH:     resolveResumePath(user.resumePath),
    // Full profile JSON — richer data for ATS-specific scripts
    APPLY_PROFILE_JSON:    profileSnapshot ?? '',
  }

  console.log(`[Orchestrator] Launching → ${applyUrl}`)
  console.log(`[Orchestrator] Python: ${PYTHON}  Script: ${ORCHESTRATOR}`)

  return new Promise((resolve) => {
    execFile(
      PYTHON,
      [ORCHESTRATOR, '--url', applyUrl, '--submit'],
      { env, timeout: 360_000, cwd: path.dirname(ORCHESTRATOR) },
      (err, stdout, stderr) => {
        const out = stdout + stderr
        console.log(`[Orchestrator] Output:\n${out.slice(-4000)}`)

        // Only trust the explicit sentinel — any ✅ or "submitted" in intermediate
        // logs does NOT mean the application was actually submitted.
        const confirmed    = out.includes('APPLICATION SUBMITTED')
        const needsReview  = out.includes('MANUAL REVIEW REQUIRED')
        const needsInfo    = out.includes('NEEDS_INFO:') || out.includes('FORM_FILLED_NO_SUBMIT')
        const hardFailed   = out.includes('APPLICATION FAILED') || (err !== null && !confirmed && !needsReview && !needsInfo)

        if (confirmed) {
          resolve({ success: true })
        } else if (needsReview) {
          resolve({ success: false, error: 'NEEDS_REVIEW' })
        } else if (needsInfo || (!hardFailed && out.length > 100)) {
          // Form likely filled but submit wasn't confirmed — needs human check
          resolve({ success: false, error: 'NEEDS_INFO' })
        } else {
          const errLine = (
            out.split('\n').find(l =>
              l.includes('APPLICATION FAILED') ||
              l.includes('❌') ||
              l.includes('spam')
            ) ?? ''
          )
          resolve({
            success: false,
            error: errLine.slice(0, 300) || err?.message || 'Orchestrator did not confirm submission',
          })
        }
      },
    )
  })
}

// ── Application processor ─────────────────────────────────────────────────────

async function processApplication(applicationId: string): Promise<void> {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    include: { job: true, user: true },
  })

  if (!application || application.status !== ApplicationStatus.PENDING) return

  await prisma.application.update({
    where: { id: applicationId },
    data: { status: ApplicationStatus.APPLYING },
  })

  const { user, job } = application
  if (!user?.email) {
    await prisma.application.update({
      where: { id: applicationId },
      data: {
        status: ApplicationStatus.FAILED,
        errorMessage: 'User profile incomplete — please fill in your profile.',
      },
    })
    return
  }

  const applyUrl = job.applyUrl ?? ''
  let result: ScrapflyResult

  try {
    result = await applyWithOrchestrator(
      applyUrl,
      {
        name:        user.name,
        email:       user.email,
        phone:       user.phone ?? null,
        linkedinUrl: user.linkedinUrl ?? null,
        githubUrl:   user.githubUrl ?? null,
        resumePath:  user.resumePath ?? null,
      },
      (application as { profileSnapshot?: string | null }).profileSnapshot ?? null,
    )
  } catch (err) {
    result = {
      success: false,
      error: err instanceof Error ? err.message : 'Unexpected error',
    }
  }

  let finalStatus: string = ApplicationStatus.FAILED
  if (result.success) {
    finalStatus = ApplicationStatus.APPLIED
  } else if (result.error === 'NEEDS_REVIEW') {
    finalStatus = ApplicationStatus.NEEDS_REVIEW
  } else if (result.error === 'NEEDS_INFO') {
    finalStatus = ApplicationStatus.NEEDS_INFO
  }

  await prisma.application.update({
    where: { id: applicationId },
    data: {
      status:       finalStatus,
      errorMessage: (result.error && result.error !== 'NEEDS_REVIEW' && result.error !== 'NEEDS_INFO')
                      ? result.error
                      : null,
      appliedAt:    result.success ? new Date() : null,
    },
  })
}

export async function enqueueApplication(applicationId: string): Promise<void> {
  // Fire-and-forget processing (respects concurrency limit)
  void processNext(applicationId)
}

async function processNext(applicationId: string): Promise<void> {
  if (processing >= CONCURRENCY) {
    // Re-enqueue with delay
    setTimeout(() => void processNext(applicationId), 5000)
    return
  }

  processing++
  try {
    await processApplication(applicationId)
  } finally {
    processing--
  }
}

/**
 * On server start, re-enqueue any applications that were interrupted mid-processing.
 * Call this once from a startup route or server action.
 */
export async function recoverInterruptedApplications(): Promise<void> {
  if (isRunning) return
  isRunning = true

  try {
    const interrupted = await prisma.application.findMany({
      where: { status: ApplicationStatus.APPLYING },
    })

    for (const app of interrupted) {
      // Reset to PENDING so the processor picks them up fresh
      await prisma.application.update({
        where: { id: app.id },
        data: { status: ApplicationStatus.PENDING },
      })
      void enqueueApplication(app.id)
    }
  } catch (err) {
    console.error('[Queue] Recovery failed:', err)
  }
}
