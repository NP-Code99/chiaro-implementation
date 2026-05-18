import type { Page } from 'playwright'
import type { FormField } from '../types'
import { humanClick, humanScroll } from './mouseHelper'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

// Type a string character by character with randomised per-character delay
async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await humanClick(page, selector)
  await sleep(randomBetween(200, 500))

  // Clear existing value
  await page.locator(selector).first().selectText().catch(() => {})
  await page.keyboard.press('Control+A')
  await sleep(randomBetween(50, 100))

  for (const char of text) {
    await page.keyboard.type(char, { delay: randomBetween(50, 150) })

    // Occasional longer pause to simulate thinking
    if (Math.random() < 0.05) {
      await sleep(randomBetween(300, 800))
    }
  }
}

async function humanSelectOption(page: Page, selector: string, value: string): Promise<void> {
  await humanClick(page, selector)
  await sleep(randomBetween(300, 700))
  await page.locator(selector).first().selectOption({ label: value }).catch(async () => {
    await page.locator(selector).first().selectOption({ value }).catch(async () => {
      await page.locator(selector).first().selectOption({ index: 1 })
    })
  })
  await sleep(randomBetween(200, 400))
}

async function humanCheckbox(page: Page, selector: string, check: boolean): Promise<void> {
  const el = page.locator(selector).first()
  const checked = await el.isChecked().catch(() => false)
  if (checked !== check) {
    await humanClick(page, selector)
    await sleep(randomBetween(100, 300))
  }
}

async function humanRadio(page: Page, selector: string, value: string): Promise<void> {
  // Find the radio option that matches value text
  const radios = page.locator(`input[type="radio"]`)
  const count = await radios.count()

  for (let i = 0; i < count; i++) {
    const radio = radios.nth(i)
    const radioVal = await radio.getAttribute('value') ?? ''
    const label = await page.locator(`label[for="${await radio.getAttribute('id')}"]`).textContent().catch(() => '')
    const combined = `${radioVal} ${label}`.toLowerCase()

    if (combined.includes(value.toLowerCase())) {
      const box = await radio.boundingBox()
      if (box) {
        await humanClick(page, `[id="${await radio.getAttribute('id')}"]`)
      } else {
        await radio.click({ force: true })
      }
      await sleep(randomBetween(100, 300))
      return
    }
  }
}

export async function fillFormFields(
  page: Page,
  fields: FormField[],
  resumePath?: string,
): Promise<{ filled: number; skipped: number }> {
  let filled = 0
  let skipped = 0

  for (const field of fields) {
    if (!field.value) {
      skipped++
      continue
    }

    try {
      // Scroll element into view
      await page.locator(field.selector).first().scrollIntoViewIfNeeded().catch(() => {})
      await sleep(randomBetween(500, 1500))

      switch (field.type) {
        case 'text':
        case 'textarea':
        case 'password':
          await humanType(page, field.selector, field.value)
          break

        case 'select':
          await humanSelectOption(page, field.selector, field.value)
          break

        case 'checkbox':
          await humanCheckbox(page, field.selector, field.value === 'true')
          break

        case 'radio':
          await humanRadio(page, field.selector, field.value)
          break

        case 'file':
          if (resumePath) {
            const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 })
            await humanClick(page, field.selector)
            const chooser = await fileChooserPromise
            await chooser.setFiles(resumePath)
            await sleep(randomBetween(500, 1000))
          }
          break
      }

      filled++
      await sleep(randomBetween(500, 1500))
    } catch (err) {
      console.warn(`[formFiller] Skipped field ${field.selector}:`, err instanceof Error ? err.message : String(err))
      skipped++
    }
  }

  return { filled, skipped }
}

export async function submitForm(page: Page, submitSelector: string): Promise<void> {
  await humanScroll(page, 'down')
  await sleep(randomBetween(500, 1200))
  await humanClick(page, submitSelector)
}
