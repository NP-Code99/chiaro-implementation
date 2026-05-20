import Anthropic from '@anthropic-ai/sdk'
import type { UserProfile } from './userProfile'
import type { FieldDescriptor } from './browserApply'

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
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    })
    const block = response.content[0]
    return block?.type === 'text' ? block.text.trim() : ''
  } catch {
    return ''
  }
}

export interface FilledField {
  selector: string
  value: string
  fieldType: 'text' | 'select' | 'radio' | 'checkbox' | 'file' | 'password' | 'textarea'
  confidence: number
}

/**
 * Uses Claude to map all extracted form fields to fill values in one shot.
 * Returns only fields with confidence > 0.7.
 */
export async function claudeFormMapping(
  fields: FieldDescriptor[],
  profile: UserProfile,
  job: { role: string; company: string; description: string; location: string },
  resumeText: string,
): Promise<FilledField[]> {
  // Parse city and state from the combined location string ("Charlotte, NC")
  const locationParts = (profile.location ?? '').split(',').map(s => s.trim())
  const profileCity = locationParts[0] ?? ''
  const profileState = locationParts[1] ?? ''

  const profileSummary = JSON.stringify({
    firstName: profile.firstName,
    lastName: profile.lastName,
    email: profile.email,
    phone: profile.phone,
    address_city: profileCity,
    address_state: profileState,
    address_street: '',
    address_zip: profile.addressZip ?? '',
    address_country: 'United States',
    linkedin: profile.linkedin,
    github: profile.github,
    yearsExp: profile.yearsExp,
    desiredSalary: profile.desiredSalary ?? '',
    workAuth: profile.workAuth,
    requiresSponsorship: false,
    gender: profile.gender ?? '',
    ethnicity: profile.ethnicity ?? '',
    veteranStatus: profile.veteranStatus ?? '',
    disabilityStatus: profile.disabilityStatus ?? '',
    bio: profile.bio ?? '',
  }, null, 2)

  const fieldsSummary = fields.map(f => ({
    selector: f.selector,
    label: f.label,
    type: f.inputType ?? f.tagName,
    required: f.required,
    options: f.options,
  }))

  const prompt = `You are auto-filling a job application form. Return a JSON array of fill instructions.

FORM FIELDS:
${JSON.stringify(fieldsSummary, null, 2)}

APPLICANT PROFILE:
${profileSummary}

RESUME:
${resumeText.slice(0, 2000) || '(not available)'}

JOB:
Role: ${job.role}
Company: ${job.company}
Location: ${job.location}
Description: ${job.description.slice(0, 1500)}

INSTRUCTIONS:
- For open-ended questions (Why do you want to work here, Tell us about yourself, etc): write genuine 2-3 sentence answers using the job description and profile. Be specific, not generic.
- For work authorization: authorized=Yes, sponsorship=No unless profile says otherwise
- For "How did you find us" checkboxes: use value "Other"
- For password fields: use value "Chiaro2024!"
- For salary: use profile desiredSalary if set, otherwise give a realistic range for the role and location
- For file upload (resume): use value "__RESUME__"
- For date available / start date fields: use value "05/26/2025" (one week from today) or the format the field expects (MM/DD/YYYY is common)
- NEVER invent or hallucinate data. Only fill a field if the value is present in the profile above.
- If a profile field is empty string, skip that field — do not guess or make up a value.
- City field: use address_city from profile only. State: use address_state. Street: only if address_street is non-empty. Zip: only if address_zip is non-empty.
- EEO / demographic fields (gender, race, ethnicity, veteran status, disability): use the exact values from the profile's gender/ethnicity/veteranStatus/disabilityStatus fields. If empty, use "Prefer not to say" / "I don't wish to answer" / "Decline to self-identify".
- currentTitle: use profile currentTitle. currentCompany: use profile currentCompany. Education: use profile education.
- Skip fields you cannot fill with confidence

Return ONLY a valid JSON array, no markdown, no explanation:
[
  { "selector": "CSS selector", "value": "fill value", "fieldType": "text|select|radio|checkbox|file|password|textarea", "confidence": 0.0-1.0 }
]

Only include fields with confidence above 0.7.`

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    })

    const block = response.content[0]
    const text = block?.type === 'text' ? block.text.trim() : '[]'
    // Strip markdown code fences, then extract the first JSON array in the response
    const stripped = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim()
    const arrayMatch = stripped.match(/\[[\s\S]*\]/)
    const json = arrayMatch ? arrayMatch[0] : '[]'
    const parsed = JSON.parse(json) as FilledField[]
    return parsed.filter(f => f.confidence > 0.7)
  } catch (err) {
    console.warn('[claudeFormMapping] Failed:', err instanceof Error ? err.message : String(err))
    return []
  }
}

/**
 * Rule-based form mapper — used when the Anthropic API key is unavailable or
 * claudeFormMapping returns no results.  Matches field labels/names against the
 * user profile using keyword patterns and fills every recognisable field with a
 * real (or short placeholder) value.  Unknown required text fields get a brief
 * "N/A — please see resume" stub so the form can still be submitted.
 */
