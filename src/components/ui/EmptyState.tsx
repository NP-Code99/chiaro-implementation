interface EmptyStateProps {
  title: string
  description: string
  action?: React.ReactNode
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-20 text-center px-4">
      <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl"
        style={{ background: 'var(--color-surface-elevated)' }}
      >
        ✦
      </div>
      <div className="space-y-1.5">
        <h3 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
          {title}
        </h3>
        <p className="text-sm max-w-xs" style={{ color: 'var(--color-text-secondary)' }}>
          {description}
        </p>
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
