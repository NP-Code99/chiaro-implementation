'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { EmptyState } from '@/components/ui/EmptyState'
import Link from 'next/link'
import toast from 'react-hot-toast'
import type { Application, Job, PausedApplication } from '@prisma/client'
import { ApplicationStatus } from '@/lib/prismaEnums'
import { loadProfile } from '@/lib/userProfile'

type AppWithJob = Application & {
  job: Job
  pausedApplication: PausedApplication | null
  verificationExpiry?: Date | string | null
}

type PendingQuestion = { fieldLabel: string; fieldType: string; selector: string }

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CFG: Record<ApplicationStatus, { label: string; dotColor: string; bg: string; color: string }> = {
  PENDING:               { label: 'Queued',          dotColor: 'oklch(55% 0.015 240)',  bg: 'oklch(45% 0.01 240 / 0.2)',   color: 'oklch(65% 0.015 240)'  },
  APPLYING:              { label: 'Applying',        dotColor: 'oklch(65% 0.22 250)',   bg: 'oklch(55% 0.22 250 / 0.15)',  color: 'oklch(65% 0.22 250)'   },
  APPLIED:               { label: 'Applied',         dotColor: 'oklch(68% 0.18 145)',   bg: 'oklch(68% 0.18 145 / 0.15)', color: 'oklch(68% 0.18 145)'   },
  FAILED:                { label: 'Failed',          dotColor: 'oklch(62% 0.22 25)',    bg: 'oklch(62% 0.22 25 / 0.15)',  color: 'oklch(62% 0.22 25)'    },
  NEEDS_REVIEW:          { label: 'Needs Review',    dotColor: 'oklch(72% 0.18 75)',    bg: 'oklch(72% 0.18 75 / 0.15)',  color: 'oklch(72% 0.18 75)'    },
  NEEDS_INFO:            { label: 'Needs Your Input',dotColor: 'oklch(65% 0.2 290)',    bg: 'oklch(65% 0.2 290 / 0.15)',  color: 'oklch(65% 0.2 290)'    },
  VERIFICATION_PENDING:  { label: 'Verify 2FA',      dotColor: 'oklch(75% 0.18 55)',    bg: 'oklch(75% 0.18 55 / 0.12)',  color: 'oklch(70% 0.18 55)'    },
}

function timeAgo(date: Date | string): string {
  const ms = Date.now() - new Date(date).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-xl p-4 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border-subtle)' }}>
      <p className="text-2xl font-bold tabular-nums" style={{ color }}>{value}</p>
      <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{label}</p>
    </div>
  )
}

// ── Needs Info Card ───────────────────────────────────────────────────────────

