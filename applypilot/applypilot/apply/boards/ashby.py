"""
Ashby board filler — reverse-engineered from live Linear/jobs.ashbyhq.com DOM.

Ashby form facts (confirmed 2026-05):
  - #_systemfield_name      — full name
  - #_systemfield_email     — email
  - #_systemfield_phone     — phone
  - #_systemfield_resume    — file input (pdf/doc/docx)
  - UUID inputs             — custom questions (linkedin, cover letter, etc.)
  - input[aria-haspopup=listbox] — location typeahead (Ashby custom combobox)
  - reCAPTCHA v2 invisible
  - button "Submit Application" or "Apply"
"""
from __future__ import annotations

import logging
import random
from pathlib import Path
from typing import Any

from playwright.async_api import Page

from .greenhouse import ApplyResult, SUCCESS_PATTERNS, _capsolver_solve, _inject_and_trigger_captcha

log = logging.getLogger(__name__)

# Common Ashby field label substrings → profile keys
_LABEL_TO_PROFILE: dict[str, str] = {
    "linkedin":    "linkedin",
    "github":      "github",
    "portfolio":   "portfolio",
    "website":     "portfolio",
    "twitter":     "twitter",
    "pronouns":    "pronouns",
    "salary":      "desiredSalary",
    "phone":       "phone",
}


