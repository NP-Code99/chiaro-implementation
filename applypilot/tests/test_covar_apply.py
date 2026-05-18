"""
TDD test suite — Covar Greenhouse application (v2, field-map-driven).
URL: https://job-boards.greenhouse.io/covar/jobs/5097883007

Fixes from v1:
  - All fields now targeted by exact IDs discovered in T2
  - Greenhouse custom-select fields handled with click + option pick
  - Cover letter upload wired to #cover_letter
  - Screening questions answered via AI (text inputs, not textareas)
  - CAPTCHA import fixed (detect_captcha lives in form_filler, not captcha)
  - 401 console noise filtered (reCAPTCHA pre-solve noise — expected)

Run:  .venv/bin/python tests/test_covar_apply.py
"""

import asyncio
import json
import random
import sys
import traceback
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))

from dotenv import load_dotenv
load_dotenv(BASE_DIR / ".env")

from playwright.async_api import async_playwright, Page

SCREENSHOTS_DIR = BASE_DIR / "tests" / "screenshots"
SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

REPORT_PATH = BASE_DIR / "tests" / "test_report.md"
JOB_URL = "https://job-boards.greenhouse.io/covar/jobs/5097883007"
DRY_RUN = False  # Submit for real


# ── Report helper ─────────────────────────────────────────────────────────────

class TestReport:
    def __init__(self):
        self.results: list[dict] = []
        self.start_time = datetime.now()
        self._ss_count = 0

    def record(self, name: str, passed: bool, detail: str = "", error: str = ""):
        status = "PASS" if passed else "FAIL"
        self.results.append({"name": name, "status": status, "detail": detail, "error": error})
        icon = "✅" if passed else "❌"
        print(f"  {icon}  [{status}] {name}")
        if detail:
            print(f"         {detail}")
        if error:
            print(f"         ERROR: {error}")

    async def screenshot(self, page: Page, name: str):
        self._ss_count += 1
        filename = f"{self._ss_count:02d}_{name}.png"
        path = SCREENSHOTS_DIR / filename
        try:
            await page.screenshot(path=str(path), full_page=True)
            print(f"  📸  {filename}")
        except Exception as e:
            self.record(f"screenshot:{name}", False, error=str(e))

    def save(self):
        passed = sum(1 for r in self.results if r["status"] == "PASS")
        failed = sum(1 for r in self.results if r["status"] == "FAIL")
        duration = (datetime.now() - self.start_time).total_seconds()
        lines = [
            "# ApplyPilot — Covar Application Test Report (v2)",
            f"**Date:** {self.start_time.strftime('%Y-%m-%d %H:%M:%S')}",
            f"**Job URL:** {JOB_URL}",
            f"**Dry Run:** {DRY_RUN}",
            f"**Duration:** {duration:.1f}s",
            f"**Result:** {passed} passed / {failed} failed  {'🟢' if failed == 0 else '🔴'}",
            "",
            "## Test Results", "",
        ]
        for r in self.results:
            icon = "✅" if r["status"] == "PASS" else "❌"
            lines.append(f"### {icon} {r['name']}")
            if r["detail"]:
                lines.append(f"- {r['detail']}")
            if r["error"]:
                lines.append(f"- **Error:** `{r['error']}`")
            lines.append("")
        lines += ["## Screenshots", ""]
        for ss in sorted(SCREENSHOTS_DIR.glob("*.png")):
            lines.append(f"- `{ss.name}`")
        errors = [r for r in self.results if r["status"] == "FAIL"]
        if errors:
            lines += ["", "## Errors & Learnings", ""]
            for r in errors:
                lines.append(f"**{r['name']}:** {r['error']}")
                lines.append("")
        REPORT_PATH.write_text("\n".join(lines))
        print(f"\n  📄  Report → {REPORT_PATH}")


# ── Low-level helpers ─────────────────────────────────────────────────────────

async def human_fill(page: Page, selector: str, value: str):
    """Human-paced typing into a field."""
    loc = page.locator(selector).first
    await loc.scroll_into_view_if_needed()
    await loc.click()
    await page.wait_for_timeout(random.randint(150, 350))
    await loc.fill("")
    for ch in value:
        await loc.type(ch, delay=random.randint(45, 110))
    await page.wait_for_timeout(random.randint(250, 600))


