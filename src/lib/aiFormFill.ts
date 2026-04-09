import Anthropic from '@anthropic-ai/sdk'
import type { UserProfile } from './userProfile'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

/**
 * Generates a natural, specific answer to a single job application field
 * using the candidate's resume and the job context.
 */
export async function generateFieldAnswer(
  question: string,
  resumeText: string,
  jobDescription: string,
  role: string,
  company: string,
  profile: Pick<UserProfile, 'location' | 'workAuth' | 'yearsExp'>,
): Promise<string> {
  const profileContext = [
    `Location: ${profile.location}`,
    `Work authorization: ${profile.workAuth}`,
    `Years of experience: ${profile.yearsExp}`,
  ].join('\n')

  const prompt = `You are filling out a job application on behalf of this candidate.

Question: ${question}

Candidate resume:
${resumeText || '(resume not available)'}

Candidate profile:
${profileContext}

Job: ${role} at ${company}
Description: ${jobDescription.slice(0, 1500)}

Write a concise, genuine, specific answer to this question as if you are the candidate. 2-4 sentences max. Do not be generic. Do not use filler phrases like "I am passionate about" or "I would love to". Speak directly and specifically.

Return ONLY the answer text, nothing else.`

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = message.content[0].type === 'text' ? message.content[0].text.trim() : ''
    return text
  } catch {
    return ''
  }
}

/**
 * Generates an expected salary answer based on role, location, and seniority.
 */
export async function generateSalaryAnswer(
  role: string,
  location: string,
  yearsExp: string,
): Promise<string> {
  const prompt = `What is a reasonable salary expectation for a ${role} in ${location} with ${yearsExp} years of experience? Return ONLY the number or range, e.g. "$130,000" or "$120,000 - $150,000". Nothing else.`

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 30,
      messages: [{ role: 'user', content: prompt }],
    })
    return message.content[0].type === 'text' ? message.content[0].text.trim() : ''
  } catch {
    return ''
  }
}
