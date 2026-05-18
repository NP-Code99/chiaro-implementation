/**
 * Quick verification script — confirms Scrapfly can bypass Cloudflare.
 * Usage: npx tsx scripts/test-scrapfly.ts
 */

import * as path from 'path'
import * as fs from 'fs'

// Load .env.local synchronously before any module reads process.env
const envPath = path.join(process.cwd(), '.env.local')
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = val
  }
}

import * as cheerio from 'cheerio'
import { ScrapflyClient, ScrapeConfig, ScrapeResult } from 'scrapfly-sdk'

const apiKey = process.env.SCRAPFLY_API_KEY
if (!apiKey) {
  console.error('❌ SCRAPFLY_API_KEY not found in .env.local')
  process.exit(1)
}

const scrapfly = new ScrapflyClient({ key: apiKey })

const TEST_URLS = [
  { name: 'Wellfound (heavy Cloudflare)',  url: 'https://wellfound.com/jobs' },
  { name: 'Greenhouse/Linear (lighter)',    url: 'https://boards.greenhouse.io/linear' },
  { name: 'Greenhouse/Anthropic',          url: 'https://boards.greenhouse.io/anthropic' },
]

async function test(name: string, url: string) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Testing: ${name}`)
  console.log(`URL:     ${url}`)

  try {
    const config = new ScrapeConfig({
      url,
      asp: true,
      render_js: true,
      country: 'US',
      rendering_wait: 2000,
    })

    const raw = await scrapfly.scrape(config)

    if (!(raw instanceof ScrapeResult)) {
      console.log('Status:  ❌ Got raw Response instead of ScrapeResult')
      return
    }

    const { result } = raw
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const creditCost = (result as any).cost ?? 'unknown'
    const $ = cheerio.load(result.content ?? '')
    const title = $('title').text().trim()
    const bodySnippet = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 500)
    const cfCookie = result.cookies?.find(c => c.name === 'cf_clearance')

    console.log(`Status:     ✅ HTTP ${result.status_code}`)
    console.log(`Credits:    ${creditCost}`)
    console.log(`Title:      ${title || '(no title)'}`)
    console.log(`cf_clearance: ${cfCookie ? '✅ obtained' : '❌ not present (may not be needed)'}`)
    console.log(`Body preview:\n  ${bodySnippet}`)
  } catch (err) {
    console.log(`Status:  ❌ FAILED`)
    console.log(`Error:   ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function main() {
  console.log('Scrapfly Cloudflare Bypass Test')
  console.log('================================')
  for (const { name, url } of TEST_URLS) {
    await test(name, url)
  }
  console.log(`\n${'─'.repeat(60)}`)
  console.log('Done.')
}

main().catch(console.error)
