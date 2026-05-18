'use client'

import { useState, useCallback, useRef } from 'react'
import { AnimatePresence } from 'framer-motion'
import { JobCard } from './JobCard'
import { SwipeActions } from './SwipeActions'
import { EmptyState } from '@/components/ui/EmptyState'
import toast from 'react-hot-toast'
import Link from 'next/link'
import type { Job } from '@prisma/client'
import { loadProfile } from '@/lib/userProfile'

interface SwipeDeckProps {
  jobs: Job[]
  userId: string
}

const VISIBLE_STACK = 3

export function SwipeDeck({ jobs, userId }: SwipeDeckProps) {
  const [remaining, setRemaining] = useState<Job[]>(jobs)
  const [applying, setApplying] = useState(false)
  const topCardRef = useRef<{ triggerSwipeLeft: () => void; triggerSwipeRight: () => void } | null>(null)

  const handleSwipeLeft = useCallback(() => {
    setRemaining((prev) => prev.slice(1))
  }, [])

  const handleSwipeRight = useCallback(async () => {
    const job = remaining[0]
    if (!job) return

    setRemaining((prev) => prev.slice(1))
    setApplying(true)

    try {
      const profile = loadProfile()
      const profileSnapshot = profile ? JSON.stringify(profile) : null

      if (!profileSnapshot) {
        toast.error('Complete your profile before applying', { duration: 4000 })
        setApplying(false)
        return
      }

      const res = await fetch('/api/applications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, userId, profileSnapshot }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to queue application')
      }
      toast.success(`Applying to ${job.company}…`, { icon: '🚀' })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to apply')
    } finally {
      setApplying(false)
    }
  }, [remaining, userId])

  if (remaining.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-3.5rem)]">
        <EmptyState
          title="You've seen all jobs"
          description="Check your applications dashboard to track the ones you applied to."
          action={
            <Link href="/dashboard" className="btn-primary">
              View Applications
            </Link>
          }
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-3.5rem)] px-4 py-8">
      {/* Progress indicator */}
      <p className="text-xs mb-6" style={{ color: 'var(--color-text-muted)' }}>
        {remaining.length} job{remaining.length !== 1 ? 's' : ''} left
      </p>

      {/* Card stack */}
      <div
        className="relative"
        style={{ width: 'min(380px, 100%)', height: 'min(520px, 70vh)' }}
      >
        <AnimatePresence mode="popLayout">
          {remaining.slice(0, VISIBLE_STACK).map((job, idx) => (
            <JobCard
              key={job.id}
              job={job}
              isTop={idx === 0}
              stackIndex={idx}
              onSwipeLeft={handleSwipeLeft}
              onSwipeRight={handleSwipeRight}
            />
          ))}
        </AnimatePresence>
      </div>

      {/* Action buttons */}
      <SwipeActions
        onSkip={handleSwipeLeft}
        onApply={handleSwipeRight}
        disabled={applying || remaining.length === 0}
      />

      {/* Keyboard hint */}
      <p className="text-xs mt-4" style={{ color: 'var(--color-text-muted)' }}>
        Swipe or press <kbd className="px-1 rounded text-xs" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>←</kbd>{' '}
        <kbd className="px-1 rounded text-xs" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}>→</kbd>
      </p>
    </div>
  )
}
