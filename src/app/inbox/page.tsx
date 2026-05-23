import { InboxClient } from '@/components/inbox/InboxClient'

export const metadata = {
  title: 'Inbox — Chiaro',
}

export default function InboxPage() {
  return (
    <main className="pt-14 min-h-screen" style={{ background: 'var(--color-bg)' }}>
      <div className="max-w-2xl mx-auto">
        <InboxClient />
      </div>
    </main>
  )
}