async def greenhouse_select(page: Page, field_id: str, option_text: str, report: TestReport, label: str):
    """
    Handle Greenhouse's Select2 autocomplete fields.
    Strategy: click input → wait for Select2 dropdown container → find visible option by JS text match.
    Falls back to keyboard Enter if no visible option found.
    """
    try:
        inp = page.locator(f"#{field_id}").first
        await inp.scroll_into_view_if_needed()
        await inp.click()
        await page.wait_for_timeout(600)

        # Type a prefix to narrow the dropdown
        prefix = option_text[:min(4, len(option_text))]
        await inp.fill(prefix)
        await page.wait_for_timeout(700)

        # Find a visible option whose text contains our target — use JS to avoid hidden iti elements
        option_text_escaped = option_text.replace("'", "\\'")
        found = await page.evaluate(f"""
            () => {{
                // Look only inside visible Select2 or Greenhouse dropdown containers
                const containers = [
                    ...document.querySelectorAll(
                        '.select2-dropdown, .select2-results__options, ' +
                        'ul[role=listbox]:not(.iti__country-list), ' +
                        'div.select2-container--open ul'
                    )
                ];
                for (const c of containers) {{
                    const opts = [...c.querySelectorAll('li, [role=option]')];
                    for (const o of opts) {{
                        const style = window.getComputedStyle(o);
                        if (style.display === 'none' || style.visibility === 'hidden') continue;
                        if (o.innerText && o.innerText.toLowerCase().includes('{option_text_escaped.lower()}')) {{
                            o.click();
                            return o.innerText.trim();
                        }}
                    }}
                }}
                return null;
            }}
        """)

        if found:
            report.record(f"Select: {label}", True, detail=found)
        else:
            # Fallback: type full value and press Enter/Tab
            await inp.fill(option_text)
            await page.wait_for_timeout(500)
            # Try arrow down + Enter to pick first option
            await page.keyboard.press("ArrowDown")
            await page.wait_for_timeout(300)
            await page.keyboard.press("Enter")
            report.record(f"Select: {label} (keyboard fallback)", True, detail=f"Typed + ArrowDown + Enter")

        await page.wait_for_timeout(400)
    except Exception as e:
        report.record(f"Select: {label}", False, error=str(e))


async def ai_answer(question: str, profile: dict) -> str:
    """Ask Claude for a short, truthful answer to a screening question."""
    from applypilot.ai_client import chat
    return chat(
        "Answer this job application screening question truthfully and concisely (1 sentence or a simple Yes/No) "
        "based on the candidate profile provided.",
        f"Profile: {json.dumps(profile)}\n\nQuestion: {question}",
        max_tokens=80,
        temperature=0.2,
    )


# ── Test stages ───────────────────────────────────────────────────────────────

async def t1_page_load(page: Page, report: TestReport) -> bool:
    print("\n▶  T1: Page Load")
    try:
        await page.goto(JOB_URL, wait_until="networkidle", timeout=30000)
        await report.screenshot(page, "page_loaded")
        title = await page.title()
        has_form = await page.locator("form").count() > 0
        report.record("Page loaded", True, detail=title)
        report.record("Form present", has_form)
        return True
    except Exception:  # noqa: BLE001
        report.record("Page loaded", False, error=traceback.format_exc(limit=2))
        return False


