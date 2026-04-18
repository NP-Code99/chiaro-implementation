export type ATSType =
  | 'greenhouse'
  | 'lever'
  | 'workday'
  | 'ashby'
  | 'bamboohr'
  | 'smartrecruiters'
  | 'jobvite'
  | 'icims'
  | 'taleo'
  | 'startup_jobs_native'
  | 'custom'
  | 'none'

export type ATSDifficulty = 'easy' | 'medium' | 'hard' | 'skip'

const PATTERNS: Array<{ pattern: RegExp; atsType: ATSType }> = [
  { pattern: /boards\.greenhouse\.io/i,  atsType: 'greenhouse' },
  { pattern: /grnh\.se/i,                atsType: 'greenhouse' },
  { pattern: /jobs\.lever\.co/i,         atsType: 'lever' },
  { pattern: /lever\.co/i,               atsType: 'lever' },
  { pattern: /myworkdayjobs\.com/i,      atsType: 'workday' },
  { pattern: /myworkday\.com/i,          atsType: 'workday' },
  { pattern: /workday\.com/i,            atsType: 'workday' },
  { pattern: /ashbyhq\.com/i,            atsType: 'ashby' },
  { pattern: /bamboohr\.com/i,           atsType: 'bamboohr' },
  { pattern: /smartrecruiters\.com/i,    atsType: 'smartrecruiters' },
  { pattern: /jobvite\.com/i,            atsType: 'jobvite' },
  { pattern: /icims\.com/i,              atsType: 'icims' },
  { pattern: /taleo\.net/i,              atsType: 'taleo' },
  // startup.jobs native apply links — always appear as startup.jobs/apply/UUID
  { pattern: /startup\.jobs\/apply\//i,  atsType: 'startup_jobs_native' },
]

export function classifyATS(url: string | null): ATSType {
  if (!url) return 'none'
  for (const { pattern, atsType } of PATTERNS) {
    if (pattern.test(url)) return atsType
  }
  return 'custom'
}

const LABELS: Record<ATSType, string> = {
  greenhouse:          'Greenhouse',
  lever:               'Lever',
  workday:             'Workday',
  ashby:               'Ashby',
  bamboohr:            'BambooHR',
  smartrecruiters:     'SmartRecruiters',
  jobvite:             'Jobvite',
  icims:               'iCIMS',
  taleo:               'Taleo',
  startup_jobs_native: 'Startup.jobs',
  custom:              'Custom',
  none:                'No Apply Link',
}

export function getATSLabel(atsType: ATSType): string {
  return LABELS[atsType] ?? 'Custom'
}

const DIFFICULTY: Record<ATSType, ATSDifficulty> = {
  greenhouse:          'easy',
  lever:               'easy',
  startup_jobs_native: 'easy',
  ashby:               'medium',
  bamboohr:            'medium',
  smartrecruiters:     'medium',
  jobvite:             'medium',
  workday:             'hard',
  icims:               'hard',
  taleo:               'hard',
  custom:              'hard',
  none:                'skip',
}

export function getATSDifficulty(atsType: ATSType): ATSDifficulty {
  return DIFFICULTY[atsType]
}
