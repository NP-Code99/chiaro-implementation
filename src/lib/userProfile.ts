export type WorkAuth = 'US Citizen' | 'Green Card' | 'H1B Visa' | 'Need Sponsorship'
export type YearsExp = '0-1' | '1-3' | '3-5' | '5-8' | '8-12' | '12+'
export type VeteranStatus = 'I am not a protected veteran' | 'I identify as one or more of the classifications of a protected veteran' | "I don't wish to answer"
export type DisabilityStatus = 'Yes, I have a disability' | 'No, I do not have a disability' | "I don't wish to answer"
export type Gender = 'Male' | 'Female' | 'Non-binary' | 'Prefer not to say'
export type Ethnicity = 'Asian' | 'Black or African American' | 'Hispanic or Latino' | 'Native American or Alaska Native' | 'Native Hawaiian or Pacific Islander' | 'Two or more races' | 'White' | 'Prefer not to say'

export interface UserProfile {
  firstName: string
  lastName: string
  email: string
  phone: string
  phoneCountryCode?: string
  linkedin: string
  github: string
  location: string
  workAuth: WorkAuth
  yearsExp: YearsExp
  desiredSalary: string        // e.g. "130000" or "$120,000 - $150,000"
  resumeBase64: string
  resumeFilename: string
  bio: string
  // EEO / demographic fields — used for Greenhouse, Lever, and other ATS EEO sections
  veteranStatus?: VeteranStatus
  disabilityStatus?: DisabilityStatus
  gender?: Gender
  ethnicity?: Ethnicity
  addressZip?: string           // Postal/ZIP code — used for forms requiring a zip code
  applicationPassword: string  // Used for ATS account creation fields — not a security credential
  wellfoundCookies?: string    // Paste from browser devtools — bypasses DataDome/Cloudflare
  startupJobsCookies?: string  // Paste from browser devtools — bypasses Cloudflare on startup.jobs

  // Wellfound account credentials (optional — used for existing account login)
  wellfoundEmail?: string
  wellfoundPassword?: string
  hasWellfoundAccount?: boolean

  // Google credentials (optional — used when Wellfound account is linked to Google)
  googleEmail?: string
  googlePassword?: string
  useGoogleLogin?: boolean

  // Answers provided by user for NEEDS_INFO applications (passed back on resume)
  pendingAnswers?: Record<string, string>
}

export function generateApplicationPassword(): string {
  const digits = Math.floor(10000000 + Math.random() * 90000000).toString()
  return `Chiaro${digits}!`
}

const STORAGE_KEY = 'chiaro_user_profile'

// Required fields for completion scoring — credential fields are intentionally excluded
// so users are not forced to provide login credentials to reach 100%
const COMPLETION_FIELDS: (keyof UserProfile)[] = [
  'firstName',
  'lastName',
  'email',
  'phone',
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
