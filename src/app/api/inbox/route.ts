import { NextRequest, NextResponse } from 'next/server'
import { fetchEmails, isGmailConfigured, type EmailCategory } from '@/lib/gmail'

const VALID_CATEGORIES: EmailCategory[] = ['primary', 'verification', 'interview', 'offer', 'rejection']

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const rawCategory = searchParams.get('category') ?? 'primary'
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10))
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') ?? '20', 10)))

  const category: EmailCategory = VALID_CATEGORIES.includes(rawCategory as EmailCategory)
    ? (rawCategory as EmailCategory)
    : 'primary'

  if (!isGmailConfigured()) {
    return NextResponse.json({ emails: [], configured: false }, { status: 200 })
  }

  const emails = await fetchEmails(category, page, limit)
  return NextResponse.json({ emails, configured: true }, { status: 200 })
}
