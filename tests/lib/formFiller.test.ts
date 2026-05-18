import { describe, it, expect } from 'vitest'
import { classifyLoginState, parseClaudeResponse } from '@/lib/formFiller'

// ── classifyLoginState ────────────────────────────────────────────────────────

describe('classifyLoginState', () => {
  describe('new_user detection', () => {
    it('detects "set a password" as new_user', () => {
      const { state } = classifyLoginState('Please set a password for your account.', '')
      expect(state).toBe('new_user')
    })

    it('detects "create a password" as new_user', () => {
      const { state } = classifyLoginState('Create a password to continue.', '')
      expect(state).toBe('new_user')
    })

    it('detects "create your account" as new_user', () => {
      const { state } = classifyLoginState('Create your account on Wellfound.', '')
      expect(state).toBe('new_user')
    })

    it('detects "join wellfound" as new_user', () => {
      const { state } = classifyLoginState('Join Wellfound to apply.', '')
      expect(state).toBe('new_user')
    })

    it('returns evidence for new_user', () => {
      const { evidence } = classifyLoginState('set a password', '')
      expect(evidence).toBeTruthy()
    })
  })

  describe('existing_wellfound detection via error text', () => {
    it('detects "already have an account" in error text', () => {
      const { state } = classifyLoginState('', 'You already have an account')
      expect(state).toBe('existing_wellfound')
    })

    it('detects "already exists" in error text', () => {
      const { state } = classifyLoginState('', 'This email already exists')
      expect(state).toBe('existing_wellfound')
    })

    it('detects "user already exists" in error text', () => {
      const { state } = classifyLoginState('', 'User already exists')
      expect(state).toBe('existing_wellfound')
    })

    it('detects "log in instead" in error text', () => {
      const { state } = classifyLoginState('', 'Try to log in instead')
      expect(state).toBe('existing_wellfound')
    })

    it('detects legacy "welcome back" phrase', () => {
      const { state } = classifyLoginState('Welcome back! Log in to continue.', '')
      expect(state).toBe('existing_wellfound')
    })

    it('includes error text in evidence', () => {
      const { evidence } = classifyLoginState('', 'email already exists')
      expect(evidence).toContain('email already exists')
    })
  })

  describe('existing_google detection', () => {
    it('detects Google login when existing account + Google phrase in page text', () => {
      const { state } = classifyLoginState(
        'This email already exists. Continue with Google to log in.',
        ''
      )
      expect(state).toBe('existing_google')
    })

    it('detects existing_google when error text has existing phrase AND page has Google phrase', () => {
      const { state } = classifyLoginState(
        'Sign in with Google to continue.',
        'already have an account'
      )
      expect(state).toBe('existing_google')
    })

    it('returns existing_wellfound when existing account but no Google phrase', () => {
      const { state } = classifyLoginState('This account already exists.', '')
      expect(state).toBe('existing_wellfound')
    })
  })

  describe('error text priority', () => {
    it('error text takes priority over conflicting page text', () => {
      // Page text says new user but error text says existing
      const { state } = classifyLoginState('set a password', 'email already exists')
      expect(state).toBe('existing_wellfound')
    })
  })

  describe('unknown state', () => {
    it('returns unknown when no recognisable phrases', () => {
      const { state } = classifyLoginState('Please enter your details.', '')
      expect(state).toBe('unknown')
    })

    it('returns unknown for empty strings', () => {
      const { state } = classifyLoginState('', '')
      expect(state).toBe('unknown')
    })

    it('unknown state has evidence string', () => {
      const { evidence } = classifyLoginState('', '')
      expect(typeof evidence).toBe('string')
      expect(evidence.length).toBeGreaterThan(0)
    })
  })

  describe('case insensitivity', () => {
    it('is case-insensitive for page text', () => {
      const { state } = classifyLoginState('SET A PASSWORD', '')
      expect(state).toBe('new_user')
    })

    it('is case-insensitive for error text', () => {
      const { state } = classifyLoginState('', 'ALREADY EXISTS')
      expect(state).toBe('existing_wellfound')
    })
  })
})

// ── parseClaudeResponse ───────────────────────────────────────────────────────

describe('parseClaudeResponse', () => {
  it('strips json code fences', () => {
    const raw = '```json\n{"key":"value"}\n```'
    expect(parseClaudeResponse(raw)).toBe('{"key":"value"}')
  })

  it('strips plain code fences', () => {
    const raw = '```\nsome text\n```'
    expect(parseClaudeResponse(raw)).toBe('some text')
  })

  it('returns plain text unchanged', () => {
    const raw = 'plain text response'
    expect(parseClaudeResponse(raw)).toBe('plain text response')
  })

  it('trims surrounding whitespace', () => {
    const raw = '  \n  trimmed  \n  '
    expect(parseClaudeResponse(raw)).toBe('trimmed')
  })
})
