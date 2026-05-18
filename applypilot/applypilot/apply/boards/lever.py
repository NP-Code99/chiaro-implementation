"""
Lever board filler — reverse-engineered from live Palantir/jobs.lever.co DOM.

Lever form facts (confirmed 2026-05):
  - Most text inputs have NO id attributes — must target by label-text proximity
  - #resume-upload-input  — file input for resume
  - #location-input       — location typeahead
  - #btn-submit           — submit button
  - EEO: native <select> elements, #disabilitySelectElement
  - Custom questions: .application-field blocks with a label then input/select/textarea
  - CAPTCHA: reCAPTCHA v2 invisible + sometimes hCaptcha
"""
from __future__ import annotations

import logging
import random
from dataclasses import dataclass, field as dc_field
from pathlib import Path
from typing import Any

from playwright.async_api import Page

from .greenhouse import ApplyResult, SUCCESS_PATTERNS, _capsolver_solve, _inject_and_trigger_captcha

log = logging.getLogger(__name__)


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _fill_by_label(page: Page, label_text: str, value: str) -> bool:
    """
    Find the input nearest to a label whose text contains label_text.
    Lever wraps each field in .application-field:
        <div class="application-field">
          <label>Full name *</label>
          <input type="text" ...>
        </div>
    """
    loc = page.locator(
        f'.application-field:has(label:has-text("{label_text}")) input, '
        f'.application-field:has(label:has-text("{label_text}")) textarea'
    ).first
    if await loc.count() == 0:
        # Fallback: Playwright get_by_label
        loc = page.get_by_label(label_text, exact=False).first
    if await loc.count() == 0:
        return False
    await loc.scroll_into_view_if_needed()
    await loc.click()
    await page.wait_for_timeout(random.randint(100, 250))
    await loc.fill(value)
    await page.wait_for_timeout(random.randint(200, 400))
    return True


async def _select_by_label(page: Page, label_text: str, option_text: str) -> bool:
    """Select a native <select> option in a Lever field."""
    sel = page.locator(
        f'.application-field:has(label:has-text("{label_text}")) select'
    ).first
    if await sel.count() == 0:
        sel = page.get_by_label(label_text, exact=False).first
    if await sel.count() == 0:
        return False
    try:
        await sel.scroll_into_view_if_needed()
        await sel.select_option(label=option_text)
        return True
    except Exception:
        # Try partial match
        options = await sel.evaluate("el => [...el.options].map(o => o.text)")
        for opt in options:
            if option_text.lower() in opt.lower():
                await sel.select_option(label=opt)
                return True
        return False


async def _check_radio_by_label(page: Page, container_label: str, choice_label: str) -> bool:
    """Check a radio button whose visible text matches choice_label within a group."""
    loc = page.locator(
        f'.application-field:has(:text("{container_label}")) input[type=radio]'
    )
    count = await loc.count()
    for i in range(count):
        r = loc.nth(i)
        # Get sibling/parent text to identify the option
        parent_text = await r.evaluate("el => el.closest('label')?.innerText || el.parentElement?.innerText || ''")
        if choice_label.lower() in parent_text.lower():
            await r.check()
            return True
    return False


