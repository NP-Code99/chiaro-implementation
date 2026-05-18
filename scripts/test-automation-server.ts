// @ts-nocheck
/**
 * Direct smoke test for the automation-server stack (no Redis/queue needed).
 * Launches a local Playwright browser, navigates to the job form, fills it,
 * takes screenshots at each milestone, and attempts submission.
 *
 * Run: npx tsx scripts/test-automation-server.ts
 */
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

const TARGET_URL = 'https://job-boards.greenhouse.io/covar/jobs/5097883007' // CoVar – Greenhouse (no CF)
const SCREENSHOT_DIR = path.join(process.cwd(), 'public', 'screenshots', 'automation-test')
const RESUME_PATH = '/tmp/alex-rivera-test-resume.pdf'

const PROFILE = {
  firstName: 'Alex',
  lastName: 'Rivera',
  email: 'alex.rivera.chiaro.test@gmail.com',
  phone: '4155550192',
  linkedin: 'https://linkedin.com/in/alexrivera-test',
  github: 'https://github.com/alexrivera-test',
  location: 'San Francisco, CA',
  resumePath: RESUME_PATH,
  bio: 'Full-stack software engineer with 4 years of experience building scalable web apps. Expert in TypeScript, React, Node.js, PostgreSQL, and AWS. Strong track record shipping developer tools and internal platforms.',
  yearsExp: '3-5',
  workAuth: 'US Citizen',
  desiredSalary: '$130,000',
}

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
function rnd(min: number, max: number) { return min + Math.random() * (max - min) }

async function shot(page: import('playwright').Page, label: string): Promise<string> {
  const file = path.join(SCREENSHOT_DIR, `${label}.png`)
  await page.screenshot({ path: file, fullPage: true, timeout: 10_000 }).catch(async () => {
    // Fallback: viewport-only screenshot (faster, no font wait)
    await page.screenshot({ path: file, fullPage: false, timeout: 5_000 }).catch(() => {})
  })
  console.log(`  📸 Screenshot: public/screenshots/automation-test/${label}.png`)
  return file
}

