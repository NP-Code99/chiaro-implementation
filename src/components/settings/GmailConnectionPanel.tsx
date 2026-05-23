'use client'

import { useEffect, useState, useCallback } from 'react'

interface GmailStatus {
  connected: boolean
  gmailAddress: string | null
  connectedAt: string | null
  lastSyncedAt: string | null
}

function timeAgo(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const ms = Date.now() - d.getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function GmailConnectionPanel() {
  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/gmail/status', { cache: 'no-store' })
      const data = await res.json() as GmailStatus
      setStatus(data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  // Surface OAuth callback outcome
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const flag = params.get('gmail')
    if (flag === 'connected') {
      setToast('Gmail connected successfully! Your inbox is being synced.')
      void fetch('/api/gmail/sync', { method: 'POST' }).then(loadStatus)
      params.delete('gmail')
      const next = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (next ? `?${next}` : ''))
    } else if (flag === 'error') {
      setToast('Gmail connection failed. Please try again.')
      params.delete('gmail')
      params.delete('reason')
      const next = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (next ? `?${next}` : ''))
    }
    if (flag) {
      const t = setTimeout(() => setToast(null), 4500)
      return () => clearTimeout(t)
    }
  }, [loadStatus])

  async function handleConnect() {
    const res = await fetch('/api/auth/gmail/connect')
    const data = await res.json() as { authUrl?: string; error?: string }
    if (data.authUrl) {
      window.location.href = data.authUrl
    } else {
      setToast(data.error ?? 'Failed to start OAuth flow')
    }
  }

  async function handleSync() {
    setSyncing(true)
    try {
      const res = await fetch('/api/gmail/sync', { method: 'POST' })
      const data = await res.json() as { newEmails?: number; error?: string }
      if (data.error) {
        setToast(`Sync failed: ${data.error}`)
      } else {
        setToast(`Synced — ${data.newEmails ?? 0} new email${data.newEmails === 1 ? '' : 's'}`)
      }
      await loadStatus()
    } finally {
      setSyncing(false)
      setTimeout(() => setToast(null), 4000)
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect Gmail? Chiaro will stop monitoring your inbox.')) return
    await fetch('/api/gmail/disconnect', { method: 'POST' })
    setToast('Gmail disconnected.')
    await loadStatus()
    setTimeout(() => setToast(null), 3500)
  }

  return (
    <div
      className="rounded-2xl p-5"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border-subtle)' }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-xl"
            style={{ background: 'var(--color-bg)' }}
          >
            📧
          </div>
          <div>
            <h3 className="text-base font-semibold" style={{ color: 'var(--color-text)' }}>Gmail</h3>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Auto-track verification codes, interviews, offers, and rejections
            </p>
          </div>
        </div>
        {status?.connected && (
          <span
            className="text-xs px-2 py-1 rounded-full font-semibold flex items-center gap-1.5 flex-shrink-0"
            style={{ background: 'oklch(68% 0.18 145 / 0.15)', color: 'oklch(68% 0.18 145)' }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'oklch(68% 0.18 145)' }} />
            Connected
          </span>
        )}
      </div>

      {loading ? (
        <div className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Loading…</div>
      ) : status?.connected ? (
        <>
          <div className="space-y-1 mb-4">
            <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>
              {status.gmailAddress}
            </p>
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Connected {timeAgo(status.connectedAt)}
              {status.lastSyncedAt && <> · Synced {timeAgo(status.lastSyncedAt)}</>}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void handleSync()}
              disabled={syncing}
              className="text-sm px-4 py-2 rounded-full font-medium transition-opacity disabled:opacity-60"
              style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent)' }}
            >
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
            <button
              onClick={() => void handleDisconnect()}
              className="text-sm px-4 py-2 rounded-full font-medium transition-colors"
              style={{
                background: 'transparent',
                color: 'var(--color-text-muted)',
                border: '1px solid var(--color-border-subtle)',
              }}
            >
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm mb-4" style={{ color: 'var(--color-text-muted)' }}>
            Not connected
          </p>
          <button
            onClick={() => void handleConnect()}
            className="btn-primary text-sm px-5 py-2"
          >
            Connect Gmail
          </button>
        </>
      )}

      {toast && (
        <div
          className="mt-4 text-sm rounded-lg px-3 py-2"
          style={{
            background: 'var(--color-bg)',
            color: 'var(--color-text-secondary)',
            border: '1px solid var(--color-border-subtle)',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  )
}
