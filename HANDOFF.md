# Chiaro — Project Handoff

## What This Is

**Chiaro** is a Tinder-style job application app. Users swipe right on startup jobs and Chiaro automatically applies for them. Built with Next.js 14, Prisma, PostgreSQL, Playwright, and Claude API.

---

## To Start the App

```bash
# 1. Start Postgres (if not running)
docker start chiaro-db
# or if the container doesn't exist yet:
docker run -d --name chiaro-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=chiaro \
  -p 5432:5432 postgres:16-alpine

# 2. Install deps
npm install

# 3. Push schema to DB
npm run db:push

# 4. (Optional) Seed with mock jobs
npm run db:seed

# 5. Start dev server
cd chiaro-implementation
npm run dev
```

Open http://localhost:3000

---

## Environment Variables

File: `.env.local` (Next.js runtime) AND `.env` (Prisma CLI — must exist separately)

```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/chiaro"
ANTHROPIC_API_KEY="sk-ant-..."
WELLFOUND_API_KEY=apify_api_YOUR_KEY_HERE
```

Both `.env.local` and `.env` must contain `DATABASE_URL`. Prisma CLI only reads `.env`, Next.js only reads `.env.local`.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 14 (App Router) |
| Language | TypeScript (strict) |
| ORM | Prisma |
| Database | PostgreSQL 16 (Docker) |
| Animations | Framer Motion |
| Browser automation | Playwright (Chromium headless) |
| AI | Anthropic SDK (`claude-sonnet-4-20250514`) |
| Job source | Apify actor `radeance~wellfound-job-listings-scraper` |
| Tests | Vitest (unit), Playwright config present for E2E |

---

## Database Schema

```prisma
model User {
  id           String   @id @default(cuid())
  name         String   @default("")
  email        String   @unique @default("")
  phone        String?
  linkedinUrl  String?
  githubUrl    String?
  location     String?
  resumePath   String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  applications Application[]
}

model Job {
  id                 String   @id @default(cuid())
  company            String
  role               String
  description        String
  applyUrl           String
  atsType            AtsType
  location           String
  salaryMin          Int?
  salaryMax          Int?
  tags               String[]
  logoUrl            String?
  manualReviewReason String?  // set after fillability check fails
  createdAt          DateTime @default(now())
  applications       Application[]
}

model Application {
  id              String            @id @default(cuid())
  userId          String
  jobId           String
  status          ApplicationStatus @default(PENDING)
  errorMessage    String?
  appliedAt       DateTime?
  profileSnapshot String?           // JSON of UserProfile at apply time (resumeBase64 stripped)
  createdAt       DateTime          @default(now())
  updatedAt       DateTime          @updatedAt
  @@unique([userId, jobId])
}

enum AtsType          { GREENHOUSE LEVER WORKDAY CUSTOM }
enum ApplicationStatus { PENDING APPLYING APPLIED FAILED NEEDS_REVIEW }
```

---

## File Map

```
src/
├── app/
│   ├── page.tsx                          # Home — swipe deck, profile guard
│   ├── profile/page.tsx                  # Profile setup page
│   ├── dashboard/page.tsx                # Application tracker
│   ├── layout.tsx                        # Root layout, fonts, nav
│   └── api/
│       ├── jobs/
│       │   ├── route.ts                  # GET jobs (10-min Wellfound cache + upsert)
│       │   └── sync/route.ts             # POST — manual Wellfound sync
│       ├── applications/
│       │   ├── route.ts                  # GET list, POST create (strips resumeBase64)
│       │   └── [id]/route.ts             # PATCH status, retry logic
│       ├── profile/route.ts              # GET/POST profile (localStorage bridge)
│       └── upload/route.ts               # Resume upload endpoint
├── components/
│   ├── SwipeCard.tsx                     # Main swipeable card (ATS badge, warning badge)
│   ├── CardDeck.tsx                      # Stacks 3 cards, swipe handler, stats row
│   ├── DashboardClient.tsx               # 5s polling, status cards, retry
│   ├── ProfileForm.tsx                   # Profile form with resume drag-drop
│   └── ui/Nav.tsx                        # Top nav
├── lib/
│   ├── applyEngine.ts                    # Routes by AtsType → HTTP or browserApply
│   ├── browserApply.ts                   # Playwright engine: fillability check → fill → submit
│   ├── wellfound.ts                      # Apify API fetch + normalize to Prisma Job shape
│   ├── atsClassifier.ts                  # classifyATS(url) → 'greenhouse'|'lever'|'workday'|...
│   ├── userProfile.ts                    # localStorage CRUD for UserProfile
│   ├── jobQueue.ts                       # In-memory queue, dedup Set, persists manualReviewReason
│   └── db.ts                             # Prisma singleton
└── types/
    └── wellfound.ts                      # Full typed shape of Apify actor response
```

---

## How the Apply Pipeline Works

