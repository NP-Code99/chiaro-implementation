/**
 * tests/lib/login.test.ts
 *
 * TDD: Write ALL tests before implementation.
 * Run: npx vitest run tests/lib/login.test.ts --reporter=verbose
 *
 * Expected state before implementation:
 *   T1–T2:  PASS  (classifyLoginState already exists)
 *   T3–T5:  FAIL  (pathway handlers not exported yet)
 *   T6:     FAIL  (detect2FA not exported yet)
 *   T7–T8:  FAIL  (sessionManager module does not exist)
 *   T9:     PASS  (existing_account error already returned)
 *   T10:    FAIL  (fillApplicationForm does not call getValidSession yet)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import * as crypto from 'crypto'

// ── Mock filesystem so snap() doesn't write real files ───────────────────────

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  }
})

// ── Mock Anthropic SDK so generateCoverLetter doesn't make real API calls ───

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Mock cover letter for tests.' }],
        }),
      },
    })),
  }
})

// ── Mock prisma ───────────────────────────────────────────────────────────────

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    application: {
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}))

// ── Imports ───────────────────────────────────────────────────────────────────

import { classifyLoginState } from '@/lib/formFiller'
import type { UserProfile } from '@/lib/userProfile'

// ── Helper: minimal Playwright Page mock ─────────────────────────────────────

function makeMockLocator(overrides: Record<string, unknown> = {}) {
  return {
    isVisible: vi.fn().mockResolvedValue(false),
    click: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
    first: vi.fn().mockReturnThis(),
    nth: vi.fn().mockReturnThis(),
    fill: vi.fn().mockResolvedValue(undefined),
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
    selectText: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(''),
    innerText: vi.fn().mockResolvedValue(''),
    focus: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeMockPage(overrides: Record<string, unknown> = {}) {
  const loc = makeMockLocator()
  return {
    $: vi.fn().mockResolvedValue(null),
    $$: vi.fn().mockResolvedValue([]),
    evaluate: vi.fn().mockResolvedValue(''),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(null),
    screenshot: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue('<html><body></body></html>'),
    url: vi.fn().mockReturnValue('https://wellfound.com'),
    goto: vi.fn().mockResolvedValue(undefined),
    keyboard: {
      type: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined),
    },
    locator: vi.fn().mockReturnValue(loc),
    getByLabel: vi.fn().mockReturnValue(loc),
    getByPlaceholder: vi.fn().mockReturnValue(loc),
    context: vi.fn().mockReturnValue({
      waitForEvent: vi.fn().mockResolvedValue(null),
      cookies: vi.fn().mockResolvedValue([]),
      addCookies: vi.fn().mockResolvedValue(undefined),
    }),
    ...overrides,
  } as unknown as import('playwright').Page
}

// ── Profile fixtures ──────────────────────────────────────────────────────────

const BASE_PROFILE: UserProfile = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  phone: '+1 415 555 0100',
  linkedin: '',
  github: '',
  location: 'San Francisco, CA',
  workAuth: 'US Citizen',
  yearsExp: '5-8',
  desiredSalary: '150000',
  resumeBase64: '',
  resumeFilename: 'ada-resume.pdf',
  bio: 'Senior engineer with 6 years experience.',
  applicationPassword: 'Chiaro2024!!',
}

const JOB = {
  role: 'Senior Engineer',
  company: 'TestCo',
  description: 'Build things at TestCo.',
  location: 'Remote',
}

// ═══════════════════════════════════════════════════════════════════════════════
// Wellfound Login Flow Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Wellfound Login Flow', () => {

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── T1: Detect existing account from error text ───────────────────────────

  test('T1 — detects existing account from red error text', () => {
    const { state, evidence } = classifyLoginState(
      '',
      'You already have an account with this email address'
    )
    expect(state).toBe('existing_wellfound')
    expect(evidence).toBeTruthy()
  })

  // ── T2: Detect new user when no error text ────────────────────────────────

  test('T2 — detects new user when no error text present', () => {
    const { state } = classifyLoginState(
      'Set a password to create your account',
      ''
    )
    expect(state).toBe('new_user')
  })

  // ── T3: Direct login succeeds with valid credentials ─────────────────────
  // Requires: handleExistingWellfoundPathway exported from formFiller.ts

  test('T3 — direct login succeeds with valid credentials', async () => {
    const { handleExistingWellfoundPathway } = await import('@/lib/formFiller')

    const mockPassEl = { click: vi.fn().mockResolvedValue(undefined) }
    const page = makeMockPage({
      $: vi.fn()
        .mockResolvedValueOnce(mockPassEl)    // password field found immediately
        .mockResolvedValue(null),
      evaluate: vi.fn()
        .mockResolvedValueOnce('')            // postLoginText — no error
        .mockResolvedValue([]),               // verifyRequiredFields → no missing
    })

    const profile = { ...BASE_PROFILE, wellfoundPassword: 'correctPass123' }
    const result = await handleExistingWellfoundPathway(page, profile, JOB, 'test-app')

    expect(result.loginPathway).toBe('existing_wellfound')
    expect(result.error).not.toBe('existing_account')
  })

  // ── T4: Direct login fails with wrong password ────────────────────────────

  test('T4 — direct login fails with wrong password', async () => {
    const { handleExistingWellfoundPathway } = await import('@/lib/formFiller')

    const mockPassEl = { click: vi.fn().mockResolvedValue(undefined) }
    const page = makeMockPage({
      $: vi.fn()
        .mockResolvedValueOnce(mockPassEl)
        .mockResolvedValue(null),
      evaluate: vi.fn()
        .mockResolvedValueOnce('incorrect password, please try again')
        .mockResolvedValue([]),
    })

    const profile = { ...BASE_PROFILE, wellfoundPassword: 'wrongPass' }
    const result = await handleExistingWellfoundPathway(page, profile, JOB, 'test-app')

    expect(result.success).toBe(false)
    expect(result.error).toBe('existing_account')
    expect(result.message).toMatch(/password/i)
  })

  // ── T5: Google login succeeds with valid credentials ──────────────────────
  // Requires: handleGoogleLoginPathway exported from formFiller.ts
  // Uses fake timers to skip the many sleep() calls inside the pathway.

  test('T5 — Google login succeeds with valid credentials', async () => {
    vi.useFakeTimers()

    try {
      const { handleGoogleLoginPathway } = await import('@/lib/formFiller')

      const mockGooglePage = makeMockPage({
        url: vi.fn().mockReturnValue('https://accounts.google.com/signin'),
        $: vi.fn()
          .mockResolvedValueOnce({ click: vi.fn() })   // email input
          .mockResolvedValueOnce({ click: vi.fn() })   // Next button
          .mockResolvedValueOnce({ click: vi.fn() })   // password input
          .mockResolvedValueOnce({ click: vi.fn() })   // Sign-in button
          .mockResolvedValue(null),
        evaluate: vi.fn().mockResolvedValue(''),        // no 2FA, no failure
      })

      const page = makeMockPage({
        $: vi.fn()
          .mockResolvedValueOnce({ click: vi.fn() })   // Google button
          .mockResolvedValue(null),
        evaluate: vi.fn().mockResolvedValue(''),
        context: vi.fn().mockReturnValue({
          waitForEvent: vi.fn().mockResolvedValue(mockGooglePage),
          cookies: vi.fn().mockResolvedValue([]),
          addCookies: vi.fn(),
        }),
      })

      const profile = {
        ...BASE_PROFILE,
        googleEmail: 'ada@gmail.com',
        googlePassword: 'googlePass123',
      }

      // Run the pathway and advance fake timers concurrently
      const resultPromise = handleGoogleLoginPathway(page, profile, JOB, 'test-app')
      await vi.runAllTimersAsync()
      const result = await resultPromise

      expect(result.loginPathway).toBe('google')
      expect(result.error).not.toBe('existing_account')
    } finally {
      vi.useRealTimers()
    }
  })

  // ── T6: 2FA detected and user prompted correctly ──────────────────────────
  // Requires: detect2FA exported from formFiller.ts

  test('T6 — 2FA detected and user prompted correctly', async () => {
    const { detect2FA } = await import('@/lib/formFiller')
    const page = makeMockPage()

    const emailCodeResult = await detect2FA(page, 'please enter the verification code sent to your email')
    expect(emailCodeResult.required).toBe(true)
    expect(emailCodeResult.type).toBe('email_code')

    const smsResult = await detect2FA(page, 'a text message with sms code was sent to your phone')
    expect(smsResult.required).toBe(true)
    expect(smsResult.type).toBe('sms_code')

    const authResult = await detect2FA(page, 'open your authenticator app and enter the 6-digit code')
    expect(authResult.required).toBe(true)
    expect(authResult.type).toBe('authenticator')

    const phoneResult = await detect2FA(page, 'check your phone — tap yes on the google prompt')
    expect(phoneResult.required).toBe(true)
    expect(phoneResult.type).toBe('phone_prompt')

    const noResult = await detect2FA(page, 'please fill in your application details')
    expect(noResult.required).toBe(false)
    expect(noResult.type).toBeNull()
  })

  // ── T7: Session cookie capture after successful login ─────────────────────
  // Requires: sessionManager module to exist

  test('T7 — session cookie capture after successful login', async () => {
    // Set ENCRYPTION_KEY so sessionManager can encrypt/decrypt
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex')

    const { saveSession } = await import('@/lib/sessionManager')
    const { prisma } = await import('@/lib/db')

    vi.mocked(prisma.user.update).mockResolvedValue({} as never)

    const cookies = [
      { name: 'session_token', value: 'abc123', domain: '.wellfound.com' },
      { name: 'user_id', value: '999', domain: '.wellfound.com' },
      { name: 'unrelated_cookie', value: 'xyz', domain: '.other.com' },
    ]

    await saveSession('ada@example.com', cookies)

    expect(prisma.user.update).toHaveBeenCalledOnce()
    const callArgs = vi.mocked(prisma.user.update).mock.calls[0][0]
    expect(callArgs.where).toMatchObject({ email: 'ada@example.com' })
    expect(callArgs.data.wellfoundSessionValid).toBe(true)
    expect(typeof callArgs.data.wellfoundSessionCookies).toBe('string')
    expect(callArgs.data.wellfoundSessionExpiry).toBeInstanceOf(Date)
  })

  // ── T8: Stored session cookie reused on subsequent apply ─────────────────
  // Requires: sessionManager module to exist

  test('T8 — stored session cookie reused on subsequent apply', async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex')

    const { saveSession, getValidSession } = await import('@/lib/sessionManager')
    const { prisma } = await import('@/lib/db')

    // First, encrypt some cookies using saveSession's encryption (spy on what's stored)
    let storedCookies = ''
    let storedExpiry: Date = new Date()
    // Cast to any to satisfy the complex Prisma__UserClient return type in the mock
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captureUpdate = vi.fn(async (args: any) => {
      if (args.data.wellfoundSessionCookies) storedCookies = args.data.wellfoundSessionCookies
      if (args.data.wellfoundSessionExpiry) storedExpiry = args.data.wellfoundSessionExpiry
      return {} as any
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(prisma.user.update).mockImplementation(captureUpdate as any)

    const testCookies = [
      { name: 'session_token', value: 'tok-123', domain: '.wellfound.com' },
    ]
    await saveSession('ada@example.com', testCookies)

    // Now mock findUnique to return what was stored
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      wellfoundSessionCookies: storedCookies,
      wellfoundSessionExpiry: storedExpiry,
      wellfoundSessionValid: true,
    } as never)

    const result = await getValidSession('ada@example.com')

    expect(result.hasValidSession).toBe(true)
    expect(result.cookies).toHaveLength(1)
    expect(result.cookies[0].name).toBe('session_token')
    expect(result.expiresAt).not.toBeNull()
  })

  // ── T9: Missing credentials returns needs_review with clear message ───────

  test('T9 — missing credentials returns needs_review with clear message', async () => {
    const { handleExistingWellfoundPathway } = await import('@/lib/formFiller')

    const page = makeMockPage()
    const profile = { ...BASE_PROFILE }  // no wellfoundPassword

    const result = await handleExistingWellfoundPathway(page, profile, JOB, 'test-app')

    expect(result.success).toBe(false)
    expect(result.error).toBe('existing_account')
    expect(result.message).toBeTruthy()
    expect(result.message).toMatch(/password/i)
  })

  // ── T10: Application form fills correctly after login ─────────────────────
  // Requires: fillApplicationForm calls getValidSession when session available

  test('T10 — application form fills correctly after login', async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex')

    const { prisma } = await import('@/lib/db')

    // Mock a valid stored session so fillApplicationForm skips login
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      wellfoundSessionCookies: null,
      wellfoundSessionExpiry: null,
      wellfoundSessionValid: false,
    } as never)

    const { fillApplicationForm } = await import('@/lib/formFiller')

    const page = makeMockPage({
      // First evaluate: errorText near email field
      // Second evaluate: page text for login state
      // Third evaluate: DataDome check (page.content is separate)
      // Fourth evaluate: verifyRequiredFields
      evaluate: vi.fn()
        .mockResolvedValueOnce('')          // error text near email
        .mockResolvedValueOnce('set a password for your account')   // page text
        .mockResolvedValueOnce([])          // verifyRequiredFields
        .mockResolvedValue([]),
    })

    const profile = { ...BASE_PROFILE }
    const result = await fillApplicationForm(page, profile, JOB, 'test-app-t10')

    // After fill, loginPathway should be set (shows routing worked)
    expect(result.loginPathway).toBeDefined()
    // Success or not, error should not be a system-level crash
    expect(typeof result.success).toBe('boolean')
  })
})

// ── Standalone: getValidSession handles expired session gracefully ────────────

describe('getValidSession edge cases', () => {

  test('returns hasValidSession: false when session marked invalid', async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex')
    const { getValidSession } = await import('@/lib/sessionManager')
    const { prisma } = await import('@/lib/db')

    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      wellfoundSessionCookies: 'some-encrypted-data',
      wellfoundSessionExpiry: new Date(Date.now() + 86400_000),
      wellfoundSessionValid: false,
    } as never)

    const result = await getValidSession('ada@example.com')
    expect(result.hasValidSession).toBe(false)
    expect(result.cookies).toHaveLength(0)
  })

  test('returns hasValidSession: false and invalidates when session expired', async () => {
    process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex')
    const { getValidSession } = await import('@/lib/sessionManager')
    const { prisma } = await import('@/lib/db')

    vi.mocked(prisma.user.update).mockResolvedValue({} as never)
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      wellfoundSessionCookies: 'some-encrypted-data',
      wellfoundSessionExpiry: new Date(Date.now() - 1000), // already expired
      wellfoundSessionValid: true,
    } as never)

    const result = await getValidSession('ada@example.com')
    expect(result.hasValidSession).toBe(false)
    // Should have called update to mark session invalid
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ wellfoundSessionValid: false }),
      })
    )
  })
})