function NeedsInfoCard({ app, onRefresh }: { app: AppWithJob; onRefresh: () => void }) {
  const questions: PendingQuestion[] = app.pausedApplication
    ? (JSON.parse(app.pausedApplication.pendingQuestions) as PendingQuestion[])
    : []

  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map(q => [q.fieldLabel, '']))
  )
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit() {
    const missing = questions.filter(q => !answers[q.fieldLabel]?.trim())
    if (missing.length > 0) {
      toast.error(`Please fill in: ${missing.map(q => q.fieldLabel).join(', ')}`)
      return
    }

    setSubmitting(true)
    try {
      // Load resumeBase64 from localStorage to pass along (stripped from snapshot)
      const profile = loadProfile()
      const resumeBase64 = profile?.resumeBase64 ?? undefined

      const res = await fetch(`/api/applications/${app.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers, resumeBase64 }),
      })

      if (!res.ok) {
        const err = await res.json() as { error?: string }
        throw new Error(err.error ?? 'Resume failed')
      }

      const data = await res.json() as { status: string }
      if (data.status === 'APPLIED') {
        toast.success('Application submitted!')
      } else if (data.status === 'NEEDS_INFO') {
        toast('Still needs more info — check for new questions')
      } else {
        toast('Processing — check dashboard in a moment')
      }
      onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not resume application')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-2xl p-5 space-y-4"
      style={{ background: 'oklch(65% 0.2 290 / 0.06)', border: '1px solid oklch(65% 0.2 290 / 0.3)' }}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
            {app.job.role}
          </p>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{app.job.company}</p>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold flex-shrink-0"
          style={{ background: STATUS_CFG.NEEDS_INFO.bg, color: STATUS_CFG.NEEDS_INFO.color }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS_CFG.NEEDS_INFO.dotColor }} />
          Needs Input
        </span>
      </div>

      <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
        Chiaro couldn&apos;t auto-answer these fields. Fill them in to complete the application.
      </p>

      {/* Question inputs */}
      {questions.length > 0 ? (
        <div className="space-y-3">
          {questions.map(q => (
            <div key={q.fieldLabel}>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
                {q.fieldLabel}
              </label>
              {q.fieldType === 'textarea' ? (
                <textarea
                  rows={3}
                  value={answers[q.fieldLabel] ?? ''}
                  onChange={e => setAnswers(prev => ({ ...prev, [q.fieldLabel]: e.target.value }))}
                  className="w-full rounded-lg px-3 py-2 text-sm resize-none"
                  style={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-text)',
                    outline: 'none',
                  }}
                />
              ) : (
                <input
                  type="text"
                  value={answers[q.fieldLabel] ?? ''}
                  onChange={e => setAnswers(prev => ({ ...prev, [q.fieldLabel]: e.target.value }))}
                  className="w-full rounded-lg px-3 py-2 text-sm"
                  style={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    color: 'var(--color-text)',
                    outline: 'none',
                  }}
                />
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          No pending fields — click Continue to retry submission.
        </p>
      )}

      <button
        onClick={() => void handleSubmit()}
        disabled={submitting}
        className="w-full py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-50"
        style={{
          background: 'oklch(65% 0.2 290)',
          color: 'white',
        }}
      >
        {submitting ? 'Submitting…' : 'Continue Application'}
      </button>
    </div>
  )
}

// ── Verification Card ─────────────────────────────────────────────────────────

function VerificationCard({ app, onRefresh }: { app: AppWithJob; onRefresh: () => void }) {
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [skipping, setSkipping] = useState(false)

  // Countdown timer
  const expiryMs = app.verificationExpiry ? new Date(app.verificationExpiry as unknown as string).getTime() : Date.now() + 600_000
  const [secondsLeft, setSecondsLeft] = useState(Math.max(0, Math.floor((expiryMs - Date.now()) / 1000)))
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    timerRef.current = setInterval(() => {
      const remaining = Math.max(0, Math.floor((expiryMs - Date.now()) / 1000))
      setSecondsLeft(remaining)
      if (remaining === 0 && timerRef.current) clearInterval(timerRef.current)
    }, 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [expiryMs])

  const minutes = Math.floor(secondsLeft / 60)
  const seconds = secondsLeft % 60
  const timerExpired = secondsLeft === 0

  const verificationTypeLabel = (() => {
    const msg = app.errorMessage ?? ''
    if (msg.includes('email_code'))  return 'Check your email for a verification code'
    if (msg.includes('sms_code'))    return 'Check your phone for an SMS code'
    if (msg.includes('authenticator')) return 'Open your authenticator app for a 6-digit code'
    if (msg.includes('phone_prompt')) return 'Tap Yes on your phone to approve the sign-in'
    return 'Enter your verification code below'
  })()

  async function handleSubmit() {
    if (!code.trim()) {
      toast.error('Please enter the verification code')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(`/api/applications/${app.id}/verify`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verificationCode: code.trim() }),
      })
      if (!res.ok) {
        const err = await res.json() as { error?: string }
        throw new Error(err.error ?? 'Verification failed')
      }
      toast.success('Code submitted — applying...')
      onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not submit code')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleSkip() {
    setSkipping(true)
    try {
      const res = await fetch(`/api/applications/${app.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'skip_verification' }),
      })
      if (!res.ok) throw new Error('Skip failed')
      toast('Marked for manual application')
      onRefresh()
    } catch {
      toast.error('Could not skip')
    } finally {
      setSkipping(false)
    }
  }

  return (
    <div className="rounded-2xl p-5 space-y-4"
      style={{ background: 'oklch(75% 0.18 55 / 0.07)', border: '1px solid oklch(75% 0.18 55 / 0.35)' }}>

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
            {app.job.role}
          </p>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{app.job.company}</p>
        </div>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold flex-shrink-0"
          style={{ background: STATUS_CFG.VERIFICATION_PENDING.bg, color: STATUS_CFG.VERIFICATION_PENDING.color }}>
          <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: STATUS_CFG.VERIFICATION_PENDING.dotColor }} />
          Verify 2FA
        </span>
      </div>

      {/* Instruction */}
      <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
        {verificationTypeLabel}
      </p>

      {/* Countdown */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium tabular-nums"
          style={{ color: timerExpired ? 'var(--color-error)' : 'oklch(70% 0.18 55)' }}>
          {timerExpired
            ? 'Verification window expired'
            : `${minutes}:${String(seconds).padStart(2, '0')} remaining`}
        </span>
      </div>

      {/* Code input */}
      {!timerExpired && (
        <div className="flex gap-2">
          <input
            type="text"
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
            placeholder="123456"
            maxLength={8}
            className="flex-1 rounded-lg px-3 py-2 text-center text-lg font-mono tracking-widest"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text)',
              outline: 'none',
              letterSpacing: '0.3em',
            }}
            onKeyDown={e => { if (e.key === 'Enter') void handleSubmit() }}
          />
          <button
            onClick={() => void handleSubmit()}
            disabled={submitting || !code.trim()}
            className="px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-50 flex-shrink-0"
            style={{ background: 'oklch(70% 0.18 55)', color: 'white' }}
          >
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      )}

      {/* Skip button */}
      <button
        onClick={() => void handleSkip()}
        disabled={skipping}
        className="text-xs transition-all disabled:opacity-50"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {skipping ? 'Skipping…' : 'Skip — apply manually instead'}
      </button>
    </div>
  )
}

