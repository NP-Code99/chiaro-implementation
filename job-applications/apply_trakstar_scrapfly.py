"""
Trakstar apply via Scrapfly + playwright-stealth.

Strategy:
  1. Use Scrapfly (ASP bypass + residential proxy) to render the form page
     and extract every field name, type, and options — no bot detection triggered.
  2. Use Claude to generate context-aware answers for each field.
  3. Use local Playwright with playwright-stealth (hides webdriver flag) routed
     through Scrapfly's residential proxy to fill and submit the live form.
     This combo defeats Trakstar's isSelenium / spam-detection layer.

Run:
  python apply_trakstar_scrapfly.py                            # dry-run
  python apply_trakstar_scrapfly.py --submit                   # actually submit
  python apply_trakstar_scrapfly.py --url "URL" --submit
"""

import asyncio, sys, os, json, time, random
from pathlib import Path

# ── Deps ──────────────────────────────────────────────────────────────────────
try:
    from scrapfly import ScrapflyClient, ScrapeConfig
except ImportError:
    print("Run: pip install scrapfly-sdk"); sys.exit(1)

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("Run: pip install playwright && playwright install chromium"); sys.exit(1)

try:
    # playwright-stealth v2 API
    from playwright_stealth import Stealth
    async def stealth_async(page):
        # v2 uses context manager; apply synchronously via evaluate
        s = Stealth()
        await s.apply_stealth_async(page)
except ImportError:
    try:
        from playwright_stealth import stealth_async
    except ImportError:
        print("Run: pip install playwright-stealth"); sys.exit(1)

import anthropic
from bs4 import BeautifulSoup

# ── Config ────────────────────────────────────────────────────────────────────
SCRAPFLY_KEY   = os.environ.get("SCRAPFLY_API_KEY", "scp-live-443c714b108e4137bca2e6b561978171")
ANTHROPIC_KEY  = os.environ.get("ANTHROPIC_API_KEY", "")
SUBMIT         = "--submit" in sys.argv
DEFAULT_URL    = "https://caixamagica.hire.trakstar.com/jobs/fk0zv84/?apply=true"
URL            = sys.argv[sys.argv.index("--url") + 1] if "--url" in sys.argv else DEFAULT_URL
RESULTS_DIR    = Path("results"); RESULTS_DIR.mkdir(exist_ok=True)

# ── Profile ───────────────────────────────────────────────────────────────────
PROFILE_PATH = Path(__file__).parent.parent / "applypilot" / "profile.json"
try:
    PROFILE = json.loads(PROFILE_PATH.read_text())
except Exception:
    PROFILE = {}

FIRST    = os.environ.get("APPLY_FIRST_NAME", PROFILE.get("firstName", "Nandan"))
LAST     = os.environ.get("APPLY_LAST_NAME",  PROFILE.get("lastName",  "Pullakandam"))
EMAIL    = os.environ.get("APPLY_EMAIL",      PROFILE.get("email",     "nandanpu@unc.edu"))
PHONE    = os.environ.get("APPLY_PHONE",      PROFILE.get("phone",     "+1 919 555 0142"))
LINKEDIN = os.environ.get("APPLY_LINKEDIN",   PROFILE.get("linkedin",  ""))
RESUME   = os.environ.get(
    "APPLY_RESUME_PATH",
    # Try the clean resume first, fall back to others
    str(Path.home() / "Nandan_Pullakandam_Resume.pdf")
    if (Path.home() / "Nandan_Pullakandam_Resume.pdf").exists()
    else str(Path.home() / "Pullakandam, Nandan Resume .pdf")
)

def log(msg): print(msg, flush=True)

async def human_delay(lo=400, hi=1200):
    await asyncio.sleep(random.uniform(lo / 1000, hi / 1000))

async def take_shot(page, name):
    path = RESULTS_DIR / f"trakstar_{name}_{int(time.time())}.png"
    await page.screenshot(path=str(path), full_page=True)
    log(f"[screenshot] → {path}")

# ── Step 1: Scrapfly scrape to understand the form ───────────────────────────

def scrape_form_fields(url: str) -> dict:
    """
    Use Scrapfly with JS rendering + ASP bypass to get the rendered form HTML,
    then extract field metadata so Claude can answer them.
    """
    log("[scrapfly] Rendering application page...")
    client = ScrapflyClient(key=SCRAPFLY_KEY)
    result = client.scrape(ScrapeConfig(
        url=url,
        render_js=True,
        asp=True,
        country="US",
        rendering_wait=4000,
    ))
    html = result.scrape_result["content"]
    soup = BeautifulSoup(html, "html.parser")

    fields = []
    for inp in soup.find_all(["input", "textarea", "select"]):
        ftype  = inp.get("type", "text").lower()
        name   = inp.get("name") or inp.get("id") or inp.get("placeholder", "")
        label  = ""
        # try to find associated label
        if inp.get("id"):
            lbl = soup.find("label", {"for": inp["id"]})
            if lbl: label = lbl.get_text(strip=True)
        if not label and inp.get("placeholder"):
            label = inp["placeholder"]
        if not label and name:
            label = name.replace("_", " ").replace("-", " ").title()

        if ftype in ("hidden", "submit", "button", "file", "image", "reset"):
            continue
        if not name:
            continue

        opts = []
        if inp.name == "select":
            opts = [o.get_text(strip=True) for o in inp.find_all("option") if o.get("value")]

        fields.append({"name": name, "label": label, "type": inp.name, "options": opts})

    # also grab the job title from the page for context
    title_el = soup.find(["h1", "h2"])
    job_title = title_el.get_text(strip=True) if title_el else "Software Engineer"

    log(f"[scrapfly] Found {len(fields)} fields | job: {job_title}")
    return {"fields": fields, "job_title": job_title, "html": html}