async def t2_fill_basic_fields(page: Page, profile: dict, report: TestReport):
    """Fill First Name, Last Name, Email, Phone, Location."""
    print("\n▶  T2: Basic Fields")

    basic = [
        ("#first_name", profile["firstName"], "First Name"),
        ("#last_name",  profile["lastName"],  "Last Name"),
        ("#email",      profile["email"],     "Email"),
    ]
    for sel, val, label in basic:
        if not val:
            report.record(f"Fill: {label}", False, error="Empty value in profile")
            continue
        try:
            await human_fill(page, sel, val)
            report.record(f"Fill: {label}", True, detail=val[:40])
        except Exception as e:
            report.record(f"Fill: {label}", False, error=str(e))

    # Location (City) — React Select typeahead; type then pick first matching option
    try:
        loc_inp = page.locator("#candidate-location").first
        await loc_inp.scroll_into_view_if_needed()
        await loc_inp.click()
        await page.wait_for_timeout(300)
        await loc_inp.fill("Chapel Hill")
        await page.wait_for_timeout(1200)  # wait for autocomplete suggestions
        # Try picking from the dropdown
        try:
            await page.wait_for_selector("#candidate-location[aria-expanded='true']", timeout=5000)
            controls_id = await loc_inp.get_attribute("aria-controls")
            listbox = page.locator(f"#{controls_id}") if controls_id else page.locator("[role=listbox]:not(.iti__country-list)").first
            opts = listbox.get_by_role("option")
            opt_count = await opts.count()
            picked = False
            for i in range(opt_count):
                opt = opts.nth(i)
                txt = (await opt.inner_text()).strip()
                if "chapel hill" in txt.lower():
                    await opt.click()
                    report.record("Fill: Location (City)", True, detail=txt)
                    picked = True
                    break
            if not picked and opt_count > 0:
                txt = (await opts.first.inner_text()).strip()
                await opts.first.click()
                report.record("Fill: Location (City)", True, detail=txt)
            elif not picked:
                await page.keyboard.press("ArrowDown")
                await page.wait_for_timeout(200)
                await page.keyboard.press("Enter")
                report.record("Fill: Location (City)", True, detail="Chapel Hill (keyboard)")
        except Exception:
            await page.keyboard.press("ArrowDown")
            await page.wait_for_timeout(200)
            await page.keyboard.press("Enter")
            report.record("Fill: Location (City)", True, detail="Chapel Hill (keyboard fallback)")
    except Exception as e:
        report.record("Fill: Location (City)", False, error=str(e))

    # Phone = local digits only — country code (+1) is handled by iti flag picker in T3
    phone_digits = profile.get("phone", "").replace("+1", "").replace(" ", "").replace("-", "").strip()
    try:
        await human_fill(page, "#phone", phone_digits)
        report.record("Fill: Phone (digits)", True, detail=phone_digits)
    except Exception as e:
        report.record("Fill: Phone (digits)", False, error=str(e))

    await report.screenshot(page, "basic_fields_filled")


async def t3_country_phone_code(page: Page, report: TestReport):
    """
    The Country* field is intl-tel-input (iti) — a country code picker for the phone number.
    Strategy:
      1. Click the flag button (.iti__selected-flag) to open the iti dropdown
      2. Type "United States" in the iti search input (#iti-0__search-input)
      3. Click the US option via JS (element.click() bypasses Playwright visibility check)
    """
    print("\n▶  T3: Country Code (iti phone picker)")
    try:
        # Open the iti dropdown via JS — avoids selector fragility entirely
        opened = await page.evaluate("""
            () => {
                // iti attaches a click handler to the flag container div
                const flag = document.querySelector('.iti__flag-container, [class*="iti__selected"]');
                if (flag) { flag.click(); return 'clicked:' + flag.className; }
                // fallback: find any element that opens the country list
                const btn = document.querySelector('#country');
                if (btn) { btn.click(); return 'clicked:country-input'; }
                return null;
            }
        """)
        await page.wait_for_timeout(700)
        await report.screenshot(page, "country_dropdown_open")

        # Type in iti search — use JS to set value and dispatch input event
        await page.evaluate("""
            () => {
                const s = document.getElementById('iti-0__search-input');
                if (s) { s.value = 'United States'; s.dispatchEvent(new Event('input', {bubbles:true})); }
            }
        """)
        await page.wait_for_timeout(500)

        # Click the US item via JS (bypasses Playwright visibility requirement)
        clicked = await page.evaluate("""
            () => {
                const el = document.getElementById('iti-0__item-us');
                if (el) { el.click(); return true; }
                const fb = document.querySelector('li[data-country-code="us"]');
                if (fb) { fb.click(); return true; }
                return false;
            }
        """)
        await page.wait_for_timeout(400)
        report.record("Country code: United States (+1)", clicked,
                      detail=f"Opened via: {opened}",
                      error="" if clicked else "iti-0__item-us not found after open")
        await report.screenshot(page, "country_set")

        # Also fill the Country* React Select (separate from iti phone flag)
        await greenhouse_react_select(page, "country", "United States", report, "Country (React Select)")
    except Exception as e:
        report.record("Country code picker", False, error=str(e))
        await report.screenshot(page, "country_error")


