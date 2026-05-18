"""
BambooHR application script.

Field selectors confirmed via live field dump on 2026-05-18:
  - Standard fields use #id names (firstName, lastName, etc.)
  - Address fields use dot-notation names (streetAddress.value, city.value, etc.)
  - Country/State are native <select> elements (countryId.value, state.value)
  - Apply button does SPA navigation — wait for form appearance, NOT page load event

Custom question answers come from profile.yaml under custom_answers:{}.
If a question isn't in custom_answers, Claude API picks the best option.
"""
import asyncio, os, sys, yaml
from pathlib import Path
from anthropic import Anthropic
from playwright.async_api import async_playwright

# Profile is loaded lazily inside apply() so profile_loader can write profile.yaml first.
_PROFILE_YAML = Path(__file__).parent.parent / "profile.yaml"

def _load_profile_globals():
    global PROFILE, P, A, E, CA, RESUME
    try:
        PROFILE = yaml.safe_load(_PROFILE_YAML.read_text())
    except Exception:
        PROFILE = {}
    P  = PROFILE.get("personal", {})
    A  = P.get("address", {})
    E  = PROFILE.get("employment", {})
    CA = PROFILE.get("custom_answers", {})
    RESUME = PROFILE.get("resume_path", "")

PROFILE: dict = {}; P: dict = {}; A: dict = {}; E: dict = {}; CA: dict = {}; RESUME = ""
_load_profile_globals()
DRY_RUN = "--dry-run" in sys.argv

_anthropic = None

def _get_anthropic():
    global _anthropic
    if _anthropic is None:
        key = os.environ.get("ANTHROPIC_API_KEY", "")
        if key:
            _anthropic = Anthropic(api_key=key)
    return _anthropic


# ── helpers ────────────────────────────────────────────────────────────────────

def _log(msg: str):
    print(msg)


async def _ss(page, name: str, folder="results"):
    import time
    os.makedirs(folder, exist_ok=True)
    path = f"{folder}/bamboohr_{name}_{int(time.time())}.png"
    await page.screenshot(path=path, full_page=True)
    _log(f"  📸 {path}")


async def _fill(page, selector: str, value: str, label: str):
    if not value or str(value).startswith("["):
        _log(f"  – skip '{label}' (no value in profile.yaml)")
        return
    try:
        el = await page.wait_for_selector(selector, timeout=5000, state="visible")
        await el.scroll_into_view_if_needed()
        await asyncio.sleep(0.3)
        await el.fill("")
        await el.type(str(value), delay=70)
        _log(f"  ✓ {label}")
    except Exception as e:
        _log(f"  ✗ {label}: {e}")


