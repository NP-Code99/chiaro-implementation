import * as dotenv from 'dotenv'
import * as path from 'path'
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

import express from 'express'
import { startWorker } from '../queue/applicationProcessor'
import sessionRoutes from './routes/session'
import jobRoutes from './routes/jobs'
import { setupXvfb } from '../browser/antiDetection'

const app = express()
const PORT = Number(process.env.AUTOMATION_PORT ?? 3001)

app.use(express.json({ limit: '10mb' }))

// Basic auth middleware — set AUTOMATION_API_KEY in env to enable
app.use((req, res, next) => {
  const apiKey = process.env.AUTOMATION_API_KEY
  if (!apiKey) { next(); return }
  const provided = req.headers['x-api-key'] ?? req.query.apiKey
  if (provided !== apiKey) { res.status(401).json({ error: 'Unauthorized' }); return }
  next()
})

app.use('/api/sessions', sessionRoutes)
app.use('/api/jobs', jobRoutes)

app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }))

async function main() {
  // On Linux, start Xvfb so headed Chrome has a display
  const stopXvfb = await setupXvfb()
  if (stopXvfb) {
    console.log('[server] Xvfb started on :99')
    process.on('exit', stopXvfb)
  }

  // Start BullMQ worker (2 concurrent jobs)
  const worker = startWorker(2)
  console.log('[server] Worker started (concurrency=2)')

  process.on('SIGTERM', async () => {
    await worker.close()
    process.exit(0)
  })

  app.listen(PORT, () => {
    console.log(`[server] Automation server running on http://localhost:${PORT}`)
    console.log(`[server] Endpoints:`)
    console.log(`         POST   /api/sessions/capture`)
    console.log(`         GET    /api/sessions/:userId`)
    console.log(`         GET    /api/sessions/:userId/:site/status`)
    console.log(`         DELETE /api/sessions/:userId/:site`)
    console.log(`         POST   /api/jobs`)
    console.log(`         GET    /api/jobs/:jobId`)
    console.log(`         GET    /api/jobs/metrics`)
  })
}

main().catch(err => { console.error('[server] Fatal:', err); process.exit(1) })