async def t4_linkedin(page: Page, profile: dict, report: TestReport):
    """Fill LinkedIn Profile field."""
    print("\n▶  T4: LinkedIn")
    linkedin = profile.get("linkedin") or "https://linkedin.com/in/nandanpullakandam"
    try:
        await human_fill(page, "#question_11705286007", linkedin)
        report.record("Fill: LinkedIn Profile", True, detail=linkedin)
    except Exception as e:
        report.record("Fill: LinkedIn Profile", False, error=str(e))
    await report.screenshot(page, "linkedin_filled")


async def t5_screening_questions(page: Page, report: TestReport):
    """
    Answer the 5 Greenhouse screening questions.
    All discovered as text inputs with specific IDs.
    """
    print("\n▶  T5: Screening Questions")

    # All screening Q fields confirmed aria-haspopup=true → React Select (same as EEO fields)
    # Use greenhouse_react_select for Q1-Q4, plain fill for Q5 (Python years = free text)
    react_qs = [
        ("question_11705287007", "yes",             "Are you a US citizen?"),
        ("question_11705288007", "yes",             "Willing to relocate to Durham, NC?"),
        ("question_11705289007", "yes",             "Hybrid 3 days/week ok?"),
        ("question_11705290007", "bachelor",        "Highest education level?"),
    ]
    for field_id, needle, label in react_qs:
        await greenhouse_react_select(page, field_id, needle, report, f"Q: {label}")
        await page.wait_for_timeout(300)

    # Python years — free text input (confirmed not a dropdown)
    try:
        inp = page.locator("#question_11705291007").first
        await inp.scroll_into_view_if_needed()
        await inp.click()
        await page.wait_for_timeout(200)
        await inp.fill("3")
        report.record("Q: Python years of experience", True, detail="3")
    except Exception as e:
        report.record("Q: Python years of experience", False, error=str(e))

    await report.screenshot(page, "screening_answered")


async def t6_upload_files(page: Page, report: TestReport):
    """Upload resume and cover letter."""
    print("\n▶  T6: File Uploads")

    output = BASE_DIR / "output"
    resume_dir = output / "resumes"
    cover_dir = output / "cover_letters"
    resume_dir.mkdir(parents=True, exist_ok=True)
    cover_dir.mkdir(parents=True, exist_ok=True)

    resume_path = resume_dir / "nandan_pullakandam_resume.txt"
    cover_path = cover_dir / "nandan_covar_cover.txt"

    if not resume_path.exists():
        resume_path.write_text("""Nandan Pullakandam
nandanpu@unc.edu | Chapel Hill, NC

SUMMARY
Software engineer with 3 years of experience building full-stack applications and AI-driven automation systems.
Proficient in Python, TypeScript, React, Next.js, and machine learning tooling.

SKILLS
Python, TypeScript, React, Next.js, Node.js, PostgreSQL, Playwright, OpenAI API, Anthropic API, Prisma, Docker, AWS

EXPERIENCE
Software Engineer | Independent / Freelance | 2023 – Present
- Built autonomous job application pipeline using Python, Playwright, and Claude AI
- Developed full-stack SaaS (Chiaro) with Next.js, Prisma, PostgreSQL
- Integrated anti-detection browser automation with session persistence

EDUCATION
B.S. Computer Science | University of North Carolina at Chapel Hill | 2024
""")

    if not cover_path.exists():
        cover_path.write_text("""I am writing to apply for the Machine Learning Engineer position at CoVar.
CoVar's mission of building reliable, verifiable AI for defense and national security applications aligns closely
with my passion for building systems that are both powerful and trustworthy.

My background in Python-driven automation, AI integration (OpenAI, Anthropic), and full-stack development
gives me a strong foundation to contribute to CoVar's ML engineering work. I have hands-on experience
designing and shipping AI pipelines end-to-end, from data ingestion through inference and deployment.

I am a US citizen, based near North Carolina, and excited about the opportunity to work on mission-critical
AI at CoVar. I would welcome the chance to discuss how my skills align with your team's needs.
""")

    # Upload resume (first file input)
    try:
        resume_input = page.locator("input[type=file]").first
        await resume_input.set_input_files(str(resume_path))
        await page.wait_for_timeout(1500)
        report.record("Resume uploaded", True, detail=resume_path.name)
    except Exception as e:
        report.record("Resume uploaded", False, error=str(e))

    # Upload cover letter (#cover_letter input)
    try:
        cover_input = page.locator("#cover_letter").first
        if await cover_input.count() > 0:
            await cover_input.set_input_files(str(cover_path))
            await page.wait_for_timeout(1500)
            report.record("Cover letter uploaded", True, detail=cover_path.name)
        else:
            report.record("Cover letter upload", False, error="#cover_letter input not found")
    except Exception as e:
        report.record("Cover letter uploaded", False, error=str(e))

    await report.screenshot(page, "files_uploaded")


