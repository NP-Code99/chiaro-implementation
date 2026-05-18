'use client'

import { useApplications } from '@/hooks/useApplications'
import type { ApplicationWithJob } from '@/hooks/useApplications'
import { ApplicationRow } from './ApplicationRow'
import { EmptyState } from '@/components/ui/EmptyState'
import { ApplicationStatus } from '@/lib/prismaEnums'
import Link from 'next/link'

const STAT_LABELS: Partial<Record<ApplicationStatus, string>> = {
  APPLIED: 'Applied',
  PENDING: 'Queued',
  APPLYING: 'In Progress',
  FAILED: 'Failed',
  NEEDS_REVIEW: 'Review',
}

const isSkippedApp = (a: ApplicationWithJob) =>
  a.status === ApplicationStatus.NEEDS_REVIEW &&
  (a as ApplicationWithJob & { errorCode?: string | null }).errorCode?.startsWith('B') === true

export function ApplicationsTable() {
  const { applications, isLoading, mutate } = useApplications()

  const skippedCount = applications.filter(isSkippedApp).length

  const stats = [
    ...Object.entries(STAT_LABELS).map(([status, label]) => ({
      label,
      count: status === ApplicationStatus.NEEDS_REVIEW
        ? applications.filter((a) => a.status === status && !isSkippedApp(a)).length
        : applications.filter((a) => a.status === status).length,
      status: status as ApplicationStatus,
    })),
    { label: 'Skipped', count: skippedCount, status: 'SKIPPED' as ApplicationStatus },
  ]

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin"
          style={{ borderColor: 'var(--color-accent)' }} />
      </div>
    )
  }

  if (applications.length === 0) {
    return (
      <EmptyState
        title="No applications yet"
        description="Swipe right on jobs to start auto-applying. Applications will appear here."
        action={
          <Link href="/" className="btn-primary">
            Start Swiping
          </Link>
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {stats.map(({ label, count, status }) => (
          <div
            key={status}
            className="rounded-xl p-4 text-center"
            style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border-subtle)',
            }}
          >
            <p className="text-2xl font-bold tabular-nums" style={{ color: 'var(--color-text)' }}>
              {count}
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              {label}
            </p>
          </div>
        ))}
      </div>

      {/* Table */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border-subtle)',
        }}
      >
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border-subtle)' }}>
                {['Job', 'Status', 'Time', ''].map((col) => (
                  <th
                    key={col}
                    className={`px-4 py-3 text-left text-xs font-semibold ${col === '' ? 'text-right' : ''} ${col === 'Time' ? 'hidden sm:table-cell' : ''}`}
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y" style={{ color: 'transparent' }}>
              {applications.map((app) => (
                <ApplicationRow key={app.id} application={app} onRetry={() => mutate()} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
