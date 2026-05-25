/**
 * Playwright batch driver — opens the swipe UI at localhost:3000, applies to 10
 * jobs picked for ATS diversity, then polls /api/applications until each one
 * reaches a terminal status. Writes a per-job report with Steel session links.
 *
 * Run: npx tsx scripts/playwright-swipe-batch.ts
 *
 * First run: a headed Chromium window opens. If you have no profile saved in
 * that context's localStorage, you'll be redirected to /profile — fill it out,
 * click Save, then return to this terminal and press Enter. The persistent
 * context at ./.playwright-data keeps the profile for subsequent runs.
 */
import { chromium, type BrowserContext, type Page } from 'playwright'
import * as fs from 'fs'
import * as path from 'path'

const BASE = process.env.BASE_URL ?? 'http://localhost:3000'
const TARGET_APPLIES = Number(process.env.TARGET_APPLIES ?? 10)
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 25 * 60_000)
const PER_JOB_TIMEOUT_MS = Number(process.env.PER_JOB_TIMEOUT_MS ?? 8 * 60_000)
const USER_DATA_DIR = path.join(process.cwd(), '.playwright-data')
const OUT_DIR = path.join(process.cwd(), 'playwright-batch-results')

interface JobLite {
  id: string
  company: string
  role: string
  atsType: string
  applyUrl: string | null
}

interface AppRow {
  id: string
  jobId: string
  status: string
  errorMessage?: string | null
  errorCode?: string | null
  createdAt: string
}

interface OutcomeDetail {
  steelSessionId?: string | null
  steelViewUrl?: string | null
}

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.json() as Promise<T>
}

function pickDiverseTargets(jobs: JobLite[], count: number): Set<string> {
  const buckets: Record<string, JobLite[]> = {}
  for (const j of jobs) {
    if (!buckets[j.atsType]) buckets[j.atsType] = []
    buckets[j.atsType].push(j)
  }
  const types = Object.keys(buckets)
  const picked = new Set<string>()
  let cursor = 0
  while (picked.size < count && cursor < count * 4) {
    const ats = types[cursor % types.length]
    const next = buckets[ats]?.shift()
    if (next) picked.add(next.id)
    cursor++
  }
  return picked
}

async function ensureProfileReady(page: Page): Promise<void> {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  const hasProfile = async (): Promise<boolean> => {
    try { return await page.evaluate(() => Boolean(localStorage.getItem('chiaro_user_profile'))) }
    catch { return false }
  }
  if (await hasProfile()) return

  console.log('\n[batch] No profile in this browser context.')
  console.log('[batch] Fill the profile in the opened browser and click Save — I will poll for it.')
  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    if (await hasProfile()) {
      console.log('[batch] Profile detected — continuing.')
      await page.goto(BASE, { waitUntil: 'networkidle' })
      return
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('Profile not saved within 10 minutes — aborting')
}

async function waitForTopCard(page: Page, role: string, company: string): Promise<boolean> {
  try {
    await page.waitForFunction(
      ({ role, company }) => {
        const body = document.body.innerText
        return body.includes(role) && body.includes(company)
      },
      { role, company },
      { timeout: 15_000 }
    )
    return true
  } catch {
    return false
  }
}

async function runDeck(ctx: BrowserContext, jobs: JobLite[], targets: Set<string>): Promise<{ jobId: string; queuedAt: number }[]> {
  const page = ctx.pages()[0] ?? await ctx.newPage()
  await ensureProfileReady(page)

  const queued: { jobId: string; queuedAt: number }[] = []
  for (const job of jobs) {
    if (queued.length >= TARGET_APPLIES) break

    const matched = await waitForTopCard(page, job.role, job.company)
    if (!matched) {
      console.warn(`[batch] Top card did not show ${job.company} | ${job.role} within 15s — stopping walk`)
      break
    }

    if (targets.has(job.id)) {
      console.log(`[batch] APPLY  ${job.atsType.padEnd(12)} | ${job.company} | ${job.role}`)
      await page.click('button[aria-label="Apply"]')
      queued.push({ jobId: job.id, queuedAt: Date.now() })
      await page.waitForTimeout(1500)
    } else {
      console.log(`[batch] SKIP   ${job.atsType.padEnd(12)} | ${job.company} | ${job.role}`)
      await page.click('button[aria-label="Skip"]')
      await page.waitForTimeout(400)
    }
  }
  return queued
}

const TERMINAL = new Set(['APPLIED', 'FAILED', 'NEEDS_REVIEW', 'NEEDS_INFO'])

async function pollUntilTerminal(queued: { jobId: string; queuedAt: number }[]): Promise<Record<string, AppRow>> {
  const final: Record<string, AppRow> = {}
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline && Object.keys(final).length < queued.length) {
    const { applications } = await fetchJSON<{ applications: AppRow[] }>(`${BASE}/api/applications`)
    for (const q of queued) {
      if (final[q.jobId]) continue
      const row = applications.find(a => a.jobId === q.jobId)
      if (!row) continue
      const timedOut = Date.now() - q.queuedAt > PER_JOB_TIMEOUT_MS
      if (TERMINAL.has(row.status) || timedOut) {
        final[q.jobId] = row
      }
    }
    const remaining = queued.length - Object.keys(final).length
    if (remaining > 0) {
      const elapsedMin = ((Date.now() - queued[0].queuedAt) / 60_000).toFixed(1)
      process.stdout.write(`\r[batch] polling… ${Object.keys(final).length}/${queued.length} terminal (${elapsedMin}m elapsed)   `)
      await new Promise(r => setTimeout(r, 5_000))
    }
  }
  process.stdout.write('\n')
  return final
}

