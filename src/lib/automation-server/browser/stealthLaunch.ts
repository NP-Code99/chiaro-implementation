/**
 * stealthLaunch.ts
 *
 * Five-layer anti-detection stack:
 *   1. Patchright  — patched Chromium binary that removes CDP-level automation signals
 *   2. Fingerprint — realistic canvas/WebGL/audio/font fingerprint from fingerprint-generator
 *   3. Warmup      — brief real-site visit before the target so Google cookies exist
 *   4. Behaviour   — human-speed scroll + random mouse drift on every page load
 *   5. Proxy       — residential IP for clean CAPTCHA reputation score
 *
 * reCAPTCHA Enterprise scores on: TLS fingerprint, CDP detection, prior Google cookies,
 * interaction timing, and browser entropy. This stack addresses all five.
 */

import { chromium } from 'patchright'
import { FingerprintGenerator } from 'fingerprint-generator'
import { FingerprintInjector } from 'fingerprint-injector'
// Use patchright's own types to avoid cross-package BrowserContext mismatch
import type { BrowserContext, Page } from 'patchright'
import * as path from 'path'
import * as fs from 'fs'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StealthLaunchOptions {
  /** Persistent profile dir — accumulates cookies / browsing history between runs */
  profileDir?: string
  /** Route through residential proxy for clean IP reputation */
  proxy?: string
  /** Run headed (shows browser window) — increases reCAPTCHA score */
  headed?: boolean
  /** Visit google.com first to seed Google cookies (reCAPTCHA checks these) */
  warmup?: boolean
  /** Override viewport */
  viewport?: { width: number; height: number }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
function rnd(min: number, max: number) { return min + Math.random() * (max - min) }

async function humanScroll(page: Page, passes = 3) {
  for (let i = 0; i < passes; i++) {
    await page.mouse.wheel(0, rnd(120, 400))
    await sleep(rnd(300, 900))
  }
}

async function driftMouse(page: Page) {
  const vp = page.viewportSize() ?? { width: 1280, height: 800 }
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(rnd(100, vp.width - 100), rnd(100, vp.height - 100), { steps: Math.floor(rnd(8, 20)) })
    await sleep(rnd(200, 600))
  }
}

// ─── Layer 1 + 2: Patchright + fingerprint injection ─────────────────────────

export async function stealthContext(opts: StealthLaunchOptions = {}): Promise<{
  context: BrowserContext
  close: () => Promise<void>
}> {
  const {
    profileDir,
    proxy,
    headed = false,
    warmup = true,
    viewport = { width: 1366 + Math.floor(rnd(-30, 30)), height: 768 + Math.floor(rnd(-20, 20)) },
  } = opts

  // ── Layer 2: generate a realistic fingerprint ──────────────────────────────
  const generator = new FingerprintGenerator({
    browsers: [{ name: 'chrome', minVersion: 120, maxVersion: 124 }],
    devices: ['desktop'],
    operatingSystems: ['windows', 'macos'],
    locales: ['en-US', 'en'],
  })
  const { fingerprint, headers } = generator.getFingerprint()

  const userAgent = fingerprint.navigator.userAgent

  // ── Layer 1: Patchright (patched Chromium, removes CDP automation signals) ──
  const launchArgs = [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-infobars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions-except=',
    // Randomise window position to avoid uniform geometry fingerprint
    `--window-position=${Math.floor(rnd(0, 100))},${Math.floor(rnd(0, 50))}`,
  ]

  let context: BrowserContext

  if (profileDir) {
    // Persistent context: accumulates real cookies, localStorage, browsing history
    fs.mkdirSync(profileDir, { recursive: true })
    context = await chromium.launchPersistentContext(profileDir, {
      headless: !headed,
      userAgent,
      viewport,
      locale: fingerprint.navigator.language ?? 'en-US',
      timezoneId: 'America/New_York',
      args: launchArgs,
      ignoreDefaultArgs: ['--enable-automation'],
      ...(proxy ? { proxy: { server: proxy } } : {}),
    })
  } else {
    const browser = await chromium.launch({
      headless: !headed,
      args: launchArgs,
      ignoreDefaultArgs: ['--enable-automation'],
      ...(proxy ? { proxy: { server: proxy } } : {}),
    })
    context = await browser.newContext({
      userAgent,
      viewport,
      locale: fingerprint.navigator.language ?? 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept-Language': headers['accept-language'] ?? 'en-US,en;q=0.9',
      },
    })
  }

  // ── Layer 2 continued: inject canvas/WebGL/audio/font fingerprint ──────────
  const injector = new FingerprintInjector()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await injector.attachFingerprintToPlaywright(context as any, { fingerprint, headers })

  // ── Extra JS-level stealth (belt-and-suspenders over patchright) ───────────
  await context.addInitScript(() => {
    // Remove webdriver traces
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })

    // Spoof plugins (empty array is a headless tell)
    Object.defineProperty(navigator, 'plugins', {
      get: () => Object.assign([1, 2, 3, 4, 5], { item: () => null, namedItem: () => null, refresh: () => {} }),
    })

    // Spoof permissions API to avoid notification-state tells
    const origQuery = window.navigator.permissions.query.bind(window.navigator.permissions)
    window.navigator.permissions.query = (p) =>
      (p as PermissionDescriptor).name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null } as PermissionStatus)
        : origQuery(p)

    // Chrome object present in real browsers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!(window as any).chrome) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}), app: {} }
    }

    // Prevent iframe contentWindow automation detection
    const origContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow')
    if (origContentWindow) {
      Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
        get() {
          const win = origContentWindow.get?.call(this)
          if (!win) return win
          Object.defineProperty(win.navigator, 'webdriver', { get: () => undefined, configurable: true })
          return win
        },
      })
    }
  })

  // ── Layer 3: Warmup — visit google.com to seed reCAPTCHA cookies ───────────
  if (warmup) {
    const warmPage = await context.newPage()
    try {
      await warmPage.goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 15_000 })
      await sleep(rnd(1200, 2500))
      await driftMouse(warmPage)
      await humanScroll(warmPage, 2)
      await sleep(rnd(800, 1800))
    } catch { /* warmup failure is non-fatal */ }
    await warmPage.close()
  }

  return {
    context,
    close: async () => {
      try { await context.browser()?.close() } catch { /* ignore */ }
    },
  }
}

