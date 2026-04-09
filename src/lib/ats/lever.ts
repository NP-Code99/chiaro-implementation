import path from 'path'
import { existsSync } from 'fs'
import { parseLeverUrl } from './classifier'
import type { ApplicantData, SubmissionResult } from './types'

export async function submitToLever(
  applyUrl: string,
  applicant: ApplicantData
): Promise<SubmissionResult> {
  const parsed = parseLeverUrl(applyUrl)
  if (!parsed) {
    return { success: false, error: 'Could not parse Lever URL' }
  }

  const { company, postingId } = parsed
  const submitUrl = `https://api.lever.co/v0/postings/${company}/${postingId}/apply`

  try {
    const formData = new FormData()

    // Lever standard fields
    formData.append('name', applicant.name)
    formData.append('email', applicant.email)

    if (applicant.phone) {
      formData.append('phone', applicant.phone)
    }
    if (applicant.linkedinUrl) {
      formData.append('urls[LinkedIn]', applicant.linkedinUrl)
    }
    if (applicant.githubUrl) {
      formData.append('urls[GitHub]', applicant.githubUrl)
    }
    if (applicant.location) {
      formData.append('location', applicant.location)
    }

    // Resume
    if (applicant.resumePath) {
      const absolutePath = path.join(process.cwd(), 'public', applicant.resumePath.replace(/^\//, ''))
      if (existsSync(absolutePath)) {
        const resumeBuffer = await import('fs/promises').then((fs) => fs.readFile(absolutePath))
        formData.append('resume', new Blob([resumeBuffer], { type: 'application/pdf' }), 'resume.pdf')
      }
    }

    const res = await fetch(submitUrl, {
      method: 'POST',
      headers: {
        'X-Lever-Referrer': 'chiaro-auto-apply',
      },
      body: formData,
    })

    if (res.ok) {
      const data = await res.json() as { ok?: boolean; applicationId?: string }
      return { success: true, applicationId: data.applicationId }
    }

    const errorText = await res.text()
    return { success: false, error: `Lever returned ${res.status}: ${errorText.slice(0, 200)}` }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error during Lever submission',
    }
  }
}
