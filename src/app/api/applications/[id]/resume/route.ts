import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { ApplicationStatus } from '@prisma/client'
import { browserApply } from '@/lib/browserApply'
import type { UserProfile } from '@/lib/userProfile'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json() as { answers: Record<string, string>; resumeBase64?: string }
    const { answers, resumeBase64 } = body

    if (!answers || typeof answers !== 'object') {
      return NextResponse.json({ error: 'answers object required' }, { status: 400 })
    }

    // Load the application
    const application = await prisma.application.findUnique({
      where: { id: params.id },
      include: { job: true },
    })
    if (!application) {
      return NextResponse.json({ error: 'Application not found' }, { status: 404 })
    }
    if (application.status !== ApplicationStatus.NEEDS_INFO) {
      return NextResponse.json({ error: 'Application is not paused' }, { status: 400 })
    }

    // Load the paused record to get the original apply URL
    const paused = await prisma.pausedApplication.findUnique({
      where: { applicationId: params.id },
    })
    if (!paused) {
      return NextResponse.json({ error: 'No paused state found' }, { status: 404 })
    }

    // Reconstruct the profile from the snapshot
    if (!application.profileSnapshot) {
      return NextResponse.json({ error: 'Profile snapshot missing' }, { status: 400 })
    }
    const profile = JSON.parse(application.profileSnapshot) as UserProfile
    // Merge resume bytes from client — stripped from snapshot at creation time
    if (resumeBase64) profile.resumeBase64 = resumeBase64

    // Mark as applying again
    await prisma.application.update({
      where: { id: params.id },
      data: { status: ApplicationStatus.APPLYING, errorMessage: null },
    })

    // Re-run the full apply flow with user-provided answers merged in
    // We re-start from the original apply URL rather than relying on stale session cookies
    const applyUrl = application.job.applyUrl ?? paused.pageUrl
    const result = await browserApply(applyUrl, profile, params.id, answers)

    // Map result to DB status
    const nextStatus =
      result.status === 'applied'
        ? ApplicationStatus.APPLIED
        : result.pendingQuestions && result.pendingQuestions.length > 0
        ? ApplicationStatus.NEEDS_INFO
        : result.status === 'needs_review'
        ? ApplicationStatus.NEEDS_REVIEW
        : ApplicationStatus.FAILED

    await prisma.application.update({
      where: { id: params.id },
      data: {
        status: nextStatus,
        errorMessage: result.errorMessage ?? null,
        appliedAt: result.status === 'applied' ? new Date() : null,
      },
    })

    // Clean up paused record if successfully applied
    if (nextStatus === ApplicationStatus.APPLIED) {
      await prisma.pausedApplication.delete({ where: { applicationId: params.id } }).catch(() => {})
    }

    return NextResponse.json({ status: nextStatus, errorMessage: result.errorMessage ?? null })
  } catch (err) {
    console.error('[POST /api/applications/[id]/resume]', err)

    // Try to mark as failed in DB
    try {
      await prisma.application.update({
        where: { id: params.id },
        data: {
          status: ApplicationStatus.FAILED,
          errorMessage: err instanceof Error ? err.message : 'Unknown error',
        },
      })
    } catch { /* ignore */ }

    return NextResponse.json({ error: 'Failed to resume application' }, { status: 500 })
  }
}
