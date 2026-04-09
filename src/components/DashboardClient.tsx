'use client'

import { useEffect, useState, useCallback } from 'react'
import { EmptyState } from '@/components/ui/EmptyState'
import Link from 'next/link'
import toast from 'react-hot-toast'
import type { Application, Job } from '@prisma/client'
import { ApplicationStatus } from '@prisma/client'

type AppWithJob = Application & { job: Job }

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CFG: Record<ApplicationStatus, { label: string; dotColor: string; bg: string; color: string }> = {
  PENDING:      { label: 'Queued',      dotColor: 'oklch(55% 0.015 240)',  bg: 'oklch(45% 0.01 240 / 0.2)',   color: 'oklch(65% 0.015 240)'  },
  APPLYING:     { label: 'Applying',    dotColor: 'oklch(65% 0.22 250)',   bg: 'oklch(55% 0.22 250 / 0.15)',  color: 'oklch(65% 0.22 250)'   },
  APPLIED:      { label: 'Applied',     dotColor: 'oklch(68% 0.18 145)',   bg: 'oklch(68% 0.18 145 / 0.15)',  color: 'oklch(68% 0.18 145)'   },
  FAILED:       { label: 'Failed',      dotColor: 'oklch(62% 0.22 25)',    bg: 'oklch(62% 0.22 25 / 0.15)',   color: 'oklch(62% 0.22 25)'    },
  NEEDS_REVIEW: { label: 'Needs Review',dotColor: 'oklch(72% 0.18 75)',    bg: 'oklch(72% 0.18 75 / 0.15)',   color: 'oklch(72% 0.18 75)'    },
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

// ── Row ───────────────────────────────────────────────────────────────────────

function AppRow({ app, onRetry }: { app: AppWithJob; onRetry: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const cfg = STATUS_CFG[app.status]
  const isRetryable = app.status === ApplicationStatus.FAILED || app.status === ApplicationStatus.NEEDS_REVIEW

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
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
            style={{ background: cfg.bg, color: cfg.color }}>
            <span className={`w-1.5 h-1.5 rounded-full ${app.status === 'APPLYING' ? 'animate-pulse-slow' : ''}`}
              style={{ background: cfg.dotColor }} />
            {cfg.label}
          </span>
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

  const counts = {
    applied: apps.filter(a => a.status === 'APPLIED').length,
    pending: apps.filter(a => a.status === 'PENDING' || a.status === 'APPLYING').length,
    failed: apps.filter(a => a.status === 'FAILED').length,
    needs_review: apps.filter(a => a.status === 'NEEDS_REVIEW').length,
  }

  const needsAttention = apps.filter(a => a.status === 'NEEDS_REVIEW')

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
      {/* Stat cards */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Applied" value={counts.applied} color="var(--color-success)" />
        <StatCard label="Pending" value={counts.pending} color="var(--color-accent)" />
        <StatCard label="Failed" value={counts.failed} color="var(--color-error)" />
        <StatCard label="Needs Review" value={counts.needs_review} color="var(--color-warning)" />
      </div>

      {/* Needs Attention section */}
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
