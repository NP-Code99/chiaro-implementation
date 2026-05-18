import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { ApplicationStatus } from '@/lib/prismaEnums'
import type { UserProfile } from '@/lib/userProfile'

const APPLYPILOT_URL = process.env.APPLYPILOT_URL ?? 'http://localhost:8765'

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

    const application = await prisma.application.findUnique({
      where: { id: params.id },
      include: { job: true },
    })
    if (!application) return NextResponse.json({ error: 'Application not found' }, { status: 404 })
    if (application.status !== ApplicationStatus.NEEDS_INFO) {
      return NextResponse.json({ error: 'Application is not paused' }, { status: 400 })
    }

    if (!application.profileSnapshot) {
      return NextResponse.json({ error: 'Profile snapshot missing' }, { status: 400 })
    }

    const profile = JSON.parse(application.profileSnapshot) as UserProfile
    if (resumeBase64) profile.resumeBase64 = resumeBase64
    // Merge user-provided answers into profile so the filler can use them
    if (Object.keys(answers).length > 0) {
      profile.pendingAnswers = answers
    }

    await prisma.application.update({
      where: { id: params.id },
      data: { status: ApplicationStatus.APPLYING, errorMessage: null },
    })

    const applyUrl = application.job.applyUrl ?? ''
    let nextStatus: ApplicationStatus = ApplicationStatus.FAILED
    let errorMessage: string | null = null

    try {
      const res = await fetch(`${APPLYPILOT_URL}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicationId: params.id,
          dryRun: false,
          job: {
            id: application.job.id,
            applyUrl,
            title: application.job.role,
            company: application.job.company,
            location: application.job.location ?? '',
            description: application.job.description ?? '',
          },
          profile,
        }),
      })

      if (res.ok) {
        const result = await res.json() as { status: string; errorMessage?: string; pendingQuestions?: string[]; blockerFields?: string[] }
        nextStatus =
          result.status === 'applied'                      ? ApplicationStatus.APPLIED
          : (result.pendingQuestions?.length ?? 0) > 0     ? ApplicationStatus.NEEDS_INFO
          : result.status === 'needs_review'               ? ApplicationStatus.NEEDS_REVIEW
          : ApplicationStatus.FAILED
        errorMessage = result.errorMessage ?? null
      } else {
        errorMessage = `ApplyPilot HTTP ${res.status}`
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    }

    await prisma.application.update({
      where: { id: params.id },
      data: {
        status: nextStatus,
        errorMessage,
        appliedAt: nextStatus === ApplicationStatus.APPLIED ? new Date() : null,
      },
    })

    if (nextStatus === ApplicationStatus.APPLIED) {
      await prisma.pausedApplication.delete({ where: { applicationId: params.id } }).catch(() => {})
    }

    return NextResponse.json({ status: nextStatus, errorMessage })
  } catch (err) {
    console.error('[POST /api/applications/[id]/resume]', err)
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
