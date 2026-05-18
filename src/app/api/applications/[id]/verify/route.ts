import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { ApplicationStatus } from '@/lib/prismaEnums'

/**
 * PATCH /api/applications/[id]/verify
 *
 * Accepts a user-supplied 2FA / verification code and writes it to the Application
 * row. The background apply process polls this field every 5 seconds — once it sees
 * a non-null value it submits the code to the provider and continues.
 *
 * Body: { verificationCode: string }
 * Returns: { success: true } or an error response.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json() as { verificationCode?: string }
    const { verificationCode } = body

    if (!verificationCode || typeof verificationCode !== 'string') {
      return NextResponse.json(
        { error: 'verificationCode is required and must be a string' },
        { status: 400 }
      )
    }

    const code = verificationCode.trim()
    if (code.length < 4 || code.length > 10) {
      return NextResponse.json(
        { error: 'verificationCode must be between 4 and 10 characters' },
        { status: 400 }
      )
    }

    const application = await prisma.application.findUnique({
      where: { id: params.id },
      select: { id: true, status: true, verificationExpiry: true },
    })

    if (!application) {
      return NextResponse.json({ error: 'Application not found' }, { status: 404 })
    }

    if (application.status !== ApplicationStatus.VERIFICATION_PENDING) {
      return NextResponse.json(
        { error: 'Application is not waiting for verification' },
        { status: 409 }
      )
    }

    // Check if the verification window has expired
    if (application.verificationExpiry && new Date() > application.verificationExpiry) {
      return NextResponse.json(
        { error: 'Verification window has expired. Please retry the application.' },
        { status: 410 }
      )
    }

    await prisma.application.update({
      where: { id: params.id },
      data: { verificationCode: code },
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[PATCH /api/applications/[id]/verify]', err)
    return NextResponse.json({ error: 'Failed to submit verification code' }, { status: 500 })
  }
}
