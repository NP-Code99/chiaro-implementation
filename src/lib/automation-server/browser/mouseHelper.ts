import type { Page } from 'playwright'

interface Point {
  x: number
  y: number
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// De Casteljau's algorithm for Bezier curve interpolation
function bezier(points: Point[], t: number): Point {
  if (points.length === 1) return points[0]
  const next: Point[] = []
  for (let i = 0; i < points.length - 1; i++) {
    next.push({
      x: (1 - t) * points[i].x + t * points[i + 1].x,
      y: (1 - t) * points[i].y + t * points[i + 1].y,
    })
  }
  return bezier(next, t)
}

function generateControlPoints(from: Point, to: Point): Point[] {
  const midX = (from.x + to.x) / 2
  const midY = (from.y + to.y) / 2
  const spread = randomBetween(50, 200)

  const cp1: Point = {
    x: midX + randomBetween(-spread, spread),
    y: midY + randomBetween(-spread, spread),
  }
  const cp2: Point = {
    x: midX + randomBetween(-spread, spread),
    y: midY + randomBetween(-spread, spread),
  }
  return [from, cp1, cp2, to]
}

export async function moveMouseTo(page: Page, target: Point): Promise<void> {
  const current = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
  const from: Point = { x: current.x + 683, y: current.y + 384 }

  const points = generateControlPoints(from, target)
  const steps = Math.floor(randomBetween(30, 60))

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const { x, y } = bezier(points, t)
    await page.mouse.move(x, y)
    await sleep(randomBetween(5, 15))
  }
}

export async function humanClick(page: Page, selector: string): Promise<void> {
  const el = page.locator(selector).first()
  const box = await el.boundingBox()
  if (!box) {
    await el.click()
    return
  }

  const target: Point = {
    x: box.x + box.width * randomBetween(0.2, 0.8),
    y: box.y + box.height * randomBetween(0.2, 0.8),
  }

  await moveMouseTo(page, target)
  await sleep(randomBetween(50, 150))
  await page.mouse.click(target.x, target.y)
}

export async function humanScroll(page: Page, direction: 'down' | 'up' = 'down'): Promise<void> {
  const delta = direction === 'down' ? randomBetween(200, 500) : -randomBetween(200, 500)
  const steps = Math.floor(randomBetween(3, 8))
  const stepDelta = delta / steps

  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepDelta)
    await sleep(randomBetween(50, 150))
  }
}
