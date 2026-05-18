import { chromium } from 'playwright-extra'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
chromium.use(StealthPlugin())

import type { BrowserContext, Page } from 'playwright'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import type { PlaywrightStorageState } from '../types'

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
]

export function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
}

function getProfileDir(userId: string): string {
  const dir = path.join(process.cwd(), 'profiles', userId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export async function launchHeadedBrowser(userId: string): Promise<{ context: BrowserContext; userAgent: string }> {
  const userAgent = randomUserAgent()
  const profileDir = getProfileDir(userId)

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    userAgent,
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  })

  await applyStealthScripts(context)
  return { context, userAgent }
}

export async function launchHeadlessContext(
  userId: string,
  storageState: PlaywrightStorageState,
  userAgent: string,
): Promise<BrowserContext> {
  const profileDir = getProfileDir(userId)

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  })

  const context = await browser.newContext({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storageState: storageState as any,
    userAgent,
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  })

  await applyStealthScripts(context)
  return context
}

async function applyStealthScripts(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // Remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })

    // Fake plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    })

    // Fake languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    })

    // Spoof chrome object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).chrome = {
      runtime: {},
      loadTimes: function () {},
      csi: function () {},
      app: {},
    }

    // Spoof permissions
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions)
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
        : originalQuery(parameters)
  })
}

export async function setupXvfb(): Promise<(() => void) | null> {
  if (os.platform() !== 'linux') return null

  return new Promise((resolve) => {
    const { spawn } = require('child_process')
    const display = ':99'
    const xvfb = spawn('Xvfb', [display, '-screen', '0', '1366x768x24'], {
      detached: true,
      stdio: 'ignore',
    })
    xvfb.unref()
    process.env.DISPLAY = display
    setTimeout(() => resolve(() => xvfb.kill()), 1000)
  })
}