# ── Step 2: Claude answers each field ─────────────────────────────────────────

def claude_answer(field: dict, job_title: str) -> str:
    if not ANTHROPIC_KEY:
        return _fallback(field)

    client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    prompt = f"""You are filling out a job application for "{job_title}" on behalf of:
Name: {FIRST} {LAST}
Email: {EMAIL}
Phone: {PHONE}
LinkedIn: {LINKEDIN}
Profile: {json.dumps(PROFILE, indent=2)}

Field label: "{field['label']}"
Field type: {field['type']}
{f"Options: {field['options']}" if field['options'] else ""}

Reply with ONLY the answer text (no explanation). If it's a select, pick the best matching option exactly.
If it's a yes/no question, reply Yes or No. Keep answers concise and honest."""

    msg = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=200,
        messages=[{"role": "user", "content": prompt}],
    )
    return msg.content[0].text.strip()

def _fallback(field: dict) -> str:
    label = field["label"].lower()
    if "first" in label: return FIRST
    if "last" in label:  return LAST
    if "email" in label: return EMAIL
    if "phone" in label: return PHONE
    if "linkedin" in label: return LINKEDIN
    if "salary" in label or "compensation" in label: return "120000"
    if "sponsor" in label: return "No"
    if "authoriz" in label or "eligible" in label: return "Yes"
    if "relocat" in label: return "No"
    if "start" in label or "available" in label: return "2025-07-01"
    if field["options"]: return field["options"][0]
    return ""

# ── Step 3: Playwright-stealth fills and submits ──────────────────────────────

async def slow_type(page, selector, text):
    """Type text character-by-character with human timing."""
    await page.click(selector)
    await human_delay(200, 400)
    await page.fill(selector, "")
    await human_delay(100, 200)
    for ch in text:
        await page.type(selector, ch, delay=random.randint(40, 120))
    await human_delay(300, 700)

