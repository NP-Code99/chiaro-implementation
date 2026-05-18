'use client'

import { motion, useMotionValue, useTransform, useAnimate, PanInfo } from 'framer-motion'
import { classifyATS, getATSLabel, getATSDifficulty } from '@/lib/atsClassifier'
import type { Job } from '@prisma/client'

// ── Types ────────────────────────────────────────────────────────────────────

interface SwipeCardProps {
  job: Job
  isTop: boolean
  stackIndex: number
  onSwipeLeft: () => void
  onSwipeRight: () => void
}

// ── Constants ────────────────────────────────────────────────────────────────

const SWIPE_THRESHOLD = 80

const ATS_COLORS = {
  easy: {
    bg: 'oklch(68% 0.18 145 / 0.15)',
    color: 'oklch(68% 0.18 145)',
    border: 'oklch(68% 0.18 145 / 0.3)',
  },
  medium: {
    bg: 'oklch(72% 0.18 75 / 0.15)',
    color: 'oklch(72% 0.18 75)',
    border: 'oklch(72% 0.18 75 / 0.3)',
  },
  hard: {
    bg: 'oklch(62% 0.22 25 / 0.15)',
    color: 'oklch(62% 0.22 25)',
    border: 'oklch(62% 0.22 25 / 0.3)',
  },
  skip: {
    bg: 'oklch(45% 0.01 240 / 0.2)',
    color: 'oklch(55% 0.015 240)',
    border: 'oklch(45% 0.01 240 / 0.3)',
  },
}

// Deterministic color from company name
function logoColor(company: string): string {
  const COLORS = [
    'oklch(62% 0.22 250)',
    'oklch(62% 0.22 145)',
    'oklch(62% 0.22 25)',
    'oklch(62% 0.22 300)',
    'oklch(62% 0.22 75)',
    'oklch(62% 0.22 200)',
  ]
  let hash = 0
  for (let i = 0; i < company.length; i++) hash = (hash * 31 + company.charCodeAt(i)) >>> 0
  return COLORS[hash % COLORS.length]
}

function formatSalary(min?: number | null, max?: number | null): string | null {
  if (!min && !max) return null
  const fmt = (n: number) => `$${Math.round(n / 1000)}k`
  if (min && max) return `${fmt(min)} – ${fmt(max)}`
  if (min) return `${fmt(min)}+`
  return max ? `up to ${fmt(max)}` : null
}

// ── Stack card (non-top) ─────────────────────────────────────────────────────

function StackCard({ stackIndex }: { stackIndex: number }) {
  return (
    <div
      className="absolute inset-0 rounded-3xl"
      style={{
        background: `oklch(${14 + stackIndex * 2}% 0.015 240)`,
        border: '1px solid var(--color-border-subtle)',
        transform: `scale(${1 - stackIndex * 0.04}) translateY(${-stackIndex * 10}px)`,
        zIndex: 10 - stackIndex,
        boxShadow: 'var(--shadow-card)',
      }}
    />
  )
}

// ── Main swipeable card ───────────────────────────────────────────────────────

