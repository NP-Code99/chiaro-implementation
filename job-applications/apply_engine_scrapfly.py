"""
Universal apply engine — Scrapfly + playwright-stealth.

Replaces Steel.dev. Works for any ATS (BambooHR, Trakstar, Greenhouse,
Lever, Teamtailor, Personio, etc.).

Strategy:
  1. Scrapfly (ASP bypass + JS render) scrapes the form fields — no bot detection.
  2. Claude Haiku generates contextual answers for every field.
  3. Local Playwright + playwright-stealth + Webshare residential proxy fills
     and submits. The webdriver flag is hidden; IP is residential.

Run:
  python apply_engine_scrapfly.py --url "https://..."            # dry-run
  python apply_engine_scrapfly.py --url "https://..." --submit   # submit
"""

import asyncio, sys, os, json, time, random
from pathlib import Path
from urllib.parse import urlparse

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
    from playwright_stealth import Stealth
    async def _apply_stealth(page):
        await Stealth().apply_stealth_async(page)
except ImportError:
    async def _apply_stealth(_):
        pass  # stealth not available; webdriver flag stays default

try:
    from bs4 import BeautifulSoup
except ImportError:
    print("Run: pip install beautifulsoup4"); sys.exit(1)

try:
    import anthropic as _anthropic
    _ANTHROPIC_AVAILABLE = True
except ImportError:
    _ANTHROPIC_AVAILABLE = False

try:
    import capsolver
    CAPSOLVER_AVAILABLE = True
except ImportError:
    capsolver = None  # type: ignore[assignment]
    CAPSOLVER_AVAILABLE = False

# ── Config ────────────────────────────────────────────────────────────────────
SCRAPFLY_KEY  = os.environ.get("SCRAPFLY_API_KEY", "scp-live-443c714b108e4137bca2e6b561978171")
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CAPSOLVER_KEY = os.environ.get("CAPSOLVER_API_KEY", "CAP-3B64A18B30B50A0278278C10BD9E97D6FAD840D982632D2A061F4E121A6B7083")
SUBMIT        = "--submit" in sys.argv
RESULTS_DIR   = Path("results"); RESULTS_DIR.mkdir(exist_ok=True)

URL = (
    sys.argv[sys.argv.index("--url") + 1]
    if "--url" in sys.argv
    else sys.exit("Usage: python apply_engine_scrapfly.py --url URL [--submit]")
)

# ── Proxy (Webshare residential — hides automation IP) ───────────────────────
_raw_proxy = os.environ.get("RESIDENTIAL_PROXY_URL", "")
PROXY_CFG = None
if _raw_proxy:
    _p = urlparse(_raw_proxy)
    PROXY_CFG = {
        "server":   f"{_p.scheme}://{_p.hostname}:{_p.port}",
        "username": _p.username or "",
        "password": _p.password or "",
    }

# ── Profile — loaded from applypilot/profile.json ────────────────────────────
_profile_path = Path(__file__).parent.parent / "applypilot" / "profile.json"
try:
    PROFILE = json.loads(_profile_path.read_text())
except Exception:
    PROFILE = {}

FIRST    = os.environ.get("APPLY_FIRST_NAME",   PROFILE.get("firstName",  "Nandan"))
LAST     = os.environ.get("APPLY_LAST_NAME",    PROFILE.get("lastName",   "Pullakandam"))
EMAIL    = os.environ.get("APPLY_EMAIL",        PROFILE.get("email",      "nandanpu@unc.edu"))
PHONE    = os.environ.get("APPLY_PHONE",        PROFILE.get("phone",      "+1 919 555 0142"))
LINKEDIN = os.environ.get("APPLY_LINKEDIN",     PROFILE.get("linkedin",   ""))

_resume_candidates = [
    Path.home() / "Nandan_Pullakandam_Resume.pdf",
    Path.home() / "Pullakandam, Nandan Resume .pdf",
    Path(__file__).parent.parent / "applypilot" / "resume.pdf",
]
RESUME = os.environ.get(
    "APPLY_RESUME_PATH",
    str(next((p for p in _resume_candidates if p.exists()), ""))
)

# ── Helpers ───────────────────────────────────────────────────────────────────
def log(msg: str): print(msg, flush=True)

async def _delay(lo: int = 400, hi: int = 1200):
    await asyncio.sleep(random.uniform(lo / 1000, hi / 1000))

async def _shot(page, name: str):
    path = RESULTS_DIR / f"apply_{name}_{int(time.time())}.png"
    try:
        await page.screenshot(path=str(path), full_page=False, timeout=8000)
        log(f"[screenshot] → {path}")
    except Exception as ex:
        log(f"[screenshot] ⚠ skipped ({ex})")

