export type WorkAuth = 'US Citizen' | 'Green Card' | 'H1B Visa' | 'Need Sponsorship'
export type YearsExp = '0-1' | '1-3' | '3-5' | '5-8' | '8-12' | '12+'

export interface UserProfile {
  firstName: string
  lastName: string
  email: string
  phone: string
  linkedin: string
  github: string
  location: string
  workAuth: WorkAuth
  yearsExp: YearsExp
  resumeBase64: string
  resumeFilename: string
  bio: string
  applicationPassword: string  // Used for ATS account creation fields — not a security credential
}

export function generateApplicationPassword(): string {
  const digits = Math.floor(10000000 + Math.random() * 90000000).toString()
  return `Chiaro${digits}!`
}

const STORAGE_KEY = 'chiaro_user_profile'

// Ordered list of fields used for completion scoring
const COMPLETION_FIELDS: (keyof UserProfile)[] = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'linkedin',
  'location',
  'workAuth',
  'yearsExp',
  'resumeBase64',
  'bio',
]

export function saveProfile(profile: UserProfile): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile))
}

export function loadProfile(): UserProfile | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as UserProfile
  } catch {
    return null
  }
}

export function clearProfile(): void {
  localStorage.removeItem(STORAGE_KEY)
}

export function profileCompletionPct(profile: UserProfile): number {
  if (!profile) return 0
  const filled = COMPLETION_FIELDS.filter(f => {
    const v = profile[f]
    return typeof v === 'string' && v.trim().length > 0
  }).length
  return Math.round((filled / COMPLETION_FIELDS.length) * 100)
}
