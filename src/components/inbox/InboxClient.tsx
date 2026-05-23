'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

// ── Types (mirror /api/gmail/emails response) ─────────────────────────────────

export type InboxCategory =
  | 'all'
  | 'verification_code'
  | 'interview'
  | 'offer'
  | 'rejection'
  | 'application_confirm'
  | 'other'

export interface InboxEmail {
  id: string
  gmailMessageId: string
  from: string
  fromName: string
  subject: string
  snippet: string
  body: string
  receivedAt: string
  category: Exclude<InboxCategory, 'all'>
  verificationCode: string | null
  companyName: string | null
  applicationId: string | null
  isRead: boolean
}

interface EmailsResponse {
  connected: boolean
  gmailAddress?: string
  emails: InboxEmail[]
}

// ── Display config ─────────────────────────────────────────────────────────────

const CATEGORIES: { id: InboxCategory; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'verification_code', label: 'Codes' },
  { id: 'interview', label: 'Interviews' },
  { id: 'offer', label: 'Offers' },
  { id: 'rejection', label: 'Rejections' },
  { id: 'application_confirm', label: 'Confirmed' },
  { id: 'other', label: 'Other' },
]

const CATEGORY_LABEL: Record<Exclude<InboxCategory, 'all'>, string> = {
  verification_code: 'Verification Code',
  interview: 'Interview',
  offer: 'Offer',
  rejection: 'Rejection',
  application_confirm: 'Application Confirmed',
  other: 'Other',
}

const CATEGORY_COLORS: Record<Exclude<InboxCategory, 'all'>, { bg: string; color: string; dot: string }> = {
  verification_code:   { bg: 'oklch(62% 0.22 250 / 0.15)', color: 'oklch(62% 0.22 250)', dot: '🔵' },
  interview:           { bg: 'oklch(72% 0.18 75 / 0.15)',  color: 'oklch(72% 0.18 75)',  dot: '🟡' },
  offer:               { bg: 'oklch(68% 0.18 145 / 0.15)', color: 'oklch(68% 0.18 145)', dot: '🟢' },
  rejection:           { bg: 'oklch(62% 0.22 25 / 0.15)',  color: 'oklch(62% 0.22 25)',  dot: '🔴' },
  application_confirm: { bg: 'var(--color-accent-subtle)', color: 'var(--color-accent)', dot: '⚪' },
  other:               { bg: 'oklch(50% 0 0 / 0.12)',     color: 'oklch(65% 0 0)',      dot: '⚫' },
}

