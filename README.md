<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=2,3,30&height=180&section=header&text=Chiaro&fontSize=56&fontColor=fff&animation=twinkling&fontAlignY=36&desc=AI-Powered%20Auto-Apply%20Job%20Platform&descSize=17&descAlignY=58&descColor=a5b4fc" width="100%"/>

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Next.js](https://img.shields.io/badge/Next.js%2014-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![Claude API](https://img.shields.io/badge/Claude%20API-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://anthropic.com)
[![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=for-the-badge&logo=playwright&logoColor=white)](https://playwright.dev)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://postgresql.org)
[![Status](https://img.shields.io/badge/Status-Live%20on%20App%20Store-brightgreen?style=for-the-badge)]()

</div>

---

## 📌 Overview

**Chiaro** is a full-stack job application platform with **100+ deployed users on the App Store**. Users swipe through curated startup job listings Tinder-style, and Chiaro automatically applies to each one on their behalf — filling out forms, uploading resumes, and navigating multi-step ATS portals using browser automation and AI.

- 🤖 **90%+ automation success rate** across Greenhouse, Lever, and Trakstar portals
- ⚡ **Saves users 10+ minutes** per application
- 📬 **Gmail API integration** for real-time verification code and email parsing
- 🏢 **30 fresh startup listings scraped daily** via Apify → Wellfound

---

## 🎬 How It Works

```
User swipes right on a job
         ↓
POST /api/applications  →  Application{PENDING} created in DB
         ↓
jobQueue.ts  →  dedup check  →  enqueue(applicationId)
         ↓
applyEngine.ts routes by ATS type:
   ┌─────────────────────────────────────────────────────┐
   │  GREENHOUSE  →  HTTP multipart POST (fast path)     │
   │  LEVER       →  HTTP multipart POST (fast path)     │
   │  WORKDAY     →  browserApply() via Playwright       │
   │  CUSTOM      →  browserApply() via Playwright       │
   └─────────────────────────────────────────────────────┘
         ↓
browserApply():
  1. Launch Chromium headless
  2. Navigate + 2s settle
  3. CAPTCHA check → needs_review if found
  4. extractFields() — scrape all inputs/selects with labels
  5. checkFillability() — Claude call: can we fill with user profile?
     → canAutoFill=false? → write manualReviewReason → needs_review
  6. askClaude() — Claude maps fields to user profile values
  7. fillFields() — fill(), selectOption(), setInputFiles() (resume)
  8. Multi-step: click Next/Continue up to 5 times
  9. Click Submit
  10. Screenshot → /public/screenshots/<applicationId>.png
  11. Detect success text → 'applied' or 'needs_review'
  12. 30s hard timeout via Promise.race
```

---

## 🛠️ Tech Stack

| Layer | Technology |
|:---|:---|
| **Framework** | Next.js 14 (App Router) |
| **Language** | TypeScript (strict) |
| **AI** | Anthropic Claude API (`claude-sonnet-4`) |
| **Browser Automation** | Playwright (Chromium headless) |
| **ORM** | Prisma |
| **Database** | PostgreSQL 16 (Docker) |
| **Job Scraping** | Apify — Wellfound listings scraper |
| **Email Parsing** | Gmail API |
| **Animations** | Framer Motion |
| **Testing** | Vitest (unit) + Playwright (E2E) |

---

## 📁 Project Structure

```
chiaro-implementation/
├── prisma/
│   └── schema.prisma              # DB models: User, Job, Application
├── src/
│   ├── app/
│   │   ├── page.tsx               # Home — swipe deck + profile guard
│   │   ├── profile/page.tsx       # Profile setup (resume upload)
│   │   ├── dashboard/page.tsx     # Application tracker (5s polling)
│   │   ├── layout.tsx             # Root layout + nav
│   │   └── api/
│   │       ├── jobs/
│   │       │   ├── route.ts       # GET jobs (10-min Wellfound cache + upsert)
│   │       │   └── sync/route.ts  # POST — manual Wellfound refresh
│   │       ├── applications/
│   │       │   ├── route.ts       # GET list, POST create
│   │       │   └── [id]/route.ts  # PATCH status + retry logic
│   │       ├── profile/route.ts   # GET/POST profile
│   │       └── upload/route.ts    # Resume upload endpoint
│   ├── components/
│   │   ├── SwipeCard.tsx          # Swipeable card (ATS badge, ⚠ warning badge)
│   │   ├── CardDeck.tsx           # Stacks 3 cards, swipe handler, stats
│   │   ├── DashboardClient.tsx    # Live status polling + retry UI
│   │   ├── ProfileForm.tsx        # Profile form with drag-drop resume
│   │   └── ui/Nav.tsx             # Top navigation
│   ├── lib/
│   │   ├── applyEngine.ts         # Routes by AtsType → HTTP or browserApply
│   │   ├── browserApply.ts        # Core Playwright engine (fillability + AI fill)
│   │   ├── atsClassifier.ts       # classifyATS(url) → enum
│   │   ├── wellfound.ts           # Apify fetch + normalize to Prisma Job shape
│   │   ├── jobQueue.ts            # In-memory queue with dedup Set
│   │   └── db.ts                  # Prisma singleton
│   └── types/
│       └── wellfound.ts           # Typed Apify actor response shape
├── tests/                         # Vitest unit tests
└── playwright.config.ts           # E2E test config
```

---

## 🧠 ATS Classification Engine

`src/lib/atsClassifier.ts` automatically detects the job portal type from the application URL:

| URL Pattern | ATS Type | Apply Method |
|:---|:---|:---|
| `boards.greenhouse.io`, `grnh.se` | `GREENHOUSE` | ⚡ HTTP multipart POST |
| `jobs.lever.co`, `lever.co` | `LEVER` | ⚡ HTTP multipart POST |
| `myworkdayjobs.com`, `workday.com` | `WORKDAY` | 🌐 Browser automation |
| `ashbyhq.com`, `bamboohr.com` | `CUSTOM` | 🌐 Browser automation |
| Anything else | `CUSTOM` | 🌐 Browser automation |

---

## 🗄️ Database Schema

```prisma
model User {
  id          String        @id @default(cuid())
  name        String
  email       String        @unique
  phone       String?
  linkedinUrl String?
  githubUrl   String?
  location    String?
  resumePath  String?
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
  manualReviewReason String?  // set when AI determines form can't be auto-filled
  applications       Application[]
}

model Application {
  id              String            @id @default(cuid())
  userId          String
  jobId           String
  status          ApplicationStatus @default(PENDING)
  errorMessage    String?
  appliedAt       DateTime?
  profileSnapshot String?           // JSON snapshot at apply time
  @@unique([userId, jobId])
}

enum AtsType           { GREENHOUSE LEVER WORKDAY CUSTOM }
enum ApplicationStatus { PENDING APPLYING APPLIED FAILED NEEDS_REVIEW }
```

---

## 🔌 API Reference

| Method | Endpoint | Description |
|:---|:---|:---|
| `GET` | `/api/jobs` | Fetch unseen jobs (10-min Wellfound cache) |
| `POST` | `/api/jobs/sync` | Force-refresh Wellfound listings |
| `GET` | `/api/applications` | All applications for user |
| `POST` | `/api/applications` | Create application + enqueue |
| `PATCH` | `/api/applications/[id]` | Update status / trigger retry |
| `GET/POST` | `/api/profile` | Read/write user profile |
| `POST` | `/api/upload` | Resume upload |

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- Docker (for PostgreSQL)
- Anthropic API key
- Apify API key

### Setup

```bash
# 1. Start PostgreSQL
docker run -d --name chiaro-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=chiaro \
  -p 5432:5432 postgres:16-alpine

# 2. Install dependencies
npm install

# 3. Configure environment
# .env and .env.local both need:
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/chiaro"
ANTHROPIC_API_KEY="sk-ant-..."
WELLFOUND_API_KEY="apify_api_..."

# 4. Push schema to DB
npm run db:push

# 5. Seed with mock jobs
npm run db:seed

# 6. Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### Useful Commands

```bash
npm run dev          # Start dev server
npm run build        # Production build
npm run test         # Vitest unit tests
npm run db:push      # Sync Prisma schema to DB
npm run db:seed      # Seed 37 mock jobs
npm run db:studio    # Open Prisma Studio (DB browser)

# Manual Wellfound job sync
curl -X POST http://localhost:3000/api/jobs/sync
```

---

## 🗺️ Roadmap

- [x] Tinder-style swipe UI with Framer Motion
- [x] Greenhouse + Lever HTTP fast-path applying
- [x] Playwright browser automation for custom ATS portals
- [x] Claude AI form-filling with fillability checks
- [x] ⚠️ Warning badge system for forms requiring manual review
- [x] Dashboard with live 5s polling + retry
- [x] Apify Wellfound scraper integration (30 jobs/day)
- [x] Gmail API for verification code + email parsing
- [x] 100+ App Store users
- [ ] Real auth (NextAuth / Clerk)
- [ ] Resume stored in S3 / Vercel Blob
- [ ] Persistent queue via Redis + BullMQ
- [ ] Email notifications on application completion
- [ ] Job filtering UI (role, location, salary)
- [ ] Dark mode

---

<div align="center">

**Built by [Nandan Pullakandam](https://github.com/NP-Code99)**

[![LinkedIn](https://img.shields.io/badge/LinkedIn-0A66C2?style=flat-square&logo=linkedin&logoColor=white)](https://linkedin.com/in/nandan-pullakandam)
[![GitHub](https://img.shields.io/badge/GitHub-171515?style=flat-square&logo=github&logoColor=white)](https://github.com/NP-Code99)

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=2,3,30&height=100&section=footer" width="100%"/>

</div>
