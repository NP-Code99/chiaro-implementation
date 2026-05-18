/**
 * Generate a one-page PDF resume for Alex Rivera (mock test user).
 * Output: /tmp/alex-rivera-test-resume.pdf
 * Run: npx tsx scripts/generate-test-resume.ts
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import * as fs from 'fs'

const OUT_PATH = '/tmp/alex-rivera-test-resume.pdf'

async function main() {
  const doc  = await PDFDocument.create()
  const page = doc.addPage([612, 792]) // US Letter
  const { width, height } = page.getSize()

  const fontBold   = await doc.embedFont(StandardFonts.HelveticaBold)
  const fontNormal = await doc.embedFont(StandardFonts.Helvetica)
  const black      = rgb(0, 0, 0)
  const gray       = rgb(0.4, 0.4, 0.4)
  const divider    = rgb(0.7, 0.7, 0.7)

  let y = height - 50

  function drawLine(text: string, font = fontNormal, size = 10, color = black, indent = 50) {
    page.drawText(text, { x: indent, y, font, size, color })
    y -= size + 4
  }

  function drawHR() {
    y -= 4
    page.drawLine({ start: { x: 50, y }, end: { x: width - 50, y }, thickness: 0.5, color: divider })
    y -= 8
  }

  function drawSection(title: string) {
    y -= 6
    page.drawText(title.toUpperCase(), { x: 50, y, font: fontBold, size: 10, color: black })
    y -= 4
    drawHR()
  }

  // ── Header ─────────────────────────────────────────────────────────────────
  page.drawText('Alex Rivera', { x: 50, y, font: fontBold, size: 22, color: black })
  y -= 28

  drawLine('Software Engineer', fontNormal, 12, gray)
  y -= 4
  drawLine('alex.rivera.chiaro.test@gmail.com  ·  (415) 555-0192  ·  San Francisco, CA', fontNormal, 9, gray)
  drawLine('linkedin.com/in/alexrivera-test  ·  github.com/alexrivera-test  ·  alexrivera.dev', fontNormal, 9, gray)

  // ── Summary ────────────────────────────────────────────────────────────────
  drawSection('Summary')
  drawLine('Full-stack software engineer with 4 years of experience building scalable web', fontNormal, 10, black)
  drawLine('applications. Expertise in TypeScript, React, Node.js, PostgreSQL, and AWS.', fontNormal, 10, black)
  drawLine('Passionate about clean architecture, developer tooling, and product-focused engineering.', fontNormal, 10, black)

  // ── Experience ─────────────────────────────────────────────────────────────
  drawSection('Experience')

  page.drawText('Senior Software Engineer  ·  TechCorp Inc.', { x: 50, y, font: fontBold, size: 10, color: black })
  page.drawText('Jan 2022 – Present', { x: width - 160, y, font: fontNormal, size: 10, color: gray })
  y -= 16
  drawLine('• Led development of a real-time analytics dashboard serving 200k+ monthly users', fontNormal, 10, black, 60)
  drawLine('• Architected migration from REST to GraphQL, reducing client bundle size by 35%', fontNormal, 10, black, 60)
  drawLine('• Mentored 3 junior engineers and ran weekly code reviews', fontNormal, 10, black, 60)
  drawLine('• Stack: TypeScript, React, Node.js, PostgreSQL, Redis, AWS ECS', fontNormal, 10, black, 60)
  y -= 8

  page.drawText('Software Engineer  ·  Startup Studio LLC', { x: 50, y, font: fontBold, size: 10, color: black })
  page.drawText('Jun 2020 – Dec 2021', { x: width - 170, y, font: fontNormal, size: 10, color: gray })
  y -= 16
  drawLine('• Built and launched 3 SaaS MVPs from zero to production in under 6 months each', fontNormal, 10, black, 60)
  drawLine('• Integrated Stripe, Twilio, and Sendgrid into core product billing flows', fontNormal, 10, black, 60)
  drawLine('• Reduced page load times by 60% through code splitting and CDN optimization', fontNormal, 10, black, 60)
  drawLine('• Stack: React, Express.js, MongoDB, Docker, DigitalOcean', fontNormal, 10, black, 60)

  // ── Education ──────────────────────────────────────────────────────────────
  drawSection('Education')

  page.drawText('B.S. Computer Science  ·  UC Berkeley', { x: 50, y, font: fontBold, size: 10, color: black })
  page.drawText('2016 – 2020', { x: width - 120, y, font: fontNormal, size: 10, color: gray })
  y -= 16
  drawLine('GPA: 3.7 / 4.0  ·  Dean\'s List 3 semesters', fontNormal, 10, black, 60)

  // ── Skills ─────────────────────────────────────────────────────────────────
  drawSection('Skills')
  drawLine('Languages:   TypeScript, JavaScript, Python, SQL, Bash', fontNormal, 10, black)
  drawLine('Frontend:    React, Next.js, Tailwind CSS, Zustand, Storybook', fontNormal, 10, black)
  drawLine('Backend:     Node.js, Express, NestJS, GraphQL, REST', fontNormal, 10, black)
  drawLine('Data:        PostgreSQL, Redis, MongoDB, Prisma, Elasticsearch', fontNormal, 10, black)
  drawLine('Cloud/Ops:   AWS (ECS, S3, Lambda), Docker, GitHub Actions, Vercel', fontNormal, 10, black)

  const pdfBytes = await doc.save()
  fs.writeFileSync(OUT_PATH, pdfBytes)
  console.log(`Test resume created at ${OUT_PATH} (${Math.round(pdfBytes.length / 1024)}KB)`)
}

main().catch(e => {
  console.error('Failed to generate resume:', e)
  process.exit(1)
})
