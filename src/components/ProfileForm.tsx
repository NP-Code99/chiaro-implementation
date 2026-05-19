'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { saveProfile, loadProfile, profileCompletionPct, generateApplicationPassword, type UserProfile, type WorkAuth, type YearsExp, type VeteranStatus, type DisabilityStatus, type Gender, type Ethnicity } from '@/lib/userProfile'
import toast from 'react-hot-toast'

const COUNTRY_CODE_OPTIONS = [
  { label: '+1 (US/Canada)', value: '+1' },
  { label: '+44 (UK)', value: '+44' },
  { label: '+91 (India)', value: '+91' },
  { label: '+61 (Australia)', value: '+61' },
  { label: '+49 (Germany)', value: '+49' },
  { label: '+33 (France)', value: '+33' },
  { label: '+81 (Japan)', value: '+81' },
  { label: '+86 (China)', value: '+86' },
  { label: '+55 (Brazil)', value: '+55' },
  { label: '+52 (Mexico)', value: '+52' },
  { label: '+65 (Singapore)', value: '+65' },
  { label: '+971 (UAE)', value: '+971' },
  { label: '+972 (Israel)', value: '+972' },
  { label: '+31 (Netherlands)', value: '+31' },
  { label: '+46 (Sweden)', value: '+46' },
  { label: '+47 (Norway)', value: '+47' },
  { label: '+45 (Denmark)', value: '+45' },
  { label: '+358 (Finland)', value: '+358' },
  { label: '+41 (Switzerland)', value: '+41' },
  { label: '+48 (Poland)', value: '+48' },
]
const WORK_AUTH_OPTIONS: WorkAuth[] = ['US Citizen', 'Green Card', 'H1B Visa', 'Need Sponsorship']
const YEARS_EXP_OPTIONS: YearsExp[] = ['0-1', '1-3', '3-5', '5-8', '8-12', '12+']
const VETERAN_OPTIONS: VeteranStatus[] = ['I am not a protected veteran', 'I identify as one or more of the classifications of a protected veteran', "I don't wish to answer"]
const DISABILITY_OPTIONS: DisabilityStatus[] = ['Yes, I have a disability', 'No, I do not have a disability', "I don't wish to answer"]
const GENDER_OPTIONS: Gender[] = ['Male', 'Female', 'Non-binary', 'Prefer not to say']
const ETHNICITY_OPTIONS: Ethnicity[] = ['Asian', 'Black or African American', 'Hispanic or Latino', 'Native American or Alaska Native', 'Native Hawaiian or Pacific Islander', 'Two or more races', 'White', 'Prefer not to say']

const EMPTY: UserProfile = {
  firstName: '', lastName: '', email: '', phone: '', phoneCountryCode: '+1',
  linkedin: '', github: '', location: '',
  workAuth: 'US Citizen', yearsExp: '1-3',
  desiredSalary: '',
  resumeBase64: '', resumeFilename: '',
  bio: '',
  applicationPassword: '',
  hasWellfoundAccount: false,
  wellfoundEmail: '',
  wellfoundPassword: '',
  useGoogleLogin: false,
  googleEmail: '',
  googlePassword: '',
}

