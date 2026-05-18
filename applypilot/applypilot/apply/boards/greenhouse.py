"""
Greenhouse board filler.
Handles job-boards.greenhouse.io forms: React-Select dropdowns, iti phone picker,
file uploads, EEO fields, and reCAPTCHA invisible v2.
"""
from __future__ import annotations

import json
import logging
import os
import random
import time as _time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from playwright.async_api import Page

log = logging.getLogger(__name__)

SUCCESS_PATTERNS = [
    "thank you",
    "application received",
    "application submitted",
    "successfully applied",
    "we'll be in touch",
    "we received your",
    "application complete",
    "successfully submitted",
    "submission confirmed",
    "you've applied",
]


@dataclass
class ApplyResult:
    status: str                     # "applied" | "failed" | "needs_review"
    error_message: str = ""
    screenshot_url: str = ""
    pending_questions: list[str] = field(default_factory=list)
    blocker_fields: list[str] = field(default_factory=list)


# ── Low-level helpers ─────────────────────────────────────────────────────────

async def _human_fill(page: Page, selector: str, value: str) -> None:
    loc = page.locator(selector).first
    await loc.scroll_into_view_if_needed()
    await loc.click()
    await page.wait_for_timeout(random.randint(150, 350))
    await loc.fill("")
    for ch in value:
        await loc.type(ch, delay=random.randint(45, 110))
    await page.wait_for_timeout(random.randint(250, 500))


async def _react_select(page: Page, field_id: str, needle: str) -> str | None:
    """
    Click a Greenhouse React-Select input (aria-haspopup=true, class=select__input),
    wait for the listbox, and pick the first option whose text contains `needle`.
    Returns the matched option text, or None if not found.
    """
    inp = page.locator(f"#{field_id}").first
    await inp.scroll_into_view_if_needed()
    await inp.click()
    await page.wait_for_timeout(400)

    try:
        await page.wait_for_selector(f"#{field_id}[aria-expanded='true']", timeout=5000)
    except Exception:
        log.warning("React-Select #%s did not open (aria-expanded timeout)", field_id)
        return None

    controls_id = await inp.get_attribute("aria-controls")
    listbox = (
        page.locator(f"#{controls_id}")
        if controls_id
        else page.locator("[role=listbox]:not(.iti__country-list)").first
    )

    opts = listbox.get_by_role("option")
    count = await opts.count()
    needle_lower = needle.lower()

    for i in range(count):
        opt = opts.nth(i)
        txt = (await opt.inner_text()).strip()
        if needle_lower in txt.lower():
            await opt.click()
            await page.wait_for_timeout(300)
            return txt

    # Fallback: pick first non-empty option
    for i in range(count):
        opt = opts.nth(i)
        txt = (await opt.inner_text()).strip()
        if txt:
            await opt.click()
            await page.wait_for_timeout(300)
            log.warning("React-Select #%s: no match for '%s', picked first: %s", field_id, needle, txt)
            return txt

    log.warning("React-Select #%s: empty listbox after open", field_id)
    return None


async def _typeahead_select(page: Page, field_id: str, query: str, needle: str) -> str | None:
    """
    Click a typeahead React-Select (like candidate-location), type a query to trigger
    autocomplete, then pick the first option containing needle.
    """
    inp = page.locator(f"#{field_id}").first
    await inp.scroll_into_view_if_needed()
    await inp.click()
    await page.wait_for_timeout(300)
    await inp.fill(query)
    await page.wait_for_timeout(1200)

    try:
        await page.wait_for_selector(f"#{field_id}[aria-expanded='true']", timeout=5000)
    except Exception:
        # Try keyboard nav as fallback
        await page.keyboard.press("ArrowDown")
        await page.wait_for_timeout(200)
        await page.keyboard.press("Enter")
        return query

    controls_id = await inp.get_attribute("aria-controls")
    listbox = (
        page.locator(f"#{controls_id}")
        if controls_id
        else page.locator("[role=listbox]:not(.iti__country-list)").first
    )
    opts = listbox.get_by_role("option")
    count = await opts.count()
    needle_lower = needle.lower()

    for i in range(count):
        opt = opts.nth(i)
        txt = (await opt.inner_text()).strip()
        if needle_lower in txt.lower():
            await opt.click()
            await page.wait_for_timeout(300)
            return txt

    if count > 0:
        txt = (await opts.first.inner_text()).strip()
        await opts.first.click()
        await page.wait_for_timeout(300)
        return txt

    await page.keyboard.press("ArrowDown")
    await page.wait_for_timeout(200)
    await page.keyboard.press("Enter")
    return query


