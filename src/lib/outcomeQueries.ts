import { prisma } from './db'

export interface AtsStats {
  atsType: string
  total: number
  success: number
  partial: number
  failed: number
  captchaBlocked: number
  verificationRequired: number
  alreadyApplied: number
  successRate: number
  avgDurationMs: number | null
}

export interface FieldFailureRate {
  fieldLabel: string
  atsType: string
  total: number
  filled: number
  failed: number
  skipped: number
  failureRate: number
}

export interface RecentOutcome {
  id: string
  applicationId: string
  overallStatus: string
  submitSucceeded: boolean
  atsType: string
  bypassMethod: string | null
  durationMs: number | null
  errorMessage: string | null
  steelSessionId: string | null
  steelViewUrl: string | null
  fieldsFilled: number
  fieldsSkipped: number
  fieldsFailed: number
  createdAt: Date
  job: { company: string; role: string; applyUrl: string } | null
}

export async function getAtsSummaryStats(since?: Date): Promise<AtsStats[]> {
  const outcomes = await prisma.applicationOutcome.findMany({
    where: since ? { createdAt: { gte: since } } : undefined,
    select: {
      atsType: true,
      overallStatus: true,
      durationMs: true,
    },
  })

  const byAts = new Map<string, {
    total: number; success: number; partial: number; failed: number
    captchaBlocked: number; verificationRequired: number; alreadyApplied: number
    durations: number[]
  }>()

  for (const o of outcomes) {
    if (!byAts.has(o.atsType)) {
      byAts.set(o.atsType, { total: 0, success: 0, partial: 0, failed: 0, captchaBlocked: 0, verificationRequired: 0, alreadyApplied: 0, durations: [] })
    }
    const s = byAts.get(o.atsType)!
    s.total++
    if (o.overallStatus === 'SUCCESS') s.success++
    else if (o.overallStatus === 'PARTIAL') s.partial++
    else if (o.overallStatus === 'FAILED') s.failed++
    else if (o.overallStatus === 'CAPTCHA_BLOCKED') s.captchaBlocked++
    else if (o.overallStatus === 'VERIFICATION_REQUIRED') s.verificationRequired++
    else if (o.overallStatus === 'ALREADY_APPLIED') s.alreadyApplied++
    if (o.durationMs != null) s.durations.push(o.durationMs)
  }

  return Array.from(byAts.entries()).map(([atsType, s]) => ({
    atsType,
    total: s.total,
    success: s.success,
    partial: s.partial,
    failed: s.failed,
    captchaBlocked: s.captchaBlocked,
    verificationRequired: s.verificationRequired,
    alreadyApplied: s.alreadyApplied,
    successRate: s.total > 0 ? s.success / s.total : 0,
    avgDurationMs: s.durations.length > 0
      ? Math.round(s.durations.reduce((a, b) => a + b, 0) / s.durations.length)
      : null,
  })).sort((a, b) => b.total - a.total)
}

export async function getFieldFailureRates(atsType?: string, limit = 50): Promise<FieldFailureRate[]> {
  const fields = await prisma.fieldOutcome.findMany({
    where: atsType ? { atsType } : undefined,
    select: {
      fieldLabel: true,
      atsType: true,
      status: true,
    },
  })

  const key = (f: { fieldLabel: string; atsType: string }) => `${f.atsType}::${f.fieldLabel}`
  const byField = new Map<string, { fieldLabel: string; atsType: string; filled: number; failed: number; skipped: number }>()

  for (const f of fields) {
    const k = key(f)
    if (!byField.has(k)) byField.set(k, { fieldLabel: f.fieldLabel, atsType: f.atsType, filled: 0, failed: 0, skipped: 0 })
    const s = byField.get(k)!
    if (f.status === 'FILLED' || f.status === 'PRE_FILLED') s.filled++
    else if (f.status === 'FAILED' || f.status === 'BLOCKED') s.failed++
    else if (f.status === 'SKIPPED') s.skipped++
  }

  return Array.from(byField.values())
    .map(s => ({
      ...s,
      total: s.filled + s.failed + s.skipped,
      failureRate: (s.filled + s.failed) > 0 ? s.failed / (s.filled + s.failed) : 0,
    }))
    .sort((a, b) => b.failureRate - a.failureRate || b.total - a.total)
    .slice(0, limit)
}

export async function getRecentOutcomes(limit = 20, offset = 0): Promise<RecentOutcome[]> {
  const outcomes = await prisma.applicationOutcome.findMany({
    take: limit,
    skip: offset,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      applicationId: true,
      overallStatus: true,
      submitSucceeded: true,
      atsType: true,
      bypassMethod: true,
      durationMs: true,
      errorMessage: true,
      steelSessionId: true,
      steelViewUrl: true,
      fieldsFilled: true,
      fieldsSkipped: true,
      fieldsFailed: true,
      createdAt: true,
      application: {
        select: {
          job: { select: { company: true, role: true, applyUrl: true } },
        },
      },
    },
  })

  return outcomes.map(o => ({
    ...o,
    job: o.application?.job ?? null,
    application: undefined,
  }))
}

export async function getOutcomeDetail(applicationId: string) {
  return prisma.applicationOutcome.findUnique({
    where: { applicationId },
    include: {
      fieldOutcomes: {
        orderBy: { createdAt: 'asc' },
      },
    },
  })
}

export async function getOverallSummary(since?: Date) {
  const outcomes = await prisma.applicationOutcome.findMany({
    where: since ? { createdAt: { gte: since } } : undefined,
    select: { overallStatus: true, submitSucceeded: true, durationMs: true },
  })

  const total = outcomes.length
  const success = outcomes.filter(o => o.overallStatus === 'SUCCESS').length
  const captchaBlocked = outcomes.filter(o => o.overallStatus === 'CAPTCHA_BLOCKED').length
  const durations = outcomes.map(o => o.durationMs).filter((d): d is number => d != null)

  return {
    total,
    success,
    successRate: total > 0 ? success / total : 0,
    captchaBlockedRate: total > 0 ? captchaBlocked / total : 0,
    avgDurationMs: durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null,
    breakdown: {
      SUCCESS: outcomes.filter(o => o.overallStatus === 'SUCCESS').length,
      PARTIAL: outcomes.filter(o => o.overallStatus === 'PARTIAL').length,
      FAILED: outcomes.filter(o => o.overallStatus === 'FAILED').length,
      CAPTCHA_BLOCKED: captchaBlocked,
      VERIFICATION_REQUIRED: outcomes.filter(o => o.overallStatus === 'VERIFICATION_REQUIRED').length,
      ALREADY_APPLIED: outcomes.filter(o => o.overallStatus === 'ALREADY_APPLIED').length,
    },
  }
}
