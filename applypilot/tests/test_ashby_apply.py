"""
Ashby-specific apply test suite.

Live URL: Linear on jobs.ashbyhq.com
    https://jobs.ashbyhq.com/linear/82778dbf-711e-4d23-9d49-4a60db76737a/application

Run modes:
    # Dry-run (default — no actual submission):
    DRY_RUN=1 .venv/bin/python -m pytest tests/test_ashby_apply.py -v

    # Live submission:
    DRY_RUN=0 .venv/bin/python -m pytest tests/test_ashby_apply.py -v -k live

Environment:
    CAPSOLVER_API_KEY — required for live captcha solve
    DRY_RUN           — "1" (default) or "0"
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from dotenv import load_dotenv

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))
load_dotenv(BASE_DIR / ".env")

from playwright.async_api import async_playwright

from applypilot.apply.engine import detect_board, run_apply

# ── Constants ─────────────────────────────────────────────────────────────────

ASHBY_URL = "https://jobs.ashbyhq.com/linear/82778dbf-711e-4d23-9d49-4a60db76737a/application"

DRY_RUN = os.environ.get("DRY_RUN", "1") != "0"

SCREENSHOTS = BASE_DIR / "tests" / "screenshots" / "ashby"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

SAMPLE_PROFILE = {
    "firstName": "Test",
    "lastName": "Candidate",
    "email": "test.candidate+ashby@example.com",
    "phone": "+1 (555) 000-1234",
    "location": "San Francisco, CA",
    "linkedin": "https://linkedin.com/in/testcandidate",
    "github": "https://github.com/testcandidate",
    "portfolio": "https://testcandidate.dev",
    "workAuth": "US Citizen",
    "yearsExp": "3-5",
    "desiredSalary": "150000",
    "bio": "Experienced software engineer with 4 years in backend development.",
    "resumeBase64": "",
    "resumeFilename": "test_resume.pdf",
}

SAMPLE_JOB = {
    "id": "ashby-linear-test",
    "applyUrl": ASHBY_URL,
    "title": "Software Engineer",
    "company": "Linear",
    "location": "Remote",
    "description": "Software engineering role at Linear.",
}


# ── Unit tests ────────────────────────────────────────────────────────────────

class TestAshbyBoardDetection:
    def test_ashbyhq_detected(self):
        assert detect_board(ASHBY_URL) == "ashby"

    def test_ashbyhq_variant(self):
        assert detect_board("https://jobs.ashbyhq.com/ramp/abc/application") == "ashby"

    def test_ashby_subdomain_variant(self):
        assert detect_board("https://hiring.ashby.io/some-company/job/abc") == "ashby"

    def test_greenhouse_not_ashby(self):
        assert detect_board("https://job-boards.greenhouse.io/acme/jobs/123") != "ashby"

    def test_lever_not_ashby(self):
        assert detect_board("https://jobs.lever.co/stripe/abc/apply") != "ashby"


# ── Integration tests (Playwright) ───────────────────────────────────────────

class TestAshbyPageLoad:
    """Verify Ashby form page loads and exposes expected DOM structure."""

    @pytest.mark.asyncio
    async def test_page_loads(self):
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(
                headless=True,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
            )
            ctx = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                ),
                viewport={"width": 1280, "height": 900},
            )
            page = await ctx.new_page()
            try:
                await page.goto(ASHBY_URL, wait_until="domcontentloaded", timeout=45000)
                await page.wait_for_timeout(3000)

                title = await page.title()
                assert title, "Page has no title"

                ss = SCREENSHOTS / "01_page_load.png"
                await page.screenshot(path=str(ss), full_page=True)
                print(f"\n  Screenshot → {ss}")
                print(f"  Title: {title}")
            finally:
                await browser.close()

    @pytest.mark.asyncio
    async def test_system_fields_present(self):
        """Confirm #_systemfield_name, #_systemfield_email, #_systemfield_resume exist."""
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
            ctx = await browser.new_context(viewport={"width": 1280, "height": 900})
            page = await ctx.new_page()
            try:
                await page.goto(ASHBY_URL, wait_until="domcontentloaded", timeout=45000)
                await page.wait_for_timeout(3000)

                for field_id in ["_systemfield_name", "_systemfield_email"]:
                    loc = page.locator(f"#{field_id}").first
                    assert await loc.count() > 0, f"#{field_id} not found on Ashby form"
                    print(f"\n  Found #{field_id}")

                # Resume — either system field or generic file input
                resume = page.locator("#_systemfield_resume, input[type=file]").first
                assert await resume.count() > 0, "No resume/file input found"
            finally:
                await browser.close()

    @pytest.mark.asyncio
    async def test_custom_fields_discoverable(self):
        """Dump all label+input pairs to verify UUID custom field structure."""
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
            ctx = await browser.new_context(viewport={"width": 1280, "height": 900})
            page = await ctx.new_page()
            try:
                await page.goto(ASHBY_URL, wait_until="domcontentloaded", timeout=45000)
                await page.wait_for_timeout(3000)

                fields = await page.evaluate("""
                    () => [...document.querySelectorAll('label[for]')].map(l => ({
                        label: l.innerText.trim().slice(0, 60),
                        for: l.getAttribute('for'),
                        tag: document.getElementById(l.getAttribute('for'))?.tagName?.toLowerCase() || 'missing',
                        type: document.getElementById(l.getAttribute('for'))?.type || '',
                    }))
                """)
                print(f"\n  Found {len(fields)} label[for] pairs:")
                for f in fields:
                    print(f'    [{f["tag"]:8}] for={f["for"][:40]:40} label="{f["label"]}"')

                assert len(fields) > 0, "No label[for] pairs found — Ashby DOM structure changed?"
            finally:
                await browser.close()

    @pytest.mark.asyncio
    async def test_submit_button_present(self):
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
            ctx = await browser.new_context(viewport={"width": 1280, "height": 900})
            page = await ctx.new_page()
            try:
                await page.goto(ASHBY_URL, wait_until="domcontentloaded", timeout=45000)
                await page.wait_for_timeout(3000)

                btn = page.locator("button[type=submit], button:has-text('Submit')").first
                assert await btn.count() > 0, "No submit button found on Ashby form"
                btn_text = await btn.inner_text()
                print(f"\n  Submit button text: '{btn_text}'")
            finally:
                await browser.close()


