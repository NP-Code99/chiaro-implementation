import { describe, it, expect } from 'vitest'
import { classifyATS, getATSLabel, getATSDifficulty } from '@/lib/atsClassifier'

// ── classifyATS ─────────────────────────────────────────────────────────────

describe('classifyATS', () => {
  // null / missing URL
  it('returns none for null URL', () => {
    expect(classifyATS(null)).toBe('none')
  })

  it('returns none for empty string', () => {
    expect(classifyATS('')).toBe('none')
  })

  // Greenhouse
  it('detects boards.greenhouse.io', () => {
    expect(classifyATS('https://boards.greenhouse.io/linear/jobs/4567890')).toBe('greenhouse')
  })

  it('detects grnh.se shortlink', () => {
    expect(classifyATS('https://grnh.se/abc123')).toBe('greenhouse')
  })

  it('detects greenhouse with query params', () => {
    expect(classifyATS('https://boards.greenhouse.io/acme/jobs/99?gh_jid=99')).toBe('greenhouse')
  })

  // Lever
  it('detects jobs.lever.co', () => {
    expect(classifyATS('https://jobs.lever.co/cursor/ab12cd34-ef56-7890-abcd-ef1234567890')).toBe('lever')
  })

  it('detects lever.co without jobs subdomain', () => {
    expect(classifyATS('https://lever.co/somecompany/posting')).toBe('lever')
  })

  // Workday
  it('detects myworkdayjobs.com', () => {
    expect(classifyATS('https://amazon.wd5.myworkdayjobs.com/external/job/Seattle/SDE')).toBe('workday')
  })

  it('detects workday.com', () => {
    expect(classifyATS('https://stripe.workday.com/en-US/staffing/job/1234')).toBe('workday')
  })

  it('detects myworkday.com variant', () => {
    expect(classifyATS('https://stripe.wd5.myworkday.com/stripe/d/job/1234')).toBe('workday')
  })

  // Ashby
  it('detects ashbyhq.com', () => {
    expect(classifyATS('https://jobs.ashbyhq.com/openai/senior-engineer')).toBe('ashby')
  })

  it('detects ashbyhq.com subdomain variant', () => {
    expect(classifyATS('https://ashbyhq.com/acme/apply')).toBe('ashby')
  })

  // BambooHR
  it('detects bamboohr.com', () => {
    expect(classifyATS('https://acme.bamboohr.com/careers/123')).toBe('bamboohr')
  })

  it('detects bamboohr with different subdomain', () => {
    expect(classifyATS('https://recruitment.bamboohr.com/jobs/apply')).toBe('bamboohr')
  })

  // Custom
  it('returns custom for anthropic direct careers page', () => {
    expect(classifyATS('https://anthropic.com/careers/4567890')).toBe('custom')
  })

  it('returns custom for openai careers', () => {
    expect(classifyATS('https://openai.com/careers/frontend-engineer')).toBe('custom')
  })

  it('returns custom for apply.workable.com', () => {
    expect(classifyATS('https://apply.workable.com/huggingface/j/AB12CD34EF')).toBe('custom')
  })

  it('returns custom for arbitrary domain', () => {
    expect(classifyATS('https://example.com/apply')).toBe('custom')
  })

  // Case insensitivity
  it('is case-insensitive for greenhouse', () => {
    expect(classifyATS('https://BOARDS.GREENHOUSE.IO/company/jobs/1')).toBe('greenhouse')
  })

  it('is case-insensitive for lever', () => {
    expect(classifyATS('https://JOBS.LEVER.CO/company/uuid')).toBe('lever')
  })
})

// ── getATSLabel ──────────────────────────────────────────────────────────────

describe('getATSLabel', () => {
  it('returns Greenhouse for greenhouse', () => {
    expect(getATSLabel('greenhouse')).toBe('Greenhouse')
  })

  it('returns Lever for lever', () => {
    expect(getATSLabel('lever')).toBe('Lever')
  })

  it('returns Workday for workday', () => {
    expect(getATSLabel('workday')).toBe('Workday')
  })

  it('returns Ashby for ashby', () => {
    expect(getATSLabel('ashby')).toBe('Ashby')
  })

  it('returns BambooHR for bamboohr', () => {
    expect(getATSLabel('bamboohr')).toBe('BambooHR')
  })

  it('returns Custom for custom', () => {
    expect(getATSLabel('custom')).toBe('Custom')
  })

  it('returns No Apply Link for none', () => {
    expect(getATSLabel('none')).toBe('No Apply Link')
  })
})

// ── getATSDifficulty ─────────────────────────────────────────────────────────

describe('getATSDifficulty', () => {
  it('greenhouse is easy', () => {
    expect(getATSDifficulty('greenhouse')).toBe('easy')
  })

  it('lever is easy', () => {
    expect(getATSDifficulty('lever')).toBe('easy')
  })

  it('ashby is medium', () => {
    expect(getATSDifficulty('ashby')).toBe('medium')
  })

  it('bamboohr is medium', () => {
    expect(getATSDifficulty('bamboohr')).toBe('medium')
  })

  it('workday is hard', () => {
    expect(getATSDifficulty('workday')).toBe('hard')
  })

  it('custom is hard', () => {
    expect(getATSDifficulty('custom')).toBe('hard')
  })

  it('none returns skip', () => {
    expect(getATSDifficulty('none')).toBe('skip')
  })
})
