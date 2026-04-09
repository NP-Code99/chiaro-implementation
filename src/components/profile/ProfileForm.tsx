'use client'

import { useState } from 'react'
import { ResumeUpload } from './ResumeUpload'
import toast from 'react-hot-toast'
import type { User } from '@prisma/client'

interface ProfileFormProps {
  initialUser: User | null
}

export function ProfileForm({ initialUser }: ProfileFormProps) {
  const [saving, setSaving] = useState(false)
  const [resumePath, setResumePath] = useState(initialUser?.resumePath ?? null)
  const [form, setForm] = useState({
    name: initialUser?.name ?? '',
    email: initialUser?.email ?? '',
    phone: initialUser?.phone ?? '',
    linkedinUrl: initialUser?.linkedinUrl ?? '',
    githubUrl: initialUser?.githubUrl ?? '',
    location: initialUser?.location ?? '',
  })

  function handleChange(field: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const res = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Save failed')
      toast.success('Profile saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const fields: { label: string; key: keyof typeof form; type?: string; placeholder?: string }[] = [
    { label: 'Full Name', key: 'name', placeholder: 'Ada Lovelace' },
    { label: 'Email', key: 'email', type: 'email', placeholder: 'ada@example.com' },
    { label: 'Phone', key: 'phone', type: 'tel', placeholder: '+1 (415) 555-0100' },
    { label: 'LinkedIn URL', key: 'linkedinUrl', placeholder: 'https://linkedin.com/in/username' },
    { label: 'GitHub URL', key: 'githubUrl', placeholder: 'https://github.com/username' },
    { label: 'Location', key: 'location', placeholder: 'San Francisco, CA' },
  ]

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        {fields.map(({ label, key, type = 'text', placeholder }) => (
          <div key={key} className="space-y-1.5">
            <label className="block text-sm font-medium" style={{ color: 'var(--color-text-secondary)' }}>
              {label}
            </label>
            <input
              type={type}
              value={form[key]}
              onChange={handleChange(key)}
              placeholder={placeholder}
              className="input"
              required={key === 'name' || key === 'email'}
            />
          </div>
        ))}
      </div>

      <ResumeUpload currentPath={resumePath} onUploaded={setResumePath} />

      <div className="flex justify-end pt-2">
        <button type="submit" disabled={saving} className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
          {saving ? 'Saving…' : 'Save Profile'}
        </button>
      </div>
    </form>
  )
}