async def _capsolver_solve(site_key: str, page_url: str) -> str | None:
    """Solve reCAPTCHA v2 invisible via CapSolver. Returns token or None."""
    capsolver_key = os.environ.get("CAPSOLVER_API_KEY", "")
    if not capsolver_key:
        return None
    try:
        import requests as _req
        r = _req.post("https://api.capsolver.com/createTask", json={
            "clientKey": capsolver_key,
            "task": {
                "type": "ReCaptchaV2TaskProxyLess",
                "websiteURL": page_url,
                "websiteKey": site_key,
                "isInvisible": True,
            }
        }, timeout=20)
        data = r.json()
        if data.get("errorId"):
            log.error("CapSolver createTask error: %s", data)
            return None
        task_id = data["taskId"]
        for _ in range(40):
            _time.sleep(3)
            res = _req.post("https://api.capsolver.com/getTaskResult",
                            json={"clientKey": capsolver_key, "taskId": task_id}, timeout=20).json()
            if res.get("status") == "ready":
                return res["solution"]["gRecaptchaResponse"]
            if res.get("errorId"):
                log.error("CapSolver poll error: %s", res)
                return None
    except Exception as exc:
        log.error("CapSolver exception: %s", exc)
    return None


async def _capsolver_turnstile(site_key: str, page_url: str) -> str | None:
    """Solve Cloudflare Turnstile via CapSolver. Returns cf-turnstile-response token or None."""
    capsolver_key = os.environ.get("CAPSOLVER_API_KEY", "")
    if not capsolver_key:
        return None
    try:
        import requests as _req
        r = _req.post("https://api.capsolver.com/createTask", json={
            "clientKey": capsolver_key,
            "task": {
                "type": "AntiTurnstileTaskProxyLess",
                "websiteURL": page_url,
                "websiteKey": site_key,
            }
        }, timeout=20)
        data = r.json()
        if data.get("errorId"):
            log.error("CapSolver Turnstile createTask error: %s", data)
            return None
        task_id = data["taskId"]
        for _ in range(40):
            _time.sleep(3)
            res = _req.post("https://api.capsolver.com/getTaskResult",
                            json={"clientKey": capsolver_key, "taskId": task_id}, timeout=20).json()
            if res.get("status") == "ready":
                return res["solution"]["token"]
            if res.get("errorId"):
                log.error("CapSolver Turnstile poll error: %s", res)
                return None
    except Exception as exc:
        log.error("CapSolver Turnstile exception: %s", exc)
    return None


async def _capsolver_cloudflare_challenge(page_url: str) -> str | None:
    """
    Solve a Cloudflare managed challenge (not pure Turnstile) via CapSolver.
    Uses AntiCloudflareTask which handles JS challenge / IUAM pages.
    Returns the clearance token or None.
    """
    capsolver_key = os.environ.get("CAPSOLVER_API_KEY", "")
    if not capsolver_key:
        return None
    try:
        import requests as _req
        r = _req.post("https://api.capsolver.com/createTask", json={
            "clientKey": capsolver_key,
            "task": {
                "type": "AntiCloudflareTask",
                "websiteURL": page_url,
                "proxy": "",   # proxy-less attempt; CapSolver may reject without proxy
            }
        }, timeout=20)
        data = r.json()
        if data.get("errorId"):
            log.error("CapSolver AntiCloudflareTask error: %s", data.get("errorDescription", data))
            return None
        task_id = data["taskId"]
        for _ in range(40):
            _time.sleep(3)
            res = _req.post("https://api.capsolver.com/getTaskResult",
                            json={"clientKey": capsolver_key, "taskId": task_id}, timeout=20).json()
            if res.get("status") == "ready":
                return res["solution"].get("token") or res["solution"].get("cf_clearance")
            if res.get("errorId"):
                log.error("CapSolver AntiCloudflareTask poll error: %s", res)
                return None
    except Exception as exc:
        log.error("CapSolver AntiCloudflareTask exception: %s", exc)
    return None


