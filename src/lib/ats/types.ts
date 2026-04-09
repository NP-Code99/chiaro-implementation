export interface ApplicantData {
  name: string
  email: string
  phone?: string
  linkedinUrl?: string
  githubUrl?: string
  location?: string
  resumePath?: string
}

export interface SubmissionResult {
  success: boolean
  error?: string
  applicationId?: string
}

export interface AtsStrategy {
  submit(applyUrl: string, applicant: ApplicantData): Promise<SubmissionResult>
}
