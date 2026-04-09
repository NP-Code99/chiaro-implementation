import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { enqueue } from '@/lib/jobQueue'
import { ApplicationStatus } from '@prisma/client'

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const application = await prisma.application.findUnique({
      where: { id: params.id },
      include: { job: true },
    })
    if (!application) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ application })
  } catch (err) {
    console.error('[GET /api/applications/[id]]', err)
    return NextResponse.json({ error: 'Failed to fetch' }, { status: 500 })
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await req.json() as { action?: string }
    const { action } = body

    const application = await prisma.application.findUnique({ where: { id: params.id } })
    if (!application) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    if (action === 'retry') {
      if (application.status !== ApplicationStatus.FAILED && application.status !== ApplicationStatus.NEEDS_REVIEW) {
        return NextResponse.json({ error: 'Only failed or needs_review applications can be retried' }, { status: 400 })
      }
      const updated = await prisma.application.update({
        where: { id: params.id },
        data: { status: ApplicationStatus.PENDING, errorMessage: null },
      })
      enqueue(params.id)
      return NextResponse.json({ application: updated })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    console.error('[PATCH /api/applications/[id]]', err)
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 })
  }
}
