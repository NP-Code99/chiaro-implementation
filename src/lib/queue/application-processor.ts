import { prisma } from '@/lib/db'
import { classifyAts } from '@/lib/ats/classifier'
import { submitToGreenhouse } from '@/lib/ats/greenhouse'
import { submitToLever } from '@/lib/ats/lever'
import { submitWithPlaywright } from '@/lib/automation/playwright-apply'
import { AtsType, ApplicationStatus } from '@prisma/client'
import type { ApplicantData } from '@/lib/ats/types'

const CONCURRENCY = 2
let processing = 0
let isRunning = false

async function getApplicantData(userId: string): Promise<ApplicantData | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user || !user.email) return null
  return {
    name: user.name,
    email: user.email,
    phone: user.phone ?? undefined,
    linkedinUrl: user.linkedinUrl ?? undefined,
    githubUrl: user.githubUrl ?? undefined,
    location: user.location ?? undefined,
    resumePath: user.resumePath ?? undefined,
  }
}

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

  const applicant = await getApplicantData(application.userId)
  if (!applicant) {
    await prisma.application.update({
      where: { id: applicationId },
      data: {
        status: ApplicationStatus.FAILED,
        errorMessage: 'User profile incomplete. Please fill in your profile.',
      },
    })
    return
  }

  const atsType = classifyAts(application.job.applyUrl)

  let result
  try {
    switch (atsType) {
      case AtsType.GREENHOUSE:
        result = await submitToGreenhouse(application.job.applyUrl, applicant)
        break
      case AtsType.LEVER:
        result = await submitToLever(application.job.applyUrl, applicant)
        break
      case AtsType.WORKDAY:
      case AtsType.CUSTOM:
        result = await submitWithPlaywright(application.job.applyUrl, applicant)
        break
      default:
        result = { success: false, error: 'Unknown ATS type' }
    }
  } catch (err) {
    result = {
      success: false,
      error: err instanceof Error ? err.message : 'Unexpected error during submission',
    }
  }

  const needsReview = result.error?.includes('manual review') ?? false

  await prisma.application.update({
    where: { id: applicationId },
    data: {
      status: result.success
        ? ApplicationStatus.APPLIED
        : needsReview
        ? ApplicationStatus.NEEDS_REVIEW
        : ApplicationStatus.FAILED,
      errorMessage: result.error ?? null,
      appliedAt: result.success ? new Date() : null,
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
