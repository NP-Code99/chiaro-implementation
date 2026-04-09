import { describe, it, expect, vi, beforeEach } from 'vitest'
import { submitToGreenhouse } from '@/lib/ats/greenhouse'
import type { ApplicantData } from '@/lib/ats/types'

const APPLICANT: ApplicantData = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '+1 415 555 0100',
  linkedinUrl: 'https://linkedin.com/in/ada',
  location: 'San Francisco, CA',
}

describe('submitToGreenhouse', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('returns error for unparseable URL', async () => {
    const result = await submitToGreenhouse('https://notgreenhouse.io/jobs/1', APPLICANT)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Could not parse/i)
  })

  it('returns error when job fetch returns 404', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    } as Response)

    const result = await submitToGreenhouse(
      'https://boards.greenhouse.io/acme/jobs/999',
      APPLICANT
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/404/)
  })

  it('succeeds when Greenhouse API returns 200', async () => {
    // First call: job fetch
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ questions: [] }),
      } as Response)
      // Second call: submit
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response)

    const result = await submitToGreenhouse(
      'https://boards.greenhouse.io/acme/jobs/12345',
      APPLICANT
    )
    expect(result.success).toBe(true)
  })

  it('returns error message on non-200 submit response', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ questions: [] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => 'Validation failed: email is invalid',
      } as Response)

    const result = await submitToGreenhouse(
      'https://boards.greenhouse.io/acme/jobs/12345',
      APPLICANT
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/422/)
  })

  it('returns error when fetch throws network error', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'))

    const result = await submitToGreenhouse(
      'https://boards.greenhouse.io/acme/jobs/12345',
      APPLICANT
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Network error/)
  })
})
