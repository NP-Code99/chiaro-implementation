"""
Multi-board apply engine.
Detects the job board from the apply URL, launches the appropriate filler,
and returns a structured ApplyResult.
"""
from __future__ import annotations

import base64
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from playwright.async_api import async_playwright, Browser, BrowserContext

from .boards.greenhouse import GreenhouseFiller, ApplyResult
from .boards.lever import LeverFiller
from .boards.ashby import AshbyFiller
from .boards.startupjobs import StartupJobsFiller
from .boards.generic import GenericFiller

log = logging.getLogger(__name__)

# ── Board detection ───────────────────────────────────────────────────────────

def detect_board(url: str) -> str:
    u = (url or "").lower()
    if "greenhouse.io" in u:
        return "greenhouse"
    if "lever.co" in u:
        return "lever"
    if "workday.com" in u or "myworkdayjobs.com" in u:
        return "workday"
    if "ashbyhq.com" in u or "ashby" in u:
        return "ashby"
    if "startup.jobs" in u:
        return "startupjobs"
    if "bamboohr.com" in u:
        return "bamboohr"
    if "smartrecruiters.com" in u:
        return "smartrecruiters"
    if "taleo.net" in u:
        return "taleo"
    if "icims.com" in u:
        return "icims"
    if "jobvite.com" in u:
        return "jobvite"
    return "generic"


# ── Browser setup ─────────────────────────────────────────────────────────────

async def _new_browser_context(pw, use_real_chrome: bool = True) -> tuple[Browser, BrowserContext]:
    """
    Launch a browser context.
    use_real_chrome=True: uses the system Chrome binary (passes CF challenges naturally).
    Falls back to Chromium if Chrome isn't installed.
    """
    launch_kwargs: dict = {
        "headless": True,
        "args": [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--window-size=1280,900",
        ],
    }
    if use_real_chrome:
        import shutil
        chrome_paths = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium-browser",
        ]
        chrome_bin = next((p for p in chrome_paths if shutil.os.path.exists(p)), None)
        if chrome_bin:
            launch_kwargs["executable_path"] = chrome_bin
            log.info("Using real Chrome: %s", chrome_bin)
        else:
            log.info("Real Chrome not found — using Chromium")

    browser = await pw.chromium.launch(**launch_kwargs)
    ctx = await browser.new_context(
        viewport={"width": 1280, "height": 900},
        locale="en-US",
        timezone_id="America/New_York",
    )
    # Minimal stealth — real Chrome handles the rest
    await ctx.add_init_script(
        "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
    )
    return browser, ctx


# ── File prep helpers ─────────────────────────────────────────────────────────

def _write_temp_file(data: str | bytes, suffix: str, name: str) -> Path:
    """Write base64-encoded content or raw text to a temp file and return its Path."""
    tmp_dir = Path(tempfile.gettempdir()) / "applypilot_files"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    path = tmp_dir / name
    if isinstance(data, bytes):
        path.write_bytes(data)
    else:
        path.write_text(data)
    return path


def _prepare_resume(profile: dict[str, Any]) -> Path:
    """Extract resume from profile (base64 PDF or text) to a temp file."""
    resume_b64: str | None = profile.get("resumeBase64")
    if resume_b64:
        # Strip data URI header if present
        if "," in resume_b64:
            resume_b64 = resume_b64.split(",", 1)[1]
        raw = base64.b64decode(resume_b64)
        name = f"{profile.get('lastName', 'candidate')}_resume.pdf"
        return _write_temp_file(raw, ".pdf", name)

    # Fallback: generate a plain-text resume from profile fields
    lines = [
        f"{profile.get('firstName','')} {profile.get('lastName','')}",
        profile.get("email", ""),
        profile.get("phone", ""),
        profile.get("location", ""),
        "",
        "SUMMARY",
        profile.get("summary", ""),
        "",
        "SKILLS",
        ", ".join(profile.get("skills", [])),
        "",
    ]
    for exp in profile.get("experience", []):
        lines += [
            f"{exp.get('title','')} | {exp.get('company','')} | {exp.get('start','')}–{exp.get('end','')}",
            *[f"- {b}" for b in exp.get("bullets", [])],
            "",
        ]
    for edu in profile.get("education", []):
        lines.append(f"{edu.get('degree','')} | {edu.get('school','')} | {edu.get('year','')}")
    text = "\n".join(lines)
    name = f"{profile.get('lastName', 'candidate')}_resume.txt"
    return _write_temp_file(text, ".txt", name)


def _prepare_cover_letter(profile: dict[str, Any], job: dict[str, Any]) -> Path:
    """Generate a cover letter and write to temp file."""
    try:
        from applypilot.cover_letter import generate_cover_letter
        text = generate_cover_letter(profile, job)
    except Exception:
        first = profile.get("firstName", "")
        company = job.get("company", "")
        role = job.get("title", "the role")
        text = (
            f"Dear Hiring Manager,\n\n"
            f"I am writing to apply for the {role} position at {company}. "
            f"My background in {', '.join(profile.get('skills', [])[:3])} "
            f"makes me a strong fit for this role.\n\n"
            f"Best regards,\n{first}"
        )
    name = f"{profile.get('lastName', 'candidate')}_cover.txt"
    return _write_temp_file(text, ".txt", name)


# ── Main entry point ──────────────────────────────────────────────────────────

async def run_apply(
    apply_url: str,
    profile: dict[str, Any],
    job: dict[str, Any],
    dry_run: bool = False,
    screenshot_dir: Path | None = None,
) -> ApplyResult:
    """
    Navigate to apply_url, detect the board, run the appropriate filler,
    and return an ApplyResult.
    """
    board = detect_board(apply_url)
    log.info("Detected board=%s for URL=%s", board, apply_url)

    resume_path = _prepare_resume(profile)
    cover_letter_path = _prepare_cover_letter(profile, job)

    ss_dir = screenshot_dir or (Path("/tmp/applypilot_screenshots") / job.get("id", "job"))
    ss_dir.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as pw:
        browser, ctx = await _new_browser_context(pw)
        try:
            page = await ctx.new_page()
            await page.goto(apply_url, wait_until="domcontentloaded", timeout=45000)
            await page.wait_for_timeout(3000)

            filler_kwargs = dict(
                page=page,
                profile=profile,
                job=job,
                resume_path=resume_path,
                cover_letter_path=cover_letter_path,
                dry_run=dry_run,
                screenshot_dir=ss_dir,
            )

            if board == "greenhouse":
                result = await GreenhouseFiller(**filler_kwargs).run()
            elif board == "lever":
                result = await LeverFiller(**filler_kwargs).run()
            elif board == "ashby":
                result = await AshbyFiller(**filler_kwargs).run()
            elif board == "startupjobs":
                result = await StartupJobsFiller(**filler_kwargs).run()
            else:
                # Workday/BambooHR/generic — AI-driven
                result = await GenericFiller(**filler_kwargs).run()

            return result
        except Exception as exc:
            log.exception("run_apply crashed for board=%s url=%s", board, apply_url)
            return ApplyResult(status="failed", error_message=str(exc))
        finally:
            await browser.close()