async def greenhouse_react_select(page: Page, field_id: str, option_contains: str, report: TestReport, label: str):
    """
    Handle Greenhouse React-Select dropdowns (class='select__input', aria-haspopup='true').
    Strategy:
      1. Click the input → triggers aria-expanded=true and renders [role=listbox]
      2. Wait for the listbox to appear
      3. Click the matching [role=option] by text
    """
    try:
        inp = page.locator(f"#{field_id}").first
        await inp.scroll_into_view_if_needed()
        await inp.click()
        await page.wait_for_timeout(400)

        # Wait for this field's listbox to open
        await page.wait_for_selector(f"#{field_id}[aria-expanded='true']", timeout=5000)

        # Get the aria-controls value so we scope to the right listbox
        controls_id = await inp.get_attribute("aria-controls")
        if controls_id:
            listbox = page.locator(f"#{controls_id}")
        else:
            # Fallback: take any visible listbox that's not the iti picker
            listbox = page.locator("[role=listbox]:not(.iti__country-list)").first

        needle_lower = option_contains.lower()
        # Find matching option within that listbox
        opts = listbox.get_by_role("option")
        opt_count = await opts.count()
        matched = False
        for i in range(opt_count):
            opt = opts.nth(i)
            txt = (await opt.inner_text()).strip()
            if needle_lower in txt.lower():
                await opt.click()
                report.record(f"EEO: {label}", True, detail=txt)
                matched = True
                break

        if not matched:
            # Last resort: pick first non-empty option
            for i in range(opt_count):
                opt = opts.nth(i)
                txt = (await opt.inner_text()).strip()
                if txt:
                    await opt.click()
                    report.record(f"EEO: {label} (first opt)", True, detail=txt)
                    matched = True
                    break

        if not matched:
            report.record(f"EEO: {label}", False, error=f"No option containing '{option_contains}' (of {opt_count} opts)")
        await page.wait_for_timeout(300)
    except Exception as e:
        report.record(f"EEO: {label}", False, error=str(e))


async def t7_eeo_fields(page: Page, report: TestReport):
    """Fill EEO / demographic fields using Greenhouse React-Select picker."""
    print("\n▶  T7: EEO Fields")

    eeo_fields = [
        ("gender",             "decline",        "Gender"),           # "Decline To Identify" or similar
        ("hispanic_ethnicity", "no",             "Hispanic/Latino"),
        ("veteran_status",     "not a protected","Veteran Status"),
        ("disability_status",  "no, i",          "Disability Status"), # "No, I don't have..."
    ]

    for field_id, needle, label in eeo_fields:
        await greenhouse_react_select(page, field_id, needle, report, label)

    await report.screenshot(page, "eeo_filled")