async def _slow_type(page, selector: str, text: str):
    await page.click(selector)
    await _delay(150, 350)
    await page.fill(selector, "")
    await _delay(80, 150)
    for ch in text:
        await page.type(selector, ch, delay=random.randint(35, 110))
    await _delay(250, 600)

# ── Step 0: Scrapfly — resolve startup.jobs redirect to real ATS URL ──────────

def resolve_startup_jobs_url(url: str) -> str:
    """
    If this is a startup.jobs/apply/* link, use Scrapfly to follow the JS
    redirect chain and return the final ATS URL. Returns url unchanged if not
    a startup.jobs link or if resolution fails.
    """
    if "startup.jobs" not in url:
        return url

    log(f"[scrapfly] Resolving startup.jobs redirect: {url}")
    client = ScrapflyClient(key=SCRAPFLY_KEY)
    try:
        result = client.scrape(ScrapeConfig(
            url=url,
            render_js=True,
            asp=True,
            country="US",
            rendering_wait=4000,
        ))
        from urllib.parse import urlparse
        final_url = result.scrape_result.get("url", url)
        # Check the HOST (not full URL) so utm_source=startup.jobs doesn't fool us
        final_host = urlparse(final_url).netloc if final_url else ""
        if final_url and final_url != url and "startup.jobs" not in final_host:
            log(f"[scrapfly] Resolved → {final_url}")
            return final_url
        log(f"[scrapfly] Could not resolve away from startup.jobs — using original")
    except Exception as err:
        log(f"[scrapfly] Resolve failed: {err}")
    return url

# ── Step 1: Scrapfly — understand the form ────────────────────────────────────

def scrape_fields(url: str) -> dict:
    log("[scrapfly] Rendering form with ASP bypass...")
    client = ScrapflyClient(key=SCRAPFLY_KEY)
    result = client.scrape(ScrapeConfig(
        url=url,
        render_js=True,
        asp=True,
        country="US",
        rendering_wait=5000,
    ))
    html   = result.scrape_result["content"]
    soup   = BeautifulSoup(html, "html.parser")

    skip_types = {"hidden", "submit", "button", "file", "image", "reset"}
    fields = []
    for inp in soup.find_all(["input", "textarea", "select"]):
        ftype = inp.get("type", "text").lower()
        if ftype in skip_types:
            continue
        name  = inp.get("name") or inp.get("id") or ""
        if not name or "recaptcha" in name.lower():
            continue

        # Derive human-readable label
        label = ""
        if inp.get("id"):
            lbl = soup.find("label", {"for": inp["id"]})
            if lbl: label = lbl.get_text(strip=True)
        if not label:
            label = inp.get("placeholder") or inp.get("aria-label") or ""
        if not label:
            label = name.replace("_", " ").replace("-", " ").title()

        opts = (
            [o.get_text(strip=True) for o in inp.find_all("option") if o.get("value")]
            if inp.name == "select" else []
        )
        fields.append({"name": name, "label": label, "type": inp.name, "options": opts})

    title_el  = soup.find(["h1", "h2"])
    job_title = title_el.get_text(strip=True) if title_el else "the role"
    company   = soup.title.get_text(strip=True) if soup.title else "the company"

    log(f"[scrapfly] {len(fields)} form fields | job: {job_title}")
    return {"fields": fields, "job_title": job_title, "company": company}

# ── Step 2: Claude — generate answers ────────────────────────────────────────

def _fallback_answer(field: dict) -> str:
    label = field["label"].lower()
    name  = field["name"].lower()
    if "first" in label or "first" in name:              return FIRST
    if "last"  in label or "last"  in name:              return LAST
    if "email" in label or "email" in name:              return EMAIL
    if "phone" in label or "phone" in name:              return PHONE
    if "linkedin" in label or "linkedin" in name:        return LINKEDIN
    if "github"   in label or "github"   in name:        return PROFILE.get("github", "")
    if "salary"   in label or "compensation" in label:   return "120000"
    if "sponsor"  in label:                              return "No"
    if "authoriz" in label or "eligible" in label:       return "Yes"
    if "relocat"  in label:                              return "No"
    if "start"    in label or "available" in label:      return "2025-07-01"
    if "cover"    in label or "letter"    in label:
        return (
            f"I am excited to apply for this role. My background in software engineering "
            f"with TypeScript, Python, React, and Next.js makes me a strong fit. "
            f"I am a quick learner and passionate about building impactful products."
        )
    if field["options"]:                                 return field["options"][0]
    return ""

