"""
Central autofill orchestrator — called by the TypeScript queue processor.

Strategy (in order):
  1. Claude-driven fill — extracts DOM, sends to Claude API, executes action plan
  2. ATS-specific script fallback — for ATSes with known quirks (BambooHR, etc.)
  3. Generic Scrapfly engine — last resort

Usage:
  python autofill_orchestrator.py --url URL [--submit]

Env vars (set by queue processor):
  APPLY_FIRST_NAME, APPLY_LAST_NAME, APPLY_EMAIL, APPLY_PHONE
  APPLY_LINKEDIN, APPLY_RESUME_PATH, APPLY_PROFILE_JSON
  SCRAPFLY_API_KEY, ANTHROPIC_API_KEY, CAPSOLVER_API_KEY

Exit codes:
  0 = submitted (or dry-run success)
  1 = failed

Output lines parsed by the TS caller:
  "APPLICATION SUBMITTED"    → status = applied
  "FORM_FILLED_NO_SUBMIT: …" → status = needs_info  (dry-run or unconfirmed)
  "MANUAL REVIEW REQUIRED"   → status = needs_review
  "APPLICATION FAILED: …"    → status = failed
"""

import asyncio, importlib, os, sys, traceback
from pathlib import Path

_HERE = Path(__file__).parent
sys.path.insert(0, str(_HERE))

from utils.ats_detector import detect_ats
from utils.profile_loader import load_profile, write_profile_yaml, check_required
from utils.logger import log

SUBMIT  = "--submit" in sys.argv
DRY_RUN = not SUBMIT

URL = (
    sys.argv[sys.argv.index("--url") + 1]
    if "--url" in sys.argv
    else None
)

# ── ATS → legacy script mapping (used as fallback if Claude fails) ─────────────

_LEGACY_MAP: dict[str, str] = {
    "bamboohr":   "scripts.bamboohr",
    "greenhouse": "scripts.greenhouse",
    "lever":      "scripts.lever",
    "trakstar":   "scripts.trakstar",
    "personio":   "scripts.personio",
    "teamtailor": "scripts.teamtailor",
}
_GENERIC_ENGINE = "apply_engine_scrapfly"

_ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")


# ── Strategy 1: Claude-driven fill ────────────────────────────────────────────

async def _run_claude_strategy(url: str, profile: dict) -> dict:
    """
    Open a browser, navigate to the URL, let Claude fill the form, submit.
    Returns {"status": "applied"} or raises on failure.
    """
    from utils.browser import new_browser, human_delay, screenshot
    from utils.captcha import check_and_solve
    from utils.claude_form_filler import claude_fill_form

    pw, browser, _, page = await new_browser()
    try:
        log(f"[claude-strategy] Navigating to {url}")
        await page.goto(url, wait_until="networkidle", timeout=40000)
        await check_and_solve(page, page.url)
        await human_delay(1500, 2500)

        # Click any "Apply" button to open the form
        for btn_text in ["Apply for This Job", "Apply Now", "Apply now", "Apply", "Jetzt bewerben"]:
            try:
                btn = page.locator(f"text={btn_text}").first
                if await btn.count() > 0:
                    await btn.click(timeout=4000)
                    await human_delay(1500, 2500)
                    await check_and_solve(page, page.url)
                    log(f"[claude-strategy] Opened form via: {btn_text}")
                    break
            except Exception:
                pass

        # Extract job info from page title for Claude context
        title = await page.title()
        company = url.split("/")[2].replace("www.", "").split(".")[0]

        await screenshot(page, "01_form_open")

        log("[claude-strategy] Handing off to Claude form filler...")
        submitted = await claude_fill_form(
            page, profile,
            job_title=title or "the role",
            company=company,
            dry_run=DRY_RUN,
        )

        await screenshot(page, "02_after_fill")

        if submitted or DRY_RUN:
            return {"status": "applied"}
        else:
            # Submission unconfirmed — flag for manual review rather than hard-fail
            log("[orchestrator] ⚠ Claude strategy: submit unconfirmed — flagging for review")
            return {"status": "needs_review", "error": "Submit unconfirmed by Claude strategy"}

    except Exception:
        await screenshot(page, "error_claude_strategy")
        raise
    finally:
        await browser.close()
        await pw.stop()


