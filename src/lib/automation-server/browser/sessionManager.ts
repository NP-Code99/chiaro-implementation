import * as fs from 'fs'
import * as path from 'path'
import type { BrowserContext, Page } from 'playwright'
import type { StoredSession, SessionCaptureOptions, PlaywrightStorageState } from '../types'
import { encrypt, decrypt } from '../security/encryption'
import { launchHeadedBrowser, launchHeadlessContext, randomUserAgent } from './antiDetection'

const SESSION_DIR = path.join(process.cwd(), 'sessions')
const ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY ?? 'chiaro-default-key-change-in-prod'

function sessionPath(userId: string, site: string): string {
  fs.mkdirSync(SESSION_DIR, { recursive: true })
  const safe = site.replace(/[^a-z0-9]/gi, '_')
  return path.join(SESSION_DIR, `${userId}_${safe}.enc`)
}

// ── Save ──────────────────────────────────────────────────────────────────────

export async function captureSession(opts: SessionCaptureOptions): Promise<void> {
  const { userId, site, validationUrl, validationSelector, ttlHours = 168 } = opts

  console.log(`[sessionManager] Launching headed browser for user ${userId}`)
  console.log(`[sessionManager] Navigate to ${site} and log in. Press Ctrl+C in this terminal when done.`)

  const { context, userAgent } = await launchHeadedBrowser(userId)
  const page = await context.newPage()

  await page.goto(site)

  // Wait for user to complete login manually
  await page.waitForSelector(validationSelector, { timeout: 300_000 })
  console.log(`[sessionManager] Login detected. Saving session…`)

  const storageState = await context.storageState() as PlaywrightStorageState

  const session: StoredSession = {
    userId,
    site,
    storageState,
    userAgent,
    capturedAt: Date.now(),
    expiresAt: Date.now() + ttlHours * 60 * 60 * 1000,
  }

  const encrypted = encrypt(JSON.stringify(session), ENCRYPTION_KEY)
  fs.writeFileSync(sessionPath(userId, site), encrypted, 'utf8')
  console.log(`[sessionManager] Session saved for ${userId} @ ${site}`)

  await context.close()
}

// ── Load ──────────────────────────────────────────────────────────────────────

export function loadSession(userId: string, site: string): StoredSession | null {
  const p = sessionPath(userId, site)
  if (!fs.existsSync(p)) return null

  try {
    const raw = fs.readFileSync(p, 'utf8')
    const session: StoredSession = JSON.parse(decrypt(raw, ENCRYPTION_KEY))
    return session
  } catch {
    return null
  }
}

export function isSessionExpired(session: StoredSession): boolean {
  return Date.now() > session.expiresAt
}

// ── Validate (live check against a protected page) ────────────────────────────

export async function validateSession(
  userId: string,
  site: string,
  validationUrl: string,
  validationSelector: string,
): Promise<boolean> {
  const session = loadSession(userId, site)
  if (!session || isSessionExpired(session)) return false

  const context = await launchHeadlessContext(userId, session.storageState, session.userAgent)
  try {
    const page = await context.newPage()
    await page.goto(validationUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    const el = await page.locator(validationSelector).first().isVisible({ timeout: 5000 })
    return el
  } catch {
    return false
  } finally {
    await context.close()
  }
}

// ── Restore — returns a ready context ─────────────────────────────────────────

export async function restoreSession(
  userId: string,
  site: string,
  validationUrl: string,
  validationSelector: string,
): Promise<BrowserContext> {
  const session = loadSession(userId, site)
  if (!session) throw new Error(`No session found for ${userId} @ ${site}`)
  if (isSessionExpired(session)) throw new Error(`Session expired for ${userId} @ ${site}`)

  const valid = await validateSession(userId, site, validationUrl, validationSelector)
  if (!valid) throw new Error(`Session no longer valid for ${userId} @ ${site}. Re-authenticate.`)

  return launchHeadlessContext(userId, session.storageState, session.userAgent)
}

// ── Delete ────────────────────────────────────────────────────────────────────

export function deleteSession(userId: string, site: string): void {
  const p = sessionPath(userId, site)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}

export function listSessions(userId: string): { site: string; capturedAt: number; expiresAt: number }[] {
  fs.mkdirSync(SESSION_DIR, { recursive: true })
  return fs
    .readdirSync(SESSION_DIR)
    .filter(f => f.startsWith(userId) && f.endsWith('.enc'))
    .map(f => {
      try {
        const raw = fs.readFileSync(path.join(SESSION_DIR, f), 'utf8')
        const s: StoredSession = JSON.parse(decrypt(raw, ENCRYPTION_KEY))
        return { site: s.site, capturedAt: s.capturedAt, expiresAt: s.expiresAt }
      } catch {
        return null
      }
    })
    .filter(Boolean) as { site: string; capturedAt: number; expiresAt: number }[]
}