function timeAgo(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const ms = Date.now() - d.getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 7) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function stringToColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash)
  const hues = [250, 145, 75, 290, 25, 340, 200]
  return `oklch(55% 0.2 ${hues[Math.abs(hash) % hues.length]})`
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function CategoryPills({ active, onChange }: { active: InboxCategory; onChange: (c: InboxCategory) => void }) {
  return (
    <div className="flex gap-2 overflow-x-auto py-3 px-4" style={{ scrollbarWidth: 'none' }}>
      {CATEGORIES.map(({ id, label }) => {
        const isActive = id === active
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            className="flex-shrink-0 px-3.5 py-1.5 rounded-full text-sm font-medium transition-all"
            style={{
              background: isActive ? 'var(--color-accent-subtle)' : 'transparent',
              color: isActive ? 'var(--color-accent)' : 'var(--color-text-muted)',
              border: `1px solid ${isActive ? 'var(--color-accent)' : 'var(--color-border-subtle)'}`,
            }}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

function ConnectGmailBanner({ onConnect }: { onConnect: () => void }) {
  return (
    <div
      className="mx-4 my-4 rounded-xl p-4 flex items-center gap-3"
      style={{
        background: 'var(--color-accent-subtle)',
        border: '1px solid var(--color-accent)',
      }}
    >
      <div className="text-2xl">📧</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          Connect your Gmail
        </p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
          Auto-track verification codes, interviews, offers, and rejections.
        </p>
      </div>
      <button
        onClick={onConnect}
        className="btn-primary text-xs px-3 py-1.5 flex-shrink-0"
      >
        Connect →
      </button>
    </div>
  )
}

function EmailRow({ email, onClick }: { email: InboxEmail; onClick: () => void }) {
  const colors = CATEGORY_COLORS[email.category]
  const senderLabel = email.companyName ?? email.fromName ?? email.from
  const avatarColor = stringToColor(email.from)

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 transition-colors text-left"
      style={{
        borderBottom: '1px solid var(--color-border-subtle)',
        background: email.isRead ? 'transparent' : 'oklch(62% 0.22 250 / 0.04)',
      }}
    >
      <div
        className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white"
        style={{ background: avatarColor }}
      >
        {(senderLabel?.[0] ?? '?').toUpperCase()}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span
            className="text-sm truncate"
            style={{ color: 'var(--color-text)', fontWeight: email.isRead ? 400 : 600 }}
          >
            {senderLabel}
          </span>
          <span className="flex-shrink-0 text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {timeAgo(email.receivedAt)}
          </span>
        </div>

        <p
          className="text-sm truncate"
          style={{ color: 'var(--color-text-secondary)', fontWeight: email.isRead ? 400 : 500 }}
        >
          {email.subject}
        </p>

        <div className="flex items-center gap-2 mt-1">
          <span
            className="text-xs px-1.5 py-0.5 rounded-full font-medium flex-shrink-0"
            style={{ background: colors.bg, color: colors.color }}
          >
            {CATEGORY_LABEL[email.category]}
          </span>
          {email.verificationCode && (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-bold font-mono flex-shrink-0"
              style={{
                background: 'oklch(72% 0.18 75 / 0.15)',
                color: 'oklch(72% 0.18 75)',
                letterSpacing: '0.05em',
              }}
            >
              {email.verificationCode}
            </span>
          )}
          <p className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>
            {email.snippet}
          </p>
        </div>
      </div>
    </button>
  )
}

function VerificationCodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div
      className="rounded-xl p-5 flex flex-col items-center gap-3"
      style={{
        background: 'oklch(72% 0.18 75 / 0.1)',
        border: '1px solid oklch(72% 0.18 75 / 0.3)',
      }}
    >
      <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: 'oklch(72% 0.18 75)' }}>
        Verification Code
      </p>
      <p
        className="text-4xl font-black tracking-widest select-all"
        style={{ color: 'var(--color-text)', fontFamily: 'monospace' }}
      >
        {code}
      </p>
      <button
        onClick={handleCopy}
        className="btn-primary text-sm px-6 py-2"
        style={copied ? { background: 'var(--color-success)' } : undefined}
      >
        {copied ? '✓ Copied!' : 'Copy Code'}
      </button>
    </div>
  )
}

