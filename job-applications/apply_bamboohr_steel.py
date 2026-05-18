"""
BambooHR apply via Steel.dev cloud browser.
Uses profile data from applypilot/profile.json, overridden by env vars set by the
TypeScript app (APPLY_FIRST_NAME, APPLY_EMAIL, etc.) so it works for any logged-in user.

Run:
  python apply_bamboohr_steel.py                    # dry-run (no submit)
  python apply_bamboohr_steel.py --submit            # actually submit
  python apply_bamboohr_steel.py --url "URL" --submit
"""
import asyncio, sys, os, json, time, requests
from pathlib import Path
from playwright.async_api import async_playwright

# ── Config ────────────────────────────────────────────────────────────────────

_DEFAULT_URL = "https://lxt.bamboohr.com/careers/526?utm_source=startup.jobs&utm_medium=organic"
STEEL_API_KEY = os.environ.get(
    "STEEL_API_KEY",
    "ste-eRCexAxZZeT04dOvQT3U2vyww3ct4r87lduNsMuJStlQispT0k30wizJO8jtJ5ErU5n6PzDPl13ZRpKItz9gQgofZdfUV4t5hF5"
)
SUBMIT = "--submit" in sys.argv
URL = (
    sys.argv[sys.argv.index("--url") + 1] if "--url" in sys.argv
    else os.environ.get("BAMBOOHR_TARGET_URL", _DEFAULT_URL)
)

# ── Load profile — env vars from TypeScript app always win ────────────────────

PROFILE_PATH = Path(__file__).parent.parent / "applypilot" / "profile.json"
try:
    profile = json.loads(PROFILE_PATH.read_text())
except Exception:
    profile = {
        "firstName": "", "lastName": "", "email": "", "phone": "",
        "location": "Chapel Hill, NC", "desired_salary_min": 120000, "desired_salary_max": 180000,
    }

def _e(key: str, fallback: str = "") -> str:
    """Read env var, fall back to profile field or literal default."""
    return os.environ.get(key, "") or fallback

FIRST    = _e("APPLY_FIRST_NAME", profile.get("firstName", ""))
LAST     = _e("APPLY_LAST_NAME",  profile.get("lastName",  ""))
EMAIL    = _e("APPLY_EMAIL",      profile.get("email",     ""))
PHONE    = _e("APPLY_PHONE",      profile.get("phone",     ""))
LINKEDIN = _e("APPLY_LINKEDIN",   profile.get("linkedin",  ""))
WEBSITE  = _e("APPLY_WEBSITE",    profile.get("portfolio", ""))

# Location — parse "City, ST" from profile.location or APPLY_LOCATION env var
_location = _e("APPLY_LOCATION", profile.get("location", "Chapel Hill, NC"))
_loc_parts = [p.strip() for p in _location.split(",")]
ADDRESS  = profile.get("address", "123 Franklin St")
CITY     = _loc_parts[0] if _loc_parts else "Chapel Hill"
ZIP_CODE = profile.get("zip", "27514")
COUNTRY  = "United States"

# Derive state from location string
_STATE_MAP = {
    "nc": "North Carolina", "north carolina": "North Carolina",
    "ca": "California",     "california": "California",
    "ny": "New York",       "new york": "New York",
    "tx": "Texas",          "texas": "Texas",
    "wa": "Washington",     "washington": "Washington",
    "ma": "Massachusetts",  "massachusetts": "Massachusetts",
    "co": "Colorado",       "colorado": "Colorado",
    "il": "Illinois",       "illinois": "Illinois",
    "ga": "Georgia",        "georgia": "Georgia",
    "fl": "Florida",        "florida": "Florida",
}
_state_raw = (_loc_parts[1] if len(_loc_parts) > 1 else "NC").strip().lower()
STATE = _STATE_MAP.get(_state_raw, _state_raw.title() if len(_state_raw) > 2 else "North Carolina")

