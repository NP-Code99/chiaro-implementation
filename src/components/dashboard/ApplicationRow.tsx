'use client'

import { useState } from 'react'
import { StatusBadge } from './StatusBadge'
import toast from 'react-hot-toast'
import { ApplicationStatus } from '@/lib/prismaEnums'
import type { ApplicationWithJob } from '@/hooks/useApplications'

interface ApplicationRowProps {
  application: ApplicationWithJob
  onRetry: () => void
}

const BYPASS_CFG: Record<string, { label: string; color: string; bg: string }> = {
  scrapfly_only:              { label: 'Scrapfly',          color: 'oklch(55% 0.18 145)', bg: 'oklch(55% 0.18 145 / 0.12)' },
  scrapfly_plus_capsolver:    { label: 'Scrapfly+CapSolver', color: 'oklch(65% 0.18 60)',  bg: 'oklch(65% 0.18 60 / 0.12)'  },
  failed:                     { label: 'Bypass Failed',     color: 'oklch(62% 0.22 25)',  bg: 'oklch(62% 0.22 25 / 0.12)'  },
}

const LOGIN_PATHWAY_CFG: Record<string, { label: string; color: string; bg: string }> = {
  new_user:           { label: 'New account',        color: 'oklch(55% 0.18 145)', bg: 'oklch(55% 0.18 145 / 0.12)' },
  existing_wellfound: { label: 'Password login',     color: 'oklch(58% 0.18 250)', bg: 'oklch(58% 0.18 250 / 0.12)' },
  google:             { label: 'Google login',       color: 'oklch(58% 0.18 250)', bg: 'oklch(58% 0.18 250 / 0.12)' },
}

// Phrases that indicate the needs_review was due to missing credentials
const CREDENTIAL_PHRASES = [
  'wellfound account',
  'wellfound password',
  'google email',
  'google password',
  'login credentials',
  'account credentials',
  'log in automatically',
]

function isCredentialPrompt(message: string | null | undefined): boolean {
  if (!message) return false
  const lower = message.toLowerCase()
  return CREDENTIAL_PHRASES.some(p => lower.includes(p))
}

function BypassBadge({ method }: { method: string }) {
  const cfg = BYPASS_CFG[method]
  if (!cfg) return null
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium"
      style={{ color: cfg.color, background: cfg.bg }}
    >
      {cfg.label}
    </span>
  )
}

function LoginPathwayBadge({ pathway }: { pathway: string }) {
  const cfg = LOGIN_PATHWAY_CFG[pathway]
  if (!cfg) return null
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium"
      style={{ color: cfg.color, background: cfg.bg }}
    >
      {cfg.label}
    </span>
  )
}

