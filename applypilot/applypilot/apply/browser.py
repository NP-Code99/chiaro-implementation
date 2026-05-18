"""
Playwright browser management with persistent storageState and anti-detection.
"""
import json
import logging
import sys
from pathlib import Path
from typing import Any

from playwright.async_api import async_playwright, Browser, BrowserContext, Page

from .anti_detect import STEALTH_LAUNCH_ARGS, STEALTH_INIT_SCRIPT, REALISTIC_UA
from .session import save_session, load_session

log = logging.getLogger(__name__)

# Page to visit to validate session is active (common auth check)
SESSION_VALIDATION_URL = "https://www.linkedin.com/feed/"


async def launch_browser(
    headless: bool = False,
    storage_state: dict | None = None,
) -> tuple[Any, Browser, BrowserContext]:
    """
    Launch a Playwright Chromium browser with stealth args.
    Returns (playwright, browser, context).
    """
    pw = await async_playwright().start()
    extra_args = list(STEALTH_LAUNCH_ARGS)

    # Xvfb virtual display on Linux (headless=False but no display)
    if sys.platform.startswith("linux") and not headless:
        try:
            import subprocess
            subprocess.Popen(
                ["Xvfb", ":99", "-screen", "0", "1366x768x24"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            import os
            os.environ.setdefault("DISPLAY", ":99")
        except FileNotFoundError:
            log.warning("Xvfb not found — running without virtual display")

    browser = await pw.chromium.launch(
        headless=headless,
        args=extra_args,
    )

    ctx_kwargs: dict = {
        "user_agent": REALISTIC_UA,
        "viewport": {"width": 1366, "height": 768},
        "locale": "en-US",
        "timezone_id": "America/New_York",
    }
    if storage_state:
        ctx_kwargs["storage_state"] = storage_state

    context = await browser.new_context(**ctx_kwargs)
    await context.add_init_script(STEALTH_INIT_SCRIPT)
    return pw, browser, context


async def capture_new_session(user_id: str) -> dict:
    """
    Launch a headed browser, let the user log in manually, then capture
    and return the storageState. Saves encrypted session to disk.
    """
    print("\n[ApplyPilot] Opening browser for manual login...")
    print("  Log into any job sites (LinkedIn, Greenhouse, etc.), then press Enter here.\n")
    pw, browser, context = await launch_browser(headless=False)
    page = await context.new_page()
    await page.goto("about:blank")
    input("  Press Enter when you have finished logging in → ")
    state = await context.storage_state()
    save_session(user_id, state)
    await browser.close()
    await pw.stop()
    print(f"[ApplyPilot] Session saved for user '{user_id}'\n")
    return state


async def validate_session(context: BrowserContext, validation_url: str = SESSION_VALIDATION_URL) -> bool:
    """
    Open the validation URL and check we're not redirected to a login page.
    """
    try:
        page = await context.new_page()
        response = await page.goto(validation_url, timeout=15000)
        final_url = page.url
        await page.close()
        is_valid = "login" not in final_url and "signin" not in final_url
        log.info("Session validation: %s (%s)", "valid" if is_valid else "expired", final_url)
        return is_valid
    except Exception as exc:
        log.warning("Session validation error: %s", exc)
        return False


async def get_ready_context(user_id: str, headless: bool = False) -> tuple[Any, Browser, BrowserContext]:
    """
    Load or capture a session, validate it, and return a ready context.
    Prompts re-auth if session is expired.
    """
    state = load_session(user_id)
    if not state:
        log.info("No session found for %s — starting capture flow", user_id)
        state = await capture_new_session(user_id)

    pw, browser, context = await launch_browser(headless=headless, storage_state=state)
    valid = await validate_session(context)
    if not valid:
        print("[ApplyPilot] Session expired — please log in again.")
        await browser.close()
        await pw.stop()
        state = await capture_new_session(user_id)
        pw, browser, context = await launch_browser(headless=headless, storage_state=state)

    return pw, browser, context