def generate_answers(fields: list, job_title: str, company: str) -> dict:
    if not (ANTHROPIC_KEY and _ANTHROPIC_AVAILABLE):
        log("[claude] No API key — using fallback answers")
        return {f["name"]: _fallback_answer(f) for f in fields}

    client = _anthropic.Anthropic(api_key=ANTHROPIC_KEY)
    answers = {}
    for field in fields:
        try:
            prompt = f"""Fill out this job application field on behalf of:
Name: {FIRST} {LAST} | Email: {EMAIL} | Phone: {PHONE}
Job: "{job_title}" at "{company}"
Profile summary: {PROFILE.get('summary', '')}

Field label: "{field['label']}"
Field type: {field['type']}
{f"Options: {field['options']}" if field['options'] else ""}

Reply with ONLY the answer value. No explanation. If select, match an option exactly.
If yes/no, reply Yes or No. Be honest and concise."""

            msg = client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=200,
                messages=[{"role": "user", "content": prompt}],
            )
            answers[field["name"]] = msg.content[0].text.strip()
        except Exception:
            answers[field["name"]] = _fallback_answer(field)

        log(f"  {field['label'][:38]:38} → {answers[field['name']][:50]}")

    return answers

# ── Step 3: Playwright-stealth fill & submit ──────────────────────────────────

_FORM_FIELD_SELECTORS = (
    # BambooHR specific IDs
    "#firstName, #lastName, #email, #phone, "
    # Generic name patterns
    "[name*='candidate_'], [name*='first_name'], [name*='last_name'], "
    "[name*='firstName'], [name*='lastName'], "
    # Generic email/phone
    "input[type='email'], input[name*='email'], "
    # Fallback: any visible text input
    "input[name*='first'], input[name*='last']"
)

async def _wait_for_form(page) -> bool:
    """Click Apply button if needed, then wait for candidate form fields to appear."""
    # Check if form is already visible (no button click needed)
    if await page.locator(_FORM_FIELD_SELECTORS).count() > 0:
        return True

    # Ordered apply button selectors — BambooHR's exact text comes first
    apply_selectors = [
        "button:has-text('Apply for This Job')",
        "a:has-text('Apply for This Job')",
        "button:has-text('Apply Now')",
        "a:has-text('Apply Now')",
        "button:has-text('Apply now')",
        "a:has-text('Apply now')",
        "button:has-text('Apply')",
        "a:has-text('Apply')",
        "[data-ui='apply-button']",
        ".apply-button",
        "#apply-button",
        "[id*='apply'][role='button']",
    ]
    for sel in apply_selectors:
        try:
            btn = page.locator(sel).first
            if await btn.count() == 0:
                continue
            await btn.scroll_into_view_if_needed()
            await _delay(500, 900)
            await btn.click()
            log(f"[playwright] Opened form via: {sel}")
            await _delay(2500, 4000)
            break
        except Exception:
            pass

    try:
        await page.wait_for_selector(_FORM_FIELD_SELECTORS, timeout=15000)
        return True
    except Exception:
        return False

async def _fill_field(page, name: str, value: str, tag: str, opts: list):
    """Fill a single form field; skip gracefully on any error."""
    if not value:
        return
    sel = f"[name='{name}']"
    try:
        el = page.locator(sel).first
        if await el.count() == 0:
            return

        if tag == "select":
            # Try exact then partial match
            try:
                await el.select_option(label=value)
            except Exception:
                best = next((o for o in opts if value.lower() in o.lower()), None)
                if best:
                    await el.select_option(label=best)
        else:
            itype = (await el.get_attribute("type") or "text").lower()
            if itype in ("radio", "checkbox"):
                if value.lower() in ("yes", "true", "1"):
                    await el.check()
            elif itype not in ("hidden", "submit"):
                await _slow_type(page, sel, value)

    except Exception as ex:
        log(f"[playwright] ⚠ {name}: {ex}")