async function fetchOutcomes(final: Record<string, AppRow>): Promise<Record<string, OutcomeDetail>> {
  const out: Record<string, OutcomeDetail> = {}
  for (const row of Object.values(final)) {
    try {
      const res = await fetch(`${BASE}/api/outcomes/${row.id}`)
      if (!res.ok) continue
      const body = await res.json() as { success: boolean; data?: { steelSessionId?: string | null; steelViewUrl?: string | null } }
      if (body.success && body.data) {
        out[row.jobId] = { steelSessionId: body.data.steelSessionId, steelViewUrl: body.data.steelViewUrl }
      }
    } catch {
      // outcome may not exist yet — that's fine
    }
  }
  return out
}

function writeReport(opts: {
  startedAt: number
  jobs: JobLite[]
  queued: { jobId: string; queuedAt: number }[]
  final: Record<string, AppRow>
  outcomes: Record<string, OutcomeDetail>
}): string {
  const { startedAt, jobs, queued, final, outcomes } = opts
  const lines: string[] = []
  lines.push(`# Playwright swipe batch — ${new Date(startedAt).toISOString()}`)
  lines.push('')
  lines.push(`- Base URL: ${BASE}`)
  lines.push(`- Queued: ${queued.length}`)
  lines.push(`- Reached terminal status: ${Object.keys(final).length}`)
  lines.push(`- Duration: ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`)
  lines.push('')

  const byStatus = Object.values(final).reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1
    return acc
  }, {})
  lines.push('## Status breakdown')
  for (const [s, n] of Object.entries(byStatus)) lines.push(`- ${s}: ${n}`)
  lines.push('')

  lines.push('## Per-job results')
  lines.push('')
  lines.push('| # | Company | Role | ATS | Status | ErrorCode | ErrorMessage | Steel |')
  lines.push('|---|---------|------|-----|--------|-----------|--------------|-------|')
  queued.forEach((q, i) => {
    const job = jobs.find(j => j.id === q.jobId)
    if (!job) return
    const row = final[q.jobId]
    const o = outcomes[q.jobId]
    const steel = o?.steelViewUrl ? `[view](${o.steelViewUrl})` : (o?.steelSessionId ?? '')
    const status = row?.status ?? 'TIMEOUT'
    const errCode = row?.errorCode ?? ''
    const errMsg = (row?.errorMessage ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 100)
    lines.push(`| ${i + 1} | ${job.company} | ${job.role} | ${job.atsType} | ${status} | ${errCode} | ${errMsg} | ${steel} |`)
  })

  const reportPath = path.join(OUT_DIR, `report-${startedAt}.md`)
  fs.writeFileSync(reportPath, lines.join('\n'))
  return reportPath
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const startedAt = Date.now()

  console.log(`[batch] Fetching deck from ${BASE}/api/jobs ...`)
  const { jobs } = await fetchJSON<{ jobs: JobLite[]; userId: string }>(`${BASE}/api/jobs`)
  if (jobs.length === 0) throw new Error('No jobs in deck. Run /api/jobs refresh or pnpm db:seed first.')

  const targets = pickDiverseTargets(jobs, Math.min(TARGET_APPLIES, jobs.length))
  console.log(`[batch] Selected ${targets.size} target IDs across ATS types`)

  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  })

  let queued: { jobId: string; queuedAt: number }[] = []
  try {
    queued = await runDeck(ctx, jobs, targets)
  } finally {
    // Keep the browser open during polling so you can watch Steel sessions render.
  }

  if (queued.length === 0) {
    console.warn('[batch] Nothing queued — exiting')
    await ctx.close()
    return
  }

  console.log(`[batch] Queued ${queued.length} applications; polling for terminal status (max ${POLL_TIMEOUT_MS / 60_000}min)`)
  const final = await pollUntilTerminal(queued)
  const outcomes = await fetchOutcomes(final)

  const reportPath = writeReport({ startedAt, jobs, queued, final, outcomes })
  console.log(`[batch] Report written to ${reportPath}`)

  await ctx.close()
}

void main().catch(err => {
  console.error('[batch] FATAL:', err)
  process.exit(1)
})
