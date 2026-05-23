// Server-only Gmail inbox sync — pulls job-related emails into the InboxEmail
// table for the connected user, classifies them, and extracts verification codes.
import 'server-only'
import { google, gmail_v1 } from 'googleapis'
import { prisma } from '../db'
import { getRefreshedClient } from './oauthClient'

// ── Types ─────────────────────────────────────────────────────────────────────

export type EmailCategory =
  | 'verification_code'
  | 'interview'
  | 'offer'
  | 'rejection'
  | 'application_confirm'
  | 'other'

export interface SyncResult {
  newEmails: number
  verificationCodes: number
  interviews: number
  offers: number
  rejections: number
  confirmations: number
}

// ── Search queries (per category) ─────────────────────────────────────────────

const SEARCH_QUERIES: { category: Exclude<EmailCategory, 'other'>; q: string }[] = [
  {
    category: 'verification_code',
    q: 'subject:(verify OR verification OR confirm OR code) newer_than:7d',
  },
  {
    category: 'interview',
    q: 'subject:(interview OR "phone screen" OR "video call" OR "technical interview" OR "we would like to meet") newer_than:30d',
  },
  {
    category: 'offer',
    q: 'subject:("job offer" OR "offer letter" OR "excited to offer" OR "pleased to offer" OR "offer of employment") newer_than:30d',
  },
  {
    category: 'rejection',
    q: 'subject:("unfortunately" OR "not moving forward" OR "other candidates" OR "position has been filled" OR "we will not") newer_than:30d',
  },
  {
    category: 'application_confirm',
    q: 'subject:("application received" OR "thank you for applying" OR "we received your application" OR "application confirmation") newer_than:30d',
  },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function decodeBase64Url(str: string): string {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeBase64Url(payload.body.data)
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64Url(part.body.data)
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) return stripHtml(decodeBase64Url(part.body.data))
      if (part.parts) {
        const nested = extractBody(part)
        if (nested) return nested
      }
    }
  }
  if (payload.body?.data) {
    const text = decodeBase64Url(payload.body.data)
    return payload.mimeType?.includes('html') ? stripHtml(text) : text
  }
  return ''
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function parseFrom(raw: string): { name: string; email: string } {
  const m = raw.match(/^(.+?)\s*<([^>]+)>$/)
  if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() }
  return { name: raw.trim(), email: raw.trim() }
}

function classify(subject: string, body: string): EmailCategory {
  const s = subject.toLowerCase()
  const b = body.toLowerCase().slice(0, 4000)

  if (
    /verify|verification code|confirm your email|enter this code|one[\s-]?time code|security code/.test(s) ||
    /verify|verification code|confirm your email|enter this code|one[\s-]?time code|security code|your code is/.test(b)
  ) return 'verification_code'

  if (
    /unfortunately|not moving forward|other candidates|position has been filled|we will not|regret to inform|decided to move forward/.test(s) ||
    /unfortunately|not moving forward|other candidates|position has been filled|we will not|regret to inform|decided to move forward|won't be moving/.test(b)
  ) return 'rejection'

  if (
    /job offer|offer letter|excited to offer|pleased to offer|offer of employment/.test(s) ||
    /pleased to offer|excited to offer|extend an offer|formal offer|compensation package|start date/.test(b)
  ) return 'offer'

  if (
    /interview|phone screen|video call|technical interview|schedule a call|meet with/.test(s) ||
    /schedule a call|calendly|zoom\.us\/j\/|book a time|interview/.test(b)
  ) return 'interview'

  if (
    /application received|thank you for applying|we received your application|application confirmation/.test(s) ||
    /we have received your application|thanks for applying/.test(b)
  ) return 'application_confirm'

  return 'other'
}

// Verification code extraction waterfall.
const CODE_PATTERNS: RegExp[] = [
  /\b(\d{6})\b/,
  /\b(\d{4})\b/,
  /code[:\s]+([A-Z0-9]{6,10})/i,
  /token[:\s]+([A-Z0-9]{8,20})/i,
]

export function extractVerificationCode(body: string): string | null {
  for (const re of CODE_PATTERNS) {
    const m = body.match(re)
    if (m?.[1]) return m[1]
  }
  return null
}

function companyFromAddress(fromEmail: string, fromName: string): string | null {
  const domain = fromEmail.split('@')[1]?.toLowerCase()
  if (!domain) return null
  // Strip well-known ATS bounce subdomains
  const cleaned = domain
    .replace(/^.*?(no-?reply|notifications?|jobs?|careers?|hello|team|hr|talent|recruiting|do[_-]?not[_-]?reply)\./, '')
    .replace(/^(greenhouse-mail|us\.greenhouse|mail)\./, '')
  // Use the display name if present and not generic
  if (fromName && !/no[_-]?reply|notifications?/i.test(fromName)) {
    const part = fromName.split(/\s+(via|at|from|—|-)/i)[0].trim()
    if (part.length > 1) return part
  }
  // Otherwise derive from domain SLD
  const sld = cleaned.split('.').slice(-2, -1)[0]
  if (!sld) return null
  return sld.charAt(0).toUpperCase() + sld.slice(1)
}

