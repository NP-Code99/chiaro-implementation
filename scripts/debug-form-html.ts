import * as fs from 'fs'
import * as path from 'path'

const envPath = path.join(process.cwd(), '.env.local')
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const match = line.match(/^([^=#\s][^=]*)=(.*)$/)
  if (match) process.env[match[1].trim()] = match[2].trim()
}

async function main() {
  const { scrapflyFetch } = await import('../src/lib/scrapflyFetch')
  const cheerio = await import('cheerio')

  const applyUrl = 'https://wellfound.com/jobs/4016092-software-engineer?autoOpenApplication=true'

  console.log('Fetching apply URL via Scrapfly...')
  const { html, cookies } = await scrapflyFetch(applyUrl)

  console.log(`\nHTML length: ${html.length}`)
  console.log(`Cookies: ${cookies.map(c => c.name).join(', ')}`)

  // Save full HTML
  const dir = path.join(process.cwd(), 'public', 'screenshots')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'apply-page.html'), html)
  console.log('Full HTML saved to public/screenshots/apply-page.html')

  // Extract form fields
  const $ = cheerio.load(html)
  console.log('\n=== FORM ANALYSIS ===')
  console.log(`Forms found: ${$('form').length}`)

  $('form').each((i, form) => {
    const action = $(form).attr('action') || '(no action)'
    const method = $(form).attr('method') || 'GET'
    console.log(`\nForm ${i+1}: ${method.toUpperCase()} ${action}`)
    $(form).find('input, textarea, select').each((_, el) => {
      const type = $(el).attr('type') || (el as { tagName: string }).tagName
      const name = $(el).attr('name') || $(el).attr('id') || '(no name)'
      const placeholder = $(el).attr('placeholder') || ''
      console.log(`  [${type}] name="${name}" ph="${placeholder}"`)
    })
  })

  // Look for application-related inputs (not inside forms)
  console.log('\n=== ALL VISIBLE INPUTS ===')
  $('input, textarea, select').not('[type="hidden"]').each((i, el) => {
    if (i < 30) {
      const type = $(el).attr('type') || (el as { tagName: string }).tagName
      const name = $(el).attr('name') || $(el).attr('id') || ''
      const placeholder = $(el).attr('placeholder') || ''
      console.log(`  [${type}] name="${name}" ph="${placeholder}"`)
    }
  })

  // Modal elements
  console.log('\n=== MODAL ELEMENTS ===')
  const modals = $('[class*="modal"], [class*="Modal"], [role="dialog"], [aria-modal="true"]')
  console.log(`Count: ${modals.length}`)

  // Check if buttons exist
  console.log('\n=== BUTTONS ===')
  $('button').each((i, el) => {
    if (i < 15) console.log(`  "${$(el).text().trim()}" type="${$(el).attr('type') || 'button'}"`)
  })

  // Check __NEXT_DATA__
  const nextData = $('script[id="__NEXT_DATA__"]').html()
  if (nextData) {
    try {
      const parsed = JSON.parse(nextData)
      console.log('\n=== __NEXT_DATA__ top keys ===')
      console.log(Object.keys(parsed).join(', '))
      if (parsed.props?.pageProps) {
        console.log('pageProps keys:', Object.keys(parsed.props.pageProps).join(', '))
      }
    } catch { /* noop */ }
  } else {
    console.log('\nNo __NEXT_DATA__ found')
  }

  // HTML snippets around "apply" keywords
  const applyIdx = html.toLowerCase().indexOf('apply')
  if (applyIdx > -1) {
    console.log('\n=== HTML around first "apply" keyword ===')
    console.log(html.slice(Math.max(0, applyIdx - 50), applyIdx + 200))
  }
}

main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1) })
