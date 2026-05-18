import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  saveProfile,
  loadProfile,
  clearProfile,
  profileCompletionPct,
  type UserProfile,
} from '@/lib/userProfile'

const FULL_PROFILE: UserProfile = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  phone: '+1 415 555 0100',
  linkedin: 'https://linkedin.com/in/ada',
  github: 'https://github.com/ada',
  location: 'San Francisco, CA',
  workAuth: 'US Citizen',
  yearsExp: '5-8',
  desiredSalary: '160000',
  resumeBase64: 'data:application/pdf;base64,JVBERi0x',
  resumeFilename: 'ada-resume.pdf',
  bio: 'Passionate engineer with 6 years of experience.',
  applicationPassword: 'Chiaro12345678!',
}

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
    clear: () => { store = {} },
  }
})()

beforeEach(() => {
  localStorageMock.clear()
  vi.stubGlobal('localStorage', localStorageMock)
})

describe('saveProfile', () => {
  it('saves profile to localStorage as JSON', () => {
    saveProfile(FULL_PROFILE)
    const raw = localStorage.getItem('chiaro_user_profile')
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toMatchObject({ firstName: 'Ada', email: 'ada@example.com' })
  })
})

describe('loadProfile', () => {
  it('returns null when nothing saved', () => {
    expect(loadProfile()).toBeNull()
  })

  it('returns saved profile', () => {
    saveProfile(FULL_PROFILE)
    const profile = loadProfile()
    expect(profile).not.toBeNull()
    expect(profile!.firstName).toBe('Ada')
    expect(profile!.email).toBe('ada@example.com')
  })

  it('returns null for corrupted JSON', () => {
    localStorage.setItem('chiaro_user_profile', '{bad json}')
    expect(loadProfile()).toBeNull()
  })
})

describe('clearProfile', () => {
  it('removes profile from localStorage', () => {
    saveProfile(FULL_PROFILE)
    clearProfile()
    expect(loadProfile()).toBeNull()
  })
})

describe('profileCompletionPct', () => {
  it('returns 0 for empty profile', () => {
    expect(profileCompletionPct({} as UserProfile)).toBe(0)
  })

  it('returns 100 for fully filled profile', () => {
    expect(profileCompletionPct(FULL_PROFILE)).toBe(100)
  })

  it('returns partial percentage for partial profile', () => {
    const partial: Partial<UserProfile> = { firstName: 'Ada', email: 'ada@example.com' }
    const pct = profileCompletionPct(partial as UserProfile)
    expect(pct).toBeGreaterThan(0)
    expect(pct).toBeLessThan(100)
  })

  it('increases as more fields are filled', () => {
    const p1 = profileCompletionPct({ firstName: 'Ada' } as UserProfile)
    const p2 = profileCompletionPct({ firstName: 'Ada', email: 'a@b.com' } as UserProfile)
    expect(p2).toBeGreaterThan(p1)
  })

  it('counts resumeBase64 as a completion field', () => {
    const withResume = profileCompletionPct({ ...FULL_PROFILE })
    const withoutResume = profileCompletionPct({ ...FULL_PROFILE, resumeBase64: '' })
    expect(withResume).toBeGreaterThan(withoutResume)
  })

  it('does not count credential fields toward completion percentage', () => {
    const withCredentials: UserProfile = {
      ...FULL_PROFILE,
      hasWellfoundAccount: true,
      wellfoundEmail: 'ada@wellfound.com',
      wellfoundPassword: 'secret-password',
      useGoogleLogin: true,
      googleEmail: 'ada@gmail.com',
      googlePassword: 'google-secret',
    }
    // Credential fields should not push score above the non-credential 100%
    expect(profileCompletionPct(withCredentials)).toBe(100)
  })

  it('returns 100 even without credential fields', () => {
    const noCredentials: UserProfile = {
      ...FULL_PROFILE,
      hasWellfoundAccount: false,
      wellfoundEmail: undefined,
      wellfoundPassword: undefined,
    }
    expect(profileCompletionPct(noCredentials)).toBe(100)
  })
})

describe('credential field serialization', () => {
  it('saves and restores Wellfound credentials', () => {
    const profile: UserProfile = {
      ...FULL_PROFILE,
      hasWellfoundAccount: true,
      wellfoundEmail: 'ada@wellfound.com',
      wellfoundPassword: 'wellfound-pass',
    }
    saveProfile(profile)
    const loaded = loadProfile()
    expect(loaded).not.toBeNull()
    expect(loaded!.hasWellfoundAccount).toBe(true)
    expect(loaded!.wellfoundEmail).toBe('ada@wellfound.com')
    expect(loaded!.wellfoundPassword).toBe('wellfound-pass')
  })

  it('saves and restores Google credentials', () => {
    const profile: UserProfile = {
      ...FULL_PROFILE,
      useGoogleLogin: true,
      googleEmail: 'ada@gmail.com',
      googlePassword: 'google-pass',
    }
    saveProfile(profile)
    const loaded = loadProfile()
    expect(loaded).not.toBeNull()
    expect(loaded!.useGoogleLogin).toBe(true)
    expect(loaded!.googleEmail).toBe('ada@gmail.com')
    expect(loaded!.googlePassword).toBe('google-pass')
  })

  it('credential fields default to undefined when not set', () => {
    saveProfile(FULL_PROFILE)
    const loaded = loadProfile()
    expect(loaded).not.toBeNull()
    expect(loaded!.wellfoundPassword).toBeUndefined()
    expect(loaded!.googlePassword).toBeUndefined()
    expect(loaded!.hasWellfoundAccount).toBeUndefined()
    expect(loaded!.useGoogleLogin).toBeUndefined()
  })
})