# ── Strategy 2: Legacy ATS-specific script ─────────────────────────────────────

async def _run_legacy_strategy(ats: str, url: str) -> dict:
    """Fall back to ATS-specific script or generic engine."""
    module_name = _LEGACY_MAP.get(ats, _GENERIC_ENGINE)
    log(f"[legacy-strategy] Routing to: {module_name}")
    mod = importlib.import_module(module_name)
    await mod.apply(url)
    return {"status": "applied"}


# ── Orchestrator ───────────────────────────────────────────────────────────────

async def orchestrate(url: str) -> dict:
    log(f"[orchestrator] URL: {url}")

    # 1. Load + validate profile
    profile = load_profile()
    ok, missing = check_required(profile)
    if not ok:
        msg = f"Profile incomplete — missing: {', '.join(missing)}"
        log(f"[orchestrator] ❌ {msg}")
        return {"status": "failed", "error": msg}

    p = profile["personal"]
    log(f"[orchestrator] Profile: {p['first_name']} {p['last_name']} <{p['email']}>")
    log(f"[orchestrator] Resume: {profile['resume_path'] or 'NOT SET'}")

    # Write profile.yaml for legacy scripts
    write_profile_yaml(profile)

    # 2. Detect ATS
    ats = detect_ats(url)
    log(f"[orchestrator] Detected ATS: {ats.upper()}")

    # 3. Patch sys.argv for legacy scripts that check --dry-run
    if DRY_RUN and "--dry-run" not in sys.argv:
        sys.argv.append("--dry-run")
    elif not DRY_RUN and "--dry-run" in sys.argv:
        sys.argv.remove("--dry-run")

    # 4. Try Claude strategy first (requires ANTHROPIC_API_KEY)
    if _ANTHROPIC_KEY:
        log("[orchestrator] Strategy 1: Claude-driven fill")
        try:
            result = await _run_claude_strategy(url, profile)
            log("[orchestrator] ✅ Claude strategy succeeded")
            return result
        except Exception as err:
            log(f"[orchestrator] ⚠ Claude strategy failed: {err} — trying legacy script")
    else:
        log("[orchestrator] No ANTHROPIC_API_KEY — skipping Claude strategy")

    # 5. Fall back to legacy ATS script / generic engine
    log(f"[orchestrator] Strategy 2: Legacy {'(' + ats + ')' if ats in _LEGACY_MAP else '(generic)'}")
    try:
        result = await _run_legacy_strategy(ats, url)
        log("[orchestrator] ✅ Legacy strategy succeeded")
        return result
    except Exception as err:
        log(f"[orchestrator] ❌ Legacy strategy failed: {err}")
        traceback.print_exc()
        return {"status": "failed", "error": str(err)}


async def main():
    if not URL:
        print("APPLICATION FAILED: --url is required", flush=True)
        sys.exit(1)

    log(f"\n{'='*65}")
    log(f"[orchestrator] Mode: {'SUBMIT' if SUBMIT else 'DRY RUN'}")
    log(f"[orchestrator] Claude API: {'✅ available' if _ANTHROPIC_KEY else '❌ not set'}")
    log(f"{'='*65}\n")

    result = await orchestrate(URL)

    if result.get("status") == "applied":
        if DRY_RUN:
            print("FORM_FILLED_NO_SUBMIT: dry-run mode", flush=True)
            sys.exit(0)
        else:
            print("APPLICATION SUBMITTED", flush=True)
            sys.exit(0)
    elif result.get("status") == "needs_review":
        print(f"MANUAL REVIEW REQUIRED: {result.get('error', '')}", flush=True)
        sys.exit(0)
    else:
        print(f"APPLICATION FAILED: {result.get('error', 'unknown error')}", flush=True)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
