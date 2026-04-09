'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { saveProfile, loadProfile, profileCompletionPct, type UserProfile, type WorkAuth, type YearsExp } from '@/lib/userProfile'
import toast from 'react-hot-toast'

const WORK_AUTH_OPTIONS: WorkAuth[] = ['US Citizen', 'Green Card', 'H1B Visa', 'Need Sponsorship']
const YEARS_EXP_OPTIONS: YearsExp[] = ['0-1', '1-3', '3-5', '5-8', '8-12', '12+']

const EMPTY: UserProfile = {
  firstName: '', lastName: '', email: '', phone: '',
  linkedin: '', github: '', location: '',
  workAuth: 'US Citizen', yearsExp: '1-3',
  resumeBase64: '', resumeFilename: '',
  bio: '',
}

export function ProfileForm() {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [form, setForm] = useState<UserProfile>(EMPTY)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const existing = loadProfile()
    if (existing) setForm(existing)
  }, [])

  const pct = profileCompletionPct(form)

  function field(key: keyof UserProfile) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm(prev => ({ ...prev, [key]: e.target.value }))
  }

  async function handleResumeFile(file: File) {
    if (file.type !== 'application/pdf') { toast.error('PDF only'); return }
    if (file.size > 5 * 1024 * 1024) { toast.error('Max 5MB'); return }
    const reader = new FileReader()
    reader.onload = () => {
      setForm(prev => ({
        ...prev,
        resumeBase64: reader.result as string,
        resumeFilename: file.name,
      }))
    }
    reader.readAsDataURL(file)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.firstName || !form.email) { toast.error('Name and email are required'); return }
    setSaving(true)
    saveProfile(form)
    setSaving(false)
    toast.success('Profile saved!')
    router.push('/')
  }

  const inputCls = 'input text-sm'
  const labelCls = 'block text-xs font-semibold mb-1.5 uppercase tracking-wide'

  return (
    <form onSubmit={handleSubmit} className="space-y-7">
      {/* Completion bar */}
      <div>
        <div className="flex justify-between items-center mb-2">
          <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
            Profile completion
          </span>
          <span className="text-xs font-bold tabular-nums" style={{ color: pct === 100 ? 'var(--color-success)' : 'var(--color-accent)' }}>
            {pct}%
          </span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${pct}%`,
              background: pct === 100 ? 'var(--color-success)' : 'var(--color-accent)',
            }}
          />
        </div>
      </div>

      {/* Name row */}
      <div className="grid grid-cols-2 gap-4">
        {[['firstName', 'First Name'], ['lastName', 'Last Name']] .map(([key, label]) => (
          <div key={key}>
            <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>{label}</label>
            <input value={form[key as keyof UserProfile] as string} onChange={field(key as keyof UserProfile)}
              placeholder={key === 'firstName' ? 'Ada' : 'Lovelace'} className={inputCls}
              required={key === 'firstName'} />
          </div>
        ))}
      </div>

      {/* Email + Phone */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Email</label>
          <input type="email" value={form.email} onChange={field('email')}
            placeholder="ada@example.com" className={inputCls} required />
        </div>
        <div>
          <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Phone</label>
          <input type="tel" value={form.phone} onChange={field('phone')}
            placeholder="+1 415 555 0100" className={inputCls} />
        </div>
      </div>

      {/* LinkedIn + GitHub */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>LinkedIn</label>
          <input value={form.linkedin} onChange={field('linkedin')}
            placeholder="linkedin.com/in/username" className={inputCls} />
        </div>
        <div>
          <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>GitHub</label>
          <input value={form.github} onChange={field('github')}
            placeholder="github.com/username" className={inputCls} />
        </div>
      </div>

      {/* Location + Work Auth + Years Exp */}
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Location</label>
          <input value={form.location} onChange={field('location')}
            placeholder="San Francisco, CA" className={inputCls} />
        </div>
        <div>
          <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Work Auth</label>
          <select value={form.workAuth} onChange={field('workAuth')} className={inputCls}>
            {WORK_AUTH_OPTIONS.map(o => <option key={o}>{o}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Years Exp</label>
          <select value={form.yearsExp} onChange={field('yearsExp')} className={inputCls}>
            {YEARS_EXP_OPTIONS.map(o => <option key={o}>{o}</option>)}
          </select>
        </div>
      </div>

      {/* Resume upload */}
      <div>
        <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Resume (PDF)</label>
        <div
          className="border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-all"
          style={{ borderColor: 'var(--color-border)', background: 'var(--color-surface)' }}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--color-accent)' }}
          onDragLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border)' }}
          onDrop={e => {
            e.preventDefault()
            e.currentTarget.style.borderColor = 'var(--color-border)'
            const f = e.dataTransfer.files[0]
            if (f) handleResumeFile(f)
          }}
        >
          <input ref={fileRef} type="file" accept="application/pdf" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleResumeFile(f) }} />
          {form.resumeFilename ? (
            <div className="flex flex-col items-center gap-1">
              <span className="text-xl">📄</span>
              <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{form.resumeFilename}</span>
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Click to replace</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1">
              <span className="text-xl">↑</span>
              <span className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>Drop PDF here</span>
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Max 5MB · stored locally</span>
            </div>
          )}
        </div>
      </div>

      {/* Bio / cover letter */}
      <div>
        <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Bio / Cover Letter Template</label>
        <textarea
          value={form.bio}
          onChange={field('bio')}
          rows={4}
          placeholder="I'm a software engineer with 6 years of experience building…"
          className={inputCls}
          style={{ resize: 'vertical' }}
        />
      </div>

      <button type="submit" disabled={saving} className="btn-primary w-full py-3 text-base disabled:opacity-50">
        {saving ? 'Saving…' : 'Save & Start Applying'}
      </button>
    </form>
  )
}
