# Autofill Implementation Plan

## What Exists

### Swipe-Right Flow (TypeScript/Next.js)
- `src/components/swipe-deck/SwipeDeck.tsx` — swipe-right calls POST /api/applications
- `src/app/api/applications/route.ts` — creates DB record, calls `enqueue(applicationId)`
- `src/lib/jobQueue.ts` — enqueues to in-process queue
- `src/lib/queue/application-processor.ts` — picks up PENDING apps, spawns Python subprocess

### Current Python Entry Point
- `job-applications/apply_engine_scrapfly.py` — universal Scrapfly+Playwright engine
  - Uses label-based filling (generic, works but misses ATS-specific fields)
  - Has CapSolver stub but no routing to ATS-specific logic

### Existing ATS-Specific Scripts (NOT yet wired in)
- `job-applications/scripts/bamboohr.py` — BambooHR, confirmed working. Handles custom dropdown, custom questions, EEOC.
- `job-applications/scripts/greenhouse.py` — Greenhouse. EEOC section, work auth radios.
- `job-applications/scripts/lever.py` — Lever. Full name field, comments/cover letter.
- `job-applications/scripts/trakstar.py` — Trakstar, multi-step with Next buttons.
- `job-applications/scripts/personio.py` — Personio. GDPR checkbox, salary, start date.
- `job-applications/scripts/teamtailor.py` — TeamTailor. Click "Apply for this job" first.

### Shared Utilities
- `job-applications/utils/browser.py` — headful stealth Chromium factory
- `job-applications/utils/captcha.py` — Turnstile auto-solve, reCAPTCHA manual prompt
- `job-applications/utils/form_filler.py` — fill_text, select_option, upload_file, click_button
- `job-applications/utils/cover_letter.py` — Claude API cover letter generator
- `job-applications/utils/ats_detector.py` — URL pattern → ATS name
- `job-applications/utils/logger.py` — simple print logger

### Profile Data
- TypeScript side: `UserProfile` in localStorage → passed as `profileSnapshot` JSON
- Python side: `profile.yaml` with `personal`, `employment`, `work_authorization`, `skills`, `demographics`
- Gap: queue processor only passes 5 env vars (first name, last name, email, phone, linkedin) — not the full profile

## The Problem

`apply_engine_scrapfly.py` is called for ALL ATSes but uses generic label-based form filling.
The ATS-specific scripts (`scripts/*.py`) are much better but are never called by the queue.

## Implementation Plan

### New Files
1. `autofill_orchestrator.py` — detects ATS, writes profile.yaml from env vars, routes to correct script
2. `utils/profile_loader.py` — bridges TypeScript env vars → Python profile dict

### Updated Files
1. `utils/captcha.py` — add CapSolver for reCAPTCHA v2 auto-solve
2. `utils/ats_detector.py` — add more ATS patterns (Ashby, SmartRecruiters, Workday, etc.)
3. `src/lib/queue/application-processor.ts` — switch to orchestrator, pass APPLY_PROFILE_JSON

### ATS Routing
```
bamboohr    → scripts/bamboohr.py
greenhouse  → scripts/greenhouse.py
lever       → scripts/lever.py
trakstar    → scripts/trakstar.py
personio    → scripts/personio.py
teamtailor  → scripts/teamtailor.py
unknown     → apply_engine_scrapfly.py (generic fallback)
```

### Profile Bridge
TypeScript UserProfile fields → profile.yaml structure:
- firstName/lastName/email/phone/linkedin/github → personal.*
- location "City, ST" → personal.address.{city, state}
- workAuth → work_authorization.{authorized_to_work, requires_sponsorship}
- yearsExp → employment.years_of_experience
- desiredSalary → employment.desired_salary (strip $ and commas)
- resumeBase64 → written to temp file → resume_path
- bio → skills (if no skills field)

### CapSolver Integration (captcha.py)
- Detect reCAPTCHA v2 iframe
- Extract sitekey from page
- Call CapSolver API (key: CAP-3B64A18B30B50A0278278C10BD9E97D6FAD840D982632D2A061F4E121A6B7083)
- Inject gRecaptchaResponse token
- Fall back to manual prompt if CapSolver fails