function EmailDetail({ email, onBack }: { email: InboxEmail; onBack: () => void }) {
  const colors = CATEGORY_COLORS[email.category]

  return (
    <div className="flex flex-col h-full" style={{ background: 'var(--color-bg)' }}>
      <div
        className="flex items-center gap-3 px-4 py-3 border-b"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          Back
        </button>
        <div className="flex-1" />
        <span
          className="text-xs px-2.5 py-1 rounded-full font-semibold"
          style={{ background: colors.bg, color: colors.color }}
        >
          {CATEGORY_LABEL[email.category]}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <h1 className="text-lg font-bold leading-snug" style={{ color: 'var(--color-text)' }}>
          {email.subject}
        </h1>

        <div
          className="rounded-xl p-4 space-y-2"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border-subtle)' }}
        >
          <MetaRow label="From" value={`${email.fromName} <${email.from}>`} />
          {email.companyName && <MetaRow label="Company" value={email.companyName} />}
          <MetaRow label="Date" value={new Date(email.receivedAt).toLocaleString()} />
        </div>

        {email.verificationCode && <VerificationCodeBlock code={email.verificationCode} />}

        <div
          className="rounded-xl p-4"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border-subtle)' }}
        >
          <pre
            className="text-sm whitespace-pre-wrap break-words"
            style={{
              color: 'var(--color-text-secondary)',
              fontFamily: 'var(--font-inter), system-ui, sans-serif',
              lineHeight: '1.6',
            }}
          >
            {email.body || email.snippet}
          </pre>
        </div>
      </div>
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs font-semibold w-16 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
        {label}
      </span>
      <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
        {value}
      </span>
    </div>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function InboxClient() {
  const [category, setCategory] = useState<InboxCategory>('all')
  const [emails, setEmails] = useState<InboxEmail[]>([])
  const [connected, setConnected] = useState(true)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [selected, setSelected] = useState<InboxEmail | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchEmails = useCallback(async () => {
    try {
      const res = await fetch(`/api/gmail/emails?category=${category}&limit=50`, { cache: 'no-store' })
      const data = await res.json() as EmailsResponse
      setConnected(data.connected)
      setEmails(data.emails)
    } catch {
      // ignore — keep previous data
    } finally {
      setLoading(false)
    }
  }, [category])

  useEffect(() => {
    setLoading(true)
    void fetchEmails()
  }, [fetchEmails])

  useEffect(() => {
    intervalRef.current = setInterval(() => void fetchEmails(), 30_000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [fetchEmails])

  async function handleSync() {
    setSyncing(true)
    try {
      await fetch('/api/gmail/sync', { method: 'POST' })
      await fetchEmails()
    } finally {
      setSyncing(false)
    }
  }

  async function handleConnect() {
    const res = await fetch('/api/auth/gmail/connect')
    const data = await res.json() as { authUrl?: string }
    if (data.authUrl) window.location.href = data.authUrl
  }

  async function handleSelectEmail(email: InboxEmail) {
    setSelected(email)
    if (!email.isRead) {
      void fetch(`/api/gmail/emails/${email.id}/mark-read`, { method: 'POST' })
      setEmails(prev => prev.map(e => (e.id === email.id ? { ...e, isRead: true } : e)))
    }
  }

  if (selected) {
    return <EmailDetail email={selected} onBack={() => setSelected(null)} />
  }

  return (
    <div className="flex flex-col min-h-0">
      <div
        className="flex items-center justify-between px-4 py-2 border-b"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <h1 className="text-base font-semibold" style={{ color: 'var(--color-text)' }}>
          Inbox
        </h1>
        {connected && (
          <button
            onClick={() => void handleSync()}
            disabled={syncing}
            className="text-xs px-2.5 py-1 rounded-full transition-colors disabled:opacity-60"
            style={{
              color: 'var(--color-text-muted)',
              border: '1px solid var(--color-border-subtle)',
            }}
          >
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
        )}
      </div>

      {!connected && <ConnectGmailBanner onConnect={() => void handleConnect()} />}

      {connected && <CategoryPills active={category} onChange={cat => { setCategory(cat); setSelected(null) }} />}

      <div className="flex-1">
        {connected && loading && (
          <div className="space-y-0">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-4 py-3"
                style={{ borderBottom: '1px solid var(--color-border-subtle)' }}
              >
                <div
                  className="w-9 h-9 rounded-full flex-shrink-0 animate-pulse"
                  style={{ background: 'var(--color-surface-elevated)' }}
                />
                <div className="flex-1 space-y-2">
                  <div
                    className="h-3.5 rounded animate-pulse"
                    style={{ background: 'var(--color-surface-elevated)', width: `${50 + (i * 17) % 35}%` }}
                  />
                  <div
                    className="h-3 rounded animate-pulse"
                    style={{ background: 'var(--color-surface-elevated)', width: `${60 + (i * 11) % 30}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {connected && !loading && emails.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 px-8 text-center gap-3">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center text-2xl"
              style={{ background: 'var(--color-surface)' }}
            >
              📬
            </div>
            <p className="text-sm max-w-xs" style={{ color: 'var(--color-text-muted)' }}>
              No emails yet. Tap “Sync Now” or wait for the next background sync.
            </p>
          </div>
        )}

        {connected && !loading && emails.length > 0 && (
          <div>
            {emails.map(email => (
              <EmailRow key={email.id} email={email} onClick={() => void handleSelectEmail(email)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