class AshbyFiller:
    """
    Fills and submits an Ashby job application form.
    Targets: jobs.ashbyhq.com/{company}/{uuid}/application
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
            await self._fill_system_fields()
            await self._upload_resume()
            await self._fill_location()
            await self._fill_custom_fields()
            token = await self._solve_captcha()
            await self._screenshot("pre_submit")
            if self.dry_run:
                return ApplyResult(status="applied", error_message="dry_run")
            return await self._submit(token)
        except Exception as exc:
            log.exception("AshbyFiller crashed")
            return ApplyResult(status="failed", error_message=str(exc))

    async def _fill_system_fields(self) -> None:
        """Fill #_systemfield_name, #_systemfield_email, #_systemfield_phone."""
        p = self.profile
        full_name = f"{p.get('firstName', '')} {p.get('lastName', '')}".strip()

        for sel, value in [
            ("#_systemfield_name",  full_name),
            ("#_systemfield_email", p.get("email", "")),
            ("#_systemfield_phone", p.get("phone", "")),
        ]:
            if not value:
                continue
            loc = self.page.locator(sel).first
            if await loc.count() == 0:
                log.warning("Ashby system field not found: %s", sel)
                continue
            await loc.scroll_into_view_if_needed()
            await loc.click()
            await self.page.wait_for_timeout(random.randint(100, 250))
            await loc.fill(value)
            await self.page.wait_for_timeout(random.randint(150, 300))

        await self._screenshot("system_fields")

    async def _upload_resume(self) -> None:
        """Upload resume via #_systemfield_resume or any file input."""
        inp = self.page.locator("#_systemfield_resume").first
        if await inp.count() == 0:
            inp = self.page.locator("input[type=file]").first
        if await inp.count() == 0:
            log.warning("Ashby: no resume file input found")
            return
        try:
            await inp.set_input_files(str(self.resume_path))
            await self.page.wait_for_timeout(1500)
            log.info("Ashby: resume uploaded")
        except Exception as exc:
            log.warning("Ashby: resume upload failed: %s", exc)

        await self._screenshot("resume")

    async def _fill_location(self) -> None:
        """
        Ashby location typeahead: input[aria-haspopup=listbox] near a location label,
        OR a plain text input.
        """
        location = self.profile.get("location", "")
        if not location:
            return

        # Ashby location is a combobox with aria-haspopup=listbox
        loc_inp = self.page.locator(
            "input[aria-haspopup='listbox'][aria-autocomplete='list'], "
            "input[role='combobox']"
        ).first
        if await loc_inp.count() == 0:
            # Fallback: look for a label containing "location" or "city"
            loc_inp = self.page.get_by_label("Location", exact=False).first

        if await loc_inp.count() == 0:
            log.warning("Ashby: location input not found")
            return

        await loc_inp.scroll_into_view_if_needed()
        await loc_inp.click()
        await self.page.wait_for_timeout(300)
        await loc_inp.fill(location)
        await self.page.wait_for_timeout(1500)

        # Pick first suggestion
        suggestion = self.page.locator(
            "[role=option], [role=listbox] li, [class*='suggestion'] li"
        ).first
        if await suggestion.count() > 0:
            await suggestion.click()
            await self.page.wait_for_timeout(300)
        else:
            await self.page.keyboard.press("ArrowDown")
            await self.page.wait_for_timeout(200)
            await self.page.keyboard.press("Enter")

    async def _fill_custom_fields(self) -> None:
        """
        Walk all remaining visible inputs/textareas and fill using label text.
        Ashby custom field IDs are UUIDs — must find by label proximity.
        """
        p = self.profile

        # Find all label+input pairs
        labels = self.page.locator("label")
        count = await labels.count()

        for i in range(count):
            lbl = labels.nth(i)
            label_text = (await lbl.inner_text()).strip().lower()
            if not label_text:
                continue

            # Skip system fields already handled
            skip = ["name", "email", "resume", "cv", "upload", "location", "city"]
            if any(s in label_text for s in skip):
                continue

            # Map label to profile value
            profile_value = ""
            for key_fragment, profile_key in _LABEL_TO_PROFILE.items():
                if key_fragment in label_text:
                    profile_value = p.get(profile_key, "")
                    break

            # Get for= attribute to find the input
            for_id = await lbl.get_attribute("for")
            if not for_id:
                continue

            inp = self.page.locator(f"#{for_id}").first
            if await inp.count() == 0:
                continue

            tag = await inp.evaluate("el => el.tagName.toLowerCase()")

            if tag == "textarea":
                existing = await inp.input_value()
                if existing:
                    continue
                if "cover" in label_text or "letter" in label_text:
                    text = self.cover_letter_path.read_text()
                elif profile_value:
                    text = profile_value
                else:
                    text = _ai_answer(label_text, self.profile)
                if text:
                    await inp.scroll_into_view_if_needed()
                    await inp.fill(text)
                continue

            inp_type = await inp.get_attribute("type") or "text"
            if inp_type in ("file", "submit", "button", "hidden", "checkbox", "radio"):
                continue

            existing = await inp.input_value()
            if existing:
                continue

            value = profile_value or _ai_answer(label_text, self.profile)
            if value:
                await inp.scroll_into_view_if_needed()
                await inp.click()
                await self.page.wait_for_timeout(100)
                await inp.fill(value)
                await self.page.wait_for_timeout(150)

        # Handle checkboxes (e.g., "Are you based in Australia?") — leave unchecked by default
        # Handle work auth selects
        await self._fill_work_auth_selects()
        await self._screenshot("custom_fields")

    async def _fill_work_auth_selects(self) -> None:
        """Fill any visible <select> elements related to work auth or sponsorship."""
        work_auth = self.profile.get("workAuth", "")
        selects = self.page.locator("select")
        count = await selects.count()
        for i in range(count):
            sel = selects.nth(i)
            # Get the parent label text to understand what this select is for
            parent_text = await sel.evaluate(
                "el => { let p = el.parentElement; for(let j=0;j<4;j++){ if(!p) break; const l=p.querySelector('label'); if(l) return l.innerText.toLowerCase(); p=p.parentElement; } return ''; }"
            )
            if any(k in parent_text for k in ["sponsor", "visa", "work auth", "authorized"]):
                needs_sponsorship = work_auth in ("H1B Visa", "Need Sponsorship")
                opts = await sel.evaluate("el => [...el.options].map(o=>({v:o.value, t:o.text.toLowerCase()}))")
                target_text = "yes" if needs_sponsorship else "no"
                matched = next((o["v"] for o in opts if target_text in o["t"]), None)
                if matched:
                    try:
                        await sel.select_option(value=matched)
                    except Exception:
                        pass

    async def _solve_captcha(self) -> str | None:
        from urllib.parse import parse_qs, urlparse
        html = await self.page.content()
        if "g-recaptcha" not in html and "h-captcha" not in html:
            return None

        site_key = await self.page.evaluate("""
            () => { const el = document.querySelector('[data-sitekey]'); return el ? el.getAttribute('data-sitekey') : null; }
        """)
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
            log.warning("Ashby CAPTCHA present but sitekey not found")
            return None

        log.info("Ashby: solving reCAPTCHA sitekey=%s", site_key[:20])
        return await _capsolver_solve(site_key, self.page.url)

    async def _submit(self, captcha_token: str | None) -> ApplyResult:
        if captcha_token:
            cb_result = await _inject_and_trigger_captcha(self.page, captcha_token)
            log.info("Ashby reCAPTCHA callback: %s", cb_result)
            await self.page.wait_for_timeout(1000)

        btn = self.page.locator("button[type=submit]").first
        if await btn.count() == 0:
            for text in ["Submit Application", "Apply", "Submit"]:
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
            () => [...document.querySelectorAll('[class*="error"], [data-error], .ashby-error')]
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
