export interface StoredSession {
  userId: string
  site: string
  storageState: PlaywrightStorageState
  userAgent: string
  capturedAt: number
  expiresAt: number
}

export interface PlaywrightStorageState {
  cookies: Cookie[]
  origins: OriginState[]
}

export interface Cookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Strict' | 'Lax' | 'None'
}

export interface OriginState {
  origin: string
  localStorage: { name: string; value: string }[]
}

export interface SessionCaptureOptions {
  userId: string
  site: string
  validationUrl: string
  validationSelector: string
  ttlHours?: number
}

export interface JobApplication {
  id: string
  userId: string
  jobUrl: string
  site: string
  jobTitle: string
  company: string
  status: 'pending' | 'processing' | 'done' | 'failed' | 'needs_review'
  errorMessage?: string
  createdAt: number
  processedAt?: number
}

export interface FormField {
  selector: string
  label: string
  type: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file' | 'password'
  required: boolean
  options?: string[]
  value?: string
}

export interface ApplicantProfile {
  firstName: string
  lastName: string
  email: string
  phone: string
  linkedin?: string
  github?: string
  location: string
  resumePath?: string
  bio?: string
  yearsExp?: string
  workAuth?: string
  desiredSalary?: string
}

export interface ProcessJobPayload {
  applicationId: string
  userId: string
  jobUrl: string
  site: string
  profile: ApplicantProfile
}