async def _select(page, selector: str, value: str, label: str):
    """
    Select an option in a BambooHR dropdown.
    BambooHR hides the native <select> (aria-hidden + readonly) and renders a
    custom button-based dropdown on top of it. We click the visible trigger button,
    then type-to-search and click the matching option.
    Falls back to force= on the hidden select if the custom UI isn't found.
    """
    if not value or str(value).startswith("["):
        _log(f"  – skip '{label}' (no value in profile.yaml)")
        return

    sel_js = selector.replace("'", "\\'")
    val_js = value.replace("'", "\\'")

    # Find the hidden select and locate its sibling/ancestor trigger button
    triggered = await page.evaluate(f"""() => {{
        const sel = document.querySelector('{sel_js}');
        if (!sel) return {{ ok: false, reason: 'selector not found' }};
        let container = sel.parentElement;
        for (let i = 0; i < 6; i++) {{
            if (!container) break;
            const btn = container.querySelector(
                'button:not([type="submit"]):not([type="reset"])'
            );
            if (btn && btn.offsetParent !== null) {{
                btn.click();
                return {{ ok: true, btnText: btn.textContent.trim() }};
            }}
            container = container.parentElement;
        }}
        return {{ ok: false, reason: 'no trigger button found' }};
    }}""")

    if triggered.get("ok"):
        await asyncio.sleep(0.6)
        # Type into search box if present
        search = await page.query_selector(
            ".fab-Select__searchInput, input[role='combobox'], "
            "input[placeholder*='Search'], input[placeholder*='search']"
        )
        if search:
            await search.type(value[:6], delay=60)
            await asyncio.sleep(0.4)

        # Click the matching list item
        try:
            await page.click(
                f"li:has-text('{value}'), "
                f"[role='option']:has-text('{value}'), "
                f".fab-Select__option:has-text('{value}')",
                timeout=4000
            )
            _log(f"  ✓ {label} (custom dropdown)")
            return
        except Exception:
            # Press Escape to close and try force-select
            await page.keyboard.press("Escape")

    # Fallback: force-set the hidden native select via JS
    result = await page.evaluate(f"""() => {{
        const sel = document.querySelector('{sel_js}');
        if (!sel) return 'not found';
        const opt = [...sel.options].find(o => o.text.trim() === '{val_js}');
        if (!opt) return 'option not found: ' + [...sel.options].map(o=>o.text).join(', ');
        const setter = Object.getOwnPropertyDescriptor(
            window.HTMLSelectElement.prototype, 'value'
        ).set;
        setter.call(sel, opt.value);
        sel.dispatchEvent(new Event('input', {{bubbles: true}}));
        sel.dispatchEvent(new Event('change', {{bubbles: true}}));
        return 'ok:' + opt.text;
    }}""")

    if result and result.startswith("ok:"):
        _log(f"  ✓ {label} (JS force)")
    else:
        _log(f"  ✗ {label}: {result}")


async def _click_radio(page, name: str, value: str, label: str):
    """Click a radio input by its name attribute and value."""
    try:
        await page.check(f"input[type='radio'][name='{name}'][value='{value}']")
        _log(f"  ✓ Radio '{label}' = '{value}'")
    except Exception as e:
        _log(f"  ✗ Radio '{label}': {e}")


async def _ai_pick_radio(question: str, options: list[dict]) -> str:
    """Ask Claude to pick the best radio option value given a question and option list."""
    client = _get_anthropic()
    if not client:
        return options[0]["value"]  # Default to first option if no API key

    opt_text = "\n".join(f"  value={o['value']!r}  label={o['label']!r}" for o in options)
    profile_summary = (
        f"Name: {P.get('first_name','')} {P.get('last_name','')}\n"
        f"Skills: {PROFILE.get('skills','')}\n"
        f"Years experience: {E.get('years_of_experience','')}\n"
        f"Title: {E.get('current_title','')}\n"
        f"Location: {A.get('city','')}, {A.get('country','')}"
    )
    prompt = (
        f"Job application question: {question}\n\n"
        f"Options:\n{opt_text}\n\n"
        f"Candidate profile:\n{profile_summary}\n\n"
        f"Reply with ONLY the value string of the best option. No explanation."
    )
    try:
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=20,
            messages=[{"role": "user", "content": prompt}],
        )
        picked = resp.content[0].text.strip().strip("'\"")
        valid = [o["value"] for o in options]
        if picked in valid:
            return picked
        return valid[0]
    except Exception:
        return options[0]["value"]


async def _ai_answer_text(question: str) -> str:
    """Ask Claude to write a short answer for an open-text question."""
    client = _get_anthropic()
    if not client:
        return ""
    profile_summary = (
        f"Name: {P.get('first_name','')} {P.get('last_name','')}\n"
        f"Skills: {PROFILE.get('skills','')}\n"
        f"Experience: {E.get('years_of_experience','')} years\n"
        f"Title: {E.get('current_title','')}"
    )
    try:
        resp = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=150,
            messages=[{"role": "user", "content":
                f"Answer this job application question in 1-3 sentences:\n{question}\n\n"
                f"Candidate profile:\n{profile_summary}"}],
        )
        return resp.content[0].text.strip()
    except Exception:
        return ""


# ── custom question handler ────────────────────────────────────────────────────

