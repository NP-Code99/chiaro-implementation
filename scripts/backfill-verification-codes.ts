import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// MUST stay in sync with src/lib/gmail/inboxSync.ts CODE_PATTERNS / CODE_BLOCKLIST.
const CODE_PATTERNS: RegExp[] = [
  /paste this code[^]*?application:\s*([A-Za-z0-9]{8})\s*[\r\n]+[^]*?after you enter the code/i,
  /paste this code[^:]*:\s*([A-Za-z0-9]{8})\b/i,
  /security code[^:]*:\s*([A-Za-z0-9]{8})\b/i,
  /your (?:verification |security |one[\s-]?time )?code is[:\s]+([A-Za-z0-9]{6,16})/i,
  /\bcode[:\s]+([A-Za-z0-9]{8,16})\b/i,
  /\btoken[:\s]+([A-Za-z0-9]{8,20})\b/i,
]
const CODE_BLOCKLIST = /^(\d{1,4}|20\d{2}|19\d{2}|verification|security|greenhouse|code|token|copy)$/i

function extractVerificationCode(body: string): string | null {
  for (const re of CODE_PATTERNS) {
    const m = body.match(re)
    const candidate = m?.[1]
    if (candidate && !CODE_BLOCKLIST.test(candidate)) {
      console.log(`Retrieved verification code: ${candidate}`)
      return candidate
    }
  }
  return null
}

async function main() {
  const rows = await prisma.inboxEmail.findMany({
    where: { emailCategory: 'verification_code' },
    select: { id: true, subject: true, fullBody: true, verificationCode: true },
  })

  let updated = 0
  let unchanged = 0
  let cleared = 0

  for (const row of rows) {
    const next = extractVerificationCode(row.fullBody)
    if (next === row.verificationCode) {
      unchanged++
      continue
    }
    await prisma.inboxEmail.update({
      where: { id: row.id },
      data: { verificationCode: next },
    })
    if (next === null) cleared++
    else updated++
    console.log(`[${row.id}] "${row.subject}"  ${row.verificationCode ?? 'null'} -> ${next ?? 'null'}`)
  }

  console.log(`\nDone. Scanned ${rows.length}. Updated ${updated}. Cleared ${cleared}. Unchanged ${unchanged}.`)
}

main()
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