export function SwipeCard({ job, isTop, stackIndex, onSwipeLeft, onSwipeRight }: SwipeCardProps) {
  const [scope, animate] = useAnimate()
  const x = useMotionValue(0)
  const rotate = useTransform(x, [-300, 0, 300], [-15, 0, 15])

  const applyOverlayOpacity = useTransform(x, [0, SWIPE_THRESHOLD / 2, SWIPE_THRESHOLD], [0, 0.6, 1])
  const skipOverlayOpacity = useTransform(x, [-SWIPE_THRESHOLD, -SWIPE_THRESHOLD / 2, 0], [1, 0.6, 0])

  if (!isTop) return <StackCard stackIndex={stackIndex} />

  const atsType = classifyATS(job.applyUrl ?? null)
  const difficulty = getATSDifficulty(atsType)
  const atsLabel = getATSLabel(atsType)
  const atsStyle = ATS_COLORS[difficulty]
  const salary = formatSalary(job.salaryMin, job.salaryMax)
  const color = logoColor(job.company)
  const initials = job.company.slice(0, 2).toUpperCase()
  const parsedTags: string[] = typeof job.tags === 'string' ? JSON.parse(job.tags) : job.tags
  const isRemote = parsedTags.some(t => /remote/i.test(t))
  const stage = parsedTags.find(t => /series|seed|pre-seed|yc|backed|public|pre-ipo/i.test(t)) ?? null

  async function handleDragEnd(_: unknown, info: PanInfo) {
    const { offset, velocity } = info
    const shouldRight = offset.x > SWIPE_THRESHOLD || velocity.x > 500
    const shouldLeft = offset.x < -SWIPE_THRESHOLD || velocity.x < -500

    if (shouldRight) {
      await animate(scope.current, { x: 600, opacity: 0, rotate: 18 }, { duration: 0.28, ease: [0.16, 1, 0.3, 1] })
      onSwipeRight()
    } else if (shouldLeft) {
      await animate(scope.current, { x: -600, opacity: 0, rotate: -18 }, { duration: 0.28, ease: [0.16, 1, 0.3, 1] })
      onSwipeLeft()
    } else {
      await animate(scope.current, { x: 0, rotate: 0 }, { type: 'spring', stiffness: 350, damping: 28 })
    }
  }

  return (
    <motion.div
      ref={scope}
      style={{ x, rotate, zIndex: 20, position: 'absolute', inset: 0, cursor: 'grab' }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.65}
      onDragEnd={handleDragEnd}
      whileTap={{ cursor: 'grabbing', scale: 1.01 }}
      className="select-none"
    >
      <div
        className="w-full h-full rounded-3xl flex flex-col overflow-hidden"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border-subtle)',
          boxShadow: 'var(--shadow-elevated)',
        }}
      >
        {/* Header: logo + company + stage badge */}
        <div className="px-5 pt-5 pb-3 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center text-sm font-bold flex-shrink-0"
              style={{ background: `${color}22`, color, border: `1.5px solid ${color}44` }}
            >
              {initials}
            </div>
            <div>
              <p className="text-sm font-bold leading-tight" style={{ color: 'var(--color-text)' }}>
                {job.company}
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                {job.location}
              </p>
            </div>
          </div>
          {stage && (
            <span
              className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0"
              style={{
                background: 'var(--color-surface-elevated)',
                color: 'var(--color-text-secondary)',
                border: '1px solid var(--color-border-subtle)',
              }}
            >
              {stage}
            </span>
          )}
        </div>

        {/* Role + salary row */}
        <div className="px-5 pb-3">
          <h2 className="text-xl font-bold leading-snug" style={{ color: 'var(--color-text)' }}>
            {job.role}
          </h2>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {salary && (
              <span className="text-xs font-semibold" style={{ color: 'var(--color-accent)' }}>
                {salary}
              </span>
            )}
            {isRemote && (
              <span className="tag">Remote</span>
            )}
          </div>
        </div>

        {/* Divider */}
        <div className="mx-5 h-px" style={{ background: 'var(--color-border-subtle)' }} />

        {/* Description */}
        <div className="px-5 py-3 flex-1">
          <p className="text-sm leading-relaxed line-clamp-2" style={{ color: 'var(--color-text-secondary)' }}>
            {job.description}
          </p>
        </div>

        {/* Skill tags */}
        <div className="px-5 pb-3 flex flex-wrap gap-1.5">
          {parsedTags
            .filter(t => !/remote|series|seed|yc|backed|public|pre-ipo/i.test(t))
            .slice(0, 4)
            .map((tag) => (
              <span key={tag} className="tag">{tag}</span>
            ))}
        </div>

        {/* Manual review warning badge */}
        {job.manualReviewReason && (
          <div
            className="mx-5 mb-2 px-3 py-2 rounded-xl"
            style={{
              background: 'oklch(72% 0.18 75 / 0.1)',
              border: '1px solid oklch(72% 0.18 75 / 0.3)',
            }}
            title={`Requires manual review: ${job.manualReviewReason}`}
          >
            <p className="text-xs font-semibold" style={{ color: 'oklch(72% 0.18 75)' }}>
              ⚠ Manual review required
            </p>
            <p className="text-xs mt-0.5 truncate" style={{ color: 'oklch(65% 0.12 75)' }}>
              Missing: {job.manualReviewReason}
            </p>
          </div>
        )}

        {/* ATS badge footer */}
        <div
          className="mx-5 mb-5 px-3 py-2 rounded-xl flex items-center justify-between"
          style={{ background: atsStyle.bg, border: `1px solid ${atsStyle.border}` }}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold" style={{ color: atsStyle.color }}>
              {atsLabel}
            </span>
            {difficulty === 'easy' && (
              <span className="text-xs" style={{ color: atsStyle.color }}>· Auto-applies instantly</span>
            )}
            {difficulty === 'medium' && (
              <span className="text-xs" style={{ color: atsStyle.color }}>· Browser automation</span>
            )}
            {difficulty === 'hard' && atsType !== 'none' && (
              <span className="text-xs" style={{ color: atsStyle.color }}>· Browser automation</span>
            )}
            {atsType === 'none' && (
              <span className="text-xs" style={{ color: atsStyle.color }}>Email founder instead?</span>
            )}
          </div>
          <div
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: atsStyle.color }}
          />
        </div>

        {/* APPLY overlay */}
        <motion.div
          style={{ opacity: applyOverlayOpacity }}
          className="absolute inset-0 rounded-3xl flex items-start justify-start p-5 pointer-events-none"
        >
          <div
            className="border-[3px] rounded-xl px-4 py-2 rotate-[-12deg]"
            style={{ borderColor: 'var(--color-success)', color: 'var(--color-success)' }}
          >
            <span className="text-2xl font-black tracking-wide uppercase">Apply</span>
          </div>
        </motion.div>

        {/* SKIP overlay */}
        <motion.div
          style={{ opacity: skipOverlayOpacity }}
          className="absolute inset-0 rounded-3xl flex items-start justify-end p-5 pointer-events-none"
        >
          <div
            className="border-[3px] rounded-xl px-4 py-2 rotate-[12deg]"
            style={{ borderColor: 'oklch(55% 0.02 240)', color: 'oklch(65% 0.02 240)' }}
          >
            <span className="text-2xl font-black tracking-wide uppercase">Skip</span>
          </div>
        </motion.div>
      </div>
    </motion.div>
  )
}