async function findApplicationIdForCompany(userId: string, companyName: string | null): Promise<string | null> {
  if (!companyName) return null
  const app = await prisma.application.findFirst({
    where: {
      userId,
      job: { company: { contains: companyName } },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  return app?.id ?? null
}

// ── Main sync ─────────────────────────────────────────────────────────────────

export async function syncGmailInbox(userId: string): Promise<SyncResult> {
  const conn = await prisma.gmailConnection.findUnique({ where: { userId } })
  if (!conn || !conn.isActive) {
    throw new Error('[inboxSync] No active Gmail connection for user')
  }

  const oauthClient = await getRefreshedClient(userId)
  if (!oauthClient) throw new Error('[inboxSync] Failed to build OAuth client for user')

  const gmail = google.gmail({ version: 'v1', auth: oauthClient })

  const seenIds = new Set<string>()
  const messageIds: string[] = []

  for (const { q } of SEARCH_QUERIES) {
    try {
      const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 25 })
      for (const m of list.data.messages ?? []) {
        if (m.id && !seenIds.has(m.id)) {
          seenIds.add(m.id)
          messageIds.push(m.id)
        }
      }
    } catch (err) {
      console.warn('[inboxSync] Query failed:', q, err instanceof Error ? err.message : String(err))
    }
  }

  // Skip messages already stored
  const existing = await prisma.inboxEmail.findMany({
    where: { gmailMessageId: { in: messageIds } },
    select: { gmailMessageId: true },
  })
  const existingSet = new Set(existing.map(e => e.gmailMessageId))
  const newIds = messageIds.filter(id => !existingSet.has(id))

  const counts: SyncResult = {
    newEmails: 0,
    verificationCodes: 0,
    interviews: 0,
    offers: 0,
    rejections: 0,
    confirmations: 0,
  }

  for (const id of newIds) {
    try {
      const detail = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
      const headers = detail.data.payload?.headers ?? []
      const rawFrom = header(headers, 'from')
      const { name: fromName, email: fromEmail } = parseFrom(rawFrom)
      const subject = header(headers, 'subject') || '(no subject)'
      const dateStr = header(headers, 'date')
      const receivedAt = dateStr ? new Date(dateStr) : new Date()
      const body = extractBody(detail.data.payload ?? undefined)
      const snippet = (detail.data.snippet ?? body).replace(/\s+/g, ' ').slice(0, 320)
      const category = classify(subject, body)
      const verificationCode = category === 'verification_code' ? extractVerificationCode(body) : null
      const companyName = companyFromAddress(fromEmail, fromName)
      const applicationId = await findApplicationIdForCompany(userId, companyName)

      await prisma.inboxEmail.create({
        data: {
          userId,
          gmailMessageId: id,
          threadId: detail.data.threadId ?? id,
          fromAddress: fromEmail,
          fromName,
          subject,
          receivedAt,
          snippet,
          fullBody: body.slice(0, 50_000),
          emailCategory: category,
          verificationCode,
          companyName,
          applicationId,
          isRead: !(detail.data.labelIds ?? []).includes('UNREAD'),
        },
      })

      counts.newEmails++
      if (category === 'verification_code') counts.verificationCodes++
      else if (category === 'interview') counts.interviews++
      else if (category === 'offer') counts.offers++
      else if (category === 'rejection') counts.rejections++
      else if (category === 'application_confirm') counts.confirmations++
    } catch (err) {
      console.warn('[inboxSync] Skipped message', id, err instanceof Error ? err.message : String(err))
    }
  }

  await prisma.gmailConnection.update({
    where: { userId },
    data: { lastSyncedAt: new Date() },
  })

  return counts
}

// ── Verification code polling (used by the apply flow) ────────────────────────

export interface VerificationCodeOptions {
  maxWaitMs?: number
  pollIntervalMs?: number
  // Look back this far for already-stored codes (default 2 minutes)
  lookbackMs?: number
}

export async function getVerificationCode(
  userId: string,
  senderDomain: string,
  opts: VerificationCodeOptions = {},
): Promise<string | null> {
  const maxWaitMs = opts.maxWaitMs ?? 60_000
  const pollIntervalMs = opts.pollIntervalMs ?? 3_000
  const lookbackMs = opts.lookbackMs ?? 2 * 60_000

  const deadline = Date.now() + maxWaitMs
  const normalizedDomain = senderDomain.toLowerCase().replace(/^@/, '')

  async function findCode(): Promise<string | null> {
    const since = new Date(Date.now() - lookbackMs)
    const row = await prisma.inboxEmail.findFirst({
      where: {
        userId,
        emailCategory: 'verification_code',
        receivedAt: { gt: since },
        verificationCode: { not: null },
        ...(normalizedDomain ? { fromAddress: { contains: normalizedDomain } } : {}),
      },
      orderBy: { receivedAt: 'desc' },
    })
    return row?.verificationCode ?? null
  }

  while (Date.now() < deadline) {
    const code = await findCode()
    if (code) return code
    await new Promise(r => setTimeout(r, pollIntervalMs))
  }

  // Final attempt — trigger a fresh sync and check once more.
  try {
    await syncGmailInbox(userId)
  } catch (err) {
    console.warn('[getVerificationCode] Final sync failed:', err instanceof Error ? err.message : String(err))
  }
  return findCode()
}

// Mark a stored email read in both Gmail and the local table.
export async function markEmailRead(userId: string, inboxEmailId: string): Promise<boolean> {
  const email = await prisma.inboxEmail.findFirst({ where: { id: inboxEmailId, userId } })
  if (!email) return false

  const oauthClient = await getRefreshedClient(userId)
  if (oauthClient) {
    try {
      const gmail = google.gmail({ version: 'v1', auth: oauthClient })
      await gmail.users.messages.modify({
        userId: 'me',
        id: email.gmailMessageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      })
    } catch (err) {
      console.warn('[markEmailRead] Gmail modify failed:', err instanceof Error ? err.message : String(err))
    }
  }

  await prisma.inboxEmail.update({ where: { id: inboxEmailId }, data: { isRead: true } })
  return true
}
