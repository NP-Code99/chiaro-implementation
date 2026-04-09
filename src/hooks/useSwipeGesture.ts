'use client'

import { useMotionValue, useTransform, useAnimate, PanInfo } from 'framer-motion'
import { useCallback } from 'react'

interface UseSwipeGestureOptions {
  onSwipeLeft: () => void
  onSwipeRight: () => void
  threshold?: number
}

export function useSwipeGesture({
  onSwipeLeft,
  onSwipeRight,
  threshold = 120,
}: UseSwipeGestureOptions) {
  const x = useMotionValue(0)
  const [scope, animate] = useAnimate()

  const rotate = useTransform(x, [-300, 0, 300], [-18, 0, 18])
  const opacity = useTransform(x, [-300, -150, 0, 150, 300], [0, 1, 1, 1, 0])

  const skipOverlayOpacity = useTransform(x, [-threshold, -threshold / 2, 0], [1, 0.5, 0])
  const applyOverlayOpacity = useTransform(x, [0, threshold / 2, threshold], [0, 0.5, 1])

  const handleDragEnd = useCallback(
    async (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      const { offset, velocity } = info
      const swipeX = offset.x
      const swipeVelocity = velocity.x

      const shouldSwipeLeft = swipeX < -threshold || swipeVelocity < -500
      const shouldSwipeRight = swipeX > threshold || swipeVelocity > 500

      if (shouldSwipeRight) {
        await animate(scope.current, { x: 600, opacity: 0, rotate: 20 }, { duration: 0.3, ease: [0.16, 1, 0.3, 1] })
        onSwipeRight()
      } else if (shouldSwipeLeft) {
        await animate(scope.current, { x: -600, opacity: 0, rotate: -20 }, { duration: 0.3, ease: [0.16, 1, 0.3, 1] })
        onSwipeLeft()
      } else {
        await animate(scope.current, { x: 0, rotate: 0 }, { type: 'spring', stiffness: 300, damping: 25 })
      }
    },
    [threshold, onSwipeLeft, onSwipeRight, animate, scope]
  )

  const triggerSwipeLeft = useCallback(async () => {
    await animate(scope.current, { x: -600, opacity: 0, rotate: -20 }, { duration: 0.3, ease: [0.16, 1, 0.3, 1] })
    onSwipeLeft()
  }, [animate, scope, onSwipeLeft])

  const triggerSwipeRight = useCallback(async () => {
    await animate(scope.current, { x: 600, opacity: 0, rotate: 20 }, { duration: 0.3, ease: [0.16, 1, 0.3, 1] })
    onSwipeRight()
  }, [animate, scope, onSwipeRight])

  return {
    scope,
    x,
    rotate,
    opacity,
    skipOverlayOpacity,
    applyOverlayOpacity,
    handleDragEnd,
    triggerSwipeLeft,
    triggerSwipeRight,
  }
}
