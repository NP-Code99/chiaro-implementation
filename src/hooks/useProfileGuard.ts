'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { loadProfile, type UserProfile } from '@/lib/userProfile'

export function useProfileGuard() {
  const router = useRouter()
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    const p = loadProfile()
    if (!p || !p.firstName || !p.email) {
      router.replace('/profile')
    } else {
      setProfile(p)
    }
    setChecked(true)
  }, [router])

  return { profile, checked }
}
