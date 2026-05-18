"""Anti-detection helpers for Playwright browser launch."""
import random

REALISTIC_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

STEALTH_LAUNCH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--disable-features=IsolateOrigins,site-per-process",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--window-size=1366,768",
    "--start-maximized",
    f"--user-agent={REALISTIC_UA}",
]

# JS to inject before any page script runs — spoofs navigator.webdriver
STEALTH_INIT_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3]});
Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
window.chrome = {runtime: {}};
"""


async def human_delay(page, min_ms: int = 500, max_ms: int = 1500) -> None:
    """Random pause between field interactions."""
    await page.wait_for_timeout(random.randint(min_ms, max_ms))


async def human_type(page, selector: str, text: str) -> None:
    """Type text with randomized per-character delays (50-150ms)."""
    element = page.locator(selector).first
    await element.click()
    await human_delay(page, 200, 600)
    for char in text:
        await element.type(char, delay=random.randint(50, 150))
    await human_delay(page, 300, 800)


async def ghost_move(page, x: int, y: int) -> None:
    """Move mouse with slight jitter to simulate human movement."""
    steps = random.randint(5, 15)
    cur_x, cur_y = random.randint(100, 800), random.randint(100, 600)
    for i in range(steps):
        t = (i + 1) / steps
        nx = int(cur_x + (x - cur_x) * t + random.randint(-3, 3))
        ny = int(cur_y + (y - cur_y) * t + random.randint(-3, 3))
        await page.mouse.move(nx, ny)
        await page.wait_for_timeout(random.randint(10, 40))
    await page.mouse.move(x, y)
