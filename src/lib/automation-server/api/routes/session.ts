import { Router, Request, Response } from 'express'
import { captureSession, loadSession, validateSession, deleteSession, listSessions, isSessionExpired } from '../../browser/sessionManager'

const router = Router()

function str(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] : v ?? ''
}

// GET /api/sessions/:userId — list all sessions for a user
router.get('/:userId', (req: Request, res: Response) => {
  const { userId } = req.params
  const sessions = listSessions(str(userId))
  res.json({ sessions })
})

// GET /api/sessions/:userId/:site/status — validate a session live
router.get('/:userId/:site/status', async (req: Request, res: Response) => {
  const { userId, site } = req.params
  const validationUrl = str(req.query.validationUrl as string | string[])
  const validationSelector = str(req.query.validationSelector as string | string[])

  if (!validationUrl || !validationSelector) {
    res.status(400).json({ error: 'validationUrl and validationSelector query params required' })
    return
  }

  const siteDecoded = decodeURIComponent(str(site))
  const session = loadSession(str(userId), siteDecoded)
  if (!session) {
    res.json({ exists: false, valid: false })
    return
  }

  if (isSessionExpired(session)) {
    res.json({ exists: true, valid: false, reason: 'expired' })
    return
  }

  const valid = await validateSession(str(userId), siteDecoded, validationUrl, validationSelector)
  res.json({ exists: true, valid, capturedAt: session.capturedAt, expiresAt: session.expiresAt })
})

// POST /api/sessions/capture — launch headed browser for manual login
router.post('/capture', async (req: Request, res: Response) => {
  const { userId, site, validationUrl, validationSelector, ttlHours } = req.body as {
    userId: string
    site: string
    validationUrl: string
    validationSelector: string
    ttlHours?: number
  }

  if (!userId || !site || !validationUrl || !validationSelector) {
    res.status(400).json({ error: 'userId, site, validationUrl, validationSelector required' })
    return
  }

  captureSession({ userId, site, validationUrl, validationSelector, ttlHours })
    .then(() => console.log(`[session route] Capture complete for ${userId}`))
    .catch(err => console.error(`[session route] Capture failed:`, err))

  res.json({ message: 'Browser launched. Complete login manually then the session will be saved.' })
})

// DELETE /api/sessions/:userId/:site — remove stored session
router.delete('/:userId/:site', (req: Request, res: Response) => {
  const { userId, site } = req.params
  deleteSession(str(userId), decodeURIComponent(str(site)))
  res.json({ message: 'Session deleted' })
})

export default router
