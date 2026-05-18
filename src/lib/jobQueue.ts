/**
 * Job queue — calls the TypeScript apply engine directly.
 * Routing: Greenhouse/Lever → direct API; startup.jobs → Steel.dev; others → CloakBrowser.
 * CapSolver handles captchas; Scrapfly handles reconnaissance and DataDome bypass.
 */

import { prisma } from '@/lib/db'
import { ApplicationStatus } from '@/lib/prismaEnums'
import type { UserProfile } from './userProfile'
import { applyToJob } from './applyEngine'

const DELAY_MS = 2000

const queue: string[] = []
const queued = new Set<string>()
let running = false


// ── Queue processor ───────────────────────────────────────────────────────────

async function processNext(): Promise<void> {
  if (running || queue.length === 0) return
  running = true

  const id = queue.shift()!
  queued.delete(id)

  try {
    const application = await prisma.application.findUnique({
      where: { id },
      include: { job: true },
    })
    if (!application) return

    const profile = application.profileSnapshot
      ? (JSON.parse(application.profileSnapshot) as UserProfile)
      : null

    if (!profile) {
      await prisma.application.update({
        where: { id },
        data: {
          status: ApplicationStatus.FAILED,
          errorMessage: 'Profile missing — complete your profile and retry.',
        },
      })
      return
    }

    await prisma.application.update({ where: { id }, data: { status: ApplicationStatus.APPLYING } })

    const result = await applyToJob(application.job, profile, id)

    console.log(`[Queue] app=${id} status=${result.status}`)

    // browserApply may have already written NEEDS_INFO to the DB — don't overwrite it
    const current = await prisma.application.findUnique({ where: { id }, select: { status: true } })
    if (current?.status === ApplicationStatus.NEEDS_INFO) return

    const nextStatus =
      result.status === 'applied'      ? ApplicationStatus.APPLIED
      : result.status === 'needs_review' ? ApplicationStatus.NEEDS_REVIEW
      : ApplicationStatus.FAILED

    await prisma.application.update({
      where: { id },
      data: {
        status: nextStatus,
        errorMessage: result.errorMessage ?? null,
        appliedAt: result.status === 'applied' ? new Date() : null,
      },
    })

    if (result.blockerFields && result.blockerFields.length > 0) {
      await prisma.job.update({
        where: { id: application.jobId },
        data: { manualReviewReason: result.blockerFields.join(', ') },
      })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try {
      await prisma.application.update({
        where: { id },
        data: { status: ApplicationStatus.FAILED, errorMessage: msg },
      })
    } catch (dbErr) {
      console.error('[Queue] DB write failed:', dbErr)
    }
  } finally {
    running = false
    if (queue.length > 0) {
      setTimeout(() => void processNext(), DELAY_MS)
    }
  }
}

export function enqueue(applicationId: string): void {
  if (queued.has(applicationId)) return
  queued.add(applicationId)
  queue.push(applicationId)
  if (!running) void processNext()
}

export function queueLength(): number {
  return queue.length
}