# ── Field-fill unit tests (no submission) ─────────────────────────────────────

class TestAshbyFieldFill:
    """Fill system fields and take a screenshot — verify no JS errors."""

    @pytest.mark.asyncio
    async def test_fill_name_and_email(self):
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
            ctx = await browser.new_context(viewport={"width": 1280, "height": 900})
            page = await ctx.new_page()
            try:
                await page.goto(ASHBY_URL, wait_until="domcontentloaded", timeout=45000)
                await page.wait_for_timeout(3000)

                # Fill name
                name_inp = page.locator("#_systemfield_name").first
                if await name_inp.count() > 0:
                    await name_inp.fill("Test Candidate")
                    await page.wait_for_timeout(300)

                # Fill email
                email_inp = page.locator("#_systemfield_email").first
                if await email_inp.count() > 0:
                    await email_inp.fill("test@example.com")
                    await page.wait_for_timeout(300)

                ss = SCREENSHOTS / "02_fields_filled.png"
                await page.screenshot(path=str(ss), full_page=True)
                print(f"\n  Screenshot → {ss}")

                # Verify values stuck
                if await name_inp.count() > 0:
                    val = await name_inp.input_value()
                    assert val == "Test Candidate", f"Name not set, got: {val}"
            finally:
                await browser.close()


# ── Dry-run engine test ───────────────────────────────────────────────────────

class TestAshbyDryRun:
    @pytest.mark.asyncio
    async def test_dry_run_completes(self):
        result = await run_apply(
            apply_url=ASHBY_URL,
            profile=SAMPLE_PROFILE,
            job=SAMPLE_JOB,
            dry_run=True,
            screenshot_dir=SCREENSHOTS / "dry_run",
        )
        print(f"\n  DryRun result: status={result.status} error={result.error_message}")
        assert result.status == "applied"
        assert result.error_message == "dry_run"


# ── Live submission (opt-in) ──────────────────────────────────────────────────

@pytest.mark.skipif(DRY_RUN, reason="Set DRY_RUN=0 to run live submission test")
class TestAshbyLiveSubmit:
    """Actually submits the form. Use a throwaway email."""

    @pytest.mark.asyncio
    async def test_live_apply(self):
        profile = {**SAMPLE_PROFILE, "email": os.environ.get("TEST_EMAIL", SAMPLE_PROFILE["email"])}
        result = await run_apply(
            apply_url=ASHBY_URL,
            profile=profile,
            job=SAMPLE_JOB,
            dry_run=False,
            screenshot_dir=SCREENSHOTS / "live",
        )
        print(f"\n  Live result: status={result.status} error={result.error_message}")
        assert result.status in ("applied", "needs_review"), (
            f"Expected applied/needs_review, got {result.status}: {result.error_message}"
        )
