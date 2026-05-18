import { Queue, Worker, QueueEvents } from 'bullmq'
import { Redis } from 'ioredis'
import type { ProcessJobPayload } from '../types'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379'
const QUEUE_NAME = 'job-applications'

export const redisConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null })

export const applicationQueue = new Queue<ProcessJobPayload>(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
})

export const queueEvents = new QueueEvents(QUEUE_NAME, { connection: redisConnection })

// ── Enqueue ───────────────────────────────────────────────────────────────────

export async function enqueueApplication(payload: ProcessJobPayload): Promise<string> {
  const job = await applicationQueue.add(`apply:${payload.applicationId}`, payload, {
    jobId: payload.applicationId,
  })
  return job.id ?? payload.applicationId
}

// ── Status helpers ─────────────────────────────────────────────────────────────

export async function getJobStatus(jobId: string) {
  const job = await applicationQueue.getJob(jobId)
  if (!job) return null

  const state = await job.getState()
  return {
    id: job.id,
    state,
    progress: job.progress,
    data: job.data,
    failedReason: job.failedReason,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
  }
}

export async function getQueueMetrics() {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    applicationQueue.getWaitingCount(),
    applicationQueue.getActiveCount(),
    applicationQueue.getCompletedCount(),
    applicationQueue.getFailedCount(),
    applicationQueue.getDelayedCount(),
  ])
  return { waiting, active, completed, failed, delayed }
}
