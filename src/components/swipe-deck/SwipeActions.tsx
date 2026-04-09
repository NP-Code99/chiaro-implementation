'use client'

interface SwipeActionsProps {
  onSkip: () => void
  onApply: () => void
  disabled?: boolean
}

export function SwipeActions({ onSkip, onApply, disabled }: SwipeActionsProps) {
  return (
    <div className="flex items-center justify-center gap-6 mt-6">
      <button
        onClick={onSkip}
        disabled={disabled}
        aria-label="Skip job"
        className="w-14 h-14 rounded-full flex items-center justify-center text-2xl transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          color: 'var(--color-error)',
        }}
        onMouseEnter={(e) => {
          if (!disabled) {
            e.currentTarget.style.background = 'var(--color-error-subtle)'
            e.currentTarget.style.transform = 'scale(1.08)'
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'var(--color-surface)'
          e.currentTarget.style.transform = 'scale(1)'
        }}
      >
        ✕
      </button>

      <button
        onClick={onApply}
        disabled={disabled}
        aria-label="Apply to job"
        className="w-16 h-16 rounded-full flex items-center justify-center text-2xl transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          background: 'var(--color-accent)',
          border: 'none',
          color: 'white',
          boxShadow: '0 4px 20px var(--color-accent-subtle)',
        }}
        onMouseEnter={(e) => {
          if (!disabled) {
            e.currentTarget.style.background = 'var(--color-accent-hover)'
            e.currentTarget.style.transform = 'scale(1.08)'
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'var(--color-accent)'
          e.currentTarget.style.transform = 'scale(1)'
        }}
      >
        ♥
      </button>
    </div>
  )
}