class LeverFiller:
    """
    Fills and submits a Lever job application form.
    Targets: jobs.lever.co/{company}/{uuid}/apply
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
            await self._upload_resume()
            await self._fill_basic()
            await self._fill_location()
            await self._fill_urls()
            await self._fill_custom_questions()
            await self._fill_eeo()
            token = await self._solve_captcha()
            await self._screenshot("pre_submit")
            if self.dry_run:
                return ApplyResult(status="applied", error_message="dry_run")
            return await self._submit(token)
        except Exception as exc:
            log.exception("LeverFiller crashed")
            return ApplyResult(status="failed", error_message=str(exc))

    async def _upload_resume(self) -> None:
        # Primary: #resume-upload-input
        inp = self.page.locator("#resume-upload-input").first
        if await inp.count() > 0:
            try:
                await inp.set_input_files(str(self.resume_path))
                await self.page.wait_for_timeout(1500)
                log.info("Resume uploaded via #resume-upload-input")
                return
            except Exception as exc:
                log.warning("Resume upload (#resume-upload-input) failed: %s", exc)
        # Fallback: first file input
        for sel in ["input[type=file]", "input.application-file-input"]:
            loc = self.page.locator(sel).first
            if await loc.count() > 0:
                try:
                    await loc.set_input_files(str(self.resume_path))
                    await self.page.wait_for_timeout(1500)
                    return
                except Exception as exc:
                    log.warning("Resume upload (%s) failed: %s", sel, exc)
        await self._screenshot("resume_upload")

    async def _fill_basic(self) -> None:
        p = self.profile
        full_name = f"{p.get('firstName','')} {p.get('lastName','')}".strip()

        pairs = [
            ("Full name",       full_name),
            ("Email",           p.get("email", "")),
            ("Phone",           p.get("phone", "")),
            ("Current company", p.get("currentCompany", "")),
        ]
        for label, value in pairs:
            if value:
                ok = await _fill_by_label(self.page, label, value)
                if not ok:
                    log.warning("Could not fill Lever field: %s", label)

        await self._screenshot("basic")

    async def _fill_location(self) -> None:
        location = self.profile.get("location", "")
        if not location:
            return
        # #location-input is a typeahead
        loc_inp = self.page.locator("#location-input").first
        if await loc_inp.count() > 0:
            await loc_inp.scroll_into_view_if_needed()
            await loc_inp.click()
            await self.page.wait_for_timeout(300)
            await loc_inp.fill(location)
            await self.page.wait_for_timeout(1200)
            # Try picking from autocomplete
            suggestion = self.page.locator("[class*='autocomplete'] li, [class*='suggestion'] li, [role=option]").first
            if await suggestion.count() > 0:
                await suggestion.click()
            else:
                await self.page.keyboard.press("ArrowDown")
                await self.page.wait_for_timeout(200)
                await self.page.keyboard.press("Enter")
        else:
            await _fill_by_label(self.page, "location", location)

    async def _fill_urls(self) -> None:
        p = self.profile
        for label, value in [
            ("LinkedIn URL", p.get("linkedin", "")),
            ("GitHub URL",   p.get("github", "")),
            ("Portfolio URL", p.get("portfolio", "")),
            ("Website",      p.get("portfolio", "")),
        ]:
            if value:
                await _fill_by_label(self.page, label, value)

        # Cover letter — Lever sometimes has a textarea or file input
        cover_textarea = self.page.locator(
            '.application-field:has(label:has-text("Cover letter")) textarea, '
            '.application-field:has(label:has-text("cover letter")) textarea'
        ).first
        if await cover_textarea.count() > 0:
            cover_text = self.cover_letter_path.read_text()
            await cover_textarea.fill(cover_text)
        else:
            cover_file = self.page.locator(
                '.application-field:has(label:has-text("Cover letter")) input[type=file], '
                'input[id*="cover"]'
            ).first
            if await cover_file.count() > 0:
                try:
                    await cover_file.set_input_files(str(self.cover_letter_path))
                    await self.page.wait_for_timeout(1000)
                except Exception as exc:
                    log.warning("Cover letter file upload failed: %s", exc)

    async def _fill_custom_questions(self) -> None:
        """Answer any visible .application-field question blocks using AI."""
        fields = self.page.locator(".application-field")
        count = await fields.count()
        for i in range(count):
            block = fields.nth(i)
            # Get label text
            label_el = block.locator("label").first
            if await label_el.count() == 0:
                continue
            label_text = (await label_el.inner_text()).strip()
            if not label_text:
                continue

            # Skip fields we already handled
            skip_patterns = ["full name", "email", "phone", "location", "company",
                              "linkedin", "github", "portfolio", "resume", "cover letter",
                              "website", "consent", "veteran", "disability"]
            if any(s in label_text.lower() for s in skip_patterns):
                continue

            # Textarea custom question
            ta = block.locator("textarea").first
            if await ta.count() > 0:
                existing = await ta.input_value()
                if not existing:
                    answer = _ai_answer(label_text, self.profile)
                    if answer:
                        await ta.fill(answer)
                continue

            # Native select custom question
            sel = block.locator("select").first
            if await sel.count() > 0:
                answer = _ai_answer(label_text, self.profile)
                options = await sel.evaluate("el => [...el.options].map(o => o.text.trim()).filter(Boolean)")
                best = _best_option(answer, options)
                if best:
                    try:
                        await sel.select_option(label=best)
                    except Exception:
                        pass
                continue

            # Text input
            inp = block.locator("input[type=text]").first
            if await inp.count() > 0:
                existing = await inp.input_value()
                if not existing:
                    answer = _ai_answer(label_text, self.profile)
                    if answer:
                        await inp.fill(answer)

    async def _fill_eeo(self) -> None:
        """Fill EEO selects: veteran + disability status."""
        # Veteran status — select "I am not a protected veteran"
        vet_sel = self.page.locator('select').filter(
            has_text="protected veteran"
        ).first
        if await vet_sel.count() == 0:
            vet_sel = self.page.locator('.application-field:has(:text("Veteran")) select').first
        if await vet_sel.count() > 0:
            try:
                await vet_sel.select_option(label="I am not a protected veteran")
            except Exception:
                pass

        # Disability status — #disabilitySelectElement or by label
        dis_sel = self.page.locator("#disabilitySelectElement").first
        if await dis_sel.count() == 0:
            dis_sel = self.page.locator('.application-field:has(:text("Disability")) select').first
        if await dis_sel.count() > 0:
            try:
                await dis_sel.select_option(label="No, I don't have a disability and have not had one in the past")
            except Exception:
                try:
                    await dis_sel.select_option(index=1)  # second option (usually "No")
                except Exception:
                    pass

        await self._screenshot("eeo")

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
            log.warning("Lever CAPTCHA present but sitekey not found")
            return None

        log.info("Lever: solving reCAPTCHA sitekey=%s", site_key[:20])
        return await _capsolver_solve(site_key, self.page.url)

    async def _submit(self, captcha_token: str | None) -> ApplyResult:
        if captcha_token:
            cb_result = await _inject_and_trigger_captcha(self.page, captcha_token)
            log.info("Lever reCAPTCHA callback: %s", cb_result)
            await self.page.wait_for_timeout(1000)

        btn = self.page.locator("#btn-submit").first
        if await btn.count() == 0:
            for sel in ["button[type=submit]", "button:has-text('SUBMIT')", "button:has-text('Submit Application')"]:
                loc = self.page.locator(sel).first
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
            () => [...document.querySelectorAll('.error-msg, .field-error, [class*="error"]')]
                  .filter(e => e.innerText?.trim())
                  .map(e => e.innerText.trim().slice(0,80))
        """)
        if errors:
            return ApplyResult(status="failed", error_message=str(errors[:5]), screenshot_url=ss, blocker_fields=errors[:5])

        return ApplyResult(status="failed", error_message=f"No success pattern. URL: {self.page.url}", screenshot_url=ss)


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


def _best_option(answer: str, options: list[str]) -> str | None:
    """Pick the option from a list that best matches the AI answer."""
    if not options:
        return None
    ans_lower = answer.lower()
    for opt in options:
        if opt and ans_lower in opt.lower():
            return opt
    for opt in options:
        if opt and opt.lower() in ans_lower:
            return opt
    # Return second option (skip blank/placeholder)
    non_blank = [o for o in options if o.strip() and o.strip() != "Select..."]
    return non_blank[0] if non_blank else None