function timeAgo(date: Date | string): string {
  const ms = Date.now() - new Date(date).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export function ApplicationRow({ application, onRetry }: ApplicationRowProps) {
  const [retrying, setRetrying] = useState(false)
  const [showError, setShowError] = useState(false)

  const { job, status, errorMessage, appliedAt, createdAt, bypassMethod } = application
  const loginPathway = (application as ApplicationWithJob & { loginPathway?: string | null }).loginPathway
  const errorCode = (application as ApplicationWithJob & { errorCode?: string | null }).errorCode
  const isSkipped = status === ApplicationStatus.NEEDS_REVIEW && errorCode?.startsWith('B') === true
  const isCredentialMissing = status === ApplicationStatus.NEEDS_REVIEW && isCredentialPrompt(errorMessage)
  const isRetryable = !isSkipped && (status === ApplicationStatus.FAILED || status === ApplicationStatus.NEEDS_REVIEW)

  async function handleRetry() {
    setRetrying(true)
    try {
      const res = await fetch(`/api/applications/${application.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry' }),
      })
      if (!res.ok) throw new Error('Retry failed')
      toast.success('Application re-queued')
      onRetry()
    } catch {
      toast.error('Could not retry application')
    } finally {
      setRetrying(false)
    }
  }

  return (
    <>
      <tr
        className="transition-colors"
        style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
      >
        {/* Company + Role */}
        <td className="py-3.5 pr-4">
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0"
              style={{
                background: 'var(--color-surface-elevated)',
                color: 'var(--color-accent)',
                border: '1px solid var(--color-border-subtle)',
              }}
            >
              {job.company.charAt(0)}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate" style={{ color: 'var(--color-text)' }}>
                {job.role}
              </p>
              <p className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>
                {job.company} · {job.location}
              </p>
            </div>
          </div>
        </td>

        {/* Status */}
        <td className="py-3.5 pr-4">
          <div className="flex flex-col gap-1">
            {isSkipped ? (
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                style={{ background: 'oklch(45% 0.01 240 / 0.15)', color: 'oklch(55% 0.01 240)' }}
              >
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'oklch(55% 0.01 240)' }} />
                Skipped
              </span>
            ) : (
              <StatusBadge status={status as ApplicationStatus} />
            )}
            {bypassMethod && !isSkipped && <BypassBadge method={bypassMethod} />}
            {loginPathway && <LoginPathwayBadge pathway={loginPathway} />}
          </div>
        </td>

        {/* Time */}
        <td className="py-3.5 pr-4 hidden sm:table-cell">
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {appliedAt ? timeAgo(appliedAt) : timeAgo(createdAt)}
          </span>
        </td>

        {/* Actions */}
        <td className="py-3.5 text-right">
          <div className="flex items-center justify-end gap-2">
            {errorMessage && (
              <button
                onClick={() => setShowError((v) => !v)}
                className="text-xs px-2 py-1 rounded-md transition-all"
                style={{
                  color: 'var(--color-text-muted)',
                  background: showError ? 'var(--color-surface-elevated)' : 'transparent',
                }}
              >
                {showError ? 'Hide' : 'Error'}
              </button>
            )}
            {isRetryable && (
              <button
                onClick={handleRetry}
                disabled={retrying}
                className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all disabled:opacity-50"
                style={{
                  background: 'var(--color-surface-elevated)',
                  color: 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border-subtle)',
                }}
              >
                {retrying ? '…' : 'Retry'}
              </button>
            )}
            {isSkipped && job.applyUrl && (
              <a
                href={job.applyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                style={{
                  background: 'oklch(45% 0.01 240 / 0.15)',
                  color: 'oklch(55% 0.01 240)',
                  border: '1px solid oklch(55% 0.01 240 / 0.3)',
                }}
              >
                Apply manually ↗
              </a>
            )}
            {status === ApplicationStatus.APPLIED && (
              <a
                href={job.applyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-3 py-1.5 rounded-lg font-medium transition-all"
                style={{
                  background: 'var(--color-success-subtle)',
                  color: 'var(--color-success)',
                  border: '1px solid oklch(68% 0.18 145 / 0.3)',
                }}
              >
                View ↗
              </a>
            )}
          </div>
        </td>
      </tr>

      {/* Credential-missing banner — always visible when credentials are the blocker */}
      {isCredentialMissing && errorMessage && (
        <tr>
          <td colSpan={4} className="pb-3 pt-0">
            <div
              className="px-3 py-2.5 rounded-lg text-xs leading-relaxed flex items-start justify-between gap-3"
              style={{
                background: 'oklch(75% 0.15 80 / 0.12)',
                color: 'oklch(48% 0.12 60)',
                border: '1px solid oklch(75% 0.15 80 / 0.35)',
              }}
            >
              <span>{errorMessage}</span>
              <a
                href="/profile#credentials"
                className="flex-shrink-0 text-xs px-2.5 py-1 rounded-lg font-medium whitespace-nowrap"
                style={{
                  background: 'oklch(75% 0.15 80 / 0.25)',
                  color: 'oklch(45% 0.12 55)',
                  border: '1px solid oklch(65% 0.15 75 / 0.4)',
                }}
              >
                Add credentials →
              </a>
            </div>
          </td>
        </tr>
      )}

      {/* Expandable error row */}
      {showError && errorMessage && !isCredentialMissing && (
        <tr>
          <td colSpan={4} className="pb-3.5 pt-0">
            <div
              className="mx-0 px-3 py-2.5 rounded-lg text-xs leading-relaxed"
              style={{
                background: 'var(--color-error-subtle)',
                color: 'var(--color-error)',
                border: '1px solid oklch(62% 0.22 25 / 0.2)',
              }}
            >
              {errorMessage}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
