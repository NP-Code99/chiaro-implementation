import { describe, it, expect, vi, beforeEach } from 'vitest'
import { submitToLever } from '@/lib/ats/lever'
import type { ApplicantData } from '@/lib/ats/types'

const APPLICANT: ApplicantData = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+1 415 555 0100',
  linkedinUrl: 'https://linkedin.com/in/ada',
  githubUrl: 'https://github.com/ada',
  location: 'San Francisco, CA',
}

const VALID_LEVER_URL = 'https://jobs.lever.co/cursor/ab12cd34-ef56-7890-abcd-ef1234567890'

describe('submitToLever', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('returns error for unparseable URL', async () => {
    const result = await submitToLever('https://notlever.io/jobs/1', APPLICANT)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Could not parse/i)
  })

  it('returns error for Lever URL without valid UUID posting ID', async () => {
    const result = await submitToLever('https://jobs.lever.co/company/not-uuid', APPLICANT)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Could not parse/i)
  })

  it('succeeds when Lever API returns 200', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, applicationId: 'lever-app-123' }),
    } as Response)

    const result = await submitToLever(VALID_LEVER_URL, APPLICANT)
    expect(result.success).toBe(true)
    expect(result.applicationId).toBe('lever-app-123')
  })

  it('returns error on 4xx from Lever', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => 'Bad Request: missing fields',
    } as Response)

    const result = await submitToLever(VALID_LEVER_URL, APPLICANT)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/400/)
  })

  it('handles network errors gracefully', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'))

    const result = await submitToLever(VALID_LEVER_URL, APPLICANT)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/ECONNREFUSED/)
  })
})
