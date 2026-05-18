"""
Lever-specific apply test suite.

Live URL: Palantir on jobs.lever.co
    https://jobs.lever.co/palantir/a543d82a-a089-4b1c-afd1-4f30d3d8ee23/apply

Run modes:
    # Dry-run (default — no actual submission):
    DRY_RUN=1 .venv/bin/python -m pytest tests/test_lever_apply.py -v

    # Live submission (use a real throwaway email!):
    DRY_RUN=0 .venv/bin/python -m pytest tests/test_lever_apply.py -v -k live

Environment:
    CAPSOLVER_API_KEY — required for live captcha solve
    DRY_RUN           — "1" (default) or "0"
"""
from __future__ import annotations

import asyncio
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

LEVER_URL = "https://jobs.lever.co/palantir/a543d82a-a089-4b1c-afd1-4f30d3d8ee23/apply"

DRY_RUN = os.environ.get("DRY_RUN", "1") != "0"

SCREENSHOTS = BASE_DIR / "tests" / "screenshots" / "lever"
SCREENSHOTS.mkdir(parents=True, exist_ok=True)

SAMPLE_PROFILE = {
    "firstName": "Test",
    "lastName": "Candidate",
    "email": "test.candidate+lever@example.com",
    "phone": "+1 (555) 000-1234",
    "location": "San Francisco, CA",
    "linkedin": "https://linkedin.com/in/testcandidate",
    "github": "https://github.com/testcandidate",
    "portfolio": "https://testcandidate.dev",
    "currentCompany": "Acme Corp",
    "workAuth": "US Citizen",
    "yearsExp": "3-5",
    "desiredSalary": "150000",
    "bio": "Experienced software engineer with 4 years in backend development.",
    "resumeBase64": "",       # set in conftest or env
    "resumeFilename": "test_resume.pdf",
}

SAMPLE_JOB = {
    "id": "lever-palantir-test",
    "applyUrl": LEVER_URL,
    "title": "Software Engineer",
    "company": "Palantir",
    "location": "New York, NY",
    "description": "Software engineering role at Palantir.",
}


# ── Unit tests (no browser) ───────────────────────────────────────────────────

class TestLeverBoardDetection:
    def test_lever_url_detected(self):
        assert detect_board(LEVER_URL) == "lever"

    def test_lever_co_variant(self):
        assert detect_board("https://jobs.lever.co/stripe/abc123/apply") == "lever"

    def test_greenhouse_not_lever(self):
        assert detect_board("https://job-boards.greenhouse.io/acme/jobs/123") != "lever"

    def test_ashby_not_lever(self):
        assert detect_board("https://jobs.ashbyhq.com/linear/abc/application") != "lever"


# ── Integration tests (Playwright) ───────────────────────────────────────────

class TestLeverPageLoad:
    """Verify the Lever form page loads and exposes expected DOM elements."""

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
                await page.goto(LEVER_URL, wait_until="domcontentloaded", timeout=45000)
                await page.wait_for_timeout(3000)

                title = await page.title()
                assert title, "Page has no title"

                ss = SCREENSHOTS / "01_page_load.png"
                await page.screenshot(path=str(ss), full_page=True)
                print(f"\n  Screenshot → {ss}")
            finally:
                await browser.close()

    @pytest.mark.asyncio
    async def test_resume_input_present(self):
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
            ctx = await browser.new_context(viewport={"width": 1280, "height": 900})
            page = await ctx.new_page()
            try:
                await page.goto(LEVER_URL, wait_until="domcontentloaded", timeout=45000)
                await page.wait_for_timeout(3000)

                resume_input = page.locator("#resume-upload-input, input[type=file]").first
                assert await resume_input.count() > 0, "No file input found on Lever form"
            finally:
                await browser.close()

    @pytest.mark.asyncio
    async def test_application_fields_present(self):
        """Confirm label-proximity form structure (no IDs on most inputs)."""
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
            ctx = await browser.new_context(viewport={"width": 1280, "height": 900})
            page = await ctx.new_page()
            try:
                await page.goto(LEVER_URL, wait_until="domcontentloaded", timeout=45000)
                await page.wait_for_timeout(3000)

                fields = page.locator(".application-field")
                count = await fields.count()
                assert count > 0, "No .application-field blocks found"
                print(f"\n  Found {count} .application-field blocks")

                # Should have at least name, email, phone
                for label in ["Full name", "Email"]:
                    loc = page.locator(
                        f'.application-field:has(label:has-text("{label}")) input'
                    ).first
                    assert await loc.count() > 0, f"Field '{label}' not found"
            finally:
                await browser.close()

    @pytest.mark.asyncio
    async def test_submit_button_present(self):
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True, args=["--no-sandbox"])
            ctx = await browser.new_context(viewport={"width": 1280, "height": 900})
            page = await ctx.new_page()
            try:
                await page.goto(LEVER_URL, wait_until="domcontentloaded", timeout=45000)
                await page.wait_for_timeout(3000)

                btn = page.locator("#btn-submit, button[type=submit]").first
                assert await btn.count() > 0, "No submit button found"
            finally:
                await browser.close()


# ── Dry-run engine test ───────────────────────────────────────────────────────

class TestLeverDryRun:
    """Run the full LeverFiller in dry_run mode — no submission."""

    @pytest.mark.asyncio
    async def test_dry_run_completes(self):
        result = await run_apply(
            apply_url=LEVER_URL,
            profile=SAMPLE_PROFILE,
            job=SAMPLE_JOB,
            dry_run=True,
            screenshot_dir=SCREENSHOTS / "dry_run",
        )
        print(f"\n  DryRun result: status={result.status} error={result.error_message}")
        # dry_run always returns status="applied" with error_message="dry_run"
        assert result.status == "applied"
        assert result.error_message == "dry_run"


# ── Live submission (opt-in) ──────────────────────────────────────────────────

@pytest.mark.skipif(DRY_RUN, reason="Set DRY_RUN=0 to run live submission test")
class TestLeverLiveSubmit:
    """Actually submits the form. Use a throwaway email."""

    @pytest.mark.asyncio
    async def test_live_apply(self):
        profile = {**SAMPLE_PROFILE, "email": os.environ.get("TEST_EMAIL", SAMPLE_PROFILE["email"])}
        result = await run_apply(
            apply_url=LEVER_URL,
            profile=profile,
            job=SAMPLE_JOB,
            dry_run=False,
            screenshot_dir=SCREENSHOTS / "live",
        )
        print(f"\n  Live result: status={result.status} error={result.error_message}")
        assert result.status in ("applied", "needs_review"), (
            f"Expected applied/needs_review, got {result.status}: {result.error_message}"
        )