async def _fill_by_labels(page) -> None:
    """
    Universal fallback: fill fields by their visible label text.
    Works on any ATS (BambooHR, Trakstar, Greenhouse, Lever, etc.)
    regardless of field name attributes, because it uses Playwright's
    get_by_label() which matches <label> text to the associated input.
    Only fills fields that are currently empty.
    """
    # (label_texts, value, is_select)
    fill_plan = [
        (["First Name", "First name", "Given name"],       FIRST,   False),
        (["Last Name",  "Last name",  "Surname", "Family name"], LAST, False),
        (["Email",      "Email address", "E-mail"],        EMAIL,   False),
        (["Phone",      "Phone number",  "Mobile", "Telephone"], PHONE, False),
        (["LinkedIn",   "LinkedIn URL",  "LinkedIn Profile"], LINKEDIN, False),
        (["Address",    "Street address", "Address line 1"],
         "123 Main St", False),
        (["City"],      "Chapel Hill",   False),
        (["ZIP",        "Zip code",  "Postal code"],        "27514", False),
        (["Country"],   "United States", True),
        (["State",      "Province"],     "North Carolina",  True),
        # Work authorisation / common yes-no questions
        (["Are you authorized", "Work authorization", "Eligible to work",
          "right to work"],                                 "Yes",   False),
        (["Require sponsorship", "Visa sponsorship",
          "sponsorship required"],                          "No",    False),
        (["Cover letter", "Cover Letter"],
         (f"I'm excited to apply. As a software engineer skilled in TypeScript, "
          f"Python, React, and Next.js, I build impactful full-stack products. "
          f"I'm a fast learner who thrives in collaborative startup environments."),
         False),
    ]

    for labels, value, is_select in fill_plan:
        if not value:
            continue
        for label_text in labels:
            try:
                el = page.get_by_label(label_text, exact=False).first
                if await el.count() == 0:
                    continue
                tag = await el.evaluate("e => e.tagName.toLowerCase()")
                if tag == "select" or is_select:
                    current = await el.input_value()
                    if not current or current == "--Select--":
                        try:
                            await el.select_option(label=value)
                        except Exception:
                            pass
                else:
                    current = await el.input_value()
                    if not current:  # only fill empty fields
                        await el.click()
                        await _delay(100, 250)
                        await el.fill("")
                        for ch in value:
                            await page.keyboard.type(ch)
                            await asyncio.sleep(random.uniform(0.03, 0.09))
                        await _delay(200, 500)
                        log(f"[fill] {label_text!r} → {value[:40]}")
                break  # found and filled — move to next field
            except Exception:
                continue


