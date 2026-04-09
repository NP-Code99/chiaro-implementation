'use client'

import { motion, MotionValue } from 'framer-motion'

interface CardOverlayProps {
  applyOpacity: MotionValue<number>
  skipOpacity: MotionValue<number>
}

export function CardOverlay({ applyOpacity, skipOpacity }: CardOverlayProps) {
  return (
    <>
      {/* APPLY overlay — right swipe */}
      <motion.div
        style={{ opacity: applyOpacity }}
        className="absolute inset-0 rounded-2xl flex items-start justify-start p-6 pointer-events-none"
      >
        <div className="border-[3px] rounded-xl px-4 py-2 rotate-[-12deg]"
          style={{ borderColor: 'var(--color-success)', color: 'var(--color-success)' }}
        >
          <span className="text-2xl font-black tracking-wide uppercase">Apply</span>
        </div>
      </motion.div>

      {/* SKIP overlay — left swipe */}
      <motion.div
        style={{ opacity: skipOpacity }}
        className="absolute inset-0 rounded-2xl flex items-start justify-end p-6 pointer-events-none"
      >
        <div className="border-[3px] rounded-xl px-4 py-2 rotate-[12deg]"
          style={{ borderColor: 'var(--color-error)', color: 'var(--color-error)' }}
        >
          <span className="text-2xl font-black tracking-wide uppercase">Skip</span>
        </div>
      </motion.div>
    </>
  )
}
