import { Worker } from 'bullmq'
import { redisConnection } from './jobQueue'
import type { ProcessJobPayload } from '../types'
import { loadSession, validateSession } from '../browser/sessionManager'
import { fillFormFields, submitForm } from '../browser/formFiller'
import { humanScroll } from '../browser/mouseHelper'

// Site-specific config: where to validate a live session for each known site
const SITE_VALIDATION: Record<string, { url: string; selector: string }> = {
  'linkedin.com': { url: 'https://www.linkedin.com/feed/', selector: '[data-test-id="nav-profile"]' },
  'greenhouse.io': { url: 'https://app.greenhouse.io/', selector: '.navbar' },
  'lever.co': { url: 'https://hire.lever.co/', selector: '.navbar' },
  'wellfound.com': { url: 'https://wellfound.com/jobs', selector: '[data-test="user-avatar"]' },
}

function siteKey(url: string): string {
  const match = Object.keys(SITE_VALIDATION).find(k => url.includes(k))
  return match ?? new URL(url).hostname
}

async function extractGreenhouseFields(page: import('playwright').Page) {
  return page.evaluate(() => {
    const fields: {
      selector: string
      label: string
      type: string
      required: boolean
      options: string[]
    }[] = []

    document.querySelectorAll('input, select, textarea').forEach((el) => {
      const input = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      if (['hidden', 'submit', 'button'].includes((input as HTMLInputElement).type ?? '')) return

      const id = input.id || ''
      const labelEl = id ? document.querySelector(`label[for="${id}"]`) : input.closest('label')
      const label = (labelEl?.textContent ?? '').trim()

      const options: string[] = []
      if (input.tagName === 'SELECT') {
        ;(input as HTMLSelectElement).querySelectorAll('option').forEach(o => {
          if (o.value) options.push(o.text)
        })
      }

      fields.push({
        selector: id ? `#${id}` : input.name ? `[name="${input.name}"]` : input.tagName.toLowerCase(),
        label,
        type: (input as HTMLInputElement).type || input.tagName.toLowerCase(),
        required: input.required,
        options,
      })
    })
    return fields
  })
}

function mapFieldsToProfile(
  rawFields: { selector: string; label: string; type: string; required: boolean; options: string[] }[],
  profile: ProcessJobPayload['profile'],
) {
  return rawFields.map(f => {
    const hint = `${f.label} ${f.selector}`.toLowerCase()
    let value = ''

    if (/first.*name|fname/i.test(hint))        value = profile.firstName
    else if (/last.*name|lname/i.test(hint))     value = profile.lastName
    else if (/\bfull.*name\b|\bname\b/i.test(hint) && !/company|school/i.test(hint))
                                                  value = `${profile.firstName} ${profile.lastName}`
    else if (/email/i.test(hint))                value = profile.email
    else if (/phone|mobile/i.test(hint))         value = profile.phone
    else if (/linkedin/i.test(hint))             value = profile.linkedin ?? ''
    else if (/github/i.test(hint))               value = profile.github ?? ''
    else if (/location|city|address/i.test(hint)) value = profile.location
    else if (/salary|compensation/i.test(hint))  value = profile.desiredSalary ?? ''
    else if (/sponsor|visa/i.test(hint))         value = 'No'
    else if (/authoriz|eligible/i.test(hint))    value = 'Yes'
    else if (/cover|why.*apply|about.*yourself|motivation/i.test(hint))
                                                  value = profile.bio ?? ''
    else if (f.type === 'file')                  value = '__RESUME__'

    return {
      selector: f.selector,
      label: f.label,
      type: f.type as 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file' | 'password',
      required: f.required,
      options: f.options,
      value,
    }
  })
}

export function startWorker(concurrency = 2): Worker<ProcessJobPayload> {
  const worker = new Worker<ProcessJobPayload>(
    'job-applications',
    async (job) => {
      const { userId, jobUrl, site, profile } = job.data
      console.log(`[worker] Processing application ${job.id} — ${jobUrl}`)

      await job.updateProgress(10)

      // ── Validate session ────────────────────────────────────────────────────
      const siteValidation = SITE_VALIDATION[siteKey(jobUrl)]
      if (siteValidation) {
        const valid = await validateSession(
          userId,
          siteKey(jobUrl),
          siteValidation.url,
          siteValidation.selector,
        )
        if (!valid) {
          throw new Error(`Session invalid for ${userId}. Please re-authenticate via the session API.`)
        }
      }

      await job.updateProgress(20)

      // ── Load session and open context ───────────────────────────────────────
      const session = loadSession(userId, siteKey(jobUrl))
      let context: import('playwright').BrowserContext

      if (session) {
        const { launchHeadlessContext: launchCtx } = await import('../browser/antiDetection')
        context = await launchCtx(userId, session.storageState, session.userAgent)
      } else {
        // No session — open fresh anonymous context
        const { chromium } = await import('playwright-extra')
        const browser = await chromium.launch({ headless: true })
        context = await browser.newContext()
      }

      const page = await context.newPage()

      try {
        await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await job.updateProgress(40)

        // ── Extract and map form fields ─────────────────────────────────────
        await humanScroll(page, 'down')
        const rawFields = await extractGreenhouseFields(page)
        const mappedFields = mapFieldsToProfile(rawFields, profile)

        await job.updateProgress(60)

        // ── Fill form ───────────────────────────────────────────────────────
        const { filled, skipped } = await fillFormFields(page, mappedFields, profile.resumePath)
        console.log(`[worker] Filled ${filled} fields, skipped ${skipped}`)

        await job.updateProgress(80)

        // ── Submit ──────────────────────────────────────────────────────────
        const submitSel =
          'button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Apply")'
        await submitForm(page, submitSel)

        // ── Detect success ──────────────────────────────────────────────────
        await page.waitForTimeout(3000)
        const bodyText = (await page.textContent('body') ?? '').toLowerCase()
        const success =
          /thank you|application received|successfully applied|we.ll be in touch|submission confirmed/.test(bodyText)

        await job.updateProgress(100)

        return { success, filled, skipped, finalUrl: page.url() }
      } finally {
        await context.close()
      }
    },
    {
      connection: redisConnection,
      concurrency,
    },
  )

  worker.on('completed', (job, result) => {
    console.log(`[worker] Job ${job.id} completed:`, result)
  })

  worker.on('failed', (job, err) => {
    console.error(`[worker] Job ${job?.id} failed:`, err.message)
  })

  return worker
}
