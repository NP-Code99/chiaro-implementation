import { ScrapflyClient } from 'scrapfly-sdk'

if (!process.env.SCRAPFLY_API_KEY) {
  throw new Error('SCRAPFLY_API_KEY is not set in environment variables')
}

export const scrapfly = new ScrapflyClient({ key: process.env.SCRAPFLY_API_KEY })
