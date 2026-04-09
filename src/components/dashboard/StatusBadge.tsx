import { ApplicationStatus } from '@prisma/client'

const STATUS_CONFIG: Record<
  ApplicationStatus,
  { label: string; bg: string; color: string; dot?: boolean }
> = {
  PENDING: {
    label: 'Queued',
    bg: 'oklch(45% 0.01 240 / 0.2)',
    color: 'oklch(65% 0.015 240)',
  },
  APPLYING: {
    label: 'Applying',
    bg: 'oklch(55% 0.22 250 / 0.15)',
    color: 'oklch(65% 0.22 250)',
    dot: true,
  },
  APPLIED: {
    label: 'Applied',
    bg: 'oklch(68% 0.18 145 / 0.15)',
    color: 'oklch(68% 0.18 145)',
  },
  FAILED: {
    label: 'Failed',
    bg: 'oklch(62% 0.22 25 / 0.15)',
    color: 'oklch(62% 0.22 25)',
  },
  NEEDS_REVIEW: {
    label: 'Review',
    bg: 'oklch(72% 0.18 75 / 0.15)',
    color: 'oklch(72% 0.18 75)',
  },
}

interface StatusBadgeProps {
  status: ApplicationStatus
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status]

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
      style={{ background: config.bg, color: config.color }}
    >
      {config.dot && (
        <span
          className="w-1.5 h-1.5 rounded-full animate-pulse-slow"
          style={{ background: config.color }}
        />
      )}
      {config.label}
    </span>
  )
}