async def handle_custom_questions(page):
    """
    Read all custom question groups off the page, then answer each one.
    Answers from profile.yaml custom_answers take priority; Claude fills the rest.
    """
    groups = await page.evaluate("""() => {
        const seen = new Set();
        const results = [];

        // BambooHR wraps each question in a div.fab-FormColumn or similar
        document.querySelectorAll('[class*="FormColumn"], fieldset, [class*="Question"]').forEach(row => {
            const labelEl = row.querySelector('label, legend');
            if (!labelEl) return;
            const questionText = labelEl.textContent.trim().replace(/\\s*\\*\\s*$/, '').trim();
            if (!questionText || seen.has(questionText)) return;

            const inputs = [...row.querySelectorAll('input, select, textarea')];
            if (!inputs.length) return;
            seen.add(questionText);

            const firstInput = inputs[0];
            const inputType = firstInput.type || firstInput.tagName.toLowerCase();

            if (inputType === 'radio') {
                // Collect all radio options in this group
                const allRadios = [...document.querySelectorAll(
                    `input[type='radio'][name='${firstInput.name}']`
                )];
                const options = allRadios.map(r => {
                    const lbl = r.closest('label') || r.parentElement?.querySelector('label');
                    return { value: r.value, label: lbl ? lbl.textContent.trim() : r.value };
                });
                results.push({ type: 'radio', question: questionText, name: firstInput.name, options });
            } else if (inputType === 'textarea' || inputType === 'text') {
                results.push({ type: 'text', question: questionText, name: firstInput.name || firstInput.id, id: firstInput.id });
            }
        });
        return results;
    }""")

    _log(f"\n  Handling {len(groups)} custom question(s)…")
    for g in groups:
        q = g["question"]
        # Check profile.yaml custom_answers first
        if q in CA:
            override = CA[q]
            if g["type"] == "radio":
                # Find the value matching the override label
                match = next((o["value"] for o in g["options"] if o["label"] == override), None)
                if match:
                    await _click_radio(page, g["name"], match, q)
                    continue
            elif g["type"] == "text":
                sel = f"#{g['id']}" if g.get("id") else f"[name='{g['name']}']"
                await _fill(page, sel, override, q)
                continue

        # Fall back to Claude
        if g["type"] == "radio":
            picked_value = await _ai_pick_radio(q, g["options"])
            picked_label = next((o["label"] for o in g["options"] if o["value"] == picked_value), picked_value)
            _log(f"  🤖 '{q}' → picked '{picked_label}'")
            await _click_radio(page, g["name"], picked_value, q)
        elif g["type"] == "text":
            answer = await _ai_answer_text(q)
            if answer:
                sel = f"#{g['id']}" if g.get("id") else f"[name='{g['name']}']"
                _log(f"  🤖 '{q}' → '{answer[:60]}…'")
                await _fill(page, sel, answer, q)


# ── main apply function ────────────────────────────────────────────────────────

