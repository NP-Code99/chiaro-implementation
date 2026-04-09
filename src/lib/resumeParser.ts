// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>

/**
 * Extracts plain text from a resume stored as a base64 data URL.
 * Input: "data:application/pdf;base64,JVBERi0x..."
 * Returns: raw text content, or empty string on any parse failure.
 */
export async function extractResumeText(resumeBase64: string): Promise<string> {
  if (!resumeBase64) return ''

  try {
    // Strip the data URL prefix to get the raw base64
    const base64 = resumeBase64.includes(',')
      ? resumeBase64.split(',')[1]
      : resumeBase64

    const buffer = Buffer.from(base64, 'base64')
    const result = await pdfParse(buffer)
    return result.text.trim()
  } catch {
    return ''
  }
}