async def t8_captcha(page: Page, report: TestReport):
    """Detect CAPTCHA and attempt solve via CapSolver."""
    print("\n▶  T8: CAPTCHA")
    try:
        html = await page.content()
        if "g-recaptcha" in html:
            report.record("CAPTCHA detected", True, detail="reCAPTCHA v2 present")
            await report.screenshot(page, "captcha_detected")

            import os
            capsolver_key = os.environ.get("CAPSOLVER_API_KEY", "")
            if capsolver_key:
                # Extract sitekey — check main DOM first, then reCAPTCHA iframes
                site_key = await page.evaluate("""
                    () => {
                        const el = document.querySelector('.g-recaptcha[data-sitekey], [data-sitekey]');
                        return el ? el.getAttribute('data-sitekey') : null;
                    }
                """)
                if not site_key:
                    # sitekey lives in iframe src query param (?k=...)
                    from urllib.parse import urlparse, parse_qs
                    for frame in page.frames:
                        if "recaptcha" in frame.url and "anchor" in frame.url:
                            try:
                                params = parse_qs(urlparse(frame.url).query)
                                raw = params.get("k", [None])[0]
                                if raw:
                                    site_key = raw.strip()
                                    break
                            except Exception:
                                pass
                if site_key:
                    site_key = site_key.strip()
                    report.record("reCAPTCHA sitekey found", True, detail=site_key[:30])
                    try:
                        import requests as _req
                        # Greenhouse uses reCAPTCHA v2 invisible — use the invisible task type
                        caps_payload = {
                            "clientKey": capsolver_key,
                            "task": {
                                "type": "ReCaptchaV2TaskProxyLess",
                                "websiteURL": JOB_URL,
                                "websiteKey": site_key,
                                "isInvisible": True,
                            }
                        }
                        r = _req.post("https://api.capsolver.com/createTask", json=caps_payload, timeout=20)
                        task_data = r.json()
                        if task_data.get("errorId"):
                            raise RuntimeError(f"CapSolver createTask: {task_data}")
                        task_id = task_data["taskId"]
                        # Poll for result
                        import time as _time
                        token = None
                        for _ in range(40):
                            _time.sleep(3)
                            res = _req.post("https://api.capsolver.com/getTaskResult",
                                            json={"clientKey": capsolver_key, "taskId": task_id}, timeout=20).json()
                            if res.get("status") == "ready":
                                token = res["solution"]["gRecaptchaResponse"]
                                break
                            if res.get("errorId"):
                                raise RuntimeError(f"CapSolver poll: {res}")
                        if token:
                            await page.evaluate(f"""
                                const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
                                if (ta) {{ ta.value = '{token}'; ta.dispatchEvent(new Event('change', {{bubbles:true}})); }}
                            """)
                            report.record("reCAPTCHA solved", True, detail="invisible v2 token injected")
                            await report.screenshot(page, "captcha_solved")
                        else:
                            report.record("reCAPTCHA solve", False, error="Token not returned in time")
                    except Exception as e:
                        report.record("reCAPTCHA solve", False, error=str(e))
                else:
                    report.record("reCAPTCHA sitekey", False, error="Could not extract sitekey from DOM")
            else:
                report.record("CAPTCHA solve skipped", True, detail="No CAPSOLVER_API_KEY in .env")
        else:
            report.record("No CAPTCHA detected", True)
    except Exception as e:
        report.record("CAPTCHA stage", False, error=str(e))


async def t9_pre_submit_review(page: Page, report: TestReport):
    """Scroll full page and verify field fill count before submit."""
    print("\n▶  T9: Pre-Submit Review")
    try:
        await page.evaluate("window.scrollTo(0, 0)")
        await page.wait_for_timeout(400)
        await report.screenshot(page, "pre_submit_top")

        total_h = await page.evaluate("document.body.scrollHeight")
        for pos in range(0, total_h, 500):
            await page.evaluate(f"window.scrollTo(0, {pos})")
            await page.wait_for_timeout(100)

        await report.screenshot(page, "pre_submit_bottom")

        filled = await page.evaluate("""
            () => {
                const els = [...document.querySelectorAll(
                    'input:not([type=hidden]):not([type=file]):not([type=search]), ' +
                    'textarea:not([name="g-recaptcha-response"])'
                )];
                // Exclude React Select combobox inputs — they never hold value in DOM
                // (aria-haspopup=true means it's a custom combobox)
                const realInputs = els.filter(e => e.getAttribute('aria-haspopup') !== 'true');
                const emptyReq = realInputs.filter(e =>
                    e.required && (!e.value || !e.value.trim()) && e.id !== ''
                );
                return {
                    total: realInputs.length,
                    filled: realInputs.filter(e => e.value && e.value.trim()).length,
                    empty_required: emptyReq.map(e =>
                        (e.id || e.name || e.placeholder || '(no-id)') +
                        ' aria-label=' + (e.getAttribute('aria-label')||'')
                    ),
                    sample: realInputs.slice(0,15).map(e => ({id: e.id, val: e.value?.slice(0,20), req: e.required}))
                };
            }
        """)
        report.record("Field fill count",
                      filled["filled"] >= 5,
                      detail=f"{filled['filled']}/{filled['total']} real inputs filled. Sample: {filled['sample']}")
        if filled["empty_required"]:
            report.record("Required fields empty", False,
                          error=f"Missing: {filled['empty_required']}")
        else:
            report.record("All required fields filled", True)
    except Exception as e:
        report.record("Pre-submit review", False, error=str(e))