async def apply(url: str):
    _load_profile_globals()  # re-read profile.yaml in case orchestrator just wrote it
    global DRY_RUN
    DRY_RUN = "--dry-run" in sys.argv
    _log(f"\n[bamboohr] Starting → {url}")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ],
        )
        context = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="en-US",
            timezone_id="America/New_York",
        )
        await context.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"
        )
        page = await context.new_page()

        try:
            # ── 1. Load page ───────────────────────────────────────────────
            _log("[bamboohr] Loading page…")
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(3)
            await _ss(page, "01_landed")

            # ── 2. Click Apply (BambooHR is SPA — form appears in-place) ──
            form_selector = "input[name='firstName'], #firstName"
            already_visible = await page.query_selector(form_selector)

            if not already_visible:
                _log("[bamboohr] Clicking Apply button…")
                for text in ["Apply for This Job", "Apply Now", "Apply for this job", "Apply"]:
                    btn = await page.query_selector(
                        f"a:has-text('{text}'), button:has-text('{text}')"
                    )
                    if btn:
                        await btn.click()
                        _log(f"  ✓ Clicked '{text}'")
                        break

                # Wait for the form to appear — NOT for page navigation
                try:
                    await page.wait_for_selector(form_selector, timeout=12000, state="visible")
                    _log("  ✓ Form appeared")
                except Exception:
                    _log("  ✗ Form didn't appear — trying direct /apply URL")
                    apply_url = url.split("?")[0].rstrip("/") + "/apply"
                    await page.goto(apply_url, wait_until="domcontentloaded", timeout=15000)
                    await asyncio.sleep(2)
                    await page.wait_for_selector(form_selector, timeout=8000, state="visible")

            await asyncio.sleep(1)
            await _ss(page, "02_form_visible")

            # ── 3. Fill standard fields ────────────────────────────────────
            _log("[bamboohr] Filling standard fields…")

            await _fill(page, "#firstName, input[name='firstName']",         P.get("first_name",""),  "First Name")
            await _fill(page, "#lastName, input[name='lastName']",           P.get("last_name",""),   "Last Name")
            await _fill(page, "#email, input[name='email']",                 P.get("email",""),       "Email")
            await _fill(page, "#phone, input[name='phone']",                 P.get("phone",""),       "Phone")
            await _fill(page, "input[name='streetAddress.value']",           A.get("street",""),      "Street Address")
            await _fill(page, "input[name='city.value']",                    A.get("city",""),        "City")
            await _fill(page, "input[name='zip.value']",                     A.get("zip",""),         "ZIP")
            await _fill(page, "#desiredPay, input[name='desiredPay']",       str(E.get("desired_salary","")), "Desired Pay")
            await _fill(page, "input[placeholder='yyyy-mm-dd']",             E.get("available_start_date",""), "Start Date")
            await _fill(page, "#linkedinUrl, input[name='linkedinUrl']",     P.get("linkedin",""),    "LinkedIn")
            await _fill(page, "#websiteUrl, input[name='websiteUrl']",       P.get("portfolio",""),   "Website")

            # ── 4. Country & State (native <select>) ───────────────────────
            country = A.get("country", "United States")
            await _select(page, "select[name='countryId.value']", country, "Country")
            await asyncio.sleep(0.5)
            state = A.get("state", "")
            if state:
                await _select(page, "select[name='state.value']", state, "State")

            # ── 5. Resume upload ───────────────────────────────────────────
            _log("[bamboohr] Uploading resume…")
            if RESUME and not RESUME.startswith("["):
                try:
                    inp = await page.wait_for_selector("input[type='file']", timeout=5000)
                    await inp.set_input_files(RESUME)
                    _log("  ✓ Resume uploaded")
                    await asyncio.sleep(1)
                except Exception as e:
                    _log(f"  ✗ Resume upload: {e}")
            else:
                _log("  – Skipping resume (set resume_path in profile.yaml)")

            await _ss(page, "03_standard_fields_done")

            # ── 6. Custom questions ────────────────────────────────────────
            _log("[bamboohr] Answering custom questions…")
            await handle_custom_questions(page)

            await _ss(page, "04_all_fields_done")

            # ── 7. Submit ──────────────────────────────────────────────────
            if DRY_RUN:
                _log("\n[bamboohr] 🔍 DRY RUN — not submitting")
            else:
                from utils.form_filler import submit_and_confirm
                await submit_and_confirm(
                    page,
                    "button[type='submit']:has-text('Submit'), button[type='submit'], input[type='submit']",
                    "bamboohr",
                    _ss,
                )

        except Exception as e:
            _log(f"[bamboohr] ❌ Unhandled error: {e}")
            await _ss(page, "ERROR")
            raise
        finally:
            await browser.close()


if __name__ == "__main__":
    target = (
        sys.argv[sys.argv.index("--url") + 1]
        if "--url" in sys.argv
        else "https://lxt.bamboohr.com/careers/526?utm_source=startup.jobs&utm_medium=organic"
    )
    asyncio.run(apply(target))
