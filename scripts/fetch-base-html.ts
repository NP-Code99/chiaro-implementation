import * as fs from 'fs'
import * as path from 'path'

async function main() {
  const envPath = path.join(process.cwd(), '.env.local')
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^([^=#\s][^=]*)=(.*)$/)
    if (match) process.env[match[1].trim()] = match[2].trim()
  }
  const { scrapflyFetch } = await import('../src/lib/scrapflyFetch')
  const r = await scrapflyFetch('https://wellfound.com/jobs/3000325-software-engineer')
  fs.mkdirSync('public/screenshots', { recursive: true })
  fs.writeFileSync('public/screenshots/base-page.html', r.html)
  console.log('Cookies:', r.cookies.map(c => c.name).join(', '))
  console.log('Saved base-page.html, size:', r.html.length)
}

main().catch(e => { console.error(e.message); process.exit(1) })
