# Chiaro

> **Swipe right. Get applied.** A Tinder-style job application app that auto-applies to startup jobs on your behalf using AI-driven form filling and stealth browser automation.

```
   ┌─────────────────┐         ┌──────────────────┐         ┌──────────────────┐
   │   You swipe →   │  ───▶   │  Chiaro queues   │  ───▶   │ Bot applies for  │
   │  jobs you like  │         │  the application │         │  you in the BG   │
   └─────────────────┘         └──────────────────┘         └──────────────────┘
```

---

## Table of Contents

- [What it does](#what-it-does)
- [Tech stack](#tech-stack)
- [Architecture at a glance](#architecture-at-a-glance)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Project structure](#project-structure)
- [Apply routes (the important part)](#apply-routes-the-important-part)
- [Database schema](#database-schema)
- [Common scripts](#common-scripts)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## What it does

Chiaro is a job-application autopilot. You build a profile once, upload a resume, swipe through curated startup jobs, and Chiaro applies for you in the background — handling logins, captchas, multi-step ATS forms, and verification codes.

**Supported ATS systems:**

| ATS | Status | Notes |
|---|---|---|
| Greenhouse | ✅ | Routed via Steel.dev cloud browser |
| Lever | ✅ | Native Playwright |
| BambooHR | ✅ | Native Playwright |
| SmartRecruiters | ✅ | Native Playwright |
| Workday | ⚠️ | Partial — login flow varies |
| Wellfound / Startup.jobs native | ✅ | Direct API + session reuse |

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | **Next.js 14** (App Router) |
| Language | **TypeScript** (strict) |
| ORM | **Prisma** |
| Database | **SQLite** (dev) / **Postgres** (prod) |
| UI | **Tailwind CSS** + **Framer Motion** |
| Browser automation | **Playwright** + **patchright** + **CloakBrowser** + **Steel.dev** |
| Stealth | `playwright-extra`, `puppeteer-extra-plugin-stealth`, `fingerprint-injector` |
| Captcha | **CapSolver** (Turnstile, DataDome, hCaptcha) |
| AI | **Anthropic Claude** (`claude-sonnet-4-6`) + **OpenAI** SDKs |
| Web scraping | **Scrapfly** (ASP-protected pages) |
| Job sources | Apify actors (Wellfound, Startup.jobs) |
| Email | Gmail API (OAuth) for confirmation polling |
| Queue | **BullMQ** + Redis (`ioredis`) |
| Tests | Vitest (unit), Playwright (E2E) |

---

## Architecture at a glance

```
                       ┌─────────────────────────────────────────┐
                       │            Next.js App Router            │
                       │   (UI · API routes · Server Actions)     │
                       └────────────┬──────────────┬──────────────┘
                                    │              │
                  ┌─────────────────┘              └──────────────────┐
                  ▼                                                    ▼
        ┌──────────────────┐                              ┌─────────────────────┐
        │  Prisma + DB     │                              │   BullMQ Queue      │
        │  (jobs, apps,    │                              │   (job-apply        │
        │   users, snaps)  │                              │    workers)         │
        └──────────────────┘                              └──────────┬──────────┘
                                                                     │
                       ┌─────────────────────────────────────────────┘
                       ▼
        ┌────────────────────────────────────────────────────────────────────┐
        │                       Apply Engine (src/lib/)                       │
        │                                                                     │
        │   atsClassifier  →  picks a route per ATS type                      │
        │                                                                     │
        │   ┌───────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────┐ │
        │   │  Steel.dev    │  │ CloakBrowser│  │  Scrapfly   │  │ Native  │ │
        │   │  (Greenhouse) │  │  + CapSolver│  │  fetch+fill │  │ Playwright│
        │   └───────────────┘  └─────────────┘  └─────────────┘  └─────────┘ │
        │                                                                     │
        │   aiFormFill (Claude) → maps profile fields → fills the form        │
        └────────────────────────────────────────────────────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────────────┐
        │   Gmail polling → confirmation detection │
        │   Outcome logging → /dashboard           │
        └──────────────────────────────────────────┘
```

---

## Quick start

### Prerequisites

- **Node.js** ≥ 20
- **npm** (or pnpm)
- **Docker** (for Postgres, if you choose Postgres over SQLite)
- A few API keys — see [Environment variables](#environment-variables)

### 1. Install

```bash
git clone <this-repo>
cd chiaro-implementation
npm install
```

### 2. Configure env

```bash
cp .env.local.example .env.local
# also create a sibling .env file for Prisma CLI
cp .env.local .env
```

Fill in at minimum:
- `DATABASE_URL`
- `ANTHROPIC_API_KEY`
- `ENCRYPTION_KEY` (generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)

### 3. Database

```bash
npm run db:push       # apply schema
npm run db:seed       # (optional) seed mock jobs
npm run db:studio     # (optional) open Prisma Studio
```

### 4. Run

```bash
npm run dev
```

Open **http://localhost:3000**.

---

## Environment variables

> **Both `.env.local` (Next.js runtime) and `.env` (Prisma CLI) must contain `DATABASE_URL`.** Prisma CLI does not read `.env.local`.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | ✅ | SQLite path or Postgres connection string |
| `ANTHROPIC_API_KEY` | ✅ | Claude — AI form filling, ATS classification |
| `ENCRYPTION_KEY` | ✅ | AES-256-CBC key for session cookie storage |
| `STARTUP_JOBS_API_KEY` | ⭕ | Apify actor for Startup.jobs scraping |
| `WELLFOUND_API_KEY` | ⭕ | Apify actor for Wellfound scraping |
| `APIFY_API_KEY` | ⭕ | Residential proxy for Cloudflare bypass |
| `SCRAPFLY_API_KEY` | ⭕ | Reconnaissance fetch for protected ATS pages |
| `CAPSOLVER_API_KEY` | ⭕ | Turnstile / hCaptcha / DataDome solving |
| `RESIDENTIAL_PROXY_URL` | ⭕ | Webshare / PacketStream / IPRoyal proxy |
| `DATADOME_PROXY_URL` | ⭕ | Session-locked proxy for DataDome challenges |
| `STEEL_API_KEY` | ⭕ | Steel.dev cloud Chrome (Greenhouse route) |
| `CLOAK_BROWSER` | ⭕ | Set to `true` to enable CloakBrowser |
| `GOOGLE_WEB_CLIENT_ID` | ⭕ | Gmail OAuth — inbox polling |
| `GOOGLE_WEB_CLIENT_SECRET` | ⭕ | Gmail OAuth |
| `GOOGLE_REDIRECT_URI` | ⭕ | Must match Google Cloud Console exactly |
| `CRON_SECRET` | ⭕ | Auth token for background Gmail sync |

> **Cost note:** CapSolver runs around $0.001/solve. Steel.dev has a free starter tier. Residential proxies start around $1–$15/mo depending on provider.

---

## Project structure

```
chiaro-implementation/
├── prisma/
│   ├── schema.prisma          # User · Job · Application models
│   └── seed.ts                # mock job seeding
├── src/
│   ├── app/                   # Next.js App Router
│   │   ├── api/               # REST endpoints
│   │   │   ├── apply/         #   POST → queue an application
│   │   │   ├── applications/  #   GET / verify / status
│   │   │   ├── jobs/          #   list, sync, swipe
│   │   │   ├── inbox/         #   Gmail polling
│   │   │   ├── auth/          #   Google OAuth callback
│   │   │   ├── profile/       #   user profile CRUD
│   │   │   ├── upload/        #   resume upload
│   │   │   └── outcomes/      #   analytics
│   │   ├── dashboard/         # outcomes view
│   │   ├── inbox/             # confirmation emails
│   │   ├── profile/           # profile setup
│   │   └── page.tsx           # swipe UI
│   ├── components/            # React components
│   ├── hooks/                 # SWR hooks
│   ├── lib/                   # ⭐ the brain
│   │   ├── applyEngine.ts     # main orchestrator
│   │   ├── browserApply.ts    # CloakBrowser + CapSolver route
│   │   ├── scrapflyApply.ts   # Scrapfly recon + fill
│   │   ├── aiFormFill.ts      # Claude-driven field mapping
│   │   ├── atsClassifier.ts   # ATS type detection
│   │   ├── ats/               # per-ATS adapters (greenhouse, lever, ...)
│   │   ├── automation/        # Steel.dev + stealth helpers
│   │   ├── capsolver.ts       # captcha client
│   │   ├── sessionManager.ts  # encrypted cookie cache
│   │   ├── jobQueue.ts        # BullMQ
│   │   ├── gmail.ts           # OAuth + message search
│   │   └── outcomeLogger.ts   # B1–B8 error codes
│   └── styles/
├── scripts/                   # CLI utilities (see Common scripts)
├── tests/                     # vitest + playwright fixtures
└── results/                   # per-run application artifacts
```

---

## Apply routes (the important part)

Chiaro picks an apply route per ATS. Each route has tradeoffs:

| Route | Used for | Why |
|---|---|---|
| **Steel.dev** | Greenhouse | Mobile-replicable cloud Chrome; built-in DataDome + Turnstile solving |
| **CloakBrowser + CapSolver + Claude + Scrapfly** | Lever, BambooHR, SmartRecruiters | Local stealth Chromium, patches detection at the C++ level, free Turnstile |
| **Scrapfly + native fill** | Heavily protected pages where recon is enough | ASP mode + residential pool, no full browser |
| **Native Playwright + patchright** | Native ATS (Wellfound, Startup.jobs) | Fast path when no anti-bot is in front |

> **Headless is intentionally OFF** for the CloakBrowser route. Headless mode causes captcha stalls and form-fill failures.

---

## Database schema

Three core models — `User`, `Job`, `Application` — see [`prisma/schema.prisma`](prisma/schema.prisma).

```
┌──────────┐     1:N     ┌──────────────┐     N:1     ┌─────────┐
│   User   │────────────▶│ Application  │◀────────────│   Job   │
│          │             │              │             │         │
│ profile  │             │ status       │             │ ATS     │
│ creds    │             │ errorCode    │             │ applyUrl│
│ session  │             │ snapshot     │             │ tags    │
└──────────┘             └──────────────┘             └─────────┘
```

**Application statuses:** `PENDING · APPLYING · APPLIED · FAILED · NEEDS_REVIEW · NEEDS_INFO · VERIFICATION_PENDING`

**Error codes (B1–B8):** logged on `errorCode` for broken-job analytics.

---

## Common scripts

The `scripts/` directory has 40+ TS utilities for testing routes end-to-end:

```bash
# Apply to a specific job
npx tsx scripts/run-apply.ts --job <jobId> --user <userId>

# Re-run failed applications
npx tsx scripts/run-failed.ts

# Sync jobs from Wellfound / Startup.jobs
npx tsx scripts/sync-jobs.ts

# Seed startup jobs
npx tsx scripts/seed-startup-jobs.ts

# Debug a single ATS form
npx tsx scripts/debug-apply.ts <applyUrl>
npx tsx scripts/inspect-greenhouse-form.ts <applyUrl>
npx tsx scripts/debug-scrapfly-apply.ts <applyUrl>

# Run a batch of 10 jobs against the current route
npx tsx scripts/test-10-jobs.ts

# List jobs in the DB
npx tsx scripts/list-jobs.ts
```

npm scripts:

```bash
npm run dev          # next dev
npm run build        # next build
npm run start        # next start
npm run lint         # next lint
npm run db:generate  # prisma generate
npm run db:push      # prisma db push
npm run db:seed      # tsx prisma/seed.ts
npm run db:studio    # prisma studio
npm run test         # vitest run
npm run test:watch   # vitest --watch
npm run test:e2e     # playwright test
```

---

## Testing

```bash
npm run test         # unit tests (Vitest)
npm run test:e2e     # E2E (Playwright)
```

End-to-end apply runs leave artifacts under `results/<applicationId>/`:
- `screenshot-*.png`
- `dom-snapshot.html`
- `network.har`
- `outcome.json`

---

## Troubleshooting

**Prisma can't find `DATABASE_URL`** → make sure `.env` (not just `.env.local`) exists. Prisma CLI reads only `.env`.

**Greenhouse application stalls on captcha** → confirm `STEEL_API_KEY` is set; Greenhouse is intentionally routed to Steel.dev. The CloakBrowser route was reverted for Greenhouse in commit `1f62cc2`.

**Headless mode applies are slow or fail** → expected. The CloakBrowser + CapSolver route is headed-only. Captcha solvers and stealth patches don't reliably work headless.

**Resume upload "file too large"** → the API accepts ≤ 5 MB PDFs. Re-export from your resume tool with images compressed.

**Gmail polling not detecting confirmations** → `GOOGLE_REDIRECT_URI` must match the Google Cloud Console value byte-for-byte (including trailing slash).

**`Steel.dev 7-minute cap`** → individual sessions are capped. The apply engine handles this by completing post-verify success out-of-band; see commit `afba5cf`.

---

## License

Private — not for redistribution.
