import { execFile } from 'child_process'
import path from 'path'
import type { ApplicantData, SubmissionResult } from './types'

const SCRIPT_PATH = path.resolve(
  process.cwd(),
  'job-applications/apply_bamboohr_steel.py'
)

const PYTHON_BIN = process.env.PYTHON_BIN ?? 'python3'

export async function submitToBambooHr(
  applyUrl: string,
  applicant: ApplicantData,
  submit = true
): Promise<SubmissionResult> {
  const args = ['--url', applyUrl]
  if (submit) args.push('--submit')

  return new Promise((resolve) => {
    const env = {
      ...process.env,
      // Pass applicant overrides so the script can pick them up when set
      APPLY_FIRST_NAME: applicant.name.split(' ')[0] ?? '',
      APPLY_LAST_NAME: applicant.name.split(' ').slice(1).join(' ') || '',
      APPLY_EMAIL: applicant.email,
      APPLY_PHONE: applicant.phone ?? '',
    }

    execFile(PYTHON_BIN, [SCRIPT_PATH, ...args], { env, timeout: 300_000 }, (err, stdout, stderr) => {
      const output = stdout + stderr

      if (err) {
        console.error('[bamboohr] script error:', err.message)
        console.error('[bamboohr] output:', output.slice(-2000))
        return resolve({
          success: false,
          error: `BambooHR apply script failed: ${err.message}`,
        })
      }

      const succeeded =
        output.includes('APPLICATION SUBMITTED SUCCESSFULLY') ||
        output.includes('DRY RUN — all fields filled')

      const failed = output.includes('❌ Error') || output.includes('Submit error')

      if (!submit) {
        // Dry-run: check that key fields filled
        return resolve({
          success: succeeded && !failed,
          error: succeeded ? undefined : 'BambooHR dry-run: fields not fully filled',
        })
      }

      return resolve({
        success: succeeded && !failed,
        error: succeeded ? undefined : 'BambooHR apply completed but confirmation not detected',
      })
    })
  })
}
