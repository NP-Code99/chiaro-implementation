"""
AI-driven form detection and filling using Playwright.
Handles Greenhouse, Lever, Workday, and generic HTML forms.
"""
import json
import logging
import random
from pathlib import Path
from typing import Any

from playwright.async_api import Page

from ..ai_client import chat
from .anti_detect import human_delay, human_type, ghost_move
from .captcha import (
    solve_turnstile, solve_recaptcha_v2, solve_hcaptcha, inject_captcha_solution
)

log = logging.getLogger(__name__)

_FORM_SYSTEM = """
You are an expert at filling out job application forms.
Given the current page HTML snapshot and the candidate profile, return a JSON object
mapping CSS selectors (or field labels) to values to fill in.

Return ONLY valid JSON:
{
  "fields": [
    {"selector": "<css selector or label text>", "type": "<text|select|radio|checkbox|textarea|file>", "value": "<value>"}
  ],
  "submit_selector": "<css selector for submit button, or null>",
  "captcha_detected": false,
  "captcha_type": null,
  "captcha_site_key": null
}
"""

_SCREENING_SYSTEM = """
You are answering screening questions for a job application on behalf of the candidate.
Answer each question truthfully based on the candidate profile.
Return ONLY valid JSON:
{"answers": [{"question": "...", "answer": "..."}]}
"""


async def detect_captcha(page: Page) -> dict | None:
    """Check for common CAPTCHA widgets in the page."""
    html = await page.content()
    for marker, ctype in [
        ("cf-turnstile", "turnstile"),
        ("g-recaptcha", "recaptcha"),
        ("h-captcha", "hcaptcha"),
    ]:
        if marker in html:
            # Try to extract sitekey
            site_key = await page.evaluate(f"""
                (() => {{
                    const el = document.querySelector('[data-sitekey]');
                    return el ? el.getAttribute('data-sitekey') : null;
                }})()
            """)
            return {"type": ctype, "site_key": site_key}
    return None


async def handle_captcha_if_present(page: Page) -> None:
    """Detect and solve any CAPTCHA on the current page."""
    info = await detect_captcha(page)
    if not info:
        return
    url = page.url
    site_key = info.get("site_key", "")
    log.info("CAPTCHA detected: %s (sitekey=%s)", info["type"], site_key)
    try:
        if info["type"] == "turnstile":
            token = solve_turnstile(url, site_key)
        elif info["type"] == "recaptcha":
            token = solve_recaptcha_v2(url, site_key)
        else:
            token = solve_hcaptcha(url, site_key)
        await inject_captcha_solution(page, info["type"], token)
        log.info("CAPTCHA token injected")
    except Exception as exc:
        log.warning("CAPTCHA solving failed: %s", exc)


async def get_page_snapshot(page: Page, max_chars: int = 8000) -> str:
    """Return a trimmed HTML snapshot of the current page for AI analysis."""
    html = await page.content()
    # Trim scripts and styles to save tokens
    import re
    html = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL)
    html = re.sub(r"<style[^>]*>.*?</style>", "", html, flags=re.DOTALL)
    return html[:max_chars]


async def fill_form(
    page: Page,
    profile: dict[str, Any],
    job: dict[str, Any],
    resume_path: Path,
    cover_letter_path: Path,
    dry_run: bool = False,
) -> bool:
    """
    Detect and fill an application form using AI guidance.
    Returns True on successful submission (or dry_run completion).
    """
    await handle_captcha_if_present(page)

    snapshot = await get_page_snapshot(page)
    user_prompt = f"""
PAGE HTML (trimmed):
{snapshot}

CANDIDATE PROFILE:
{json.dumps(profile, indent=2)}

JOB:
Title: {job.get('title')}
Company: {job.get('company')}

AVAILABLE FILES:
- Resume: {resume_path.name}
- Cover Letter: {cover_letter_path.name}

Fill all visible form fields. For file inputs, use the provided resume/cover letter.
"""
    try:
        raw = chat(_FORM_SYSTEM, user_prompt, temperature=0.1, json_mode=True)
        instructions = json.loads(raw)
    except Exception as exc:
        log.error("AI form analysis failed: %s", exc)
        return False

    fields = instructions.get("fields", [])
    log.info("AI identified %d fields to fill", len(fields))

    for field in fields:
        selector = field.get("selector", "")
        ftype = field.get("type", "text")
        value = field.get("value", "")
        if not selector or not value:
            continue
        try:
            locator = page.locator(selector).first
            bbox = await locator.bounding_box()
            if bbox:
                await ghost_move(page, int(bbox["x"] + bbox["width"] / 2), int(bbox["y"] + bbox["height"] / 2))

            if ftype == "file":
                # Determine which file to upload
                if "resume" in selector.lower() or "resume" in value.lower():
                    await locator.set_input_files(str(resume_path))
                else:
                    await locator.set_input_files(str(cover_letter_path))
            elif ftype == "select":
                await locator.select_option(label=value)
            elif ftype in ("radio", "checkbox"):
                await locator.check()
            elif ftype == "textarea":
                await locator.fill(value)
            else:
                # Text — use human-like typing
                await locator.click()
                await human_delay(page, 150, 400)
                for char in value:
                    await locator.type(char, delay=random.randint(50, 150))
            await human_delay(page, 400, 1200)
        except Exception as exc:
            log.warning("Could not fill field '%s': %s", selector, exc)
            continue

    if dry_run:
        log.info("[dry-run] Skipping form submission")
        return True

    submit_sel = instructions.get("submit_selector")
    if submit_sel:
        try:
            btn = page.locator(submit_sel).first
            bbox = await btn.bounding_box()
            if bbox:
                await ghost_move(page, int(bbox["x"] + bbox["width"] / 2), int(bbox["y"] + bbox["height"] / 2))
            await human_delay(page, 500, 1000)
            await btn.click()
            await page.wait_for_load_state("networkidle", timeout=15000)
            log.info("Form submitted successfully")
            return True
        except Exception as exc:
            log.error("Submit click failed: %s", exc)
            return False

    log.warning("No submit button identified by AI")
    return False
