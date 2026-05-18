import * as cheerio from 'cheerio'
import type { FieldDescriptor } from './browserApply'

/**
 * Extracts form fields from static HTML returned by Scrapfly.
 * Mirrors the extractAllFields() Playwright function but works on raw HTML.
 */
export function extractFieldsFromHtml(html: string): FieldDescriptor[] {
  const $ = cheerio.load(html)
  const results: FieldDescriptor[] = []
  const seen = new Set<string>()

  $('input, textarea, select').each((_, el) => {
    const elem = $(el)
    if (!('tagName' in el)) return
    const tagName = (el as { tagName: string }).tagName.toLowerCase()
    const inputType = elem.attr('type') ?? null
    const id = elem.attr('id') ?? ''
    const name = elem.attr('name') ?? ''

    // Skip hidden, submit, button inputs
    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(inputType ?? '')) return

    // Build a stable selector
    let selector = ''
    if (id) {
      selector = `#${id}`
    } else if (name) {
      selector = `${tagName}[name="${name}"]`
    } else {
      return // can't reliably target
    }

    if (seen.has(selector)) return
    seen.add(selector)

    // Resolve label
    let label = elem.attr('aria-label') ?? elem.attr('placeholder') ?? ''
    if (!label && id) {
      const lbl = $(`label[for="${id}"]`)
      if (lbl.length) label = lbl.text().trim()
    }
    if (!label) {
      const parentLabel = elem.closest('label')
      if (parentLabel.length) label = parentLabel.text().trim()
    }
    if (!label) {
      const prev = elem.prev('label')
      if (prev.length) label = prev.text().trim()
    }

    const required =
      elem.attr('required') !== undefined ||
      elem.attr('aria-required') === 'true'

    // Collect options for <select>
    const options: string[] = []
    if (tagName === 'select') {
      elem.find('option').each((_, opt) => {
        const val = $(opt).attr('value')
        if (val) options.push($(opt).text().trim())
      })
    }

    results.push({ selector, label, tagName, inputType, required, options })
  })

  return results
}
