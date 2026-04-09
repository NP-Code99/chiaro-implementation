/**
 * Simple in-memory job queue. Processes one application at a time
 * with a 2-second delay between jobs to avoid rate-limiting.
 * State is not persisted across server restarts (upgrade to Redis for production).
 */

import { prisma } from '@/lib/db'
import { applyToJob } from '@/lib/applyEngine'
import { ApplicationStatus } from '@prisma/client'
import type { UserProfile } from './userProfile'
import type { BrowserApplyResult } from './browserApply'

const DELAY_MS = 2000
const queue: string[] = []
const queued = new Set<string>()   // dedup guard
let running = false

async function processNext(): Promise<void> {
  if (running || queue.length === 0) return
  running = true

  const id = queue.shift()!
  queued.delete(id)

  let updateError: Error | null = null

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
          errorMessage: 'Profile missing — please complete your profile and retry.',
        },
      })
      return
    }

    await prisma.application.update({ where: { id }, data: { status: ApplicationStatus.APPLYING } })

    const result = await applyToJob(application.job, profile, id) as BrowserApplyResult

    const nextStatus =
      result.status === 'applied'
        ? ApplicationStatus.APPLIED
        : result.pendingQuestions && result.pendingQuestions.length > 0
        ? ApplicationStatus.NEEDS_INFO   // already written by browserApply, just align here
        : result.status === 'needs_review'
        ? ApplicationStatus.NEEDS_REVIEW
        : ApplicationStatus.FAILED

    await prisma.application.update({
      where: { id },
      data: {
        status: nextStatus,
        errorMessage: result.errorMessage ?? null,
        appliedAt: result.status === 'applied' ? new Date() : null,
      },
    })

    // Persist fillability blocker to the Job so the card deck can show a warning badge
    if (result.status === 'needs_review' && result.blockerFields && result.blockerFields.length > 0) {
      await prisma.job.update({
        where: { id: application.jobId },
        data: { manualReviewReason: result.blockerFields.join(', ') },
      })
    }
  } catch (err) {
    updateError = err instanceof Error ? err : new Error(String(err))
    try {
      await prisma.application.update({
        where: { id },
        data: {
          status: ApplicationStatus.FAILED,
          errorMessage: updateError.message,
        },
      })
    } catch (dbErr) {
      console.error('[Queue] Failed to write error status to DB:', dbErr)
    }
  } finally {
    // Set running = false only after all DB work is done
    running = false
    if (queue.length > 0) {
      setTimeout(() => void processNext(), DELAY_MS)
    }
  }
}

export function enqueue(applicationId: string): void {
  if (queued.has(applicationId)) return   // already queued — skip duplicate
  queued.add(applicationId)
  queue.push(applicationId)
  if (!running) void processNext()
}

export function queueLength(): number {
  return queue.length
}
