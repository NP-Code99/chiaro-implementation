'use client'

import { motion } from 'framer-motion'
import { CardOverlay } from './CardOverlay'
import { useSwipeGesture } from '@/hooks/useSwipeGesture'
import type { Job } from '@prisma/client'

interface JobCardProps {
  job: Job
  isTop: boolean
  stackIndex: number
  onSwipeLeft: () => void
  onSwipeRight: () => void
}

const ATS_LABELS: Record<string, { label: string; color: string }> = {
  GREENHOUSE: { label: 'Greenhouse', color: 'oklch(65% 0.18 145)' },
  LEVER: { label: 'Lever', color: 'oklch(65% 0.18 30)' },
  WORKDAY: { label: 'Workday', color: 'oklch(65% 0.18 220)' },
  CUSTOM: { label: 'Direct', color: 'oklch(65% 0.15 280)' },
}

function formatSalary(min?: number | null, max?: number | null): string {
  if (!min && !max) return ''
  const fmt = (n: number) => `$${Math.round(n / 1000)}k`
  if (min && max) return `${fmt(min)} – ${fmt(max)}`
  if (min) return `${fmt(min)}+`
  if (max) return `up to ${fmt(max)}`
  return ''
}

export function JobCard({ job, isTop, stackIndex, onSwipeLeft, onSwipeRight }: JobCardProps) {
  const { scope, x, rotate, opacity, skipOverlayOpacity, applyOverlayOpacity, handleDragEnd } =
    useSwipeGesture({ onSwipeLeft, onSwipeRight })

  const ats = ATS_LABELS[job.atsType] ?? ATS_LABELS.CUSTOM
  const salary = formatSalary(job.salaryMin, job.salaryMax)

  // Non-top cards show as stacked behind
  if (!isTop) {
    const scale = 1 - stackIndex * 0.04
    const translateY = -stackIndex * 10
    return (
      <div
        className="absolute inset-0 rounded-2xl"
        style={{
          background: `oklch(${14 + stackIndex * 2}% 0.015 240)`,
          border: '1px solid var(--color-border-subtle)',
          transform: `scale(${scale}) translateY(${translateY}px)`,
          zIndex: 10 - stackIndex,
          boxShadow: 'var(--shadow-card)',
        }}
      />
    )
  }

  return (
    <motion.div
      ref={scope}
      style={{ x, rotate, opacity, zIndex: 20, position: 'absolute', inset: 0, cursor: 'grab' }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.7}
      onDragEnd={handleDragEnd}
      whileTap={{ cursor: 'grabbing', scale: 1.02 }}
      className="select-none"
    >
      <div
        className="w-full h-full rounded-2xl flex flex-col overflow-hidden"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border-subtle)',
          boxShadow: 'var(--shadow-elevated)',
        }}
      >
        {/* Card header — company + ATS badge */}
        <div className="px-6 pt-6 pb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center text-lg font-bold flex-shrink-0"
              style={{
                background: 'var(--color-surface-elevated)',
                color: 'var(--color-accent)',
                border: '1px solid var(--color-border-subtle)',
              }}
            >
              {job.company.charAt(0)}
            </div>
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
                {job.company}
              </p>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {job.location}
              </p>
            </div>
          </div>
          <span
            className="text-xs px-2 py-1 rounded-full font-medium flex-shrink-0"
            style={{
              background: `${ats.color}22`,
              color: ats.color,
              border: `1px solid ${ats.color}44`,
            }}
          >
            {ats.label}
          </span>
        </div>

        {/* Role title */}
        <div className="px-6 pb-4">
          <h2 className="text-2xl font-bold leading-tight" style={{ color: 'var(--color-text)' }}>
            {job.role}
          </h2>
          {salary && (
            <p className="text-sm mt-1 font-medium" style={{ color: 'var(--color-accent)' }}>
              {salary}
            </p>
          )}
        </div>

        {/* Divider */}
        <div className="mx-6 h-px" style={{ background: 'var(--color-border-subtle)' }} />

        {/* Description */}
        <div className="px-6 py-4 flex-1 overflow-hidden">
          <p className="text-sm leading-relaxed line-clamp-5" style={{ color: 'var(--color-text-secondary)' }}>
            {job.description}
          </p>
        </div>

        {/* Tags */}
        <div className="px-6 pb-6 flex flex-wrap gap-2">
          {(JSON.parse(job.tags) as string[]).slice(0, 5).map((tag) => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        </div>

        {/* Overlays */}
        <CardOverlay applyOpacity={applyOverlayOpacity} skipOpacity={skipOverlayOpacity} />
      </div>
    </motion.div>
  )
}
