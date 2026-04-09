import { DashboardClient } from '@/components/DashboardClient'

export default function DashboardPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <div className="mb-7">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--color-text)' }}>
          Applications
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
          Updates every 5 seconds.
        </p>
      </div>
      <DashboardClient />
    </div>
  )
}
