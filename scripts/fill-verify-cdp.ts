/**
 * Connects to the already-running headed Chromium (launched by
 * launch-cdp-browser.ts on port 9222), runs the EXACT detector+fill+submit
 * logic from browserApply.ts against whatever page is currently visible,
 * using the code passed in via env var:
 *
 *   VERIFY_CODE=ABCD1234 npx tsx scripts/fill-verify-cdp.ts
 */
import { chromium, type Page } from 'playwright'

const CDP_URL = process.env.CDP_URL ?? 'http://localhost:9222'
const CODE = (process.env.VERIFY_CODE ?? '').trim()

if (!CODE) {
  console.error('VERIFY_CODE env var is required')
  process.exit(1)
}

const LOCATOR_SCRIPT = `(() => {
  const PERSONAL_FIELD_RE = /name|email|phone|address|city|state|zip|postal|country|linkedin|github|portfolio|website|school|university|company|title|resume|cover|location|gender|race|veteran|disability|pronoun|salary|referr/i;
  const isPersonal = (el) => {
    const blob = [el.name, el.id, el.placeholder, el.getAttribute('autocomplete') || '', el.getAttribute('aria-label') || ''].join(' ').toLowerCase();
    return PERSONAL_FIELD_RE.test(blob);
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = window.getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const isCellShape = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.width <= 100 && r.height > 0 && r.height <= 100;
  };
  const newMarker = () => 'gh-otp-' + Math.random().toString(36).slice(2, 9);

  // Tier 1: ARIA labels
  const aria = Array.from(document.querySelectorAll('input')).filter(el => {
    if (!isVisible(el) || isPersonal(el)) return false;
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    return /(digit|character|code)\\s*\\d+\\s*(of|\\/)/.test(label);
  });
  if (aria.length >= 2) {
    const m = newMarker();
    aria.forEach((el, i) => el.setAttribute('data-gh-otp', m + '-' + i));
    return { marker: m, count: aria.length, debug: 'aria-labeled OTP cells (' + aria.length + ')' };
  }

  // Tier 2: by "Security code" label, inputs below it
  const labels = Array.from(document.querySelectorAll('label, legend, h1, h2, h3, h4, h5, strong, span, p'));
  const labelEl = labels.find(el => {
    const t = (el.textContent || '').trim().toLowerCase();
    return t === 'security code' || t.startsWith('security code');
  });
  if (labelEl) {
    const lr = labelEl.getBoundingClientRect();
    const all = Array.from(document.querySelectorAll('input'))
      .filter(el => {
        if (!isVisible(el) || isPersonal(el)) return false;
        const t = (el.type || 'text').toLowerCase();
        if (!(t === 'text' || t === 'tel' || t === 'number' || t === 'password')) return false;
        const r = el.getBoundingClientRect();
        if (r.top < lr.bottom - 4) return false;
        if (r.top > lr.bottom + 200) return false;
        return isCellShape(el);
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        if (Math.abs(ar.top - br.top) > 5) return ar.top - br.top;
        return ar.left - br.left;
      });
    if (all.length >= 2) {
      const m = newMarker();
      all.forEach((el, i) => el.setAttribute('data-gh-otp', m + '-' + i));
      return { marker: m, count: all.length, debug: all.length + ' OTP cells below "Security code" label' };
    }
    if (all.length === 1) {
      const m = newMarker();
      all[0].setAttribute('data-gh-otp', m + '-0');
      return { marker: m, count: 1, debug: '1 combined input below "Security code" label' };
    }
  }

  // Tier 3: explicit OTP attributes
  const explicit = Array.from(document.querySelectorAll('input[autocomplete="one-time-code"], input[maxlength="1"], input[maxlength="8"], input[inputmode="numeric"]'))
    .filter(el => isVisible(el) && !isPersonal(el) && isCellShape(el));
  if (explicit.length >= 1) {
    const m = newMarker();
    explicit.forEach((el, i) => el.setAttribute('data-gh-otp', m + '-' + i));
    return { marker: m, count: explicit.length, debug: explicit.length + ' explicit-OTP inputs (fallback)' };
  }
  return null;
})()`;

async function locateGreenhouseCodeInputs(page: Page) {
  return page.evaluate(LOCATOR_SCRIPT) as Promise<{ marker: string; count: number; debug: string } | null>
}

async function main() {
  console.log(`Connecting to CDP at ${CDP_URL}`)
  const browser = await chromium.connectOverCDP(CDP_URL)
  const ctx = browser.contexts()[0]
  if (!ctx) throw new Error('No browser context found')
  const pages = ctx.pages()
  if (pages.length === 0) throw new Error('No pages open')
  // Pick the most recently focused / non-blank page
  const page = pages.find(p => /greenhouse/.test(p.url())) ?? pages[0]
  console.log(`Driving page: ${page.url()}`)

  const located = await locateGreenhouseCodeInputs(page)
  if (!located) {
    console.error('❌ Security code field not found on the current page.')
    process.exit(2)
  }
  console.log(`✅ Detection: ${located.debug}`)

  const first = page.locator(`input[data-gh-otp="${located.marker}-0"]`)
  await first.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {})
  await first.click({ timeout: 3000 })

  const focusOk = await page.evaluate(`(() => {
    var a = document.activeElement;
    var attr = a ? a.getAttribute('data-gh-otp') : null;
    return !!(attr && attr.indexOf(${JSON.stringify(located.marker)}) === 0);
  })()`) as boolean
  if (!focusOk) {
    console.error('❌ Leftmost OTP cell did not take focus — aborting.')
    process.exit(3)
  }
  console.log('✅ Leftmost OTP cell focused')

  if (located.count === 1) {
    await page.keyboard.type(CODE, { delay: 80 })
  } else {
    for (const ch of CODE) await page.keyboard.type(ch, { delay: 80 })
  }
  console.log(`✅ Typed ${CODE.length}-char code`)

  await page.waitForTimeout(500)

  const candidates = [
    page.getByRole('button', { name: /^submit application$/i }),
    page.getByRole('button', { name: /submit application/i }),
    page.locator('button:has-text("Submit application")'),
    page.getByRole('button', { name: /^verify$/i }),
    page.getByRole('button', { name: /^confirm$/i }),
    page.getByRole('button', { name: /^continue$/i }),
  ]
  for (const c of candidates) {
    const btn = c.last()
    if (await btn.count().catch(() => 0) === 0) continue
    try {
      await btn.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {})
      await btn.click({ timeout: 4000 })
      console.log('✅ Clicked Submit application')
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
      await browser.close().catch(() => {})
      return
    } catch { /* try next */ }
  }
  console.error('❌ Could not click submit button')
  await browser.close().catch(() => {})
  process.exit(4)
}

main().catch(e => { console.error(e); process.exit(1) })
