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
})