async def fill_and_submit(url: str, answers: dict, field_meta: list):
    log("[playwright] Launching stealth browser (headed)...")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-extensions",
                "--disable-infobars",
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
            proxy=PROXY_CFG,
        )

        await ctx.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            Object.defineProperty(navigator, 'plugins', {
                get: () => { const a=[1,2,3,4,5]; a.__proto__=PluginArray.prototype; return a; }
            });
            Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
            if (!window.chrome) window.chrome = {};
            window.chrome.runtime = {};
        """)

        page = await ctx.new_page()
        await _apply_stealth(page)

        log(f"[playwright] → {url}")
        await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        await _delay(3000, 5000)
        await _shot(page, "01_loaded")

        # Open the form (modal / inline panel)
        form_found = await _wait_for_form(page)
        await _shot(page, "02_form_open")
        if not form_found:
            log("[playwright] ⚠ Form fields not found — will attempt fill anyway")

        # Fill every field discovered by Scrapfly (name-based)
        field_map = {f["name"]: f for f in field_meta}
        for name, value in answers.items():
            meta = field_map.get(name, {"name": name, "label": name, "type": "input", "options": []})
            await _fill_field(page, name, value, meta["type"], meta["options"])
            await _delay(150, 400)

        # Universal label-based fill — works on any ATS regardless of field names.
        # Runs after the Scrapfly pass so it only fills fields still empty.
        await _fill_by_labels(page)

        await _shot(page, "03_fields_filled")

        # Resume upload
        if RESUME and Path(RESUME).exists():
            try:
                fi = page.locator("input[type='file']").first
                if await fi.count() > 0:
                    await fi.set_input_files(RESUME)
                    log(f"[playwright] Resume uploaded: {Path(RESUME).name}")
                    await _delay(1500, 2500)
            except Exception as ex:
                log(f"[playwright] ⚠ Resume upload: {ex}")
        else:
            log(f"[playwright] ⚠ No resume found at: {RESUME}")

        # Natural scroll — looks human, helps reCAPTCHA v3 score
        log("[playwright] Scrolling form naturally...")
        for y in range(0, 3000, 300):
            await page.evaluate(f"window.scrollTo(0, {y})")
            await _delay(80, 200)
        await page.evaluate("window.scrollTo(0, 0)")
        await _delay(700, 1200)
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await _delay(1200, 2000)

        # Detect reCAPTCHA version and handle accordingly
        has_v2 = await page.locator(
            "iframe[src*='recaptcha/api2'], .g-recaptcha, #g-recaptcha"
        ).count() > 0

        if has_v2:
            log("[playwright] reCAPTCHA v2 detected — attempting CapSolver auto-solve...")
            solved = False
            if CAPSOLVER_AVAILABLE and CAPSOLVER_KEY:
                try:
                    capsolver.api_key = CAPSOLVER_KEY
                    # Extract sitekey from page
                    sitekey = await page.evaluate("""() => {
                        const el = document.querySelector('.g-recaptcha[data-sitekey]')
                            || document.querySelector('[data-sitekey]')
                            || document.querySelector('iframe[src*="recaptcha"]');
                        if (!el) return '';
                        if (el.dataset && el.dataset.sitekey) return el.dataset.sitekey;
                        const src = el.getAttribute('src') || '';
                        const m = src.match(/[?&]k=([^&]+)/);
                        return m ? m[1] : '';
                    }""")
                    if sitekey:
                        log(f"[capsolver] Solving reCAPTCHA v2 (sitekey: {sitekey[:20]}...)...")
                        solution = await asyncio.to_thread(
                            capsolver.solve, {
                                "type": "ReCaptchaV2TaskProxyLess",
                                "websiteURL": url,
                                "websiteKey": sitekey,
                            }
                        )
                        token = solution.get("gRecaptchaResponse", "")
                        if token:
                            await page.evaluate(f"""() => {{
                                const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
                                if (ta) {{
                                    ta.value = {json.dumps(token)};
                                    ta.dispatchEvent(new Event('change', {{bubbles: true}}));
                                }}
                                // Also try callback if defined
                                const el = document.querySelector('.g-recaptcha[data-callback]');
                                if (el && el.dataset.callback && window[el.dataset.callback]) {{
                                    window[el.dataset.callback]({json.dumps(token)});
                                }}
                            }}""")
                            log("[capsolver] ✅ reCAPTCHA v2 solved and token injected")
                            solved = True
                        else:
                            log("[capsolver] ⚠ Empty token returned")
                    else:
                        log("[capsolver] ⚠ Could not extract sitekey from page")
                except Exception as cap_err:
                    log(f"[capsolver] ⚠ Auto-solve failed: {cap_err}")
            else:
                log("[capsolver] Not available — capsolver package not installed or no key")

            if not solved:
                log("[playwright] ⚠  reCAPTCHA not auto-solved.")
                log("[playwright]    Please click 'I'm not a robot' in the browser.")
                log("[playwright]    You have 45 seconds...")
                try:
                    await page.wait_for_function(
                        "document.querySelector('textarea[name=\"g-recaptcha-response\"]')?.value?.length > 0",
                        timeout=45000,
                    )
                    log("[playwright] reCAPTCHA v2 solved manually ✓")
                except Exception:
                    log("[playwright] ⚠  reCAPTCHA not solved in time — submitting anyway")
        else:
            log("[playwright] reCAPTCHA v3 — waiting for auto-score (12s)...")
            await _delay(12000, 14000)

        await _shot(page, "04_pre_submit")

        if not SUBMIT:
            log("[playwright] DRY RUN — not submitting. Keeping browser open 10s.")
            await _delay(10000, 12000)
        else:
            from utils.form_filler import submit_and_confirm
            await submit_and_confirm(
                page,
                "button[type='submit'], input[type='submit'], "
                "button:has-text('Submit Application'), button:has-text('Submit'), "
                "button:has-text('Apply')",
                "generic",
                _shot,
            )

        await browser.close()

# ── Main ──────────────────────────────────────────────────────────────────────

async def apply(url: str):
    # 0. Resolve startup.jobs redirect → real ATS URL
    resolved_url = resolve_startup_jobs_url(url)

    log(f"\n{'='*65}")
    log(f"[apply-engine] Input:  {url}")
    if resolved_url != url:
        log(f"[apply-engine] Resolved: {resolved_url}")
    log(f"[apply-engine] Mode: {'SUBMIT' if SUBMIT else 'DRY RUN'}")
    log(f"[apply-engine] Name: {FIRST} {LAST} <{EMAIL}>")
    log(f"[apply-engine] CV:   {RESUME or 'NOT FOUND'}")
    log(f"{'='*65}\n")

    # 1. Scrapfly — scrape form fields from the real ATS URL
    try:
        form_data = scrape_fields(resolved_url)
    except Exception as err:
        log(f"[scrapfly] ⚠ Failed: {err} — proceeding with fallback answers only")
        form_data = {"fields": [], "job_title": "the role", "company": "the company"}

    # 2. Claude — generate contextual answers
    log("[claude] Generating answers...")
    answers = generate_answers(
        form_data["fields"], form_data["job_title"], form_data["company"]
    )

    # 3. Playwright — fill and (optionally) submit on the resolved URL
    await fill_and_submit(resolved_url, answers, form_data["fields"])

    log(f"\n[apply-engine] Done.")

if __name__ == "__main__":
    asyncio.run(apply(URL))
