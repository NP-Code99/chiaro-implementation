import { ProfileForm } from '@/components/ProfileForm'

export default function ProfilePage() {
  return (
    <div className="max-w-xl mx-auto px-4 py-10">
      <div className="mb-7">
        <h1 className="text-2xl font-bold" style={{ color: 'var(--color-text)' }}>
          Set up your profile
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
          Chiaro uses this to fill out applications automatically.
          Your data stays on your device.
        </p>
      </div>
      <div className="card p-6">
        <ProfileForm />
      </div>
    </div>
  )
}
