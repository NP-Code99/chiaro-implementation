/**
 * outcomeLogger.ts — writes ApplicationOutcome and FieldOutcome rows after each apply run.
 *
 * Usage pattern in browserApply.ts:
 *   const logger = createOutcomeLogger(applicationId, atsType)
 *   logger.logField({ fieldLabel: 'First Name', fieldType: 'text', status: 'FILLED', filledValue: 'John' })
 *   await logger.flush({ overallStatus: 'SUCCESS', submitSucceeded: true, steelSessionId, steelViewUrl, durationMs })
 */

import { prisma } from './db'

// ── Types ─────────────────────────────────────────────────────────────────────

export type OverallStatus =
  | 'SUCCESS'
  | 'PARTIAL'
  | 'FAILED'
  | 'CAPTCHA_BLOCKED'
  | 'VERIFICATION_REQUIRED'
  | 'ALREADY_APPLIED'

export type FieldStatus = 'FILLED' | 'SKIPPED' | 'FAILED' | 'PRE_FILLED' | 'BLOCKED'

export type FieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'file'
  | 'date'
  | 'unknown'

export type PageSection =
  | 'personal_info'
  | 'work_experience'
  | 'education'
  | 'custom_questions'
  | 'resume'
  | 'cover_letter'
  | 'demographics'
  | 'other'

export interface FieldOutcomeInput {
  fieldLabel: string
  fieldType: FieldType
  status: FieldStatus
  fieldName?: string
  selector?: string
  pageSection?: PageSection
  filledValue?: string
  skipReason?: string
  errorMessage?: string
}

export interface FlushInput {
  overallStatus: OverallStatus
  submitSucceeded: boolean
  steelSessionId?: string | null
  steelViewUrl?: string | null
  bypassMethod?: string | null
  durationMs?: number
  startedAt?: Date
  errorMessage?: string | null
  errorCode?: string | null
}

// ── Logger factory ────────────────────────────────────────────────────────────

export function createOutcomeLogger(applicationId: string, atsType: string) {
  const fields: FieldOutcomeInput[] = []
  const startedAt = new Date()

  function logField(input: FieldOutcomeInput) {
    // Truncate filled values to 500 chars so we don't bloat the DB with resume text
    if (input.filledValue && input.filledValue.length > 500) {
      input.filledValue = input.filledValue.slice(0, 500) + '…'
    }
    fields.push(input)
  }

  async function flush(input: FlushInput): Promise<void> {
    const filled = fields.filter(f => f.status === 'FILLED' || f.status === 'PRE_FILLED').length
    const skipped = fields.filter(f => f.status === 'SKIPPED').length
    const failed = fields.filter(f => f.status === 'FAILED' || f.status === 'BLOCKED').length

    try {
      await prisma.applicationOutcome.upsert({
        where: { applicationId },
        create: {
          applicationId,
          steelSessionId: input.steelSessionId ?? null,
          steelViewUrl:   input.steelViewUrl ?? null,
          overallStatus:  input.overallStatus,
          submitSucceeded: input.submitSucceeded,
          atsType,
          bypassMethod:   input.bypassMethod ?? null,
          durationMs:     input.durationMs ?? null,
          startedAt,
          completedAt:    new Date(),
          errorMessage:   input.errorMessage ?? null,
          errorCode:      input.errorCode ?? null,
          fieldsFilled:   filled,
          fieldsSkipped:  skipped,
          fieldsFailed:   failed,
          fieldOutcomes: {
            create: fields.map(f => ({
              fieldLabel:   f.fieldLabel,
              fieldName:    f.fieldName ?? null,
              fieldType:    f.fieldType,
              selector:     f.selector ?? null,
              pageSection:  f.pageSection ?? null,
              status:       f.status,
              filledValue:  f.filledValue ?? null,
              skipReason:   f.skipReason ?? null,
              errorMessage: f.errorMessage ?? null,
              atsType,
            })),
          },
        },
        update: {
          steelSessionId:  input.steelSessionId ?? undefined,
          steelViewUrl:    input.steelViewUrl ?? undefined,
          overallStatus:   input.overallStatus,
          submitSucceeded: input.submitSucceeded,
          bypassMethod:    input.bypassMethod ?? undefined,
          durationMs:      input.durationMs ?? undefined,
          completedAt:     new Date(),
          errorMessage:    input.errorMessage ?? undefined,
          errorCode:       input.errorCode ?? undefined,
          fieldsFilled:    filled,
          fieldsSkipped:   skipped,
          fieldsFailed:    failed,
        },
      })
    } catch (err) {
      // Never let logging failures crash an apply run
      console.error('[outcomeLogger] Failed to write outcome:', err)
    }
  }

  return { logField, flush, startedAt }
}

export type OutcomeLogger = ReturnType<typeof createOutcomeLogger>
