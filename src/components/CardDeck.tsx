'use client'

import { useState, useCallback } from 'react'
import { AnimatePresence } from 'framer-motion'
import { SwipeCard } from './SwipeCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { loadProfile } from '@/lib/userProfile'
import toast from 'react-hot-toast'
import Link from 'next/link'
import type { Job } from '@prisma/client'

interface CardDeckProps {
  jobs: Job[]
  userId: string
  appliedToday?: number
}

const VISIBLE_STACK = 3

export function CardDeck({ jobs, userId, appliedToday = 0 }: CardDeckProps) {
  const [remaining, setRemaining] = useState<Job[]>(jobs)
  const [skippedCount, setSkippedCount] = useState(0)
  const [appliedCount, setAppliedCount] = useState(appliedToday)
  const [processing, setProcessing] = useState(false)

  const handleSkip = useCallback(() => {
    setRemaining(prev => prev.slice(1))
    setSkippedCount(c => c + 1)
  }, [])

  const handleApply = useCallback(async () => {
    const job = remaining[0]
    if (!job || processing) return

    setRemaining(prev => prev.slice(1))
    setProcessing(true)

    try {
      const profile = loadProfile()
      const res = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: job.id,
          userId,
          profileSnapshot: profile ? JSON.stringify(profile) : null,
        }),
      })
      const data = await res.json() as { error?: string; alreadyExists?: boolean }
      if (!res.ok) throw new Error(data.error ?? 'Failed to queue application')
      if (data.alreadyExists) {
        toast('Already applied to this job', { icon: '✓' })
      } else {
        setAppliedCount(c => c + 1)
        toast.success(`Applying to ${job.company}…`, { icon: '🚀' })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to apply')
    } finally {
      setProcessing(false)
    }
  }, [remaining, userId, processing])

  if (remaining.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-3.5rem)]">
        <EmptyState
          title="You've seen all jobs"
          description="Check your applications dashboard to see how they're going."
          action={
            <Link href="/dashboard" className="btn-primary">View Applications</Link>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-start min-h-[calc(100vh-3.5rem)] px-4 pt-8 pb-6">
      {/* Card stack */}
      <div className="relative" style={{ width: '100%', maxWidth: 420, height: 'min(500px, 65vh)' }}>
        <AnimatePresence mode="popLayout">
          {remaining.slice(0, VISIBLE_STACK).map((job, idx) => (
            <SwipeCard
              key={job.id}
              job={job}
              isTop={idx === 0}
              stackIndex={idx}
              onSwipeLeft={handleSkip}
              onSwipeRight={handleApply}
            />
          ))}
        </AnimatePresence>
      </div>

      {/* Action buttons */}
      <div className="flex items-center justify-center gap-6 mt-7" style={{ maxWidth: 420, width: '100%' }}>
        <button
          onClick={handleSkip}
          disabled={processing}
          aria-label="Skip"
          className="w-14 h-14 rounded-full flex items-center justify-center text-xl transition-all disabled:opacity-40"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            color: 'oklch(65% 0.02 240)',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface-elevated)'; e.currentTarget.style.transform = 'scale(1.08)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--color-surface)'; e.currentTarget.style.transform = 'scale(1)' }}
        >
          ✕
        </button>

        <button
          onClick={handleApply}
          disabled={processing}
          aria-label="Apply"
          className="w-16 h-16 rounded-full flex items-center justify-center text-2xl transition-all disabled:opacity-40"
          style={{
            background: processing ? 'var(--color-surface-elevated)' : 'var(--color-accent)',
            color: 'white',
            boxShadow: processing ? 'none' : '0 4px 20px var(--color-accent-subtle)',
          }}
          onMouseEnter={e => { if (!processing) { e.currentTarget.style.background = 'var(--color-accent-hover)'; e.currentTarget.style.transform = 'scale(1.08)' }}}
          onMouseLeave={e => { if (!processing) { e.currentTarget.style.background = 'var(--color-accent)'; e.currentTarget.style.transform = 'scale(1)' }}}
        >
          {processing ? (
            <span className="w-5 h-5 rounded-full border-2 border-t-transparent animate-spin block" style={{ borderColor: 'var(--color-accent)' }} />
          ) : '✓'}
        </button>
      </div>

      {/* Stats row */}
      <div
        className="flex items-center gap-4 mt-5 px-5 py-2.5 rounded-full"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border-subtle)',
          maxWidth: 420,
          width: '100%',
          justifyContent: 'space-around',
        }}
      >
        <Stat label="Applied today" value={appliedCount} color="var(--color-success)" />
        <div className="w-px h-4" style={{ background: 'var(--color-border-subtle)' }} />
        <Stat label="Skipped" value={skippedCount} color="var(--color-text-muted)" />
        <div className="w-px h-4" style={{ background: 'var(--color-border-subtle)' }} />
        <Stat label="Remaining" value={remaining.length} color="var(--color-accent)" />
      </div>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="text-center">
      <p className="text-base font-bold tabular-nums" style={{ color }}>{value}</p>
      <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{label}</p>
    </div>
  )
}