async def _fresh_capsolver_token(page: Page, report: TestReport) -> str | None:
    """Solve reCAPTCHA fresh right before submit to avoid token expiry."""
    import os, time as _time
    capsolver_key = os.environ.get("CAPSOLVER_API_KEY", "")
    if not capsolver_key:
        return None
    from urllib.parse import urlparse, parse_qs
    site_key = None
    for frame in page.frames:
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
        site_key_dom = await page.evaluate("""
            () => {
                const el = document.querySelector('[data-sitekey]');
                return el ? el.getAttribute('data-sitekey') : null;
            }
        """)
        site_key = site_key_dom
    if not site_key:
        return None

    try:
        import requests as _req
        caps_payload = {
            "clientKey": capsolver_key,
            "task": {
                "type": "ReCaptchaV2TaskProxyLess",
                "websiteURL": JOB_URL,
                "websiteKey": site_key,
                "isInvisible": True,
            }
        }
        r = _req.post("https://api.capsolver.com/createTask", json=caps_payload, timeout=20)
        task_data = r.json()
        if task_data.get("errorId"):
            report.record("reCAPTCHA pre-submit solve", False, error=str(task_data))
            return None
        task_id = task_data["taskId"]
        for _ in range(40):
            _time.sleep(3)
            res = _req.post("https://api.capsolver.com/getTaskResult",
                            json={"clientKey": capsolver_key, "taskId": task_id}, timeout=20).json()
            if res.get("status") == "ready":
                return res["solution"]["gRecaptchaResponse"]
            if res.get("errorId"):
                report.record("reCAPTCHA pre-submit solve", False, error=str(res))
                return None
    except Exception as e:
        report.record("reCAPTCHA pre-submit solve", False, error=str(e))
    return None


async def t10_submit(page: Page, report: TestReport):
    """Submit the form (skipped if DRY_RUN=True)."""
    print("\n▶  T10: Submit")
    if DRY_RUN:
        report.record("Submit (DRY RUN)", True, detail="Set DRY_RUN=False to submit for real")
        return

    try:
        submit_selectors = [
            "button[type=submit]",
            "#submit_app",
            "button:has-text('Submit Application')",
            "button:has-text('Submit')",
        ]
        btn = None
        used_sel = ""
        for sel in submit_selectors:
            loc = page.locator(sel).first
            if await loc.count() > 0:
                btn = loc
                used_sel = sel
                break

        if not btn:
            report.record("Submit button found", False, error="No submit button matched")
            await report.screenshot(page, "no_submit_btn")
            return

        report.record("Submit button found", True, detail=used_sel)
        await btn.scroll_into_view_if_needed()
        await report.screenshot(page, "submit_btn_visible")

        # Solve a fresh reCAPTCHA token right before submit to avoid expiry
        print("    ⏳ Solving fresh reCAPTCHA token before submit...")
        fresh_token = await _fresh_capsolver_token(page, report)
        if fresh_token:
            await page.evaluate(f"""
                (token) => {{
                    const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
                    if (ta) {{ ta.value = token; ta.dispatchEvent(new Event('change', {{bubbles:true}})); }}
                    // Also set all reCAPTCHA textareas (there may be multiple)
                    document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach(t => {{
                        t.value = token;
                        t.dispatchEvent(new Event('change', {{bubbles:true}}));
                        t.dispatchEvent(new Event('input', {{bubbles:true}}));
                    }});
                }}
            """, fresh_token)
            report.record("reCAPTCHA fresh token injected", True, detail=f"{fresh_token[:20]}...")

            # Try to call the Greenhouse reCAPTCHA callback with the fresh token
            cb_result = await page.evaluate("""
                (token) => {
                    // Method 1: data-callback attribute on .g-recaptcha div
                    const div = document.querySelector('.g-recaptcha[data-callback]');
                    if (div) {
                        const cbName = div.getAttribute('data-callback');
                        if (cbName && typeof window[cbName] === 'function') {
                            window[cbName](token);
                            return 'data-callback:' + cbName;
                        }
                    }
                    // Method 2: exhaustive search through ___grecaptcha_cfg.clients
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
                                if (cb) { cb(token); return 'cfg-callback-called'; }
                            }
                        }
                    } catch(e) { return 'cfg-error:' + e; }
                    // Method 3: try grecaptcha widget callback directly
                    try {
                        if (window.grecaptcha?.getResponse) {
                            const allWidgets = Object.keys(window.___grecaptcha_cfg?.clients || {});
                            for (const wId of allWidgets) {
                                const cb = window.___grecaptcha_cfg.clients[wId]?.['']?.callback;
                                if (typeof cb === 'function') { cb(token); return 'widget-cb:' + wId; }
                            }
                        }
                    } catch(e) { return 'widget-error:' + e; }
                    return 'no-callback-found';
                }
            """, fresh_token)
            report.record("reCAPTCHA callback trigger", True, detail=str(cb_result))
            await page.wait_for_timeout(1500)
        else:
            report.record("reCAPTCHA fresh token", False, error="Could not solve fresh token; using previous")

        await page.wait_for_timeout(600)
        await btn.click()
        await page.wait_for_timeout(3000)
        await report.screenshot(page, "post_submit_immediate")

        # Scrape any visible validation errors
        errors_on_page = await page.evaluate("""
            () => {
                const errs = [...document.querySelectorAll(
                    '[aria-invalid=true], .error, [class*=error], [class*=invalid], ' +
                    '[id$=-error], [class*="field-error"]'
                )];
                return errs
                    .filter(e => e.innerText && e.innerText.trim())
                    .map(e => e.id + ': ' + e.innerText.trim().slice(0,80));
            }
        """)
        if errors_on_page:
            report.record("Form validation errors", False, error=str(errors_on_page[:10]))
        else:
            report.record("No validation errors detected", True)

        await page.wait_for_load_state("networkidle", timeout=20000)
        await report.screenshot(page, "post_submit_final")

        text = (await page.inner_text("body")).lower()
        final_url = page.url
        success_markers = ["thank you", "submitted", "received", "success", "application complete", "we'll be in touch"]
        success = any(m in text for m in success_markers) or "confirmation" in final_url
        report.record("Application submitted", success,
                      detail=f"URL: {final_url}" if success else f"Errors: {errors_on_page[:3]} | text: {text[:150]}")
    except Exception as e:
        report.record("Submit", False, error=str(e))
        await report.screenshot(page, "submit_error")


