import { describe, it, expect } from 'vitest'
import { classifyAts, parseGreenhouseUrl, parseLeverUrl } from '@/lib/ats/classifier'
import { AtsType } from '@prisma/client'

describe('classifyAts', () => {
  it('classifies boards.greenhouse.io URLs', () => {
    expect(classifyAts('https://boards.greenhouse.io/linear/jobs/4567890')).toBe(AtsType.GREENHOUSE)
  })

  it('classifies greenhouse.io URLs without boards subdomain', () => {
    expect(classifyAts('https://job-boards.greenhouse.io/acme/jobs/123')).toBe(AtsType.GREENHOUSE)
  })

  it('classifies jobs.lever.co URLs', () => {
    expect(classifyAts('https://jobs.lever.co/cursor/ab12cd34-ef56-7890-abcd-ef1234567890')).toBe(AtsType.LEVER)
  })

  it('classifies lever.co URLs', () => {
    expect(classifyAts('https://lever.co/somecompany/posting')).toBe(AtsType.LEVER)
  })

  it('classifies myworkday.com URLs', () => {
    expect(classifyAts('https://stripe.wd5.myworkday.com/stripe/d/job/1234')).toBe(AtsType.WORKDAY)
  })

  it('classifies workday.com URLs', () => {
    expect(classifyAts('https://acme.workday.com/en-US/staffing/job')).toBe(AtsType.WORKDAY)
  })

  it('classifies unknown URLs as CUSTOM', () => {
    expect(classifyAts('https://anthropic.com/careers/4567890')).toBe(AtsType.CUSTOM)
  })

  it('classifies empty string as CUSTOM', () => {
    expect(classifyAts('')).toBe(AtsType.CUSTOM)
  })

  it('handles URLs with query parameters', () => {
    expect(classifyAts('https://boards.greenhouse.io/openai/jobs/99?gh_jid=99')).toBe(AtsType.GREENHOUSE)
  })

  it('handles URLs with trailing slashes', () => {
    expect(classifyAts('https://jobs.lever.co/somecompany/posting-id/')).toBe(AtsType.LEVER)
  })
})

describe('parseGreenhouseUrl', () => {
  it('parses standard Greenhouse board URL', () => {
    const result = parseGreenhouseUrl('https://boards.greenhouse.io/linear/jobs/4567890')
    expect(result).toEqual({ board: 'linear', jobId: '4567890' })
  })

  it('returns null for non-Greenhouse URL', () => {
    expect(parseGreenhouseUrl('https://jobs.lever.co/company/id')).toBeNull()
  })

  it('returns null for malformed Greenhouse URL', () => {
    expect(parseGreenhouseUrl('https://greenhouse.io/company')).toBeNull()
  })
})

describe('parseLeverUrl', () => {
  it('parses standard Lever URL', () => {
    const result = parseLeverUrl('https://jobs.lever.co/cursor/ab12cd34-ef56-7890-abcd-ef1234567890')
    expect(result).toEqual({
      company: 'cursor',
      postingId: 'ab12cd34-ef56-7890-abcd-ef1234567890',
    })
  })

  it('returns null for non-Lever URL', () => {
    expect(parseLeverUrl('https://boards.greenhouse.io/company/jobs/123')).toBeNull()
  })

  it('returns null for Lever URL without UUID posting ID', () => {
    expect(parseLeverUrl('https://jobs.lever.co/company/not-a-uuid')).toBeNull()
  })
})