// ─── Layer 4: page-level behaviour hooks (call after every page.goto) ─────────

export async function humanisePageLoad(page: Page): Promise<void> {
  // Random read delay — simulates user reading the page
  await sleep(rnd(800, 2000))
  // Natural scroll behaviour
  await humanScroll(page, Math.floor(rnd(2, 5)))
  // Random mouse drift
  await driftMouse(page)
  // Scroll back toward top (real users often do this)
  if (Math.random() > 0.5) {
    await page.mouse.wheel(0, -rnd(100, 300))
    await sleep(rnd(300, 700))
  }
}

// ─── Layer 5: per-field timing ────────────────────────────────────────────────

export async function humanTypeInField(page: Page, selector: string, text: string): Promise<void> {
  const el = page.locator(selector).first()
  await el.scrollIntoViewIfNeeded({ timeout: 5000 })
  await sleep(rnd(300, 800))

  // Move mouse to the element before clicking (Bezier path)
  const box = await el.boundingBox()
  if (box) {
    const tx = box.x + box.width * rnd(0.2, 0.8)
    const ty = box.y + box.height * rnd(0.2, 0.8)
    await page.mouse.move(tx - rnd(30, 80), ty + rnd(-20, 20), { steps: Math.floor(rnd(5, 12)) })
    await sleep(rnd(80, 200))
    await page.mouse.move(tx, ty, { steps: Math.floor(rnd(3, 8)) })
    await sleep(rnd(50, 150))
  }

  await el.click()
  await sleep(rnd(150, 400))

  // Clear existing value
  await page.keyboard.press('Control+A')
  await sleep(rnd(50, 120))

  // Type character by character with natural acceleration/deceleration
  for (let i = 0; i < text.length; i++) {
    // Slightly faster in the middle, slower at start/end (natural typing curve)
    const position = i / text.length
    const speedFactor = position < 0.2 || position > 0.8 ? 1.4 : 0.8
    const delay = rnd(55, 140) * speedFactor

    await page.keyboard.type(text[i], { delay })

    // Occasional thinking pause (3% chance per character)
    if (Math.random() < 0.03) await sleep(rnd(400, 1200))
    // Brief hesitation on punctuation
    if (/[.,@]/.test(text[i])) await sleep(rnd(100, 300))
  }

  await sleep(rnd(200, 600))
}
