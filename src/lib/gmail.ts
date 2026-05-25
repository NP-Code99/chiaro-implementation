// This file must only run on the server — it uses fs, googleapis, and google-auth-library.
import 'server-only'
import fs from 'fs'
import path from 'path'
import { google, gmail_v1 } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'

// ── Types ─────────────────────────────────────────────────────────────────────

export type EmailCategory = 'primary' | 'verification' | 'interview' | 'offer' | 'rejection'

export interface EmailMessage {
  id: string
  from: string
  fromName: string
  subject: string
  preview: string
  body: string
  date: string
  isRead: boolean
  category: EmailCategory
  extractedCode: string | null
}

// ── Config ─────────────────────────────────────────────────────────────────────

const ATS_DOMAINS = [
  'greenhouse-mail.io',
  'greenhouse.io',
  'lever.co',
  'myworkday.com',
  'ashbyhq.com',
  'bamboohr.com',
  'smartrecruiters.com',
  'jobvite.com',
  'icims.com',
  'taleo.net',
  'successfactors.com',
  'workable.com',
  'applytojob.com',
  'startup.jobs',
]

const CATEGORY_QUERIES: Record<EmailCategory, string> = {
  primary: `(${ATS_DOMAINS.map(d => `from:${d}`).join(' OR ')})`,
  verification: `(from:greenhouse-mail.io OR from:lever.co OR from:greenhouse.io) (subject:"security code" OR subject:"verification" OR subject:"confirm your email" OR subject:"verify your email")`,
  interview: `subject:interview OR subject:schedule OR subject:availability OR subject:"phone screen" OR subject:calendly`,
  offer: `subject:offer OR subject:congratulations OR subject:"excited to extend" OR subject:"next steps" OR subject:"pleased to offer"`,
  rejection: `(${ATS_DOMAINS.map(d => `from:${d}`).join(' OR ')}) (subject:application OR subject:"your application") (unfortunately OR "other candidates" OR "not moving forward" OR "regret to inform" OR "decided to move forward" OR "position has been filled")`,
}

// ── Cache ─────────────────────────────────────────────────────────────────────

interface CacheEntry {
  data: EmailMessage[]
  ts: number
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 30_000

function getCached(key: string): EmailMessage[] | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key)
    return null
  }
  return entry.data
}

function setCached(key: string, data: EmailMessage[]): void {
  cache.set(key, { data, ts: Date.now() })
}

// ── Auth ──────────────────────────────────────────────────────────────────────

let _client: OAuth2Client | null = null

function getCredentialsPath(): string {
  return process.env.GMAIL_CREDENTIALS_PATH ?? path.join(process.cwd(), 'credentials.json')
}

function getTokenPath(): string {
  return process.env.GMAIL_TOKEN_PATH ?? path.join(process.cwd(), 'token.json')
}

export function isGmailConfigured(): boolean {
  return fs.existsSync(getCredentialsPath()) && fs.existsSync(getTokenPath())
}

export function getGmailClient(): gmail_v1.Gmail | null {
  if (!isGmailConfigured()) return null

  if (!_client) {
    try {
      const credentials = JSON.parse(fs.readFileSync(getCredentialsPath(), 'utf-8')) as {
        installed?: { client_id: string; client_secret: string; redirect_uris: string[] }
        web?: { client_id: string; client_secret: string; redirect_uris: string[] }
      }

      const { client_id, client_secret, redirect_uris } =
        credentials.installed ?? credentials.web ?? { client_id: '', client_secret: '', redirect_uris: [''] }

      _client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0])

      const token = JSON.parse(fs.readFileSync(getTokenPath(), 'utf-8')) as object
      _client.setCredentials(token)
    } catch {
      return null
    }
  }

  return google.gmail({ version: 'v1', auth: _client })
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function decodeBase64Url(str: string): string {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
}

function extractBody(payload: gmail_v1.Schema$MessagePart): string {
  if (!payload) return ''

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data)
  }

  if (payload.parts) {
    // Prefer text/plain part
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data)
      }
    }
    // Fall back to HTML stripped of tags
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return stripHtml(decodeBase64Url(part.body.data))
      }
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

