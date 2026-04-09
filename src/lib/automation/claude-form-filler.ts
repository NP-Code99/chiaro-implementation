import Anthropic from '@anthropic-ai/sdk'
import type { ApplicantData } from '../ats/types'
import type { ClaudeFormResponse, FormFieldMapping } from './types'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

const SYSTEM_PROMPT = `You are a precise form-filling assistant. You receive a screenshot of a job application form and DOM HTML, along with applicant information.

Your task is to identify the correct CSS selectors for each form field and return a JSON object with the fields to fill.

Rules:
1. Only include fields that are visible and fillable
2. Use the most specific, stable selector (prefer id > name attribute > label-for attribute > aria-label)
3. For file inputs, use the selector but note type: "file"
4. Identify the submit button selector
5. Return ONLY valid JSON, no markdown, no explanation

Response format:
{
  "fields": [
    { "selector": "#first_name", "value": "Ada", "type": "text" },
    { "selector": "input[name='email']", "value": "ada@example.com", "type": "email" }
  ],
  "submitSelector": "button[type='submit']",
  "reasoning": "brief one-line summary of what you found"
}`

export async function identifyFormFields(
  screenshotBase64: string,
  domHtml: string,
  applicant: ApplicantData
): Promise<ClaudeFormResponse> {
  const applicantSummary = JSON.stringify({
    name: applicant.name,
    firstName: applicant.name.split(' ')[0],
    lastName: applicant.name.split(' ').slice(1).join(' '),
    email: applicant.email,
    phone: applicant.phone ?? '',
    linkedin: applicant.linkedinUrl ?? '',
    github: applicant.githubUrl ?? '',
    location: applicant.location ?? '',
  }, null, 2)

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: screenshotBase64,
            },
          },
          {
            type: 'text',
            text: `Applicant data:\n${applicantSummary}\n\nRelevant DOM (truncated to 8000 chars):\n${domHtml.slice(0, 8000)}\n\nReturn the field mappings as JSON.`,
          },
        ],
      },
    ],
  })

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('')

  try {
    // Extract JSON from response (Claude may wrap it)
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { fields: [], reasoning: 'No JSON found in response' }
    }
    return JSON.parse(jsonMatch[0]) as ClaudeFormResponse
  } catch {
    return { fields: [], reasoning: 'Failed to parse Claude response' }
  }
}

export async function validateSelectors(
  fields: FormFieldMapping[],
  pageEvalFn: (selector: string) => Promise<boolean>
): Promise<FormFieldMapping[]> {
  const valid: FormFieldMapping[] = []
  for (const field of fields) {
    const exists = await pageEvalFn(field.selector)
    if (exists) {
      valid.push(field)
    }
  }
  return valid
}