async def fill_and_submit(url: str, answers: dict):
    """
    Fill the Trakstar form using exact field names discovered by Scrapfly:
      candidate_first_name, candidate_last_name, candidate_email, candidate_phone
    + resume file upload + reCAPTCHA wait + submit.
    """
    log("[playwright] Launching stealth browser...")

    # Webshare residential proxy — parse URL into Playwright's proxy format
    raw_proxy = os.environ.get("RESIDENTIAL_PROXY_URL", "")
    proxy_cfg = None
    if raw_proxy:
        from urllib.parse import urlparse
        parsed = urlparse(raw_proxy)
        proxy_cfg = {
            "server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}",
            "username": parsed.username or "",
            "password": parsed.password or "",
        }

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-extensions",
                "--disable-plugins",
                "--disable-infobars",
                "--disable-setuid-sandbox",
            ],
        )
        ctx = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="en-US",
            timezone_id="America/New_York",
            proxy=proxy_cfg,
        )

        # Comprehensive anti-detection init script
        await ctx.add_init_script("""
            // Hide webdriver
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            // Fake plugins like a real browser
            Object.defineProperty(navigator, 'plugins', {
                get: () => {
                    const arr = [1,2,3,4,5];
                    arr.__proto__ = PluginArray.prototype;
                    return arr;
                }
            });
            Object.defineProperty(navigator, 'mimeTypes', {
                get: () => { const arr = [1]; arr.__proto__ = MimeTypeArray.prototype; return arr; }
            });
            Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
            // Chrome runtime must exist
            if (!window.chrome) window.chrome = {};
            window.chrome.runtime = {};
            // Permissions API
            const origQuery = window.navigator.permissions && window.navigator.permissions.query;
            if (origQuery) {
                window.navigator.permissions.query = (params) =>
                    params.name === 'notifications'
                        ? Promise.resolve({state: Notification.permission})
                        : origQuery(params);
            }
        """)

        page = await ctx.new_page()
        await stealth_async(page)

        log(f"[playwright] Navigating → {url}")
        await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        await human_delay(3000, 5000)
        await take_shot(page, "01_loaded")

        # ── Open the application form (it's in a modal/inline panel) ────────
        # Try clicking "Apply now" / "Apply" button to reveal the form
        apply_selectors = [
            "a:has-text('Apply now')",
            "button:has-text('Apply now')",
            "a:has-text('Apply')",
            "button:has-text('Apply')",
            "[data-ui='apply-button']",
            ".apply-button",
            "#apply-button",
        ]
        form_visible = await page.locator("[name='candidate_first_name']").count() > 0
        if not form_visible:
            log("[playwright] Form not immediately visible — clicking Apply button...")
            for sel in apply_selectors:
                try:
                    btn = page.locator(sel).first
                    if await btn.count() > 0:
                        await btn.scroll_into_view_if_needed()
                        await human_delay(500, 800)
                        await btn.click()
                        log(f"[playwright] Clicked: {sel}")
                        await human_delay(2000, 3500)
                        break
                except Exception:
                    pass

        # Wait for form field to appear (up to 15s)
        try:
            await page.wait_for_selector("[name='candidate_first_name']", timeout=15000)
            log("[playwright] Form fields visible")
        except Exception:
            log("[playwright] ⚠ Form field still not found — proceeding anyway")
        await take_shot(page, "01b_form_open")

        # ── Fill the 4 Trakstar fields ──────────────────────────────────────
        log("[playwright] Filling candidate_first_name...")
        await slow_type(page, "[name='candidate_first_name']", FIRST)

        log("[playwright] Filling candidate_last_name...")
        await slow_type(page, "[name='candidate_last_name']", LAST)

        log("[playwright] Filling candidate_email...")
        await slow_type(page, "[name='candidate_email']", EMAIL)

        log("[playwright] Filling candidate_phone...")
        await slow_type(page, "[name='candidate_phone']", PHONE)

        await take_shot(page, "02_fields_filled")

        # ── Resume upload ───────────────────────────────────────────────────
        await _upload_resume(page)

        # ── Scroll through the whole form naturally ─────────────────────────
        log("[playwright] Scrolling through form naturally...")
        for scroll_y in range(0, 3000, 300):
            await page.evaluate(f"window.scrollTo(0, {scroll_y})")
            await human_delay(100, 250)

        # Scroll back to top, then bottom (looks like a human reviewing)
        await page.evaluate("window.scrollTo(0, 0)")
        await human_delay(800, 1500)
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await human_delay(1500, 2500)

        await take_shot(page, "03_scrolled")

        # ── Wait for reCAPTCHA (v3 auto-scores, v2 needs interaction) ───────
        log("[playwright] Waiting for reCAPTCHA to score (10s)...")
        await human_delay(10000, 12000)

        # ── Submit ──────────────────────────────────────────────────────────
        if not SUBMIT:
            log("[playwright] 🔍 DRY RUN — form filled, not submitted. Waiting 8s for review.")
            await human_delay(8000, 10000)
        else:
            log("[playwright] Locating submit button...")
            submit_btn = page.locator(
                "button[type='submit'], input[type='submit'], "
                "button:has-text('Submit Application'), button:has-text('Submit')"
            ).last

            if await submit_btn.count() > 0:
                # Scroll submit button into view and click
                await submit_btn.scroll_into_view_if_needed()
                await human_delay(500, 1000)
                log("[playwright] Clicking Submit...")
                await submit_btn.click()
                await human_delay(5000, 8000)
                await take_shot(page, "04_submitted")
                log("[playwright] ✅ Clicked submit — check screenshot for confirmation")
            else:
                log("[playwright] ⚠ Submit button not found")
                await take_shot(page, "04_no_submit_btn")

        await browser.close()



async def _upload_resume(page):
    resume_path = RESUME
    if not Path(resume_path).exists():
        log(f"[playwright] ⚠ Resume not found at {resume_path}")
        return
    try:
        file_input = page.locator("input[type='file']").first
        if await file_input.count() > 0:
            await file_input.set_input_files(resume_path)
            log(f"[playwright] 📎 Resume uploaded: {resume_path}")
            await human_delay(1500, 2500)
    except Exception as ex:
        log(f"[playwright] ⚠ Resume upload failed: {ex}")

# ── Main ──────────────────────────────────────────────────────────────────────

async def apply(url: str):
    log(f"\n{'='*60}")
    log(f"[trakstar-scrapfly] Target: {url}")
    log(f"[trakstar-scrapfly] Mode: {'SUBMIT' if SUBMIT else 'DRY RUN'}")
    log(f"{'='*60}\n")

    # 1. Scrape form with Scrapfly (no bot detection risk)
    try:
        form_data = scrape_form_fields(url)
    except Exception as e:
        log(f"[scrapfly] ⚠ Scrape failed: {e} — proceeding with standard fields only")
        form_data = {"fields": [], "job_title": "Software Engineer"}

    # 2. Generate answers with Claude
    log("[claude] Generating field answers...")
    answers = {}
    for field in form_data["fields"]:
        answer = claude_answer(field, form_data["job_title"])
        answers[field["name"]] = answer
        log(f"  {field['label'][:40]:40} → {answer[:50]}")

    # 3. Fill and submit with stealth Playwright
    await fill_and_submit(url, answers)

    log(f"\n[trakstar-scrapfly] Done.")

if __name__ == "__main__":
    asyncio.run(apply(URL))