```
User swipes right
  → POST /api/applications  (creates Application{PENDING}, strips resumeBase64 from snapshot)
  → enqueue(applicationId)  (dedup Set prevents double-queue)

jobQueue.ts processes one at a time:
  → applyToJob(job, profile, applicationId)
      GREENHOUSE  → HTTP multipart POST to boards-api.greenhouse.io
      LEVER       → HTTP multipart POST to jobs.lever.co
      WORKDAY     → browserApply()
      CUSTOM      → browserApply()

browserApply():
  1. Launch Chromium headless
  2. Navigate (domcontentloaded + 2s settle)
  3. CAPTCHA check → needs_review if found
  4. extractFields() — query all input/textarea/select, grab label text
  5. checkFillability() — Claude call: can we fill this with name/email/phone/linkedin/github/location/resume?
     → If canAutoFill=false: return needs_review + blockerFields, write job.manualReviewReason to DB
  6. askClaude() — Claude call: map fields to profile values
  7. fillFields() — fill(), selectOption(), setInputFiles() (writes resume to tmp file), check()
  8. Multi-step: click Next/Continue up to 5 times
  9. Click Submit
  10. Screenshot → public/screenshots/<applicationId>.png
  11. Detect success text → return 'applied' or 'needs_review'
  12. Timeout: 30s hard limit via Promise.race
```

---

## User Profile

Stored in **localStorage** only (key: `chiaro_user_profile`). No server-side auth in this MVP.

```typescript
interface UserProfile {
  firstName: string
  lastName: string
  email: string
  phone: string
  linkedin: string
  github: string
  location: string
  workAuth: string
  yearsExp: string
  resumeBase64: string    // data:application/pdf;base64,... — browser only, never persisted to DB
  resumeFilename: string
  bio: string
}
```

**Security note:** `resumeBase64` is stripped from `profileSnapshot` before writing to DB in `POST /api/applications`.

---

## Wellfound Job Fetching

- Actor: `radeance~wellfound-job-listings-scraper` on Apify
- API key: `WELLFOUND_API_KEY` (in `.env.local`)
- Called via `GET /api/jobs` with a 10-minute in-memory cache
- On cache miss: fetches 60 jobs, upserts to Postgres using Wellfound's `job_id` as the Prisma `id`
- Manual sync: `POST /api/jobs/sync` (accepts `{ searchQuery, location, remote, maxResults }`)
- All Wellfound jobs have `applyUrl = wellfound.com/jobs/...` → classified as `CUSTOM` → go through `browserApply()` → hit Cloudflare bot check → return `needs_review` (correct — user completes manually)

---

## ATS Classification

`src/lib/atsClassifier.ts`:

| Pattern | AtsType | Difficulty |
|---|---|---|
| `boards.greenhouse.io`, `grnh.se` | greenhouse | easy (HTTP) |
| `jobs.lever.co`, `lever.co` | lever | easy (HTTP) |
| `myworkdayjobs.com`, `workday.com` | workday | hard (browser) |
| `ashbyhq.com` | ashby | medium (browser) |
| `bamboohr.com` | bamboohr | medium (browser) |
| null/empty | none | skip |
| anything else | custom | hard (browser) |

Prisma enum only has: `GREENHOUSE LEVER WORKDAY CUSTOM`. Ashby/bamboohr/none map to `CUSTOM`.

---

## Warning Badge Logic

When `browserApply()` calls `checkFillability()` and Claude returns `canAutoFill: false`:
1. Returns `needs_review` with `blockerFields: string[]`
2. `jobQueue.ts` writes `blockerFields.join(', ')` → `job.manualReviewReason`
3. `SwipeCard.tsx` reads `job.manualReviewReason` and shows an amber ⚠ badge on the card
4. Subsequent swipes show the badge immediately without re-running Playwright

---

## API Routes

| Method | Path | What it does |
|---|---|---|
| GET | `/api/jobs` | Returns unseen jobs for demo user, warms Wellfound cache |
| POST | `/api/jobs/sync` | Force-refresh Wellfound jobs |
| GET | `/api/applications` | All applications for demo user |
| POST | `/api/applications` | Create application + enqueue |
| PATCH | `/api/applications/[id]` | Update status (retry sets back to PENDING + re-enqueues) |
| GET/POST | `/api/profile` | Read/write profile (localStorage bridge) |
| POST | `/api/upload` | Resume upload |

---

## Known Limitations (MVP)

1. **No auth** — single hardcoded `demo-user`. Anyone who opens the app shares the same user.
2. **Wellfound jobs don't auto-apply** — all Wellfound URLs go through Cloudflare → `needs_review`. The browser apply engine works for direct ATS URLs (Greenhouse/Lever in seed data).
3. **Resume stored in localStorage only** — not persisted server-side. If user clears browser storage, resume is gone.
4. **In-memory queue** — restarts clear the queue and lose in-progress applications.
5. **Screenshots public** — `/public/screenshots/` is statically served with no auth.

---

## What's Left To Build

- [ ] Real auth (NextAuth or Clerk)
- [ ] Resume stored in S3/Vercel Blob instead of localStorage base64
- [ ] Wellfound cookie injection so browser apply actually works on wellfound.com
- [ ] Persistent queue (Redis/BullMQ) so restarts don't lose jobs
- [ ] Email notifications when applications complete
- [ ] Job filtering UI (by role, location, salary range)
- [ ] "Already applied externally" button to mark a job done
- [ ] Dark mode

---

## Useful Commands

```bash
npm run dev          # Start dev server
npm run build        # Production build
npm run test         # Vitest unit tests
npm run db:push      # Sync schema to DB
npm run db:seed      # Seed with 37 mock jobs
npm run db:studio    # Open Prisma Studio (DB browser)

# Manual Wellfound sync
curl -X POST http://localhost:3000/api/jobs/sync

# Check DB counts
node -e "
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
Promise.all([p.job.count(), p.user.count(), p.application.count()])
  .then(([j,u,a]) => console.log('Jobs:', j, 'Users:', u, 'Applications:', a))
  .then(() => p.\$disconnect())
"
```