export function fallbackFormMapping(
  fields: FieldDescriptor[],
  profile: UserProfile,
): FilledField[] {
  const results: FilledField[] = []

  for (const f of fields) {
    // Extract the name attribute value from CSS selectors like input[name="first_name"]
    // or IDs like #first_name, and normalise underscores/hyphens to spaces so
    // patterns like /first.*name/ match "first name" derived from "first_name".
    const selectorNameRaw =
      f.selector.match(/\[name="([^"]+)"\]/)?.[1] ??
      f.selector.match(/^#([\w-]+)/)?.[1] ??
      ''
    const selectorName = selectorNameRaw.replace(/[_\-[\]]/g, ' ')

    const hint = [f.label, selectorName, f.selector, f.tagName].join(' ').toLowerCase()
    const inputType = (f.inputType ?? f.tagName).toLowerCase()

    // Skip hidden / submit / button inputs
    if (['hidden', 'submit', 'button', 'image', 'reset'].includes(inputType)) continue

    // Skip CAPTCHA response fields — these are managed by the CAPTCHA solver (Steel/CapSolver)
    // and must NOT be filled with fake text (corrupts the token, causes rejection)
    if (/g-recaptcha-response|h-captcha-response|cf-turnstile-response/i.test(f.selector)) continue

    // ── File upload (resume) ───────────────────────────────────────────────────
    if (inputType === 'file') {
      results.push({ selector: f.selector, value: '__RESUME__', fieldType: 'file', confidence: 0.9 })
      continue
    }

    // ── Password ───────────────────────────────────────────────────────────────
    if (inputType === 'password') {
      results.push({ selector: f.selector, value: profile.applicationPassword, fieldType: 'password', confidence: 0.95 })
      continue
    }

    // ── Checkbox ───────────────────────────────────────────────────────────────
    if (inputType === 'checkbox') {
      // Agree / terms / consent checkboxes → check them
      if (/agree|terms|consent|confirm|certif|acknowledge|policy/i.test(hint)) {
        results.push({ selector: f.selector, value: 'true', fieldType: 'checkbox', confidence: 0.85 })
      }
      // "How did you hear" → skip (not required usually)
      continue
    }

    // ── Radio ──────────────────────────────────────────────────────────────────
    if (inputType === 'radio') {
      if (/sponsor|visa|h1b/i.test(hint)) {
        results.push({ selector: f.selector, value: 'No', fieldType: 'radio', confidence: 0.9 })
      } else if (/authoriz|eligible|work.*permit|legal.*work/i.test(hint)) {
        results.push({ selector: f.selector, value: 'Yes', fieldType: 'radio', confidence: 0.9 })
      } else if (/remote|hybrid|onsite|on.site|in.office/i.test(hint)) {
        results.push({ selector: f.selector, value: 'Yes', fieldType: 'radio', confidence: 0.75 })
      }
      continue
    }

    // ── Select ─────────────────────────────────────────────────────────────────
    if (inputType === 'select' || f.tagName === 'SELECT') {
      let value = ''
      const opts = (f.options ?? []).map(o => o.toLowerCase())

      if (/sponsor|visa|h1b/i.test(hint)) {
        value = pickOption(opts, ['no', 'not required', 'none', 'false']) ?? 'No'
      } else if (/authoriz|eligible|work.*permit|legal.*work|citizen/i.test(hint)) {
        value = pickOption(opts, ['yes', 'authorized', 'citizen', 'eligible']) ?? 'Yes'
      } else if (/year.*exp|experience.*year|how.*long|seniority/i.test(hint)) {
        value = pickOption(opts, [profile.yearsExp, '3', '4', '5', '3-5']) ?? profile.yearsExp
      } else if (/country/i.test(hint)) {
        value = pickOption(opts, ['united states', 'us', 'usa', 'america']) ?? 'United States'
      } else if (/state|province/i.test(hint)) {
        const st = ((profile.location ?? '').split(',')[1]?.trim() ?? '').toLowerCase()
        value = st ? (pickOption(opts, [st]) ?? '') : ''
      } else if (/gender|pronoun/i.test(hint)) {
        const g = (profile.gender ?? '').toLowerCase()
        value = g ? (pickOption(opts, [g]) ?? pickOption(opts, ['decline', 'prefer not', 'no answer', 'other']) ?? '') : (pickOption(opts, ['decline', 'prefer not', 'no answer', 'other']) ?? '')
      } else if (/race|ethnic/i.test(hint)) {
        const e = (profile.ethnicity ?? '').toLowerCase()
        value = e ? (pickOption(opts, [e, 'asian']) ?? pickOption(opts, ['decline', 'prefer not', 'no answer', 'other']) ?? '') : (pickOption(opts, ['decline', 'prefer not', 'no answer', 'other']) ?? '')
      } else if (/veteran|military/i.test(hint)) {
        value = pickOption(opts, ['not a protected veteran', 'i am not', 'not a veteran', 'no', 'decline']) ?? ''
      } else if (/disabilit/i.test(hint)) {
        value = pickOption(opts, ['no, i do not have', 'no disability', 'not disabled', 'no', 'decline', 'do not']) ?? ''
      } else if (/how.*hear|source|referral/i.test(hint)) {
        value = pickOption(opts, ['other', 'internet', 'online', 'job board']) ?? ''
      }
      if (value) {
        results.push({ selector: f.selector, value, fieldType: 'select', confidence: 0.8 })
      }
      continue
    }

    // ── Text / textarea ────────────────────────────────────────────────────────
    const fieldType: FilledField['fieldType'] = (inputType === 'textarea' || f.tagName === 'TEXTAREA') ? 'textarea' : 'text'

    let value = ''

    if (/first.*name|fname|given.*name/i.test(hint))              value = profile.firstName
    else if (/preferred.*name|nickname/i.test(hint))               value = profile.firstName
    else if (/last.*name|lname|surname|family.*name/i.test(hint))  value = profile.lastName
    else if (/full.*name|your.*name(?!.*company)(?!.*school)|applicant.*name/i.test(hint)) value = `${profile.firstName} ${profile.lastName}`
    // Bare "name" field with no first/last/full qualifier — treat as full name
    else if (/\bname\b/i.test(hint) && !/company|school|org|employer|refer|file/i.test(hint)) value = `${profile.firstName} ${profile.lastName}`
    else if (/email/i.test(hint))                                  value = profile.email
    else if (/phone|mobile|telephone|\btel\b|cell/i.test(hint))    value = profile.phone
    else if (/linkedin/i.test(hint))                               value = profile.linkedin ?? ''
    else if (/github/i.test(hint))                                 value = profile.github ?? ''
    else if (/portfolio|personal.*site|website/i.test(hint))       value = profile.github ?? ''
    else if (/\bcity\b/i.test(hint))                               value = (profile.location ?? '').split(',')[0]?.trim() ?? ''
    else if (/\bstate\b|\bprovince\b/i.test(hint))                 value = (profile.location ?? '').split(',')[1]?.trim() ?? ''
    else if (/zip|postal/i.test(hint))                             value = profile.addressZip ?? ''
    else if (/country.*time.*zone|time.*zone.*country|what.*country.*based|where.*based.*time/i.test(hint)) value = 'United States, Eastern Time (ET)'
    else if (/country/i.test(hint))                                value = 'United States'
    else if (/street|address.*line|address.*1/i.test(hint))        value = ''
    else if (/location|address/i.test(hint))                       value = profile.location ?? ''
    else if (/salary|compensation|\bpay\b|desired.*pay|expected.*pay/i.test(hint)) value = profile.desiredSalary
    else if (/year.*exp|experience.*year|how.*long.*experience/i.test(hint)) value = profile.yearsExp
    else if (/how long.*remote|remote.*how long|100.*remote.*job/i.test(hint)) value = profile.yearsExp ? `${profile.yearsExp} years` : '2 years'
    else if (/current.*title|job.*title|position.*title/i.test(hint)) value = ''
    else if (/current.*company|employer.*if.*applic|current.*employer/i.test(hint)) value = profile.currentCompany ?? ''
    else if (/current.*company|employer|organization/i.test(hint)) value = ''
    else if (/degree|education|major|school|university|college/i.test(hint)) value = ''
    else if (/skill|technolog|language|stack/i.test(hint))         value = ''
    else if (/sponsor|visa|h1b/i.test(hint))                       value = 'No'
    else if (/authoriz|eligible|work.*permit|legal.*work/i.test(hint)) value = 'Yes'
    else if (/how.*hear|source|referral|where.*find|learn.*about.*opport/i.test(hint)) value = 'Startup.jobs'
    else if (/cover.*letter|motivation|why.*apply|why.*interest|tell.*us.*about|about.*yourself|introduce/i.test(hint)) {
      value = profile.bio && profile.bio.length > 20
        ? profile.bio
        : `I'm a software engineer with ${profile.yearsExp} years of experience in full-stack development. I'm excited about this opportunity and confident my background in TypeScript, React, and Node.js would be a strong fit.`
    }
    else if (/availab|start.*date|when.*start/i.test(hint))        value = 'Immediately'
    else if (/notice|notice.*period/i.test(hint))                  value = '2 weeks'
    // Catch-all: fill every remaining text/textarea to avoid empty required fields
    // or form validation errors that block submission.
    else if (fieldType === 'textarea')   value = profile.bio && profile.bio.length > 20 ? profile.bio : 'Please see my attached resume for details.'
    else                                 value = f.required ? 'N/A' : ''

    if (value) {
      results.push({ selector: f.selector, value, fieldType, confidence: 0.75 })
    }
  }

  return results
}

/** Pick the first option text that contains any of the given keywords (case-insensitive). */
function pickOption(options: string[], keywords: string[]): string | undefined {
  for (const kw of keywords) {
    const match = options.find(o => o.includes(kw))
    if (match) return match
  }
  return undefined
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
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [{ role: 'user', content: prompt }],
    })
    const block = response.content[0]
    return block?.type === 'text' ? block.text.trim() : ''
  } catch {
    return ''
  }
}
