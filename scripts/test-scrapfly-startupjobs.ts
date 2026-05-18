import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

async function main() {
  const { scrapflyFetch } = await import('../src/lib/scrapflyFetch')
  
  const url = 'https://startup.jobs/apply/05370fff-ce16-4c5d-bca9-db56b9d4d6d9'
  const result = await scrapflyFetch(url)
  
  const titleMatch = result.html.match(/<title>([^<]*)<\/title>/)
  console.log('Page title:', titleMatch?.[1])
  
  // Find BambooHR URLs
  const bambooMatches = result.html.match(/[a-z0-9-]+\.bamboohr\.com[^\s"'<>\\]*/gi)
  if (bambooMatches) console.log('BambooHR URLs:', [...new Set(bambooMatches)].slice(0, 5))
  
  // Find any form action URLs  
  const formActions = result.html.match(/action="([^"]+)"/g)
  if (formActions) console.log('Form actions:', formActions.slice(0, 3))
  
  // Print relevant URL from meta tags
  const ogUrl = result.html.match(/<meta property="og:url" content="([^"]+)"/)
  if (ogUrl) console.log('OG URL:', ogUrl[1])
  
  const canonical = result.html.match(/<link rel="canonical" href="([^"]+)"/)
  if (canonical) console.log('Canonical:', canonical[1])
  
  // Detect ATS from response
  const hasBambooHR = result.html.includes('bamboohr.com')
  console.log('Is BambooHR:', hasBambooHR)
  
  // Print beginning of HTML
  console.log('\n--- first 1000 chars ---')
  console.log(result.html.slice(0, 1000))
}

main().catch(e => { console.error(e); process.exit(1) })
