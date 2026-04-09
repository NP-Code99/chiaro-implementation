'use client'

import useSWR from 'swr'
import type { Application, Job } from '@prisma/client'

export type ApplicationWithJob = Application & { job: Job }

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export function useApplications() {
  const { data, error, isLoading, mutate } = useSWR<{ applications: ApplicationWithJob[] }>(
    '/api/applications',
    fetcher,
    { refreshInterval: 5000 }
  )

  return {
    applications: data?.applications ?? [],
    isLoading,
    error,
    mutate,
  }
}