// ── Row ───────────────────────────────────────────────────────────────────────

function AppRow({ app, onRetry }: { app: AppWithJob; onRetry: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const errorCode = (app as AppWithJob & { errorCode?: string | null }).errorCode
  const isSkipped = app.status === ApplicationStatus.NEEDS_REVIEW && errorCode?.startsWith('B') === true
  const cfg = STATUS_CFG[app.status as ApplicationStatus]
  const isRetryable = !isSkipped && (app.status === ApplicationStatus.FAILED || app.status === ApplicationStatus.NEEDS_REVIEW)

  async function retry() {
    setRetrying(true)
    try {
      const res = await fetch(`/api/applications/${app.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry' }),
      })
      if (!res.ok) throw new Error('Retry failed')
      toast.success('Re-queued')
      onRetry()
    } catch {
      toast.error('Could not retry')
    } finally {
      setRetrying(false)
    }
  }

  return (
    <>
      <tr
        className="cursor-pointer transition-colors"
        style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
        onClick={() => setExpanded(v => !v)}
      >
        <td className="py-3.5 pr-4 pl-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
              style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-accent)', border: '1px solid var(--color-border-subtle)' }}>
              {app.job.company.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate" style={{ color: 'var(--color-text)' }}>{app.job.role}</p>
              <p className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>{app.job.company}</p>
            </div>
          </div>
        </td>
        <td className="py-3.5 pr-4">
          {isSkipped ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
              style={{ background: 'oklch(45% 0.01 240 / 0.15)', color: 'oklch(55% 0.01 240)' }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'oklch(55% 0.01 240)' }} />
              Skipped
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
              style={{ background: cfg.bg, color: cfg.color }}>
              <span className={`w-1.5 h-1.5 rounded-full ${app.status === 'APPLYING' ? 'animate-pulse-slow' : ''}`}
                style={{ background: cfg.dotColor }} />
              {cfg.label}
            </span>
          )}
        </td>
        <td className="py-3.5 pr-4 hidden sm:table-cell">
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {timeAgo(app.appliedAt ?? app.createdAt)}
          </span>
        </td>
        <td className="py-3.5 pr-4 text-right">
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {expanded ? '▲' : '▼'}
          </span>
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={4} className="pb-4 pt-0 px-4">
            <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--color-surface-elevated)', border: '1px solid var(--color-border-subtle)' }}>
              {app.job.applyUrl && (
                <a href={app.job.applyUrl} target="_blank" rel="noopener noreferrer"
                  className="text-xs font-medium break-all hover:underline"
                  style={{ color: 'var(--color-accent)' }}
                  onClick={e => e.stopPropagation()}>
                  {app.job.applyUrl} ↗
                </a>
              )}
              {app.errorMessage && (
                <p className="text-xs leading-relaxed" style={{ color: 'var(--color-error)' }}>
                  {app.errorMessage}
                </p>
              )}
              {isRetryable && (
                <button onClick={(e) => { e.stopPropagation(); void retry() }} disabled={retrying}
                  className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all disabled:opacity-50"
                  style={{ background: 'var(--color-surface)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}>
                  {retrying ? 'Retrying…' : 'Retry'}
                </button>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Main dashboard ────────────────────────────────────────────────────────────

export function DashboardClient() {
  const [apps, setApps] = useState<AppWithJob[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const fetchApps = useCallback(async () => {
    try {
      const res = await fetch('/api/applications')
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json() as { applications?: AppWithJob[] }
      if (data.applications) {
        setApps(data.applications)
        setFetchError(null)
      }
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Failed to load applications')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchApps()
    const interval = setInterval(() => void fetchApps(), 5000)
    return () => clearInterval(interval)
  }, [fetchApps])

  const isSkippedApp = (a: AppWithJob) =>
    a.status === 'NEEDS_REVIEW' && (a as AppWithJob & { errorCode?: string | null }).errorCode?.startsWith('B') === true

  const counts = {
    applied:               apps.filter(a => a.status === 'APPLIED').length,
    pending:               apps.filter(a => a.status === 'PENDING' || a.status === 'APPLYING').length,
    failed:                apps.filter(a => a.status === 'FAILED').length,
    needs_review:          apps.filter(a => a.status === 'NEEDS_REVIEW' && !isSkippedApp(a)).length,
    needs_info:            apps.filter(a => a.status === 'NEEDS_INFO').length,
    skipped:               apps.filter(a => isSkippedApp(a)).length,
    verification_pending:  apps.filter(a => a.status === 'VERIFICATION_PENDING').length,
  }

  const needsInfo            = apps.filter(a => a.status === 'NEEDS_INFO')
  const verificationPending  = apps.filter(a => a.status === 'VERIFICATION_PENDING')
  const needsAttention       = apps.filter(a => a.status === 'NEEDS_REVIEW' && !isSkippedApp(a))
  const skippedApps          = apps.filter(a => isSkippedApp(a))

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: 'var(--color-accent)' }} />
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="rounded-xl p-5 text-sm" style={{ background: 'var(--color-error-subtle)', color: 'var(--color-error)', border: '1px solid oklch(62% 0.22 25 / 0.3)' }}>
        {fetchError}
      </div>
    )
  }

  if (apps.length === 0) {
    return (
      <EmptyState
        title="No applications yet"
        description="Swipe right on jobs to start auto-applying."
        action={<Link href="/" className="btn-primary">Start Swiping</Link>}
      />
    )
  }

  return (
    <div className="space-y-6">
      {/* Amber banner — verification required */}
      {verificationPending.length > 0 && (
        <div className="rounded-xl px-4 py-3 flex items-center gap-3"
          style={{ background: 'oklch(75% 0.18 55 / 0.12)', border: '1px solid oklch(75% 0.18 55 / 0.4)' }}>
          <span style={{ color: 'oklch(70% 0.18 55)' }}>&#9888;</span>
          <p className="text-sm font-medium" style={{ color: 'oklch(65% 0.15 55)' }}>
            Action required: {verificationPending.length === 1
              ? `${verificationPending[0].job.company} application needs a verification code`
              : `${verificationPending.length} applications need verification codes`}
          </p>
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        <StatCard label="Applied"      value={counts.applied}      color="var(--color-success)" />
        <StatCard label="Pending"      value={counts.pending}      color="var(--color-accent)" />
        <StatCard label="Failed"       value={counts.failed}       color="var(--color-error)" />
        <StatCard label="Needs Review" value={counts.needs_review} color="var(--color-warning)" />
        <StatCard label="Needs Input"  value={counts.needs_info}   color="oklch(65% 0.2 290)" />
        <StatCard label="Skipped"      value={counts.skipped}      color="oklch(55% 0.01 240)" />
      </div>

      {/* Verification Pending section */}
      {verificationPending.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold" style={{ color: 'oklch(70% 0.18 55)' }}>
            Verification Required ({verificationPending.length})
          </h2>
          {verificationPending.map(a => (
            <VerificationCard key={a.id} app={a} onRefresh={() => void fetchApps()} />
          ))}
        </div>
      )}

      {/* Needs Your Input section */}
      {needsInfo.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold" style={{ color: 'oklch(65% 0.2 290)' }}>
            Needs Your Input ({needsInfo.length})
          </h2>
          {needsInfo.map(a => (
            <NeedsInfoCard key={a.id} app={a} onRefresh={() => void fetchApps()} />
          ))}
        </div>
      )}

      {/* Needs Attention section (NEEDS_REVIEW — manual) */}
      {needsAttention.length > 0 && (
        <div className="rounded-2xl p-4 space-y-3"
          style={{ background: 'oklch(72% 0.18 75 / 0.08)', border: '1px solid oklch(72% 0.18 75 / 0.25)' }}>
          <p className="text-sm font-semibold" style={{ color: 'oklch(72% 0.18 75)' }}>
            Needs Attention ({needsAttention.length})
          </p>
          <div className="space-y-2">
            {needsAttention.map(a => (
              <div key={a.id} className="flex items-center justify-between gap-3">
                <span className="text-sm truncate" style={{ color: 'var(--color-text)' }}>
                  {a.job.role} at {a.job.company}
                </span>
                {a.job.applyUrl && (
                  <a href={a.job.applyUrl} target="_blank" rel="noopener noreferrer"
                    className="text-xs px-3 py-1.5 rounded-lg font-medium flex-shrink-0 transition-all"
                    style={{ background: 'oklch(72% 0.18 75 / 0.15)', color: 'oklch(72% 0.18 75)', border: '1px solid oklch(72% 0.18 75 / 0.3)' }}>
                    Complete manually ↗
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Skipped section */}
      {skippedApps.length > 0 && (
        <div className="rounded-2xl p-4 space-y-3"
          style={{ background: 'oklch(45% 0.01 240 / 0.06)', border: '1px solid oklch(55% 0.01 240 / 0.25)' }}>
          <p className="text-sm font-semibold" style={{ color: 'oklch(55% 0.01 240)' }}>
            Skipped — Apply Manually ({skippedApps.length})
          </p>
          <div className="space-y-2">
            {skippedApps.map(a => (
              <div key={a.id} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm truncate" style={{ color: 'var(--color-text)' }}>
                    {a.job.role} at {a.job.company}
                  </p>
                  {a.errorMessage && (
                    <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
                      {a.errorMessage}
                    </p>
                  )}
                </div>
                {a.job.applyUrl && (
                  <a href={a.job.applyUrl} target="_blank" rel="noopener noreferrer"
                    className="text-xs px-3 py-1.5 rounded-lg font-medium flex-shrink-0 transition-all"
                    style={{ background: 'oklch(55% 0.01 240 / 0.15)', color: 'oklch(55% 0.01 240)', border: '1px solid oklch(55% 0.01 240 / 0.3)' }}>
                    Apply manually ↗
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Applications table */}
      <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border-subtle)' }}>
        <table className="w-full">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
              {['Job', 'Status', 'Time', ''].map((col, i) => (
                <th key={i} className={`px-4 py-3 text-left text-xs font-semibold ${i === 3 ? 'text-right' : ''} ${i === 2 ? 'hidden sm:table-cell' : ''}`}
                  style={{ color: 'var(--color-text-muted)' }}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {apps.map(app => (
              <AppRow key={app.id} app={app} onRetry={() => void fetchApps()} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
