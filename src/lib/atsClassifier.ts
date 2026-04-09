export type ATSType = 'greenhouse' | 'lever' | 'workday' | 'ashby' | 'bamboohr' | 'custom' | 'none'
export type ATSDifficulty = 'easy' | 'medium' | 'hard' | 'skip'

const PATTERNS: Array<{ pattern: RegExp; atsType: ATSType }> = [
  { pattern: /boards\.greenhouse\.io/i, atsType: 'greenhouse' },
  { pattern: /grnh\.se/i, atsType: 'greenhouse' },
  { pattern: /jobs\.lever\.co/i, atsType: 'lever' },
  { pattern: /lever\.co/i, atsType: 'lever' },
  { pattern: /myworkdayjobs\.com/i, atsType: 'workday' },
  { pattern: /myworkday\.com/i, atsType: 'workday' },
  { pattern: /workday\.com/i, atsType: 'workday' },
  { pattern: /ashbyhq\.com/i, atsType: 'ashby' },
  { pattern: /bamboohr\.com/i, atsType: 'bamboohr' },
]

export function classifyATS(url: string | null): ATSType {
  if (!url) return 'none'
  for (const { pattern, atsType } of PATTERNS) {
    if (pattern.test(url)) return atsType
  }
  return 'custom'
}

const LABELS: Record<ATSType, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  workday: 'Workday',
  ashby: 'Ashby',
  bamboohr: 'BambooHR',
  custom: 'Custom',
  none: 'No Apply Link',
}

export function getATSLabel(atsType: ATSType): string {
  return LABELS[atsType]
}

const DIFFICULTY: Record<ATSType, ATSDifficulty> = {
  greenhouse: 'easy',
  lever: 'easy',
  ashby: 'medium',
  bamboohr: 'medium',
  workday: 'hard',
  custom: 'hard',
  none: 'skip',
}

export function getATSDifficulty(atsType: ATSType): ATSDifficulty {
  return DIFFICULTY[atsType]
}