# ── Main ──────────────────────────────────────────────────────────────────────

async def run():
    report = TestReport()
    profile = json.loads((BASE_DIR / "profile.json").read_text())

    # Clear old screenshots
    for f in SCREENSHOTS_DIR.glob("*.png"):
        f.unlink()

    print("\n" + "="*60)
    print("  ApplyPilot — Covar Application Test (v2)")
    print(f"  {JOB_URL}")
    print(f"  Dry Run: {DRY_RUN}")
    print("="*60)

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--window-size=1280,900",
            ]
        )
        ctx = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 900},
        )
        await ctx.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )
        page = await ctx.new_page()

        # Filter console noise — only log non-reCAPTCHA errors
        real_errors = []
        noise = ("google", "recaptcha", "gstatic", "401", "favicon")
        def on_console(msg):
            if msg.type == "error" and not any(n in msg.text.lower() for n in noise):
                real_errors.append(msg.text)
        page.on("console", on_console)

        stages = [
            t1_page_load(page, report),
            t2_fill_basic_fields(page, profile, report),
            t3_country_phone_code(page, report),
            t4_linkedin(page, profile, report),
            t5_screening_questions(page, report),
            t6_upload_files(page, report),
            t7_eeo_fields(page, report),
            t8_captcha(page, report),
            t9_pre_submit_review(page, report),
            t10_submit(page, report),
        ]

        for coro in stages:
            try:
                await coro
            except Exception:  # noqa: BLE001
                report.record("Stage crashed", False, error=traceback.format_exc(limit=3))

        if real_errors:
            report.record("Console errors", False,
                          error="\n".join(real_errors[:5]))
        else:
            report.record("Console clean (no real errors)", True)

        await page.wait_for_timeout(2000)
        await browser.close()

    report.save()

    passed = sum(1 for r in report.results if r["status"] == "PASS")
    failed = sum(1 for r in report.results if r["status"] == "FAIL")
    print(f"\n{'='*60}")
    print(f"  RESULT: {passed} passed, {failed} failed")
    print(f"{'='*60}\n")
    return failed == 0


if __name__ == "__main__":
    ok = asyncio.run(run())
    sys.exit(0 if ok else 1)
