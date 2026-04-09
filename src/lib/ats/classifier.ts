import { AtsType } from '@prisma/client'

const PATTERNS: Array<{ pattern: RegExp; atsType: AtsType }> = [
  { pattern: /greenhouse\.io/i, atsType: AtsType.GREENHOUSE },
  { pattern: /boards\.greenhouse\.io/i, atsType: AtsType.GREENHOUSE },
  { pattern: /jobs\.lever\.co/i, atsType: AtsType.LEVER },
  { pattern: /lever\.co/i, atsType: AtsType.LEVER },
  { pattern: /myworkday\.com/i, atsType: AtsType.WORKDAY },
  { pattern: /wd\d+\.myworkday\.com/i, atsType: AtsType.WORKDAY },
  { pattern: /workday\.com/i, atsType: AtsType.WORKDAY },
]

export function classifyAts(url: string): AtsType {
  for (const { pattern, atsType } of PATTERNS) {
    if (pattern.test(url)) {
      return atsType
    }
  }
  return AtsType.CUSTOM
}

export function parseGreenhouseUrl(url: string): { board: string; jobId: string } | null {
  // https://boards.greenhouse.io/{board}/jobs/{jobId}
  const match = url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/)
  if (!match) return null
  return { board: match[1], jobId: match[2] }
}

export function parseLeverUrl(url: string): { company: string; postingId: string } | null {
  // https://jobs.lever.co/{company}/{postingId}
  const match = url.match(/lever\.co\/([^/]+)\/([a-f0-9-]{36})/)
  if (!match) return null
  return { company: match[1], postingId: match[2] }
}
