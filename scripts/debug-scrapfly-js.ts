import * as fs from 'fs'
import * as path from 'path'

const envPath = path.join(process.cwd(), '.env.local')
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const match = line.match(/^([^=#\s][^=]*)=(.*)$/)
  if (match) process.env[match[1].trim()] = match[2].trim()
}

async function main() {
  const { ScrapeConfig, ScrapeResult } = await import('scrapfly-sdk')
  const { scrapfly } = await import('../src/lib/scrapflyClient')

  const applyUrl = 'https://wellfound.com/jobs/4016092-software-engineer?autoOpenApplication=true'
  const dir = path.join(process.cwd(), 'public', 'screenshots')
  fs.mkdirSync(dir, { recursive: true })

  // Test 1: Absolute minimal js_scenario — just wait
  console.log('Test 1: Minimal js_scenario (wait only)...')
  try {
    const config1 = new ScrapeConfig({
      url: applyUrl,
      asp: true,
      render_js: true,
      country: 'US',
      rendering_wait: 5000,
      // @ts-ignore
      js_scenario: { instructions: [{ wait: { delay: 1000 } }] },
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
    })
    const raw1 = await scrapfly.scrape(config1)
    console.log(`  Status: ${raw1 instanceof ScrapeResult ? raw1.result.status_code : 'not ScrapeResult'}`)
    if (raw1 instanceof ScrapeResult) {
      const html = raw1.result.content ?? ''
      console.log(`  HTML length: ${html.length}`)
      console.log(`  Form present: ${html.includes('name="name"') || html.includes('Send application')}`)
      fs.writeFileSync(path.join(dir, 'scrapfly-test1.html'), html)
    }
  } catch (err) {
    console.log(`  Error: ${(err as Error).message?.slice(0, 300)}`)
  }

  // Test 2: js_scenario with simple click
  console.log('\nTest 2: js_scenario with click on Apply button...')
  try {
    const config2 = new ScrapeConfig({
      url: 'https://wellfound.com/jobs/4016092-software-engineer',
      asp: true,
      render_js: true,
      country: 'US',
      rendering_wait: 3000,
      // @ts-ignore
      js_scenario: {
        instructions: [
          { wait: { delay: 2000 } },
          { click: { selector: '[data-test="JobApplicationApplyButton"]' } },
          { wait: { delay: 4000 } },
        ],
      },
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
    })
    const raw2 = await scrapfly.scrape(config2)
    console.log(`  Status: ${raw2 instanceof ScrapeResult ? raw2.result.status_code : 'not ScrapeResult'}`)
    if (raw2 instanceof ScrapeResult) {
      const html = raw2.result.content ?? ''
      console.log(`  HTML length: ${html.length}`)
      const hasForm = html.includes('name="name"') || html.includes('Send application') || html.includes('Submit application')
      console.log(`  Modal form present after click: ${hasForm}`)
      fs.writeFileSync(path.join(dir, 'scrapfly-test2.html'), html)
    }
  } catch (err) {
    console.log(`  Error: ${(err as Error).message?.slice(0, 300)}`)
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
