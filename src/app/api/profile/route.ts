import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

export async function GET() {
  try {
    const user = await prisma.user.findFirst()
    if (!user) {
      return NextResponse.json({ user: null })
    }
    return NextResponse.json({ user })
  } catch (err) {
    console.error('[GET /api/profile]', err)
    return NextResponse.json({ error: 'Failed to load profile' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const { name, email, phone, linkedinUrl, githubUrl, location } = body

    if (!name || !email) {
      return NextResponse.json({ error: 'Name and email are required' }, { status: 400 })
    }

    let user = await prisma.user.findFirst()
    if (!user) {
      user = await prisma.user.create({
        data: { name, email, phone, linkedinUrl, githubUrl, location },
      })
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { name, email, phone, linkedinUrl, githubUrl, location },
      })
    }

    return NextResponse.json({ user })
  } catch (err) {
    console.error('[PUT /api/profile]', err)
    return NextResponse.json({ error: 'Failed to save profile' }, { status: 500 })
  }
}