# Salary
SAL_MIN = int(_e("APPLY_SAL_MIN", str(profile.get("desired_salary_min", 120000))))
SAL_MAX = int(_e("APPLY_SAL_MAX", str(profile.get("desired_salary_max", 180000))))
SALARY  = str((SAL_MIN + SAL_MAX) // 2)

START   = "2026-07-01"

# Custom question answers — radio AND text (textarea) questions
CUSTOM_ANSWERS = {
    # ── Radio questions ──────────────────────────────────────────────────────
    "Are you based in Philippines?":                                           ("radio", "No"),
    "How many years of hands-on SEO experience do you have?":                  ("radio", "Less than 3 years"),
    "What is your level of proficiency in HTML, CSS, and basic JavaScript?":   ("radio", "Intermediate"),
    "Please rate your English proficiency":                                    ("radio", "Native"),
    # ── Text / textarea questions ────────────────────────────────────────────
    "What technical SEO tools do you use regularly?":                          ("text", "Google Search Console, Google Analytics, SEMrush, Ahrefs, Screaming Frog SEO Spider, Moz Pro"),
    "What is your current salary (include the currency)?":                     ("text", f"USD {SAL_MIN:,}"),
    "What is your expected salary (include the currency)?":                    ("text", f"USD {SAL_MAX:,}"),
}

RESULTS_DIR = Path(__file__).parent / "results"
RESULTS_DIR.mkdir(exist_ok=True)


# ── Steel.dev session ─────────────────────────────────────────────────────────

def create_steel_session() -> dict:
    print("[steel] Creating session (useProxy=True, solveCaptcha=True)…")
    resp = requests.post(
        "https://api.steel.dev/v1/sessions",
        headers={"Steel-Api-Key": STEEL_API_KEY, "Content-Type": "application/json"},
        json={"useProxy": True, "solveCaptcha": True},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    print(f"[steel] Session: {data.get('id')}  viewer: {data.get('sessionViewerUrl', 'N/A')}")
    return data


def release_steel_session(session_id: str):
    try:
        requests.delete(
            f"https://api.steel.dev/v1/sessions/{session_id}",
            headers={"Steel-Api-Key": STEEL_API_KEY},
            timeout=15,
        )
        print(f"[steel] Session {session_id} released")
    except Exception as e:
        print(f"[steel] Release error: {e}")


# ── Playwright helpers ────────────────────────────────────────────────────────

def ss_path(name: str) -> str:
    return str(RESULTS_DIR / f"steel_{name}_{int(time.time())}.png")


async def snap(page, name: str):
    path = ss_path(name)
    await page.screenshot(path=path, full_page=True)
    print(f"  📸 {path}")


async def fill(page, selector: str, value: str, label: str):
    """Fill a visible input by selector. Uses fill() for speed; falls back to JS."""
    if not value:
        print(f"  – skip '{label}' (empty)")
        return
    try:
        el = await page.wait_for_selector(selector, timeout=6000, state="visible")
        await el.scroll_into_view_if_needed()
        await asyncio.sleep(0.2)
        # fill() is instant (JS-based) and works for both <input> and <textarea>
        await el.fill(str(value))
        # Fire React synthetic events so form state updates
        await page.evaluate(f"""(sel) => {{
            const el = document.querySelector(sel);
            if (el) {{
                el.dispatchEvent(new Event('input',  {{bubbles:true}}));
                el.dispatchEvent(new Event('change', {{bubbles:true}}));
            }}
        }}""", selector.split(",")[0].strip())
        print(f"  ✓ {label}")
    except Exception as e:
        print(f"  ✗ {label}: {e}")


async def select_bamboohr_dropdown(page, sel_name: str, option_text: str, label: str):
    """
    BambooHR hides native <select> elements and renders custom button dropdowns.
    Strategy:
      1. Check if already showing correct value — skip if so
      2. Click the visible trigger button
      3. Wait for listbox, click matching option (broad selectors)
      4. Fallback: force-set via JS native value setter (waits for options to load)
    """
    if not option_text:
        print(f"  – skip '{label}' (empty)")
        return

    sel_escaped = sel_name.replace("'", "\\'")
    opt_escaped = option_text.replace("'", "\\'")

    # Step 0: Check if the visible button already shows the correct value
    already = await page.evaluate(f"""() => {{
        const sel = document.querySelector("select[name='{sel_escaped}']");
        if (!sel) return 'no_select';
        let el = sel.parentElement;
        for (let i = 0; i < 8; i++) {{
            if (!el) break;
            const btn = el.querySelector('button:not([type="submit"]):not([type="reset"])');
            if (btn && btn.offsetParent !== null) return btn.textContent.trim();
            el = el.parentElement;
        }}
        return '';
    }}""")
    if already and option_text.lower() in already.lower():
        print(f"  ✓ {label} (already set: {already.strip()[:30]})")
        return

    # Step 1: Click the visible trigger button
    clicked = await page.evaluate(f"""() => {{
        const sel = document.querySelector("select[name='{sel_escaped}']");
        if (!sel) return 'no_select';
        let el = sel.parentElement;
        for (let i = 0; i < 8; i++) {{
            if (!el) break;
            const btn = el.querySelector('button:not([type="submit"]):not([type="reset"])');
            if (btn && btn.offsetParent !== null) {{
                btn.click();
                return 'clicked:' + btn.textContent.trim().slice(0, 30);
            }}
            el = el.parentElement;
        }}
        return 'no_button';
    }}""")
    print(f"  [dropdown] trigger result: {clicked}")

    await asyncio.sleep(1.2)

    # Step 2: Try to click the matching list option (broad selectors, longer wait)
    try:
        await page.click(
            f"[role='option']:has-text('{option_text}'), "
            f"[role='listbox'] li:has-text('{option_text}'), "
            f"li.fab-Select__option:has-text('{option_text}'), "
            f"[class*='Select__option']:has-text('{option_text}'), "
            f"[class*='option']:has-text('{option_text}'), "
            f"li:has-text('{option_text}')",
            timeout=4000,
        )
        print(f"  ✓ {label} (custom dropdown)")
        await asyncio.sleep(0.5)
        return
    except Exception:
        await page.keyboard.press("Escape")
        await asyncio.sleep(0.5)

    # Step 3: JS fallback — wait a tick for options to populate, then force value
    result = await page.evaluate(f"""() => {{
        const sel = document.querySelector("select[name='{sel_escaped}']");
        if (!sel) return 'no_select';
        const opts = [...sel.options];
        const opt = opts.find(o => o.text.trim().toLowerCase() === '{opt_escaped}'.toLowerCase());
        if (!opt) {{
            const available = opts.map(o => o.text.trim()).filter(Boolean).slice(0, 15);
            return 'no_option:' + available.join('|');
        }}
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, opt.value);
        sel.dispatchEvent(new Event('input',  {{ bubbles: true }}));
        sel.dispatchEvent(new Event('change', {{ bubbles: true }}));
        return 'js_ok:' + opt.text;
    }}""")
    if result and result.startswith("js_ok:"):
        print(f"  ✓ {label} (JS force: {result})")
    else:
        print(f"  ✗ {label}: {result}")


async def click_radio(page, name: str, value_or_label: str):
    """Click a radio button: scroll into view, try by value, then by label via JS."""
    name_esc = name.replace("'", "\\'")
    val_esc  = value_or_label.replace("'", "\\'")

    # Scroll the first radio in this group into view before clicking
    await page.evaluate(f"""() => {{
        const r = document.querySelector("input[type='radio'][name='{name_esc}']");
        if (r) r.scrollIntoView({{block:'center'}});
    }}""")
    await asyncio.sleep(0.2)

    # Try by value (force=True bypasses visibility checks)
    try:
        await page.check(
            f"input[type='radio'][name='{name}'][value='{value_or_label}']",
            timeout=3000, force=True
        )
        print(f"  ✓ radio '{name}' = '{value_or_label}' (by value)")
        return
    except Exception:
        pass

    # Try by label text via JS click (works even for React-managed inputs)
    result = await page.evaluate(f"""() => {{
        const radios = [...document.querySelectorAll("input[type='radio'][name='{name_esc}']")];
        for (const r of radios) {{
            const lbl = r.closest('label') || r.parentElement?.querySelector('label') || document.querySelector(`label[for='${{r.id}}']`);
            if (lbl && lbl.textContent.trim() === '{val_esc}') {{
                r.scrollIntoView({{block:'center'}});
                r.click();
                return 'ok:' + lbl.textContent.trim();
            }}
        }}
        return 'not_found';
    }}""")
    if result and result.startswith("ok:"):
        print(f"  ✓ radio '{name}' = '{value_or_label}' (by label)")
    else:
        print(f"  ✗ radio '{name}' = '{value_or_label}': {result}")


async def _select_state(page, state_name: str) -> bool:
    """
    BambooHR State dropdown — click trigger, wait for portal listbox, click option.
    Falls back to JS native setter if portal click fails.
    """
    state_esc = state_name.replace("'", "\\'")

    # Use Playwright click (fires proper React mouse events) on the state trigger
    # Locate state select → walk up to find closest ancestor that has a visible button
    trigger_clicked = False
    try:
        # XPath: find the state <select>, go up ancestors until we find one with a button
        state_btn = page.locator("select[name='state.value']").locator(
            "xpath=ancestor::div[.//button][1]//button[not(@type='submit')]"
        ).first
        await state_btn.scroll_into_view_if_needed()
        await state_btn.click(timeout=4000)
        print(f"  [state] Playwright trigger clicked")
        trigger_clicked = True
    except Exception as e:
        print(f"  [state] Playwright trigger failed: {e}")

    if not trigger_clicked:
        # Fallback: click any button near the state select
        try:
            await page.click(
                "select[name='state.value'] ~ button, "
                "button:near(select[name='state.value'])",
                timeout=3000
            )
            print(f"  [state] near-button clicked")
        except Exception:
            pass

    await asyncio.sleep(2.0)  # give portal time to render

    # Strategy 1: Playwright built-in locator (works with portals)
    try:
        loc = page.get_by_role("option", name=state_name, exact=True)
        await loc.click(timeout=3000)
        print(f"  ✓ State '{state_name}' (role=option)")
        return True
    except Exception:
        pass

    # Strategy 2: broad text-based selectors
    for selector in [
        f"[role='option']:has-text('{state_name}')",
        f"[role='listbox'] li:has-text('{state_name}')",
        f"li:has-text('{state_name}')",
        f"[class*='option']:has-text('{state_name}')",
        f"[class*='Select__option']:has-text('{state_name}')",
    ]:
        try:
            await page.click(selector, timeout=2000)
            print(f"  ✓ State '{state_name}' ({selector[:30]})")
            return True
        except Exception:
            continue

    # Strategy 3: get_by_text Playwright locator
    try:
        await page.get_by_text(state_name, exact=True).first.click(timeout=2000)
        print(f"  ✓ State '{state_name}' (get_by_text)")
        return True
    except Exception:
        pass

    # Strategy 4: JS — walk ALL elements including portals for exact text match
    result = await page.evaluate(f"""() => {{
        for (const el of document.querySelectorAll('*')) {{
            if (el.children.length === 0
                && el.textContent.trim() === '{state_esc}'
                && el.offsetParent !== null) {{
                el.scrollIntoView({{block:'center'}});
                el.click();
                return 'js_ok';
            }}
        }}
        return 'not_found';
    }}""")
    if result == "js_ok":
        print(f"  ✓ State '{state_name}' (JS text walk)")
        return True

    # Strategy 5: force-set native select value (works if options are in <select>)
    result2 = await page.evaluate(f"""() => {{
        const sel = document.querySelector("select[name='state.value']");
        if (!sel) return 'no_select';
        const opt = [...sel.options].find(o => o.text.trim() === '{state_esc}');
        if (!opt) return 'no_option:' + [...sel.options].map(o=>o.text.trim()).slice(0,5).join('|');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, opt.value);
        sel.dispatchEvent(new Event('input',  {{bubbles:true}}));
        sel.dispatchEvent(new Event('change', {{bubbles:true}}));
        return 'native_ok:' + opt.text;
    }}""")
    if result2 and result2.startswith("native_ok:"):
        print(f"  ✓ State '{state_name}' (native setter)")
        return True

    await page.keyboard.press("Escape")
    print(f"  ✗ State: {result2} — leaving blank")
    return False


# ── Main apply flow ───────────────────────────────────────────────────────────

async def run_apply(cdp_url: str):
    async with async_playwright() as pw:
        print(f"[playwright] Connecting to Steel session…")
        browser = await pw.chromium.connect_over_cdp(cdp_url)
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = context.pages[0] if context.pages else await context.new_page()

        try:
            # ── 1. Load the page ───────────────────────────────────────────
            print(f"\n[apply] Navigating to {URL}")
            await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
            await asyncio.sleep(4)
            await snap(page, "01_loaded")
            print(f"  URL: {page.url}")

            # ── 2. Click Apply button (BambooHR SPA — form appears in-place)
            form_check = await page.query_selector("#firstName, input[name='firstName']")
            if not form_check:
                print("[apply] Clicking Apply button…")
                for text in ["Apply for This Job", "Apply Now", "Apply for this job", "Apply"]:
                    btn = await page.query_selector(
                        f"a:has-text('{text}'), button:has-text('{text}')"
                    )
                    if btn:
                        await btn.click()
                        print(f"  ✓ Clicked '{text}'")
                        break

                # Wait for form to appear (SPA — no page navigation)
                try:
                    await page.wait_for_selector(
                        "#firstName, input[name='firstName']",
                        timeout=15000, state="visible"
                    )
                    print("  ✓ Form appeared")
                except Exception:
                    print("  ✗ Form did not appear — taking error screenshot")
                    await snap(page, "ERROR_no_form")
                    return

            await asyncio.sleep(1)
            await snap(page, "02_form_visible")

            # ── 3. Fill standard fields ────────────────────────────────────
            print("\n[apply] Filling personal info…")
            await fill(page, "#firstName, input[name='firstName']",      FIRST,    "First Name")
            await fill(page, "#lastName,  input[name='lastName']",       LAST,     "Last Name")
            await fill(page, "#email,     input[name='email']",          EMAIL,    "Email")
            await fill(page, "#phone,     input[name='phone']",          PHONE,    "Phone")

            print("\n[apply] Filling address…")
            await fill(page, "input[name='streetAddress.value']",        ADDRESS,  "Street Address")
            await fill(page, "input[name='city.value']",                 CITY,     "City")
            await fill(page, "input[name='zip.value']",                  ZIP_CODE, "ZIP")

            print("\n[apply] Selecting Country & State…")
            await select_bamboohr_dropdown(page, "countryId.value", COUNTRY, "Country")
            await asyncio.sleep(1.5)  # wait for state options to populate after country change

            # State: click trigger then wait for portal listbox, click the state option
            await _select_state(page, STATE)

            print("\n[apply] Filling employment fields…")
            await fill(page, "#desiredPay, input[name='desiredPay']",    SALARY,   "Desired Pay")
            await fill(page, "input[placeholder='yyyy-mm-dd']",          START,    "Start Date")
            await fill(page, "#linkedinUrl, input[name='linkedinUrl']",  LINKEDIN, "LinkedIn")
            await fill(page, "#websiteUrl,  input[name='websiteUrl']",   WEBSITE,  "Website")

            await snap(page, "03_standard_done")

            # ── 4. Resume upload ───────────────────────────────────────────
            resume_path = profile.get("resume_path", "")
            if resume_path and Path(resume_path).exists():
                print(f"\n[apply] Uploading resume: {resume_path}")
                try:
                    file_input = await page.wait_for_selector("input[type='file']", timeout=5000)
                    await file_input.set_input_files(resume_path)
                    print("  ✓ Resume uploaded")
                except Exception as e:
                    print(f"  ✗ Resume upload failed: {e}")
            else:
                print("\n[apply] Resume: skipping (add resume_path to profile.json to enable)")

            # ── 5. Custom questions ────────────────────────────────────────
            print("\n[apply] Answering custom questions…")

            # Scroll through the page slowly to force React to render all question elements
            for pct in [0.33, 0.66, 1.0]:
                await page.evaluate(f"window.scrollTo(0, document.body.scrollHeight * {pct})")
                await asyncio.sleep(0.5)
            await asyncio.sleep(0.5)  # settle

            # ── 5a. Radio questions ────────────────────────────────────────
            radio_groups = await page.evaluate("""() => {
                const seen = new Set();
                const groups = [];
                document.querySelectorAll('input[type="radio"]').forEach(r => {
                    if (seen.has(r.name)) return;
                    seen.add(r.name);
                    const container = r.closest('fieldset, [class*="FormColumn"], [class*="Question"]');
                    const labelEl = container
                        ? container.querySelector('label, legend')
                        : null;
                    const questionText = labelEl
                        ? labelEl.textContent.trim().replace(/\\s*\\*\\s*$/, '').trim()
                        : r.name;
                    const options = [...document.querySelectorAll(
                        `input[type='radio'][name='${r.name}']`
                    )].map(rb => {
                        const lbl = rb.closest('label') || rb.parentElement?.querySelector('label');
                        return { value: rb.value, label: lbl ? lbl.textContent.trim() : rb.value };
                    });
                    groups.push({ name: r.name, question: questionText, options });
                });
                return groups;
            }""")

            for group in radio_groups:
                q = group["question"]
                name = group["name"]
                answer_entry = CUSTOM_ANSWERS.get(q)
                if answer_entry and answer_entry[0] == "radio":
                    _, answer_label = answer_entry
                    match = next(
                        (o["value"] for o in group["options"] if o["label"] == answer_label),
                        None
                    )
                    target = match if match else answer_label
                    await click_radio(page, name, target)
                    # Retry once after a brief scroll if the first attempt may have failed
                    await asyncio.sleep(0.3)
                elif not answer_entry:
                    # Default: pick first option for unknown radio questions
                    if group["options"]:
                        print(f"  ⚠ Unknown radio '{q}' — first: {group['options'][0]['label']}")
                        await click_radio(page, name, group["options"][0]["value"])

            # ── 5b. Text / textarea questions ─────────────────────────────
            text_questions = await page.evaluate("""() => {
                const results = [];
                document.querySelectorAll('textarea, input[type="text"]:not([name])').forEach(el => {
                    if (el.type === 'file') return;
                    const container = el.closest('[class*="FormColumn"], [class*="Question"], div');
                    let labelEl = null;
                    if (container) {
                        labelEl = container.querySelector('label');
                        if (!labelEl) {
                            // walk up to find label sibling
                            let parent = el.parentElement;
                            for (let i = 0; i < 5 && parent; i++) {
                                labelEl = parent.querySelector('label');
                                if (labelEl) break;
                                parent = parent.parentElement;
                            }
                        }
                    }
                    const questionText = labelEl
                        ? labelEl.textContent.trim().replace(/\\s*\\*\\s*$/, '').trim()
                        : '';
                    if (questionText && el.name && el.name.startsWith('customQuestion')) {
                        results.push({ name: el.name, question: questionText, tag: el.tagName.toLowerCase() });
                    }
                });
                return results;
            }""")

            for tq in text_questions:
                q = tq["question"]
                answer_entry = CUSTOM_ANSWERS.get(q)
                if answer_entry and answer_entry[0] == "text":
                    answer = answer_entry[1]
                    sel = f"textarea[name='{tq['name']}'], input[name='{tq['name']}']"
                    await fill(page, sel, answer, f"Text: {q[:40]}")

            await snap(page, "04_all_filled")

            # ── 6. Submit ──────────────────────────────────────────────────
            if not SUBMIT:
                print(f"\n[apply] 🔍 DRY RUN — all fields filled, NOT submitting")
                print(f"        Run with --submit flag to actually submit")
                await asyncio.sleep(5)
            else:
                print("\n[apply] Preparing to submit…")

                # BambooHR's Submit Application button is always in a sticky footer
                # at the very bottom. Scroll there first, wait for reCAPTCHA solve,
                # then click it.

                # Step 1: Scroll to the absolute bottom so the sticky footer is visible
                print("  → Scrolling to bottom for Submit button…")
                await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                await asyncio.sleep(1.5)

                # Step 2: Wait for Steel.dev to auto-solve the reCAPTCHA (already handled
                # by solveCaptcha=True on session creation — just give it time)
                print("  → Waiting for reCAPTCHA solve (Steel.dev handles automatically)…")
                await asyncio.sleep(4)

                await snap(page, "05_pre_submit")

                # Step 3: Find and click the Submit Application button
                # BambooHR uses: <button type="submit"> with text "Submit Application"
                print("\n[apply] Clicking Submit Application…")
                try:
                    # Try specific text first ("Submit Application"), then fallback
                    submit_btn = None
                    for selector in [
                        "button:has-text('Submit Application')",
                        "button[type='submit']:has-text('Submit')",
                        "button[type='submit']",
                        "input[type='submit']",
                    ]:
                        try:
                            submit_btn = await page.wait_for_selector(selector, timeout=4000, state="visible")
                            if submit_btn:
                                print(f"  → Found submit button via: {selector}")
                                break
                        except Exception:
                            continue

                    if not submit_btn:
                        print("  ✗ Submit button not found — taking error screenshot")
                        await snap(page, "05_submit_not_found")
                    else:
                        await submit_btn.scroll_into_view_if_needed()
                        await asyncio.sleep(0.8)
                        await submit_btn.click()
                        print("  ✓ Submit Application clicked — waiting for confirmation…")

                        # Wait for page transition / success message
                        await asyncio.sleep(8)
                        await snap(page, "05_submitted")

                        body = await page.text_content("body") or ""
                        if any(p in body.lower() for p in [
                            "thank you", "application received", "submitted",
                            "we'll be in touch", "we have received", "application complete"
                        ]):
                            print("\n[apply] ✅ APPLICATION SUBMITTED SUCCESSFULLY")
                        else:
                            print("\n[apply] ⚠ Submit clicked but confirmation text not detected — check screenshot")

                except Exception as e:
                    print(f"  ✗ Submit error: {e}")
                    await snap(page, "05_submit_error")

        except Exception as e:
            print(f"\n[apply] ❌ Error: {e}")
            await snap(page, "ERROR")
        finally:
            await browser.close()


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("  BambooHR Apply — Steel.dev")
    print(f"  Name:   {FIRST} {LAST}")
    print(f"  Email:  {EMAIL}")
    print(f"  URL:    {URL}")
    print(f"  Mode:   {'SUBMIT' if SUBMIT else 'DRY RUN (add --submit to submit)'}")
    print("=" * 60)

    session = create_steel_session()
    session_id = session["id"]
    raw_ws = session.get("websocketUrl") or session.get("cdpUrl") or ""

    if not raw_ws:
        print(f"[steel] ERROR: no websocket URL in session response: {session}")
        return

    # Steel requires the API key as a query param on the websocket URL
    sep = "&" if "?" in raw_ws else "?"
    cdp_url = f"{raw_ws}{sep}apiKey={STEEL_API_KEY}"

    # Show live viewer URL
    viewer = session.get("sessionViewerUrl", "")
    if viewer:
        print(f"\n[steel] 👀 Watch live: {viewer}\n")

    try:
        asyncio.run(run_apply(cdp_url))
    finally:
        release_steel_session(session_id)


if __name__ == "__main__":
    main()
