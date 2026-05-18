"""
startup.jobs board filler.

startup.jobs form facts (confirmed 2026-05):
  - Site is protected by Cloudflare Turnstile on page load — must bypass before form
  - Form fields use standard HTML inputs with name attributes
  - Fields: name, email, phone, LinkedIn, GitHub, resume (file upload), cover letter
  - Custom questions vary per posting
  - Submit button: button[type=submit] or button:has-text("Apply")
"""
from __future__ import annotations

import logging
import random
from pathlib import Path
from typing import Any

from playwright.async_api import Page

from .greenhouse import (
    ApplyResult,
    SUCCESS_PATTERNS,
    _capsolver_solve,
    _inject_and_trigger_captcha,
    _bypass_cloudflare_turnstile,
)

log = logging.getLogger(__name__)

# Maps label substrings → profile keys
_LABEL_MAP: dict[str, str] = {
    "first name":  "firstName",
    "last name":   "lastName",
    "email":       "email",
    "phone":       "phone",
    "linkedin":    "linkedin",
    "github":      "github",
    "portfolio":   "portfolio",
    "website":     "portfolio",
    "salary":      "desiredSalary",
    "location":    "location",
    "city":        "location",
}


class StartupJobsFiller:
    """
    Fills and submits a startup.jobs application form.
    Handles Cloudflare Turnstile on the landing page before form interaction.
    """

    def __init__(
        self,
        page: Page,
        profile: dict[str, Any],
        job: dict[str, Any],
        resume_path: Path,
        cover_letter_path: Path,
        dry_run: bool = False,
        screenshot_dir: Path | None = None,
    ) -> None:
        self.page = page
        self.profile = profile
        self.job = job
        self.resume_path = resume_path
        self.cover_letter_path = cover_letter_path
        self.dry_run = dry_run
        self.screenshot_dir = screenshot_dir or Path("/tmp/applypilot_screenshots")
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)
        self._ss = 0

    async def _inject_cookies(self, raw: str) -> None:
        """Parse a document.cookie string and inject into the browser context."""
        cookies = []
        for part in raw.split(";"):
            part = part.strip()
            if "=" not in part:
                continue
            name, _, value = part.partition("=")
            cookies.append({
                "name": name.strip(),
                "value": value.strip(),
                "domain": "startup.jobs",
                "path": "/",
            })
        if cookies:
            await self.page.context.add_cookies(cookies)
            log.info("startup.jobs: injected %d cookies from profile", len(cookies))

    async def _screenshot(self, name: str) -> str:
        self._ss += 1
        path = self.screenshot_dir / f"{self._ss:02d}_{name}.png"
        try:
            await self.page.screenshot(path=str(path), full_page=True)
        except Exception:
            pass
        return str(path)

    async def run(self) -> ApplyResult:
        try:
            # Step 1: inject saved startup.jobs cookies if available (bypasses CF challenge)
            raw_cookies = self.profile.get("startupJobsCookies", "").strip()
            if raw_cookies:
                await self._inject_cookies(raw_cookies)
                # Reload so the injected cookies take effect
                await self.page.reload(wait_until="domcontentloaded", timeout=30000)
                await self.page.wait_for_timeout(2000)

            # Step 2: bypass Cloudflare Turnstile gate (auto-solve or CapSolver)
            cf_ok = await _bypass_cloudflare_turnstile(self.page)
            if not cf_ok:
                ss = await self._screenshot("cf_blocked")
                return ApplyResult(
                    status="needs_review",
                    error_message=(
                        "startup.jobs is protected by Cloudflare. "
                        "To enable auto-apply: go to startup.jobs in Chrome, log in, "
                        "open DevTools Console, run document.cookie, and paste the result "
                        "into your Profile → startup.jobs Cookies field."
                    ),
                    screenshot_url=ss,
                )
            await self.page.wait_for_timeout(2000)
            await self._screenshot("after_cf")

            # Step 2: fill the form
            await self._fill_fields()
            await self._upload_resume()
            await self._fill_cover_letter()
            await self._fill_custom_questions()
            token = await self._solve_recaptcha()
            await self._screenshot("pre_submit")

            if self.dry_run:
                return ApplyResult(status="applied", error_message="dry_run")
            return await self._submit(token)
        except Exception as exc:
            log.exception("StartupJobsFiller crashed")
            return ApplyResult(status="failed", error_message=str(exc))

    async def _fill_fields(self) -> None:
        """Fill standard text fields by matching label text → profile values."""
        p = self.profile

        # Try combined full-name field first
        full_name = f"{p.get('firstName', '')} {p.get('lastName', '')}".strip()
        for label_frag in ["full name", "your name", "name"]:
            loc = self.page.locator(
                f'input[placeholder*="{label_frag}" i], '
                f'label:has-text("{label_frag}") + input, '
                f'label:has-text("{label_frag}") ~ input'
            ).first
            if await loc.count() > 0:
                val = await loc.input_value()
                if not val:
                    await loc.fill(full_name)
                    await self.page.wait_for_timeout(150)
                break

        # Walk all visible label[for] pairs
        labels = self.page.locator("label[for]")
        count = await labels.count()
        for i in range(count):
            lbl = labels.nth(i)
            label_text = (await lbl.inner_text()).strip().lower()
            for_id = await lbl.get_attribute("for")
            if not for_id:
                continue

            inp = self.page.locator(f"#{for_id}").first
            if await inp.count() == 0:
                continue
            inp_type = (await inp.get_attribute("type") or "text").lower()
            if inp_type in ("file", "submit", "button", "hidden", "checkbox", "radio"):
                continue

            existing = await inp.input_value()
            if existing:
                continue

            # Map label → profile value
            value = ""
            for fragment, key in _LABEL_MAP.items():
                if fragment in label_text:
                    value = str(p.get(key, ""))
                    break

            # Special: first/last split
            if not value and "first" in label_text:
                value = p.get("firstName", "")
            elif not value and "last" in label_text:
                value = p.get("lastName", "")

            if value:
                await inp.scroll_into_view_if_needed()
                await inp.click()
                await self.page.wait_for_timeout(random.randint(80, 180))
                await inp.fill(value)
                await self.page.wait_for_timeout(random.randint(100, 200))

        await self._screenshot("fields_filled")

    async def _upload_resume(self) -> None:
        file_inp = self.page.locator("input[type=file]").first
        if await file_inp.count() == 0:
            log.warning("startup.jobs: no file input found")
            return
        try:
            await file_inp.set_input_files(str(self.resume_path))
            await self.page.wait_for_timeout(1500)
            log.info("startup.jobs: resume uploaded")
        except Exception as exc:
            log.warning("startup.jobs: resume upload failed: %s", exc)

    async def _fill_cover_letter(self) -> None:
        # Textarea labelled "cover letter"
        ta = self.page.locator(
            'textarea[name*="cover" i], '
            'label:has-text("Cover") ~ textarea, '
            'label:has-text("cover") ~ textarea'
        ).first
        if await ta.count() == 0:
            # Fallback: first textarea on the page
            ta = self.page.locator("textarea").first
        if await ta.count() > 0:
            existing = await ta.input_value()
            if not existing:
                text = self.cover_letter_path.read_text()
                await ta.scroll_into_view_if_needed()
                await ta.fill(text)
                await self.page.wait_for_timeout(300)

    async def _fill_custom_questions(self) -> None:
        """AI-fill any remaining visible text inputs / textareas that are empty."""
        labels = self.page.locator("label[for]")
        count = await labels.count()
        skip = {"name", "email", "phone", "resume", "linkedin", "github",
                "portfolio", "salary", "location", "cover"}
        for i in range(count):
            lbl = labels.nth(i)
            label_text = (await lbl.inner_text()).strip()
            if any(s in label_text.lower() for s in skip):
                continue
            for_id = await lbl.get_attribute("for")
            if not for_id:
                continue
            inp = self.page.locator(f"#{for_id}").first
            if await inp.count() == 0:
                continue
            tag = await inp.evaluate("el => el.tagName.toLowerCase()")
            if tag not in ("input", "textarea"):
                continue
            inp_type = await inp.get_attribute("type") or "text"
            if inp_type in ("file", "submit", "button", "hidden"):
                continue
            existing = await inp.input_value()
            if existing:
                continue
            answer = _ai_answer(label_text, self.profile)
            if answer:
                await inp.scroll_into_view_if_needed()
                await inp.fill(answer)
                await self.page.wait_for_timeout(150)

    async def _solve_recaptcha(self) -> str | None:
        from urllib.parse import parse_qs, urlparse
        html = await self.page.content()
        if "g-recaptcha" not in html and "h-captcha" not in html:
            return None
        site_key = await self.page.evaluate(
            "() => { const el = document.querySelector('[data-sitekey]'); return el ? el.getAttribute('data-sitekey') : null; }"
        )
        if not site_key:
            for frame in self.page.frames:
                if "recaptcha" in frame.url and "anchor" in frame.url:
                    try:
                        params = parse_qs(urlparse(frame.url).query)
                        raw = params.get("k", [None])[0]
                        if raw:
                            site_key = raw.strip()
                            break
                    except Exception:
                        pass
        if not site_key:
            return None
        return await _capsolver_solve(site_key, self.page.url)

    async def _submit(self, captcha_token: str | None) -> ApplyResult:
        if captcha_token:
            await _inject_and_trigger_captcha(self.page, captcha_token)
            await self.page.wait_for_timeout(1000)

        btn = self.page.locator("button[type=submit]").first
        if await btn.count() == 0:
            for text in ["Apply", "Submit Application", "Submit"]:
                loc = self.page.get_by_role("button", name=text, exact=False).first
                if await loc.count() > 0:
                    btn = loc
                    break
        if await btn.count() == 0:
            return ApplyResult(status="failed", error_message="No submit button found")

        await btn.scroll_into_view_if_needed()
        await self.page.wait_for_timeout(700)
        await btn.click()

        try:
            await self.page.wait_for_load_state("networkidle", timeout=20000)
        except Exception:
            await self.page.wait_for_timeout(4000)

        ss = await self._screenshot("post_submit")
        text = (await self.page.inner_text("body")).lower()
        success = any(m in text for m in SUCCESS_PATTERNS) or "confirmation" in self.page.url
        if success:
            return ApplyResult(status="applied", screenshot_url=ss)

        errors = await self.page.evaluate("""
            () => [...document.querySelectorAll('[class*="error"], .field-error, [data-error]')]
                  .filter(e => e.innerText?.trim())
                  .map(e => e.innerText.trim().slice(0, 80))
        """)
        if errors:
            return ApplyResult(
                status="failed",
                error_message=str(errors[:5]),
                screenshot_url=ss,
                blocker_fields=errors[:5],
            )
        return ApplyResult(
            status="failed",
            error_message=f"No success pattern. URL: {self.page.url}",
            screenshot_url=ss,
        )


def _ai_answer(question: str, profile: dict[str, Any]) -> str:
    try:
        from applypilot.ai_client import chat
        import json
        return chat(
            "Answer this job application question truthfully and concisely based on the candidate profile.",
            f"Profile: {json.dumps(profile)}\n\nQuestion: {question}",
            max_tokens=200,
            temperature=0.2,
        )
    except Exception:
        return ""