function extractHeader(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string {
  return headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function parseFromHeader(raw: string): { name: string; email: string } {
  const match = raw.match(/^(.+?)\s*<([^>]+)>$/)
  if (match) return { name: match[1].trim().replace(/^"|"$/g, ''), email: match[2].trim() }
  return { name: raw.trim(), email: raw.trim() }
}

function detectCategory(subject: string, body: string, from: string): EmailCategory {
  const s = subject.toLowerCase()
  const b = body.toLowerCase().slice(0, 2000)
  const f = from.toLowerCase()

  if (
    s.includes('security code') ||
    s.includes('verification') ||
    s.includes('verify your email') ||
    s.includes('confirm your email') ||
    /\b(your|one-time)\s+(code|pin)\b/.test(b)
  ) {
    return 'verification'
  }

  if (
    /unfortunately|other candidates|not moving forward|regret to inform|decided to move forward|position has been filled|we have decided|we will not|won't be moving/.test(b) ||
    /unfortunately|not moving forward|regret to inform/.test(s)
  ) {
    return 'rejection'
  }

  if (
    s.includes('offer') ||
    s.includes('congratulations') ||
    s.includes('excited to extend') ||
    s.includes('pleased to offer') ||
    /we.{0,20}(offer|excited|pleased|thrilled).{0,40}(position|role|join)/.test(b)
  ) {
    return 'offer'
  }

  if (
    s.includes('interview') ||
    s.includes('schedule') ||
    s.includes('availability') ||
    s.includes('phone screen') ||
    b.includes('calendly') ||
    b.includes('schedule a call') ||
    b.includes('zoom.us/j/')
  ) {
    return 'interview'
  }

  return 'primary'
}

// MUST stay in sync with src/lib/gmail/inboxSync.ts CODE_PATTERNS / CODE_BLOCKLIST.
const CODE_PATTERNS: RegExp[] = [
  /paste this code[^]*?application:\s*([A-Za-z0-9]{8})\s*[\r\n]+[^]*?after you enter the code/i,
  /paste this code[^:]*:\s*([A-Za-z0-9]{8})\b/i,
  /security code[^:]*:\s*([A-Za-z0-9]{8})\b/i,
  /your (?:verification |security |one[\s-]?time )?code is[:\s]+([A-Za-z0-9]{6,16})/i,
  /\bcode[:\s]+([A-Za-z0-9]{8,16})\b/i,
  /\btoken[:\s]+([A-Za-z0-9]{8,20})\b/i,
]

const CODE_BLOCKLIST = /^(\d{1,4}|20\d{2}|19\d{2}|verification|security|greenhouse|code|token|copy)$/i

function extractVerificationCode(body: string): string | null {
  for (const pattern of CODE_PATTERNS) {
    const match = body.match(pattern)
    const candidate = match?.[1]
    if (candidate && !CODE_BLOCKLIST.test(candidate)) {
      console.log(`Retrieved verification code: ${candidate}`)
      return candidate
    }
  }
  return null
}

// ── Main fetch function ───────────────────────────────────────────────────────

export async function fetchEmails(
  category: EmailCategory = 'primary',
  page = 1,
  limit = 20
): Promise<EmailMessage[]> {
  const cacheKey = `${category}:${page}:${limit}`
  const cached = getCached(cacheKey)
  if (cached) return cached

  const gmail = getGmailClient()
  if (!gmail) return []

  const query = CATEGORY_QUERIES[category]

  try {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: limit,
      ...(page > 1 ? {} : {}), // pageToken handling omitted for simplicity
    })

    const messages = listRes.data.messages ?? []
    if (messages.length === 0) {
      setCached(cacheKey, [])
      return []
    }

    const emails = await Promise.all(
      messages.map(async msg => {
        if (!msg.id) return null

        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full',
        })

        const headers = detail.data.payload?.headers ?? []
        const rawFrom = extractHeader(headers, 'from')
        const { name: fromName, email: fromEmail } = parseFromHeader(rawFrom)
        const subject = extractHeader(headers, 'subject')
        const dateStr = extractHeader(headers, 'date')

        const body = extractBody(detail.data.payload ?? {})
        const preview = body.replace(/\n+/g, ' ').trim().slice(0, 160)

        const isRead = !detail.data.labelIds?.includes('UNREAD')
        const detectedCategory = detectCategory(subject, body, fromEmail)

        const extractedCode = detectedCategory === 'verification' ? extractVerificationCode(body) : null

        return {
          id: msg.id,
          from: fromEmail,
          fromName: fromName || fromEmail,
          subject: subject || '(no subject)',
          preview,
          body,
          date: dateStr || new Date().toISOString(),
          isRead,
          category: detectedCategory,
          extractedCode,
        } satisfies EmailMessage
      })
    )

    const result = emails.filter((e): e is EmailMessage => e !== null)
    setCached(cacheKey, result)
    return result
  } catch {
    return []
  }
}

export async function markMessageRead(messageId: string): Promise<boolean> {
  const gmail = getGmailClient()
  if (!gmail) return false

  try {
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['UNREAD'] },
    })
    // Invalidate all cache entries
    cache.clear()
    return true
  } catch {
    return false
  }
}
