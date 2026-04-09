import { createReadStream, existsSync } from 'fs'
import path from 'path'
import { parseGreenhouseUrl } from './classifier'
import type { ApplicantData, SubmissionResult } from './types'

export async function submitToGreenhouse(
  applyUrl: string,
  applicant: ApplicantData
): Promise<SubmissionResult> {
  const parsed = parseGreenhouseUrl(applyUrl)
  if (!parsed) {
    return { success: false, error: 'Could not parse Greenhouse URL' }
  }

  const { board, jobId } = parsed
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}`

  try {
    // First fetch the job to get required questions
    const jobRes = await fetch(apiUrl)
    if (!jobRes.ok) {
      return { success: false, error: `Job not found: ${jobRes.status}` }
    }
    const jobData = await jobRes.json() as { questions?: Array<{ fields: Array<{ name: string; required: boolean }> }> }

    // Build form data for standard fields
    const formData = new FormData()
    formData.append('first_name', applicant.name.split(' ')[0] ?? applicant.name)
    formData.append('last_name', applicant.name.split(' ').slice(1).join(' ') || applicant.name.split(' ')[0])
    formData.append('email', applicant.email)

    if (applicant.phone) {
      formData.append('phone', applicant.phone)
    }
    if (applicant.linkedinUrl) {
      formData.append('question_linkedin_profile_url', applicant.linkedinUrl)
    }

    // Map questions from job posting
    if (Array.isArray(jobData.questions)) {
      for (const q of jobData.questions) {
        for (const field of q.fields ?? []) {
          if (field.name === 'cover_letter' && !formData.has('cover_letter')) {
            formData.append('cover_letter', generateCoverLetter(applicant))
          }
        }
      }
    }

    // Attach resume if available
    if (applicant.resumePath) {
      const absolutePath = path.join(process.cwd(), 'public', applicant.resumePath.replace(/^\//, ''))
      if (existsSync(absolutePath)) {
        const resumeBuffer = await import('fs/promises').then((fs) => fs.readFile(absolutePath))
        formData.append('resume', new Blob([resumeBuffer], { type: 'application/pdf' }), 'resume.pdf')
      }
    }

    const submitUrl = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}`
    const res = await fetch(submitUrl, {
      method: 'POST',
      body: formData,
    })

    if (res.ok || res.status === 200) {
      return { success: true }
    }

    const errorText = await res.text()
    return { success: false, error: `Greenhouse returned ${res.status}: ${errorText.slice(0, 200)}` }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error during Greenhouse submission',
    }
  }
}

function generateCoverLetter(applicant: ApplicantData): string {
  return `Dear Hiring Team,

I am writing to express my strong interest in this position. With my background and experience, I am confident I would be a valuable addition to your team.

I am particularly excited about this opportunity and would welcome the chance to discuss how my skills align with your needs.

Best regards,
${applicant.name}`
}
