'use client'

import { useState } from 'react'
import { StatusBadge } from './StatusBadge'
import toast from 'react-hot-toast'
import { ApplicationStatus } from '@prisma/client'
import type { ApplicationWithJob } from '@/hooks/useApplications'

interface ApplicationRowProps {
  application: ApplicationWithJob
  onRetry: () => void
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

  const { job, status, errorMessage, appliedAt, createdAt } = application
  const isRetryable = status === ApplicationStatus.FAILED || status === ApplicationStatus.NEEDS_REVIEW

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
          <StatusBadge status={status} />
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

      {/* Expandable error row */}
      {showError && errorMessage && (
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