export function ProfileForm() {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [form, setForm] = useState<UserProfile>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [showWellfoundPassword, setShowWellfoundPassword] = useState(false)
  const [showGooglePassword, setShowGooglePassword] = useState(false)
  const [showAppPassword, setShowAppPassword] = useState(false)

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
    if (form.applicationPassword && form.applicationPassword.length < 12) {
      toast.error('Application password must be at least 12 characters')
      return
    }
    setSaving(true)
    const profileToSave: UserProfile = {
      ...form,
      applicationPassword: form.applicationPassword || generateApplicationPassword(),
    }
    // Never log credential values — only log presence
    console.log('[profile] saving — wellfoundPassword:', profileToSave.wellfoundPassword ? '[present]' : '[missing]')
    console.log('[profile] saving — googlePassword:', profileToSave.googlePassword ? '[present]' : '[missing]')
    saveProfile(profileToSave)
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
          <div className="flex gap-2">
            <select
              value={form.phoneCountryCode ?? '+1'}
              onChange={field('phoneCountryCode')}
              className={inputCls}
              style={{ width: '30%', flexShrink: 0 }}
            >
              {COUNTRY_CODE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input type="tel" value={form.phone} onChange={field('phone')}
              placeholder="415 555 0100" className={inputCls} style={{ flex: 1 }} />
          </div>
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

      {/* Location + Work Auth */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Location</label>
          <input value={form.location} onChange={field('location')}
            placeholder="San Francisco, CA" className={inputCls} />
        </div>
        <div>
          <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Work Authorization</label>
          <select value={form.workAuth} onChange={field('workAuth')} className={inputCls}>
            {WORK_AUTH_OPTIONS.map(o => <option key={o}>{o}</option>)}
          </select>
        </div>
      </div>

      {/* Years Exp + Desired Salary */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Years of Experience</label>
          <select value={form.yearsExp} onChange={field('yearsExp')} className={inputCls}>
            {YEARS_EXP_OPTIONS.map(o => <option key={o}>{o}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Desired Salary (USD)</label>
          <input
            value={form.desiredSalary}
            onChange={field('desiredSalary')}
            placeholder="130000"
            className={inputCls}
          />
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Annual base in USD, e.g. 130000
          </p>
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

      {/* EEO / Demographic fields */}
      <div className="rounded-xl p-4 space-y-4" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <div>
          <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>EEO / Voluntary Self-Identification</span>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            Used for Greenhouse, Lever, and other ATS demographic sections. All fields are optional.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Gender</label>
            <select value={form.gender ?? ''} onChange={field('gender')} className={inputCls}>
              <option value="">Prefer not to say</option>
              {GENDER_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Ethnicity / Race</label>
            <select value={form.ethnicity ?? ''} onChange={field('ethnicity')} className={inputCls}>
              <option value="">Prefer not to say</option>
              {ETHNICITY_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Veteran Status</label>
            <select value={form.veteranStatus ?? ''} onChange={field('veteranStatus')} className={inputCls}>
              <option value="">I don&apos;t wish to answer</option>
              {VETERAN_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Disability Status</label>
            <select value={form.disabilityStatus ?? ''} onChange={field('disabilityStatus')} className={inputCls}>
              <option value="">I don&apos;t wish to answer</option>
              {DISABILITY_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* Account Credentials */}
      <div className="rounded-xl p-4 space-y-5" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>Account credentials</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide"
              style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
              Optional
            </span>
          </div>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            Some job sites remember your email and require you to log in. Chiaro can log in automatically
            on your behalf if you provide your credentials. Without them, jobs requiring login will be
            flagged for manual review instead.
          </p>
        </div>

        {/* Wellfound account toggle */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                Do you have a Wellfound account?
              </label>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                We will use these to log in when your account is detected
              </p>
            </div>
            <button
              type="button"
              onClick={() => setForm(prev => ({ ...prev, hasWellfoundAccount: !prev.hasWellfoundAccount }))}
              className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0"
              style={{
                background: form.hasWellfoundAccount ? 'var(--color-accent)' : 'var(--color-border)',
              }}
            >
              <span
                className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
                style={{ transform: form.hasWellfoundAccount ? 'translateX(22px)' : 'translateX(2px)' }}
              />
            </button>
          </div>

          {form.hasWellfoundAccount && (
            <div className="space-y-3 pl-0">
              <div>
                <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Wellfound email</label>
                <input
                  type="email"
                  value={form.wellfoundEmail ?? ''}
                  onChange={field('wellfoundEmail')}
                  placeholder="you@example.com"
                  className={inputCls}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Wellfound password</label>
                <div className="relative">
                  <input
                    type={showWellfoundPassword ? 'text' : 'password'}
                    value={form.wellfoundPassword ?? ''}
                    onChange={field('wellfoundPassword')}
                    placeholder="Your Wellfound password"
                    className={inputCls}
                    style={{ paddingRight: '2.5rem' }}
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowWellfoundPassword(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-xs px-1"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {showWellfoundPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Google login toggle */}
        <div className="space-y-3" style={{ borderTop: '1px solid var(--color-border)', paddingTop: '1rem' }}>
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
                Use Google to sign in?
              </label>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                For Wellfound accounts linked to Google
              </p>
            </div>
            <button
              type="button"
              onClick={() => setForm(prev => ({ ...prev, useGoogleLogin: !prev.useGoogleLogin }))}
              className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0"
              style={{
                background: form.useGoogleLogin ? 'var(--color-accent)' : 'var(--color-border)',
              }}
            >
              <span
                className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
                style={{ transform: form.useGoogleLogin ? 'translateX(22px)' : 'translateX(2px)' }}
              />
            </button>
          </div>

          {form.useGoogleLogin && (
            <div className="space-y-3">
              {/* 2FA warning */}
              <div className="rounded-lg px-3 py-2.5 text-xs" style={{ background: 'oklch(75% 0.15 80 / 0.15)', border: '1px solid oklch(75% 0.15 80 / 0.4)', color: 'oklch(50% 0.12 60)' }}>
                <strong>Important:</strong> Google login may require 2FA. If your Google account has
                two-factor authentication enabled, Google login automation may not work.
                Consider using a Wellfound password instead.
              </div>
              <div>
                <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Google email</label>
                <input
                  type="email"
                  value={form.googleEmail ?? ''}
                  onChange={field('googleEmail')}
                  placeholder="you@gmail.com"
                  className={inputCls}
                  autoComplete="off"
                />
              </div>
              <div>
                <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Google password</label>
                <div className="relative">
                  <input
                    type={showGooglePassword ? 'text' : 'password'}
                    value={form.googlePassword ?? ''}
                    onChange={field('googlePassword')}
                    placeholder="Your Google password"
                    className={inputCls}
                    style={{ paddingRight: '2.5rem' }}
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowGooglePassword(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-xs px-1"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {showGooglePassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Application password — always shown */}
        <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: '1rem' }}>
          <label className={labelCls} style={{ color: 'var(--color-text-muted)' }}>Password for new accounts</label>
          <div className="relative">
            <input
              type={showAppPassword ? 'text' : 'password'}
              value={form.applicationPassword ?? 'Chiaro2024!!'}
              onChange={field('applicationPassword')}
              placeholder="Chiaro2024!!"
              className={inputCls}
              style={{ paddingRight: '2.5rem' }}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowAppPassword(v => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs px-1"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {showAppPassword ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Used when creating new accounts on job sites that require registration.
            Same password is used everywhere. Must be at least 12 characters.
          </p>
        </div>

        {/* Footer note */}
        <p className="text-xs pt-1" style={{ color: 'var(--color-text-muted)', borderTop: '1px solid var(--color-border)', paddingTop: '0.75rem' }}>
          Your credentials are stored locally and only used to submit job applications on your behalf.
        </p>
      </div>

      {/* Wellfound Session Cookies — bypasses DataDome + Cloudflare */}
      <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>Wellfound Session</span>
              {form.wellfoundCookies?.trim() ? (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide"
                  style={{ background: 'oklch(65% 0.18 145 / 0.15)', color: 'oklch(55% 0.18 145)' }}>
                  Active
                </span>
              ) : (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide"
                  style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
                  Not set
                </span>
              )}
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              Paste your Wellfound browser cookies to bypass Cloudflare and DataDome bot detection
            </p>
          </div>
          {form.wellfoundCookies?.trim() && (
            <button
              type="button"
              onClick={() => setForm(prev => ({ ...prev, wellfoundCookies: '' }))}
              className="text-xs px-2 py-1 rounded"
              style={{ color: 'var(--color-text-muted)', background: 'var(--color-border)' }}
            >
              Clear
            </button>
          )}
        </div>

        <details className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <summary className="cursor-pointer font-semibold select-none" style={{ color: 'var(--color-text-secondary)' }}>
            How to get your cookies (30 seconds)
          </summary>
          <ol className="mt-2 ml-4 space-y-1 list-decimal leading-relaxed">
            <li>Open Chrome and go to <strong>wellfound.com</strong></li>
            <li>Log in to your Wellfound account</li>
            <li>Press <kbd className="px-1 rounded" style={{ background: 'var(--color-border)' }}>F12</kbd> to open DevTools</li>
            <li>Click the <strong>Console</strong> tab</li>
            <li>Type <code className="px-1 rounded" style={{ background: 'var(--color-border)' }}>document.cookie</code> and press Enter</li>
            <li>Select all the output text, copy it, and paste below</li>
          </ol>
          <p className="mt-2 font-medium" style={{ color: 'oklch(62% 0.18 30)' }}>
            Cookies expire after ~24h — re-paste after Wellfound logs you out.
          </p>
        </details>

        <textarea
          value={form.wellfoundCookies ?? ''}
          onChange={field('wellfoundCookies')}
          rows={3}
          placeholder="datadome=Abc123...; cf_clearance=xyz...; _wellfound_session=..."
          className={inputCls}
          style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '11px' }}
          spellCheck={false}
        />
      </div>

      {/* startup.jobs Session Cookies — bypasses Cloudflare */}
      <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>startup.jobs Session</span>
              {form.startupJobsCookies?.trim() ? (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide"
                  style={{ background: 'oklch(65% 0.18 145 / 0.15)', color: 'oklch(55% 0.18 145)' }}>
                  Active
                </span>
              ) : (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide"
                  style={{ background: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
                  Not set
                </span>
              )}
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              Paste your startup.jobs browser cookies to bypass Cloudflare bot detection
            </p>
          </div>
          {form.startupJobsCookies?.trim() && (
            <button
              type="button"
              onClick={() => setForm(prev => ({ ...prev, startupJobsCookies: '' }))}
              className="text-xs px-2 py-1 rounded"
              style={{ color: 'var(--color-text-muted)', background: 'var(--color-border)' }}
            >
              Clear
            </button>
          )}
        </div>

        <details className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <summary className="cursor-pointer font-semibold select-none" style={{ color: 'var(--color-text-secondary)' }}>
            How to get your cookies (30 seconds)
          </summary>
          <ol className="mt-2 ml-4 space-y-1 list-decimal leading-relaxed">
            <li>Open Chrome and go to <strong>startup.jobs</strong></li>
            <li>Press <kbd className="px-1 rounded" style={{ background: 'var(--color-border)' }}>F12</kbd> to open DevTools</li>
            <li>Click the <strong>Console</strong> tab</li>
            <li>Type <code className="px-1 rounded" style={{ background: 'var(--color-border)' }}>document.cookie</code> and press Enter</li>
            <li>Select all the output, copy it, and paste below</li>
          </ol>
          <p className="mt-2 font-medium" style={{ color: 'oklch(62% 0.18 30)' }}>
            Cookies expire after a few hours — re-paste if startup.jobs starts blocking again.
          </p>
        </details>

        <textarea
          value={form.startupJobsCookies ?? ''}
          onChange={field('startupJobsCookies')}
          rows={3}
          placeholder="cf_clearance=Abc123...; __cf_bm=xyz..."
          className={inputCls}
          style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: '11px' }}
          spellCheck={false}
        />
      </div>

      <button type="submit" disabled={saving} className="btn-primary w-full py-3 text-base disabled:opacity-50">
        {saving ? 'Saving…' : 'Save & Start Applying'}
      </button>
    </form>
  )
}
