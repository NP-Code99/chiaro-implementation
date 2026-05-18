/**
 * String constants that replace Prisma enums (SQLite doesn't support native enums).
 * Import from here instead of @prisma/client.
 */

export const ApplicationStatus = {
  PENDING:               'PENDING',
  APPLYING:              'APPLYING',
  APPLIED:               'APPLIED',
  FAILED:                'FAILED',
  NEEDS_REVIEW:          'NEEDS_REVIEW',
  NEEDS_INFO:            'NEEDS_INFO',
  VERIFICATION_PENDING:  'VERIFICATION_PENDING',
} as const

export type ApplicationStatus = typeof ApplicationStatus[keyof typeof ApplicationStatus]

export const AtsType = {
  GREENHOUSE:          'GREENHOUSE',
  LEVER:               'LEVER',
  WORKDAY:             'WORKDAY',
  ASHBY:               'ASHBY',
  BAMBOOHR:            'BAMBOOHR',
  SMARTRECRUITERS:     'SMARTRECRUITERS',
  JOBVITE:             'JOBVITE',
  ICIMS:               'ICIMS',
  TALEO:               'TALEO',
  TRAKSTAR:            'TRAKSTAR',
  STARTUP_JOBS_NATIVE: 'STARTUP_JOBS_NATIVE',
  CUSTOM:              'CUSTOM',
} as const

export type AtsType = typeof AtsType[keyof typeof AtsType]
