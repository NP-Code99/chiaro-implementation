# Greenhouse API Rewrite Plan

## What I Found

### File Layout
- `scripts/greenhouse.py` — current Playwright-based filler (the file to replace)
- `scripts/{bamboohr,lever,trakstar,personio,teamtailor}.py` — other ATS fillers (unchanged)
- `autofill_orchestrator.py` — central orchestrator; calls `mod.apply(url)` via `_LEGACY_MAP`
- `utils/ats_detector.py` — routes `greenhouse.io` and `gh_jid=` URLs to "greenhouse"
- `utils/profile_loader.py` — loads profile from env vars / YAML into a structured dict
- `utils/cover_letter.py` — generates cover letter text via Claude Haiku
- `utils/logger.py` — unified logger
- `main.py` — standalone runner using `apply_engine_scrapfly.py` (not the orchestrator)

### Current Interface
The legacy map in `autofill_orchestrator.py` calls:
```python
mod = importlib.import_module("scripts.greenhouse")
await mod.apply(url)  # NOT fill_and_submit — just apply(url)
```

The existing `scripts/greenhouse.py` loads its own profile via `yaml.safe_load` and uses
Playwright for every interaction.

### Profile Dict Shape (from profile_loader.py)
```python
profile = {
    "personal": {"first_name", "last_name", "email", "phone", "linkedin", "github", "portfolio", "address": {...}},
    "work_authorization": {"authorized_to_work", "requires_sponsorship", "visa_status"},
    "employment": {"desired_salary", "available_start_date", "willing_to_relocate", "years_of_experience", ...},
    "demographics": {"gender", "ethnicity", "veteran_status", "disability_status"},
    "resume_path": str,
    "cover_letter_path": str,
    "cover_letter_tone": str,
}
```

### ATS Detector Patterns for Greenhouse
- `"greenhouse.io"` — direct board URLs
- `"gh_jid="` — embedded forms

---

## Rewrite Plan

### 1. Archive old filler
`scripts/greenhouse.py` → `scripts/greenhouse_playwright_backup.py`

### 2. Write new `scripts/greenhouse.py`
Pure HTTP using `requests`. No Playwright, no browser, no Scrapfly.

Key methods:
- `parse_greenhouse_url(url)` → `(board_token, job_id)`
- `_extract_board_token_from_page(url)` → fetch HTML, regex-extract board token
- `fetch_job_questions(board_token, job_id)` → GET boards-api.greenhouse.io
- `map_answers(questions, profile, cover_letter_text)` → flat dict
- `submit_application(board_token, job_id, answers, resume_path)` → multipart POST
- `apply(url)` — main entry point (keeps the exact interface the orchestrator expects)

### 3. No router changes needed
`autofill_orchestrator.py` already maps `"greenhouse"` → `"scripts.greenhouse"` and calls `mod.apply(url)`.
The new file just re-implements `apply(url)` without a browser.

### 4. Playwright fallback
If board_token extraction fails (private/SSO board) or API returns non-200,
fall back to `scripts.greenhouse_playwright_backup.apply(url)`.

### 5. Test
- URL parsing unit test (built into `__main__`)
- Dry-run against Scout Motors and DigiCert URLs

---

## Profile Key Differences from Instruction Template
The instructions assume `profile["first_name"]` but the real profile has `profile["personal"]["first_name"]`.
The new filler will use the actual nested structure.
