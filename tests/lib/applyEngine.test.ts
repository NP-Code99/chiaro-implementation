import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyToJob, type ApplicationResult } from '@/lib/applyEngine'
import type { UserProfile } from '@/lib/userProfile'
import type { Job } from '@prisma/client'
import { AtsType } from '@prisma/client'

const PROFILE: UserProfile = {
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
  bio: 'Great engineer.',
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    company: 'TestCo',
    role: 'Engineer',
    description: 'Build things',
    applyUrl: 'https://boards.greenhouse.io/testco/jobs/123',
    atsType: AtsType.GREENHOUSE,
    location: 'Remote',
    salaryMin: 150000,
    salaryMax: 200000,
    tags: ['Remote', 'TypeScript'],
    logoUrl: null,
    manualReviewReason: null,
    createdAt: new Date(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

// ── Greenhouse ────────────────────────────────────────────────────────────────

describe('applyToJob — Greenhouse', () => {
  it('returns status applied on 2xx', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as Response)

    const result = await applyToJob(makeJob(), PROFILE, 'test-app-id')
    expect(result.status).toBe('applied')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('returns status failed on non-2xx', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false, status: 422, text: async () => 'Unprocessable'
    } as Response)

    const result = await applyToJob(makeJob(), PROFILE, 'test-app-id')
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toMatch(/422/)
  })

  it('returns failed when applyUrl cannot be parsed', async () => {
    const job = makeJob({ applyUrl: 'https://greenhouse.io/bad' })
    const result = await applyToJob(job, PROFILE, 'test-app-id')
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toBeTruthy()
  })

  it('returns failed on network error', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'))
    const result = await applyToJob(makeJob(), PROFILE, 'test-app-id')
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toMatch(/Network error/)
  })

  it('includes applyUrl in result', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)
    const result = await applyToJob(makeJob(), PROFILE, 'test-app-id')
    expect(result.applyUrl).toBe('https://boards.greenhouse.io/testco/jobs/123')
  })
})

// ── Lever ─────────────────────────────────────────────────────────────────────

describe('applyToJob — Lever', () => {
  const leverJob = makeJob({
    applyUrl: 'https://jobs.lever.co/cursor/ab12cd34-ef56-7890-abcd-ef1234567890',
    atsType: AtsType.LEVER,
  })

  it('returns status applied on 2xx', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) } as Response)
    const result = await applyToJob(leverJob, PROFILE, 'test-app-id')
    expect(result.status).toBe('applied')
  })

  it('returns failed on non-2xx', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false, status: 400, text: async () => 'Bad Request'
    } as Response)
    const result = await applyToJob(leverJob, PROFILE, 'test-app-id')
    expect(result.status).toBe('failed')
  })

  it('returns failed when URL has no valid UUID', async () => {
    const job = makeJob({ applyUrl: 'https://jobs.lever.co/company/not-a-uuid', atsType: AtsType.LEVER })
    const result = await applyToJob(job, PROFILE, 'test-app-id')
    expect(result.status).toBe('failed')
  })
})

// ── needs_review types ────────────────────────────────────────────────────────

describe('applyToJob — needs_review types', () => {
  it('returns needs_review for Workday', async () => {
    const job = makeJob({
      applyUrl: 'https://stripe.wd5.myworkday.com/job/1',
      atsType: AtsType.WORKDAY,
    })
    const result = await applyToJob(job, PROFILE, 'test-app-id')
    expect(result.status).toBe('needs_review')
    expect(result.errorMessage).toMatch(/browser automation/i)
    expect(result.applyUrl).toBeTruthy()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns needs_review for Custom', async () => {
    const job = makeJob({
      applyUrl: 'https://anthropic.com/careers/123',
      atsType: AtsType.CUSTOM,
    })
    const result = await applyToJob(job, PROFILE, 'test-app-id')
    expect(result.status).toBe('needs_review')
    expect(result.errorMessage).toMatch(/browser automation/i)
  })

  it('returns needs_review with email message for null applyUrl', async () => {
    const job = makeJob({ applyUrl: null as unknown as string, atsType: AtsType.CUSTOM })
    const result = await applyToJob(job, PROFILE, 'test-app-id')
    expect(result.status).toBe('needs_review')
    expect(result.errorMessage).toMatch(/email/i)
  })
})
