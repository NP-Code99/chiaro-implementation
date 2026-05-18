/**
 * sessionManager.ts — Wellfound session cookie cache
 *
 * Strategy: capture session cookies after the FIRST successful login, store them
 * AES-256-CBC encrypted in the User row, reuse on every subsequent apply.
 * This means login (and 2FA risk) only happens once per user session lifetime.
 *
 * Session lifetime: 7 days (conservative — Wellfound sessions last 7–30 days).
 * ENCRYPTION_KEY env var must be set (32-byte hex = 64 hex chars).
 *
 * Does NOT touch Steel, Scrapfly, CapSolver, Cloudflare, or DataDome bypass.
 */

import * as crypto from 'crypto'
import { prisma } from './db'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StoredCookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
}

export interface SessionResult {
  hasValidSession: boolean
  cookies: StoredCookie[]
  expiresAt: Date | null
}

// ── Session cookie filter ─────────────────────────────────────────────────────

/** Filter for cookies that are worth persisting as a session. */
const SESSION_COOKIE_PATTERNS = [
  'session',
  '_wellfound',
  'auth',
  'token',
  'user_id',
  'logged_in',
]

function isSessionCookie(name: string): boolean {
  const lower = name.toLowerCase()
  return SESSION_COOKIE_PATTERNS.some(p => lower.includes(p))
}

// ── Encryption helpers (AES-256-CBC) ─────────────────────────────────────────

function getEncryptionKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY
  if (!hex || hex.length < 64) {
    throw new Error(
      '[sessionManager] ENCRYPTION_KEY env var is missing or too short. ' +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    )
  }
  return Buffer.from(hex.slice(0, 64), 'hex')
}

export function encrypt(text: string): string {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`
}

export function decrypt(encoded: string): string {
  const [ivHex, encHex] = encoded.split(':')
  if (!ivHex || !encHex) {
    throw new Error('[sessionManager] Invalid encrypted data format — expected iv:encrypted')
  }
  const key = getEncryptionKey()
  const iv = Buffer.from(ivHex, 'hex')
  const encrypted = Buffer.from(encHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return decrypted.toString('utf8')
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the stored session for a user (looked up by email).
 * Returns { hasValidSession: false } if no valid session exists.
 */
export async function getValidSession(email: string): Promise<SessionResult> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      wellfoundSessionCookies: true,
      wellfoundSessionExpiry: true,
      wellfoundSessionValid: true,
    },
  })

  if (!user?.wellfoundSessionCookies || !user.wellfoundSessionValid) {
    return { hasValidSession: false, cookies: [], expiresAt: null }
  }

  // Check expiry
  if (user.wellfoundSessionExpiry && new Date() > user.wellfoundSessionExpiry) {
    console.log('[sessionManager] Session expired — marking invalid for:', email)
    await prisma.user.update({
      where: { email },
      data: { wellfoundSessionValid: false },
    })
    return { hasValidSession: false, cookies: [], expiresAt: null }
  }

  try {
    const cookies = JSON.parse(decrypt(user.wellfoundSessionCookies)) as StoredCookie[]
    return {
      hasValidSession: true,
      cookies,
      expiresAt: user.wellfoundSessionExpiry,
    }
  } catch (err) {
    // Decryption failure (e.g. key rotation) — invalidate and force re-login
    console.warn('[sessionManager] Cookie decryption failed — invalidating session:', err instanceof Error ? err.message : String(err))
    await prisma.user.update({
      where: { email },
      data: { wellfoundSessionValid: false },
    })
    return { hasValidSession: false, cookies: [], expiresAt: null }
  }
}

/**
 * Captures and stores Wellfound session cookies for a user (looked up by email).
 * Filters for session-relevant cookies only. Encrypts before storing.
 */
export async function saveSession(email: string, cookies: StoredCookie[]): Promise<void> {
  const sessionCookies = cookies.filter(c => isSessionCookie(c.name))

  if (sessionCookies.length === 0) {
    console.warn('[sessionManager] No session-relevant cookies found in cookie jar — skipping save')
    return
  }

  const expiry = new Date()
  expiry.setDate(expiry.getDate() + 7)

  await prisma.user.update({
    where: { email },
    data: {
      wellfoundSessionCookies: encrypt(JSON.stringify(sessionCookies)),
      wellfoundSessionExpiry: expiry,
      wellfoundSessionValid: true,
    },
  })

  console.log(`[sessionManager] Saved ${sessionCookies.length} session cookies for: ${email}`)
  console.log('[sessionManager] Session valid until:', expiry.toISOString())
}

/**
 * Marks a user's Wellfound session as invalid (forces re-login on next apply).
 */
export async function invalidateSession(email: string): Promise<void> {
  await prisma.user.update({
    where: { email },
    data: { wellfoundSessionValid: false },
  })
  console.log('[sessionManager] Invalidated session for:', email)
}
