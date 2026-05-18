"""
Shared Playwright browser factory.
Creates a headful, stealth-mode Chromium instance that passes
Cloudflare bot detection and Turnstile challenges.
"""
import asyncio, random
from playwright.async_api import async_playwright

VIEWPORT = {"width": 1280, "height": 800}
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

async def new_browser(headless=False):
    """Launch a stealth Chromium browser."""
    p = await async_playwright().start()
    browser = await p.chromium.launch(
        headless=headless,
        args=[
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-dev-shm-usage",
        ],
    )
    context = await browser.new_context(
        viewport=VIEWPORT,
        user_agent=USER_AGENT,
        locale="en-US",
        timezone_id="America/New_York",
    )
    await context.add_init_script(
        "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
    )
    page = await context.new_page()
    return p, browser, context, page

async def human_delay(min_ms=300, max_ms=1200):
    """Wait a random human-like amount of time."""
    await asyncio.sleep(random.uniform(min_ms / 1000, max_ms / 1000))

async def slow_type(page, selector, text, delay_ms=80):
    """Type text character by character with realistic speed."""
    await page.focus(selector)
    for char in text:
        await page.keyboard.type(char)
        await asyncio.sleep(random.uniform(0.04, delay_ms / 1000))

async def screenshot(page, name: str, folder="results"):
    """Save a screenshot with a given name."""
    import os, time
    os.makedirs(folder, exist_ok=True)
    path = f"{folder}/{name}_{int(time.time())}.png"
    await page.screenshot(path=path, full_page=True)
    print(f"[screenshot] saved → {path}")
    return path