async def _bypass_cloudflare_turnstile(page: Page) -> bool:
    """
    Detect and solve a Cloudflare Turnstile challenge page.
    Returns True if the challenge was solved (or wasn't present), False on failure.
    """
    # Check if we're on a CF challenge page
    title = await page.title()
    content = await page.content()
    is_challenge = (
        "just a moment" in title.lower()
        or "cf-turnstile" in content.lower()
        or "turnstile" in content.lower()
        or "Performing security verification" in content
    )
    if not is_challenge:
        return True

    log.info("Cloudflare Turnstile challenge detected — attempting CapSolver bypass")

    # Extract sitekey — CF Turnstile embeds it multiple ways:
    # 1. data-sitekey attribute on a div
    # 2. In the challenges.cloudflare.com iframe URL path as the last segment (0x4...)
    # 3. As a query param ?k=... in the iframe src
    site_key = await page.evaluate("""
        () => {
            // Method 1: data-sitekey on element
            const el = document.querySelector('[data-sitekey]');
            if (el) return el.getAttribute('data-sitekey');
            // Method 2: query param in iframe src
            for (const iframe of document.querySelectorAll('iframe')) {
                const src = iframe.src || '';
                const m = src.match(/[?&]k=([^&]+)/);
                if (m) return m[1];
            }
            return null;
        }
    """)

    # Method 3: extract from Cloudflare challenge iframe URL path
    # Format: /cdn-cgi/challenge-platform/.../0x4AAAAA.../
    if not site_key:
        import re as _re
        for frame in page.frames:
            m = _re.search(r'/(0x4[A-Za-z0-9_-]+)/?', frame.url)
            if m:
                site_key = m.group(1)
                log.info("Turnstile sitekey extracted from iframe URL: %s", site_key)
                break

    # Always wait up to 15s for CF to auto-pass (works without any solving if stealth is good)
    log.info("Waiting for CF challenge to auto-clear (sitekey=%s)…", site_key or "unknown")
    for _ in range(15):
        await page.wait_for_timeout(1000)
        t = await page.title()
        if "just a moment" not in t.lower() and "security verification" not in t.lower():
            log.info("CF challenge auto-passed — title: %s", t)
            return True

    if not site_key:
        log.warning("CF challenge still active and no sitekey found — giving up")
        return False

    # Try AntiTurnstileTaskProxyLess first, then AntiCloudflareTask
    token = await _capsolver_turnstile(site_key, page.url)
    if not token:
        log.info("Turnstile task failed — trying AntiCloudflareTask")
        token = await _capsolver_cloudflare_challenge(page.url)
    if not token:
        log.warning("CapSolver could not solve CF challenge")
        return False

    # Inject token and trigger the callback
    injected = await page.evaluate("""
        (token) => {
            // Set hidden input that CF checks
            const inp = document.querySelector('[name="cf-turnstile-response"]');
            if (inp) { inp.value = token; inp.dispatchEvent(new Event('change', {bubbles: true})); }
            // Fire the turnstile callback if present
            if (window.turnstile && typeof window.turnstile.execute === 'function') {
                try { window.turnstile.execute(); } catch(e) {}
            }
            // Try __cf_chl_opt callback
            if (window.__cfChallengeCallback) {
                try { window.__cfChallengeCallback(token); } catch(e) {}
            }
            return !!inp;
        }
    """, token)
    log.info("Turnstile token injected (input found=%s) — waiting for redirect", injected)

    # Wait for page to redirect past the challenge
    try:
        await page.wait_for_function(
            "() => !document.title.toLowerCase().includes('just a moment') && !document.title.toLowerCase().includes('security verification')",
            timeout=20000,
        )
        await page.wait_for_timeout(1500)
        log.info("Turnstile challenge bypassed — new title: %s", await page.title())
        return True
    except Exception:
        # Last-ditch: reload and check if CF cookie was set
        log.warning("Turnstile wait_for_function timed out — reloading page")
        await page.reload(wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(3000)
        t = await page.title()
        if "just a moment" not in t.lower() and "security" not in t.lower():
            log.info("Turnstile bypassed after reload — title: %s", t)
            return True
        log.warning("Turnstile challenge did not clear after token injection")
        return False


async def _inject_and_trigger_captcha(page: Page, token: str) -> str:
    """Inject reCAPTCHA token and try to call Greenhouse's callback."""
    return await page.evaluate("""
        (token) => {
            document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach(ta => {
                ta.value = token;
                ta.dispatchEvent(new Event('change', {bubbles: true}));
                ta.dispatchEvent(new Event('input', {bubbles: true}));
            });
            // Try data-callback attribute
            const div = document.querySelector('.g-recaptcha[data-callback]');
            if (div) {
                const cbName = div.getAttribute('data-callback');
                if (cbName && typeof window[cbName] === 'function') {
                    window[cbName](token);
                    return 'data-callback:' + cbName;
                }
            }
            // Deep search ___grecaptcha_cfg.clients
            function deepFind(obj, depth) {
                if (!obj || typeof obj !== 'object' || depth > 5) return null;
                for (const [k, v] of Object.entries(obj)) {
                    if (k === 'callback' && typeof v === 'function') return v;
                    const found = deepFind(v, depth + 1);
                    if (found) return found;
                }
                return null;
            }
            try {
                if (window.___grecaptcha_cfg?.clients) {
                    for (const client of Object.values(window.___grecaptcha_cfg.clients)) {
                        const cb = deepFind(client, 0);
                        if (cb) { cb(token); return 'cfg-callback'; }
                    }
                }
            } catch(e) { return 'cfg-error:' + e; }
            return 'token-injected';
        }
    """, token)


# ── AI helpers ────────────────────────────────────────────────────────────────

def _ai_answer(question: str, profile: dict[str, Any]) -> str:
    try:
        from applypilot.ai_client import chat
        return chat(
            "Answer this job application screening question truthfully and concisely "
            "(1 sentence or a simple Yes/No) based on the candidate profile.",
            f"Profile: {json.dumps(profile)}\n\nQuestion: {question}",
            max_tokens=80,
            temperature=0.2,
        )
    except Exception:
        return "Yes"


# ── Main filler class ─────────────────────────────────────────────────────────

class GreenhouseFiller:
    """
    Fills and submits a Greenhouse job application form.

    Usage:
        filler = GreenhouseFiller(page, profile, job, resume_path, cover_letter_path)
        result = await filler.run()
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
        self._ss_count = 0

    async def _screenshot(self, name: str) -> str:
        self._ss_count += 1
        fname = f"{self._ss_count:02d}_{name}.png"
        path = self.screenshot_dir / fname
        try:
            await self.page.screenshot(path=str(path), full_page=True)
        except Exception:
            pass
        return str(path)

    async def run(self) -> ApplyResult:
        try:
            await self._fill_basic_fields()
            await self._fill_location()
            await self._fill_phone_and_country()
            await self._fill_linkedin()
            await self._fill_screening_questions()
            await self._upload_files()
            await self._fill_eeo()
            token = await self._solve_captcha()
            if self.dry_run:
                return ApplyResult(status="applied", error_message="dry_run — not submitted")
            return await self._submit(token)
        except Exception as exc:
            log.exception("GreenhouseFiller crashed")
            return ApplyResult(status="failed", error_message=str(exc))

    async def _fill_basic_fields(self) -> None:
        p = self.profile
        for sel, val in [
            ("#first_name", p.get("firstName", "")),
            ("#last_name",  p.get("lastName",  "")),
            ("#email",      p.get("email",     "")),
        ]:
            if val:
                await _human_fill(self.page, sel, val)
        phone_digits = (p.get("phone", "")
                        .replace("+1", "").replace(" ", "")
                        .replace("-", "").replace("(", "").replace(")", "").strip())
        if phone_digits:
            await _human_fill(self.page, "#phone", phone_digits)
        await self._screenshot("basic_fields")

    async def _fill_location(self) -> None:
        location = self.profile.get("location", "")
        if not location:
            return
        # Try the candidate-location typeahead React Select first
        city = location.split(",")[0].strip()
        result = await _typeahead_select(self.page, "candidate-location", city, city)
        log.info("Location selected: %s", result)

    async def _fill_phone_and_country(self) -> None:
        # 1. iti phone flag picker (+1 country code)
        opened = await self.page.evaluate("""
            () => {
                const flag = document.querySelector('.iti__flag-container, [class*="iti__selected"]');
                if (flag) { flag.click(); return 'clicked:' + flag.className; }
                return null;
            }
        """)
        await self.page.wait_for_timeout(700)
        if opened:
            await self.page.evaluate("""
                () => {
                    const s = document.getElementById('iti-0__search-input');
                    if (s) { s.value='United States'; s.dispatchEvent(new Event('input',{bubbles:true})); }
                }
            """)
            await self.page.wait_for_timeout(500)
            await self.page.evaluate("""
                () => {
                    const el = document.getElementById('iti-0__item-us');
                    if (el) { el.click(); return true; }
                    const fb = document.querySelector('li[data-country-code="us"]');
                    if (fb) { fb.click(); return true; }
                }
            """)
            await self.page.wait_for_timeout(400)

        # 2. Country of residence React Select (separate from iti)
        country_field = await self.page.locator("#country").count()
        if country_field > 0:
            haspopup = await self.page.locator("#country").first.get_attribute("aria-haspopup")
            if haspopup == "true":
                await _react_select(self.page, "country", "United States")

        await self._screenshot("country_phone")

    async def _fill_linkedin(self) -> None:
        linkedin = self.profile.get("linkedin") or ""
        # Try common Greenhouse LinkedIn field IDs
        for field_id in ["question_linkedin_profile_url", "question_linkedin"]:
            count = await self.page.locator(f"#{field_id}").count()
            if count:
                await _human_fill(self.page, f"#{field_id}", linkedin)
                return
        # Fallback: find any visible text input whose label mentions linkedin
        # (Greenhouse dynamically assigns IDs like question_NNNNN)
        linkedin_inp = self.page.locator(
            'input[id*="linkedin"], input[placeholder*="linkedin" i], '
            'input[aria-label*="linkedin" i]'
        ).first
        if await linkedin_inp.count() > 0 and linkedin:
            await linkedin_inp.scroll_into_view_if_needed()
            await linkedin_inp.fill(linkedin)

    async def _fill_screening_questions(self) -> None:
        """
        Find all visible React Select screening question inputs and answer them.
        Questions with free-text inputs (Python years, etc.) are answered with AI.
        """
        # React Select screening questions: aria-haspopup=true inputs with question_ IDs
        react_inputs = self.page.locator(
            'input[aria-haspopup="true"][id^="question_"]'
        )
        count = await react_inputs.count()
        for i in range(count):
            inp = react_inputs.nth(i)
            field_id = await inp.get_attribute("id") or ""
            # Get the label for this field
            label_el = self.page.locator(f'label[for="{field_id}"]').first
            label_text = ""
            if await label_el.count() > 0:
                label_text = (await label_el.inner_text()).strip()
            answer = _ai_answer(label_text, self.profile) if label_text else "Yes"
            await _react_select(self.page, field_id, answer)
            await self.page.wait_for_timeout(200)

        # Free-text question inputs
        text_inputs = self.page.locator(
            'input[type="text"][id^="question_"]:not([aria-haspopup])'
        )
        t_count = await text_inputs.count()
        for i in range(t_count):
            inp = text_inputs.nth(i)
            field_id = await inp.get_attribute("id") or ""
            existing_val = await inp.input_value()
            if existing_val:
                continue
            label_el = self.page.locator(f'label[for="{field_id}"]').first
            label_text = ""
            if await label_el.count() > 0:
                label_text = (await label_el.inner_text()).strip()
            answer = _ai_answer(label_text, self.profile) if label_text else ""
            if answer:
                await inp.scroll_into_view_if_needed()
                await inp.fill(answer)
                await self.page.wait_for_timeout(200)

        await self._screenshot("screening")

    async def _upload_files(self) -> None:
        # Resume — first file input
        try:
            await self.page.locator("input[type=file]").first.set_input_files(str(self.resume_path))
            await self.page.wait_for_timeout(1500)
        except Exception as exc:
            log.warning("Resume upload failed: %s", exc)

        # Cover letter — #cover_letter if present
        cover_inp = self.page.locator("#cover_letter").first
        if await cover_inp.count() > 0:
            try:
                await cover_inp.set_input_files(str(self.cover_letter_path))
                await self.page.wait_for_timeout(1500)
            except Exception as exc:
                log.warning("Cover letter upload failed: %s", exc)

        await self._screenshot("files")

    async def _fill_eeo(self) -> None:
        p = self.profile.get("eeo", {})
        eeo_map = {
            "gender":             _eeo_needle("gender",   p.get("gender", "")),
            "hispanic_ethnicity": _eeo_needle("ethnicity", p.get("ethnicity", "")),
            "veteran_status":     _eeo_needle("veteran",   p.get("veteran", "")),
            "disability_status":  _eeo_needle("disability", p.get("disability", "")),
        }
        for field_id, needle in eeo_map.items():
            count = await self.page.locator(f"#{field_id}").count()
            if count and needle:
                await _react_select(self.page, field_id, needle)
        await self._screenshot("eeo")

    async def _solve_captcha(self) -> str | None:
        html = await self.page.content()
        if "g-recaptcha" not in html:
            return None
        # Extract sitekey from iframes (invisible reCAPTCHA doesn't use data-sitekey in DOM)
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
            log.warning("reCAPTCHA detected but sitekey not found")
            return None
        log.info("Solving reCAPTCHA sitekey=%s", site_key[:20])
        return await _capsolver_solve(site_key, self.page.url)

    async def _submit(self, captcha_token: str | None) -> ApplyResult:
        if captcha_token:
            cb_result = await _inject_and_trigger_captcha(self.page, captcha_token)
            log.info("reCAPTCHA callback result: %s", cb_result)
            await self.page.wait_for_timeout(1000)

        # Find submit button
        btn = None
        for sel in ["button[type=submit]", "#submit_app",
                    "button:has-text('Submit Application')", "button:has-text('Submit')"]:
            loc = self.page.locator(sel).first
            if await loc.count() > 0:
                btn = loc
                break
        if not btn:
            return ApplyResult(status="failed", error_message="No submit button found")

        await btn.scroll_into_view_if_needed()
        await self.page.wait_for_timeout(600)
        await btn.click()
        await self.page.wait_for_timeout(3000)

        # Capture validation errors
        errors = await self.page.evaluate("""
            () => {
                const errs = [...document.querySelectorAll(
                    '[aria-invalid=true], [id$=-error], [class*="field-error"]'
                )];
                return errs.filter(e => e.innerText?.trim())
                           .map(e => e.id + ': ' + e.innerText.trim().slice(0, 80));
            }
        """)
        if errors:
            ss = await self._screenshot("submit_errors")
            return ApplyResult(
                status="failed",
                error_message=f"Validation errors: {errors[:5]}",
                screenshot_url=ss,
                blocker_fields=errors[:5],
            )

        try:
            await self.page.wait_for_load_state("networkidle", timeout=20000)
        except Exception:
            pass

        ss = await self._screenshot("post_submit")
        text = (await self.page.inner_text("body")).lower()
        success = any(m in text for m in SUCCESS_PATTERNS) or "confirmation" in self.page.url
        if success:
            return ApplyResult(status="applied", screenshot_url=ss)
        return ApplyResult(
            status="failed",
            error_message=f"No success pattern found. URL: {self.page.url}",
            screenshot_url=ss,
        )


def _eeo_needle(field: str, value: str) -> str:
    """Map a profile EEO value to a Greenhouse option needle."""
    v = (value or "").lower()
    if "prefer" in v or "decline" in v or "not" in v or v == "":
        mapping = {
            "gender":     "decline",
            "ethnicity":  "decline",
            "veteran":    "not a protected",
            "disability": "no, i",
        }
        return mapping.get(field, "decline")
    if "male" in v:
        return "male"
    if "female" in v or "woman" in v:
        return "female"
    if "hispanic" in v or "latino" in v:
        return "yes"
    if "no" == v:
        mapping = {
            "veteran":    "not a protected",
            "disability": "no, i",
        }
        return mapping.get(field, "no")
    if "yes" == v:
        return "yes"
    return v or "decline"
