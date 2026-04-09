'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { CardDeck } from '@/components/CardDeck'
import { EmptyState } from '@/components/ui/EmptyState'
import { loadProfile } from '@/lib/userProfile'
import type { Job } from '@prisma/client'

export default function HomePage() {
  const router = useRouter()
  const [jobs, setJobs] = useState<Job[]>([])
  const [userId, setUserId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [appliedToday, setAppliedToday] = useState(0)

  useEffect(() => {
    // Profile gate
    const profile = loadProfile()
    if (!profile?.firstName || !profile?.email) {
      router.replace('/profile')
      return
    }

    async function load() {
      try {
        const [jobsRes, appsRes] = await Promise.all([
          fetch('/api/jobs'),
          fetch('/api/applications'),
        ])
        const jobsData = await jobsRes.json() as { jobs?: Job[]; userId?: string; error?: string }
        const appsData = await appsRes.json() as { applications?: Array<{ createdAt: string }> }

        if (jobsData.error) throw new Error(jobsData.error)

        setJobs(jobsData.jobs ?? [])
        setUserId(jobsData.userId ?? '')

        // Count applications created today
        const today = new Date().toDateString()
        const todayCount = (appsData.applications ?? [])
          .filter(a => new Date(a.createdAt).toDateString() === today).length
        setAppliedToday(todayCount)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load jobs')
      } finally {
        setLoading(false)
      }
    }

    void load()
  }, [router])

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-3.5rem)]">
        <div className="w-6 h-6 rounded-full border-2 border-t-transparent animate-spin"
          style={{ borderColor: 'var(--color-accent)' }} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-3.5rem)]">
        <EmptyState
          title="Could not load jobs"
          description={error}
          action={
            <div className="text-center space-y-2">
              <p className="text-xs font-mono px-3 py-2 rounded-lg"
                style={{ background: 'var(--color-surface)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}>
                pnpm db:push && pnpm db:seed
              </p>
            </div>
          }
        />
      </div>
    )
  }

  return <CardDeck jobs={jobs} userId={userId} appliedToday={appliedToday} />
}