async function main() {
  // ── Resume check ──────────────────────────────────────────────────────────
  if (!fs.existsSync(RESUME_PATH)) {
    console.error('Resume not found. Run: npx tsx scripts/generate-test-resume.ts')
    process.exit(1)
  }

  // ── Browser launch — 5-layer stealth stack ───────────────────────────────
  console.log('\n[1] Launching patchright + fingerprint-spoofed browser…')
  const { stealthContext, humanisePageLoad, humanTypeInField } = await import('../src/lib/automation-server/browser/stealthLaunch')

  const USE_PROXY = !TARGET_URL.includes('greenhouse.io') && !TARGET_URL.includes('lever.co')
  const proxyUrl = USE_PROXY ? process.env.RESIDENTIAL_PROXY_URL : undefined

  const { context, close: closeBrowser } = await stealthContext({
    profileDir: path.join(process.cwd(), 'profiles', 'test-user'),
    proxy: proxyUrl,
    headed: false,
    warmup: true,  // visits google.com first to seed reCAPTCHA cookies
  })
  console.log(`    Proxy: ${proxyUrl ? 'residential' : 'none (direct)'}`)
  console.log('    Warmup: google.com visited to seed CAPTCHA cookies')

  const page = await context.newPage()

  try {
    // ── Navigate ────────────────────────────────────────────────────────────
    console.log(`\n[2] Navigating to:\n    ${TARGET_URL}`)
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 45_000 })
    // Layer 4: human page-load behaviour (scroll, drift, read time)
    await humanisePageLoad(page)
    await shot(page, '01-page-loaded')

    const title = await page.title()
    console.log(`    Page title: ${title}`)

    // Abort if Cloudflare challenge is still up
    const bodyText0 = (await page.textContent('body') ?? '').toLowerCase()
    if (/just a moment|security verification|verifying you|cloudflare/i.test(bodyText0)) {
      console.log('\n❌  Cloudflare wall detected — headless browser blocked.')
      console.log('    Fix: route traffic through ScrapFly or residential proxy.')
      await shot(page, 'cloudflare-blocked')
      await closeBrowser()
      return
    }

    // ── Extract fields ──────────────────────────────────────────────────────
    console.log('\n[3] Extracting form fields…')
    const rawFields = await page.evaluate(() => {
      const fields: {
        selector: string; label: string; type: string; required: boolean; options: string[]; tagName: string
      }[] = []
      const seen = new Set<string>()

      const inputs = Array.from(document.querySelectorAll('input, select, textarea'))
      for (const el of inputs) {
        const input = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
        const t = ((input as HTMLInputElement).type || '').toLowerCase()
        if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(t)) continue

        // Skip CAPTCHA fields
        if (/recaptcha|captcha|hcaptcha|turnstile/i.test(input.id + input.name + input.className)) continue

        const id = input.id

        // Require either an id or a name to build a stable selector — skip nth-of-type duplicates
        const name = input.getAttribute('name')
        if (!id && !name) continue

        const selector = id ? `#${id}` : `[name="${name}"]`
        if (seen.has(selector)) continue
        seen.add(selector)

        let label = ''
        if (id) {
          const labelEl = document.querySelector(`label[for="${id}"]`)
          label = (labelEl?.textContent ?? '').replace(/\s+/g, ' ').trim()
        }
        if (!label) {
          const closest = input.closest('[class*="field"], [class*="form-group"], [class*="input-wrapper"]')
            ?? input.closest('div')
          const labelChild = closest?.querySelector('label')
          label = (labelChild?.textContent ?? closest?.querySelector('span')?.textContent ?? '')
            .replace(/\s+/g, ' ').trim().slice(0, 120)
        }

        const options: string[] = []
        if (input.tagName === 'SELECT') {
          Array.from((input as HTMLSelectElement).options).forEach(o => {
            if (o.value && o.value !== '') options.push(o.text.trim())
          })
        }

        fields.push({ selector, label, type: t || input.tagName.toLowerCase(), required: input.required, options, tagName: input.tagName })
      }
      return fields
    })

    console.log(`    Found ${rawFields.length} fields:`)
    rawFields.forEach(f => console.log(`      [${f.type}] "${f.label}" → ${f.selector}${f.options.length ? ` (${f.options.length} opts)` : ''}`))
    await shot(page, '02-form-discovered')

    // ── Map values ──────────────────────────────────────────────────────────
    console.log('\n[4] Mapping values to fields…')
    type MappedField = typeof rawFields[0] & { value: string }
    const mappedFields: MappedField[] = rawFields.map(f => {
      const hint = `${f.label} ${f.selector}`.toLowerCase()
      let value = ''

      // ── Identity ────────────────────────────────────────────────────────
      if (/first.*name|fname/i.test(hint))                          value = PROFILE.firstName
      else if (/last.*name|lname|surname/i.test(hint))              value = PROFILE.lastName
      else if (/preferred.*name/i.test(hint))                       value = PROFILE.firstName
      else if (/full.*name|\bname\b/i.test(hint) && !/company|school|org/i.test(hint))
                                                                     value = `${PROFILE.firstName} ${PROFILE.lastName}`
      else if (/email/i.test(hint))                                  value = PROFILE.email
      else if (/phone|mobile|\btel\b/i.test(hint))                  value = PROFILE.phone
      else if (/linkedin/i.test(hint))                              value = PROFILE.linkedin
      else if (/github/i.test(hint))                                value = PROFILE.github
      // ── EEO / demographic — must come before location/country to prevent
      //    "ethnicity" matching /city/ and "relocation" matching /location/ ──

      else if (/hispanic|latino/i.test(hint))
        value = f.options.length
          ? (f.options.find(o => /no|decline|prefer not/i.test(o)) ?? '')
          : 'No'
      else if (/gender|pronoun/i.test(hint))
        value = f.options.length
          ? (f.options.find(o => /decline|prefer not|no answer/i.test(o)) ?? '')
          : 'Decline to self identify'
      else if (/veteran/i.test(hint))
        value = f.options.length
          ? (f.options.find(o => /not a veteran|no|decline/i.test(o)) ?? '')
          : 'I am not a protected veteran'
      else if (/disabilit/i.test(hint))
        value = f.options.length
          ? (f.options.find(o => /no|not disabled|decline/i.test(o)) ?? '')
          : 'No, I do not have a disability'
      else if (/race|ethnic/i.test(hint))
        value = f.options.length
          ? (f.options.find(o => /decline|prefer not/i.test(o)) ?? '')
          : 'Decline to self identify'

      // ── Location / identity (after EEO — word boundaries prevent false matches) ──
      else if (/\blocation\b|\bcity\b|where.*based/i.test(hint))   value = 'Durham, NC'
      else if (/\bcountry\b/i.test(hint))                          value = 'United States'
      else if (/salary|compensation/i.test(hint))                   value = PROFILE.desiredSalary

      // ── Work auth / compliance ───────────────────────────────────────────
      else if (/us citizen|security clearance|citizenship/i.test(hint)) value = 'Yes'
      else if (/relocat/i.test(hint))                               value = 'Yes'
      else if (/hybrid|on.?site|office.*day|days.*office/i.test(hint)) value = 'Yes'
      else if (/sponsor|visa|h1b/i.test(hint))                      value = 'No'
      else if (/authoriz|eligible|legal.*work/i.test(hint))         value = 'Yes'

      // ── Education / experience ───────────────────────────────────────────
      else if (/education|degree/i.test(hint))
        value = f.options.length
          ? (f.options.find(o => /bachelor|b\.s\.|b\.a\./i.test(o)) ?? f.options[1] ?? '')
          : "Bachelor's Degree"
      else if (/year.*exp|experience.*year|how many year|python|language/i.test(hint))
        value = f.options.length
          ? (f.options.find(o => /3|4|5/.test(o)) ?? f.options[1] ?? '')
          : '4'

      // ── Files ────────────────────────────────────────────────────────────
      else if (f.type === 'file' && /resume|cv/i.test(hint))        value = '__RESUME__'
      else if (f.type === 'file' && /cover/i.test(hint))            value = '__COVER__'
      else if (f.type === 'file')                                    value = '__RESUME__'

      // ── Open-ended text ──────────────────────────────────────────────────
      else if (/cover|why.*apply|about.*yourself|motivation|additional/i.test(hint)) value = PROFILE.bio
      else if (/hear.*about|source|referral/i.test(hint))           value = 'Other'

      // ── Checkbox consent ─────────────────────────────────────────────────
      else if (f.type === 'checkbox' && /agree|terms|consent|certif/i.test(hint)) value = 'true'

      return { ...f, value }
    })

    const toFill = mappedFields.filter(f => f.value)
    const toSkip = mappedFields.filter(f => !f.value)
    console.log(`    Will fill: ${toFill.length}  |  Skip: ${toSkip.length}`)
    toFill.forEach(f => console.log(`      ✓ [${f.type}] "${f.label}" = "${f.value.slice(0, 50)}"`))

    // ── Fill fields ─────────────────────────────────────────────────────────
    console.log('\n[5] Filling form fields…')
    let filled = 0; let failed = 0

    for (const field of toFill) {
      try {
        await page.locator(field.selector).first().scrollIntoViewIfNeeded({ timeout: 3000 })
        await sleep(rnd(400, 900))

        if (field.type === 'file') {
          const filePath = /COVER/.test(field.value) ? undefined : (fs.existsSync(RESUME_PATH) ? RESUME_PATH : undefined)
          if (!filePath) { console.log(`    ⏭  Skip file: no file for ${field.value}`); continue }
          try {
            // Greenhouse hides the input — set directly via Playwright's setInputFiles
            await page.locator(field.selector).first().setInputFiles(filePath)
            console.log(`    📎 Uploaded to ${field.selector}`)
          } catch {
            // Fallback: trigger file chooser via click on associated label/button
            const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 6000 })
            const uploadBtn = page.locator(`label[for="${field.selector.replace('#', '')}"], button:near(${field.selector})`).first()
            await uploadBtn.click().catch(() => page.locator(field.selector).first().click())
            const chooser = await fileChooserPromise.catch(() => null)
            if (chooser) await chooser.setFiles(filePath)
            else console.warn(`    ⚠️  File chooser not triggered for ${field.selector}`)
          }
        } else if (field.selector === '#country') {
          // Greenhouse uses Chosen.js — the real <select> is hidden; drive the widget instead
          try {
            await page.evaluate((val) => {
              const sel = document.querySelector('#country') as HTMLSelectElement | null
              if (!sel) return
              const opt = Array.from(sel.options).find(o => o.text.toLowerCase().includes(val.toLowerCase()))
              if (opt) { opt.selected = true; sel.dispatchEvent(new Event('change', { bubbles: true })) }
            }, field.value)
            await sleep(400)
          } catch { /* ignore */ }
        } else if (field.type === 'select' || field.tagName === 'SELECT') {
          await page.locator(field.selector).first().selectOption({ label: field.value }).catch(() =>
            page.locator(field.selector).first().selectOption(field.value)
          )
        } else if (field.type === 'checkbox') {
          const checked = await page.locator(field.selector).first().isChecked()
          if (!checked) await page.locator(field.selector).first().click()
        } else if (field.type === 'radio') {
          await page.locator(`input[type="radio"][value="${field.value}"]`).first().click().catch(() => {})
        } else {
          // Layer 5: human typing with natural speed curve and mouse movement
          await humanTypeInField(page, field.selector, field.value)
        }
        filled++
        await sleep(rnd(500, 1200))
      } catch (err) {
        console.warn(`    ✗ Failed: ${field.selector} — ${err instanceof Error ? err.message.slice(0, 80) : err}`)
        failed++
      }
    }

    console.log(`\n    Filled: ${filled}  |  Failed: ${failed}`)
    await shot(page, '03-form-filled')

    // ── Scroll down and screenshot before submit ─────────────────────────────
    console.log('\n[6] Pre-submit review…')
    await page.keyboard.press('End')
    await sleep(1500)
    await shot(page, '04-pre-submit')

    // ── Solve reCAPTCHA if present ──────────────────────────────────────────
    console.log('\n[6b] Checking for reCAPTCHA…')
    const hasCaptcha = await page.locator('.g-recaptcha, iframe[src*="recaptcha"]').count() > 0
    if (hasCaptcha) {
      console.log('    reCAPTCHA detected — attempting CapSolver…')
      try {
        const { solveRecaptchaV2 } = await import('../src/lib/capsolver')
        const sitekey = await page.evaluate(() => {
          // Greenhouse embeds reCAPTCHA via iframe; sitekey is on the wrapper div or in the iframe src
          const el = document.querySelector('.g-recaptcha, [data-sitekey]') as HTMLElement | null
          if (el?.dataset.sitekey) return el.dataset.sitekey
          const iframe = document.querySelector('iframe[src*="recaptcha"]') as HTMLIFrameElement | null
          const m = iframe?.src.match(/[?&]k=([^&]+)/)
          return m?.[1] ?? ''
        })
        if (sitekey) {
          const token = await solveRecaptchaV2(sitekey, page.url())
          if (token) {
            await page.evaluate((t) => {
              const ta = document.querySelector('#g-recaptcha-response, textarea[name="g-recaptcha-response"]') as HTMLTextAreaElement | null
              if (ta) { ta.value = t; ta.dispatchEvent(new Event('change', { bubbles: true })) }
            }, token)
            console.log('    ✅ reCAPTCHA token injected')
          }
        } else {
          console.log('    ⚠️  sitekey not found — skipping CAPTCHA solve')
        }
      } catch (e) {
        console.warn('    ⚠️  CapSolver failed:', e instanceof Error ? e.message : e)
      }
    } else {
      console.log('    No reCAPTCHA found')
    }

    // ── Find submit button ───────────────────────────────────────────────────
    console.log('\n[7] Looking for submit button…')
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Submit")',
      'button:has-text("Apply")',
      'button:has-text("Send Application")',
      '[data-test*="submit"]',
    ]

    let submitFound = false
    for (const sel of submitSelectors) {
      const count = await page.locator(sel).count()
      if (count > 0) {
        const text = await page.locator(sel).first().textContent()
        console.log(`    Found submit: "${text?.trim()}" → ${sel}`)
        submitFound = true

        // Click submit
        console.log('\n[8] Submitting application…')
        await page.locator(sel).first().scrollIntoViewIfNeeded()
        await sleep(rnd(500, 1000))
        await page.locator(sel).first().click()
        await sleep(3000)
        await shot(page, '05-post-submit')

        const bodyText = (await page.textContent('body') ?? '').toLowerCase()
        const success = /thank you|application received|successfully applied|submitted|we.ll be in touch|confirmation/.test(bodyText)
        console.log(`\n[9] Result: ${success ? '✅ SUCCESS — application submitted!' : '⚠️  Unknown — check screenshot 05-post-submit'}`)
        console.log(`    Final URL: ${page.url()}`)
        break
      }
    }

    if (!submitFound) {
      console.log('    ⚠️  No submit button found — check screenshot 04-pre-submit')
    }

  } catch (err) {
    console.error('\n❌ Error:', err instanceof Error ? err.message : err)
    await shot(page, 'error-state').catch(() => {})
  } finally {
    await closeBrowser()
    console.log('\n✅ Test complete. Screenshots at: public/screenshots/automation-test/')
  }
}

main()
