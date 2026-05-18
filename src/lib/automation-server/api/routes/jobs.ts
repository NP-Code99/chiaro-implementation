import { Router, Request, Response } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { enqueueApplication, getJobStatus, getQueueMetrics } from '../../queue/jobQueue'
import type { ProcessJobPayload, ApplicantProfile } from '../../types'

const router = Router()

// GET /api/jobs/metrics — queue health
router.get('/metrics', async (_req: Request, res: Response) => {
  const metrics = await getQueueMetrics()
  res.json(metrics)
})

// GET /api/jobs/:jobId — status of a specific queued application
router.get('/:jobId', async (req: Request, res: Response) => {
  const id = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
  const status = await getJobStatus(id)
  if (!status) {
    res.status(404).json({ error: 'Job not found' })
    return
  }
  res.json(status)
})

// POST /api/jobs — enqueue a new application
router.post('/', async (req: Request, res: Response) => {
  const { userId, jobUrl, site, profile } = req.body as {
    userId: string
    jobUrl: string
    site: string
    profile: ApplicantProfile
  }

  if (!userId || !jobUrl || !profile?.email) {
    res.status(400).json({ error: 'userId, jobUrl, and profile.email are required' })
    return
  }

  const applicationId = uuidv4()
  const payload: ProcessJobPayload = { applicationId, userId, jobUrl, site: site ?? new URL(jobUrl).hostname, profile }

  const queuedId = await enqueueApplication(payload)
  res.status(202).json({ applicationId, queuedId, status: 'queued' })
})

export default router
