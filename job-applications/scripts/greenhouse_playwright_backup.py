"""
Greenhouse application script.
Targets:
  https://www.digicert.com/careers?gh_jid=8524673002#application_form
  https://job-boards.greenhouse.io/scoutmotors/jobs/5128323007
"""
import asyncio, json, os, sys, yaml
from pathlib import Path
from utils.browser import new_browser, human_delay, screenshot
from utils.captcha import check_and_solve
from utils.form_filler import fill_text, upload_file, submit_and_confirm
from utils.cover_letter import generate_cover_letter
from utils.logger import log

_PROFILE_YAML = Path(__file__).parent.parent / "profile.yaml"

def _load():
    global PROFILE, P, E, D
    try:
        PROFILE = yaml.safe_load(_PROFILE_YAML.read_text())
    except Exception:
        PROFILE = {}
    P = PROFILE.get("personal", {})
    E = PROFILE.get("employment", {})
    D = PROFILE.get("demographics", {})

PROFILE: dict = {}; P: dict = {}; E: dict = {}; D: dict = {}
_load()
DRY_RUN = "--dry-run" in sys.argv

# ── Greenhouse custom dropdown helper ─────────────────────────────────────────

async def _gh_select(page, label_text: str, value: str) -> bool:
    """
    Fill a Greenhouse custom dropdown (the styled divs with ▼).
    Greenhouse uses a React select component — find by label, click to open,
    then click the matching option.
    Returns True if successfully selected.
    """
    # Find the label element, then the associated select/custom-select nearby
    label_el = None
    for lb_sel in [
        f"label:has-text('{label_text}')",
        f"span:has-text('{label_text}')",
        f"div:has-text('{label_text}')",
    ]:
        try:
            label_el = await page.query_selector(lb_sel)
            if label_el:
                break
        except Exception:
            pass

    if not label_el:
        return False

    # 1. Try native select first (fastest path)
    try:
        parent = await label_el.evaluate_handle("el => el.closest('.field, .form-field, [class*=\"field\"], [class*=\"form\"], div')")
        if parent:
            native_sel = await parent.query_selector("select")
            if native_sel:
                try:
                    await page.select_option(await native_sel.get_attribute("id") or "select", label=value)
                    log(f"  ✓ gh-select (native) '{label_text}' ← {value}")
                    return True
                except Exception:
                    pass
    except Exception:
        pass

    # 2. Find select by for= attribute on label
    for_id = await label_el.get_attribute("for") if label_el else None
    if for_id:
        try:
            await page.select_option(f"#{for_id}", label=value)
            log(f"  ✓ gh-select (for-id) '{label_text}' ← {value}")
            return True
        except Exception:
            pass
        # Custom dropdown with same id
        try:
            trigger = await page.query_selector(f"#{for_id}")
            if trigger:
                await trigger.click()
                await human_delay(300, 500)
                await page.click(f"text={value}", timeout=2000)
                log(f"  ✓ gh-select (custom) '{label_text}' ← {value}")
                return True
        except Exception:
            pass

    # 3. Try Greenhouse's generic custom select pattern:
    #    click the first "Select..." placeholder near the label, then pick option
    try:
        # Greenhouse wraps each question in a div.field or similar
        # Find the container that has our label text, then find its select trigger
        js_result = await page.evaluate("""(labelText) => {
            const all = document.querySelectorAll('label, [class*="label"]');
            for (const lb of all) {
                if (!lb.textContent.includes(labelText)) continue;
                // Walk up to the field container
                const container = lb.closest('[class*="field"], [class*="question"], div');
                if (!container) continue;
                // Find a native select or a custom select trigger
                const sel = container.querySelector('select');
                if (sel) return {type: 'native', id: sel.id, name: sel.name};
                const trigger = container.querySelector('[class*="select"], [role="combobox"], [data-select]');
                if (trigger) return {type: 'custom', id: trigger.id, class: trigger.className};
                return null;
            }
            return null;
        }""", label_text)

        if js_result:
            if js_result.get("type") == "native":
                sel_id = js_result.get("id") or js_result.get("name")
                await page.select_option(f"#{sel_id}" if js_result.get("id") else f"[name='{sel_id}']", label=value)
                log(f"  ✓ gh-select (js-native) '{label_text}' ← {value}")
                return True
    except Exception:
        pass

    return False


_GH_EXTRACT_ALL_DROPDOWNS_JS = """() => {
    const results = [];
    const seen = new Set();

    function getLabel(el) {
        if (el.id) {
            const lb = document.querySelector('label[for="' + el.id + '"]');
            if (lb) return lb.textContent.trim().replace(/\\s*\\*\\s*$/, '').trim();
        }
        const ariaLb = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        if (ariaLb && !ariaLb.includes(' ')) {
            const lbEl = document.getElementById(ariaLb);
            if (lbEl) return lbEl.textContent.trim();
        }
        if (ariaLb) return ariaLb.trim();
        const container = el.closest('[class*="field"], [class*="form"], [class*="question"], fieldset, div');
        if (container) {
            const lbEl = container.querySelector('label, [class*="label"], legend');
            if (lbEl && !lbEl.contains(el)) return lbEl.textContent.trim().replace(/\\s*\\*\\s*$/, '').trim();
        }
        return el.name || el.id || '';
    }

    // 1. Native <select> elements
    document.querySelectorAll('select').forEach(sel => {
        if (!sel.offsetParent) return;
        if (sel.value && sel.value !== '' && sel.value !== '0') return;
        const opts = Array.from(sel.options)
            .map(o => o.text.trim())
            .filter(t => t && !['select...', 'select', '', '-- select --', '-- select one --'].includes(t.toLowerCase()));
        if (!opts.length) return;
        const key = sel.id || sel.name;
        if (seen.has(key)) return;
        seen.add(key);
        results.push({
            type: 'native',
            selector: sel.id ? '#' + sel.id : (sel.name ? '[name="' + sel.name + '"]' : null),
            label: getLabel(sel),
            options: opts,
        });
    });

    // 2. React Select custom dropdowns (Greenhouse uses these for custom questions)
    // Pattern A: containers with class containing "css-" and "container"
    // Pattern B: elements with role="combobox" that aren't native selects
    // Pattern C: divs that look like select triggers (have aria-haspopup="listbox")

    const customSelectors = [
        '[role="combobox"]',
        '[aria-haspopup="listbox"]',
        '[class*="react-select__control"]',
        '[class*="__control"][class*="css-"]',
    ];

    customSelectors.forEach(csel => {
        document.querySelectorAll(csel).forEach(el => {
            if (!el.offsetParent) return;
            if (el.tagName === 'SELECT' || el.tagName === 'INPUT') return;

            // Find the container to get the label
            const container = el.closest('[class*="field"], [class*="question"], [class*="form-group"], fieldset, div[id]');
            const label = container ? getLabel(container.querySelector('label, [class*="label"]') || container) : getLabel(el);
            if (!label) return;

            const key = 'custom:' + label;
            if (seen.has(key)) return;
            seen.add(key);

            // Try to get the current value (placeholder or selected text)
            const valueEl = el.querySelector('[class*="single-value"], [class*="placeholder"]') || el;
            const currentText = (valueEl.textContent || '').trim();
            const isPlaceholder = el.querySelector('[class*="placeholder"]') !== null;

            // Only include if not yet filled (still showing placeholder)
            if (!isPlaceholder && currentText && !['select...', 'select'].includes(currentText.toLowerCase())) {
                return; // already filled
            }

            // Build a CSS selector for this element
            let elSel = null;
            if (el.id) elSel = '#' + el.id;
            else if (el.getAttribute('aria-controls')) elSel = '[aria-controls="' + el.getAttribute('aria-controls') + '"]';
            else if (el.className) {
                // Use the most specific class
                const classes = el.className.split(' ').filter(c => c.includes('css-') || c.includes('select') || c.includes('control'));
                if (classes.length) elSel = '.' + classes[0].replace(/:/g, '\\\\:');
            }

            results.push({
                type: 'custom',
                selector: elSel,
                elementIndex: Array.from(document.querySelectorAll(csel)).indexOf(el),
                querySelector: csel,
                label: label,
                options: [],  // will be fetched after clicking
                currentText: currentText,
            });
        });
    });

    return results;
}"""


async def _react_select_choose(page, field_info: dict, chosen_value: str) -> bool:
    """
    Interact with a React Select (or similar) custom dropdown.
    1. Click the control to open it
    2. Wait for options to appear
    3. Click the matching option
    Returns True on success.
    """
    csel = field_info.get("querySelector", '[role="combobox"]')
    idx = field_info.get("elementIndex", 0)
    sel = field_info.get("selector")
    label = field_info.get("label", "dropdown")

    try:
        # Find the clickable control element
        if sel:
            try:
                ctrl = await page.wait_for_selector(sel, timeout=3000, state="visible")
            except Exception:
                ctrl = None
        else:
            ctrl = None

        if not ctrl:
            # Fall back to index-based selection
            all_controls = await page.query_selector_all(csel)
            if idx >= len(all_controls):
                return False
            ctrl = all_controls[idx]

        if not ctrl:
            return False

        await ctrl.scroll_into_view_if_needed()
        await human_delay(200, 400)
        await ctrl.click()
        await human_delay(400, 700)

        # Wait for options to appear
        option_selectors = [
            '[role="option"]',
            '[class*="__option"]',
            '[class*="react-select__option"]',
            '[class*="menu"] [class*="option"]',
        ]

        options_visible = False
        for opt_sel in option_selectors:
            try:
                await page.wait_for_selector(opt_sel, timeout=2000, state="visible")
                options_visible = True
                break
            except Exception:
                continue

        if not options_visible:
            log(f"  ✗ custom dropdown '{label}' — no options appeared after click")
            await page.keyboard.press("Escape")
            return False

        # Find and click the matching option
        chosen_lower = chosen_value.lower()
        opts = await page.query_selector_all('[role="option"], [class*="__option"]')
        for opt in opts:
            text = (await opt.inner_text()).strip()
            if text.lower() == chosen_lower or chosen_lower in text.lower() or text.lower() in chosen_lower:
                await opt.click()
                log(f"  ✓ custom-select '{label}' ← {text}")
                await human_delay(200, 400)
                return True

        # No exact match — try partial
        for opt in opts:
            text = (await opt.inner_text()).strip()
            if any(word in text.lower() for word in chosen_lower.split() if len(word) > 3):
                await opt.click()
                log(f"  ✓ custom-select '{label}' ← {text} (partial match for '{chosen_value}')")
                await human_delay(200, 400)
                return True

        log(f"  ✗ custom-select '{label}' — no option matched '{chosen_value}'")
        await page.keyboard.press("Escape")
        return False

    except Exception as exc:
        log(f"  ✗ custom-select '{label}': {exc}")
        try:
            await page.keyboard.press("Escape")
        except Exception:
            pass
        return False


async def _gh_select_all_remaining(page, profile: dict) -> None:
    """
    Find every unfilled dropdown (native <select> AND React Select custom components)
    and fill them using demographic profile data or Claude for custom questions.
    """
    try:
        import anthropic as _anthropic
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        client = _anthropic.Anthropic(api_key=api_key) if api_key else None
    except ImportError:
        client = None

    p = profile.get("personal", {})
    wa = profile.get("work_authorization", {})
    d = profile.get("demographics", {})
    e = profile.get("employment", {})

    candidate_context = (
        f"Candidate: {p.get('first_name')} {p.get('last_name')}, "
        f"location: {p.get('address', {}).get('city')}, {p.get('address', {}).get('state')}, "
        f"work auth: {'authorized, no sponsorship needed' if wa.get('authorized_to_work') and not wa.get('requires_sponsorship') else 'needs sponsorship'}, "
        f"experience: {e.get('years_of_experience')} years, "
        f"title: {e.get('current_title', '')}"
    )

    unfilled = await page.evaluate(_GH_EXTRACT_ALL_DROPDOWNS_JS)
    if not unfilled:
        log("[greenhouse] No unfilled dropdowns found")
        return

    log(f"[greenhouse] Found {len(unfilled)} unfilled dropdowns ({sum(1 for f in unfilled if f['type'] == 'native')} native, {sum(1 for f in unfilled if f['type'] == 'custom')} custom)")

    # EEO/demographic keyword mapping
    eeo_keywords = {
        "gender":       d.get("gender", "Prefer not to say"),
        "sex":          d.get("gender", "Prefer not to say"),
        "race":         d.get("ethnicity", "Prefer not to say"),
        "ethnicity":    d.get("ethnicity", "Prefer not to say"),
        "veteran":      d.get("veteran_status", "I don't wish to answer"),
        "disability":   d.get("disability_status", "I don't wish to answer"),
        "country":      p.get("address", {}).get("country", "United States"),
    }

    for field_info in unfilled:
        field_type = field_info.get("type", "native")
        label = (field_info.get("label") or "").lower()
        opts = field_info.get("options", [])
        chosen = None

        # --- Determine value ---
        # 1. EEO/demographic match by label keyword
        for keyword, val in eeo_keywords.items():
            if keyword in label:
                if field_type == "native" and opts:
                    for opt in opts:
                        if val.lower() in opt.lower() or opt.lower() in val.lower():
                            chosen = opt
                            break
                    if not chosen:
                        # Fallback: pick "prefer not" / "don't wish" option
                        for opt in opts:
                            if any(x in opt.lower() for x in ["prefer not", "wish to answer", "decline", "no answer"]):
                                chosen = opt
                                break
                else:
                    # Custom dropdown — we'll try the demographic value directly
                    chosen = val
                break

        # 2. Work authorization
        if not chosen:
            if any(kw in label for kw in ["authorized", "work authorization", "legally authorized", "visa", "sponsorship"]):
                if "sponsor" in label:
                    chosen_bool = wa.get("requires_sponsorship", False)
                    chosen = "Yes" if chosen_bool else "No"
                else:
                    chosen_bool = wa.get("authorized_to_work", True)
                    chosen = "Yes" if chosen_bool else "No"

        # 3. Years of experience
        if not chosen and any(kw in label for kw in ["years of experience", "experience level", "how many years"]):
            yrs = str(e.get("years_of_experience", ""))
            if field_type == "native" and opts:
                for opt in opts:
                    if yrs in opt:
                        chosen = opt
                        break
            else:
                chosen = yrs

        # 4. Ask Claude for unknown custom questions
        if not chosen and client:
            try:
                if field_type == "native" and opts:
                    prompt = f"""{candidate_context}

Question label: "{field_info.get('label', label)}"
Available options: {json.dumps(opts)}

Pick the single best option for this candidate. Return ONLY the exact option text, nothing else."""
                else:
                    prompt = f"""{candidate_context}

Form question: "{field_info.get('label', label)}"
This is a dropdown field. What should the candidate answer? Keep it brief (1-3 words if possible)."""

                msg = client.messages.create(
                    model="claude-haiku-4-5-20251001",
                    max_tokens=50,
                    messages=[{"role": "user", "content": prompt}],
                )
                raw = msg.content[0].text.strip().strip('"').strip("'")
                if field_type == "native" and opts:
                    for opt in opts:
                        if raw.lower() == opt.lower() or raw.lower() in opt.lower():
                            chosen = opt
                            break
                    if not chosen:
                        chosen = raw
                else:
                    chosen = raw
            except Exception as exc:
                log(f"  ✗ Claude error for '{label}': {exc}")
                continue

        if not chosen:
            log(f"  – skipping '{label}' (no value determined)")
            continue

        # --- Execute the selection ---
        if field_type == "native":
            sel = field_info.get("selector")
            if not sel:
                continue
            try:
                await page.select_option(sel, label=chosen)
                log(f"  ✓ native-select '{label}' ← {chosen}")
                await human_delay(200, 400)
            except Exception:
                try:
                    await page.select_option(sel, value=chosen)
                    log(f"  ✓ native-select-value '{label}' ← {chosen}")
                except Exception as exc2:
                    log(f"  ✗ native-select '{label}': {exc2}")
        else:
            # Custom dropdown interaction
            ok = await _react_select_choose(page, field_info, chosen)
            if not ok:
                log(f"  ✗ could not fill custom dropdown '{label}'")


async def apply(url: str):
    _load()
    global DRY_RUN
    DRY_RUN = "--dry-run" in sys.argv
    log(f"\n[greenhouse] Starting → {url}")
    pw, browser, _, page = await new_browser()

    try:
        await page.goto(url, wait_until="networkidle", timeout=30000)
        await check_and_solve(page)
        await human_delay(1500, 2500)

        if "#application_form" in url:
            await page.evaluate("document.querySelector('#application_form')?.scrollIntoView()")
            await human_delay(800, 1500)

        log("[greenhouse] Filling standard fields...")

        await fill_text(page, "#first_name, input[name='job_application[first_name]']", P["first_name"], "First Name")
        await fill_text(page, "#last_name, input[name='job_application[last_name]']", P["last_name"], "Last Name")
        await fill_text(page, "#email, input[name='job_application[email]']", P["email"], "Email")
        await fill_text(page, "#phone, input[name='job_application[phone]']", P["phone"], "Phone")

        # Country code select (phone prefix) — Greenhouse uses a native select
        try:
            await page.select_option("select#phone_country_code, select[name*='country_code']", value="1")
            log("  ✓ phone country code ← +1")
        except Exception:
            pass

        # Country select
        addr = P.get("address", {})
        country = addr.get("country", "United States")
        try:
            await page.select_option("select#country, select[name*='country']", label=country)
            log(f"  ✓ country ← {country}")
        except Exception:
            pass

        for sel in ["input[type='file']", "#resume_upload", "input[name='resume']"]:
            try:
                await upload_file(page, sel, PROFILE["resume_path"], "Resume")
                break
            except Exception:
                pass

        await fill_text(page, "input[name*='linkedin'], input[placeholder*='LinkedIn']", P.get("linkedin", ""), "LinkedIn")
        await fill_text(page, "input[name*='github'], input[placeholder*='GitHub']", P.get("github", ""), "GitHub")
        await fill_text(page, "input[name*='website'], input[placeholder*='website'], input[placeholder*='portfolio']", P.get("portfolio", ""), "Website")

        for sel in ["#cover_letter", "textarea[name*='cover_letter']", "textarea[placeholder*='cover']"]:
            try:
                el = await page.query_selector(sel)
                if el:
                    cl = generate_cover_letter("the position", "the company", PROFILE, PROFILE.get("cover_letter_tone", "Professional"))
                    await fill_text(page, sel, cl, "Cover Letter")
                    break
            except Exception:
                pass

        # EEO dropdowns — by standard Greenhouse IDs
        eeo_map = [
            ("select#gender",            D.get("gender", "Prefer not to say")),
            ("select#race",              D.get("ethnicity", "Prefer not to say")),
            ("select#veteran_status",    D.get("veteran_status", "I don't wish to answer")),
            ("select#disability_status", D.get("disability_status", "I don't wish to answer")),
        ]
        for sel, val in eeo_map:
            try:
                await page.wait_for_selector(sel, timeout=1500)
                await page.select_option(sel, label=val)
                log(f"  ✓ eeo {sel} ← {val}")
            except Exception:
                pass  # field doesn't exist on this form

        # Scroll down to reveal all sections
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
        await human_delay(800, 1200)
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        await human_delay(800, 1200)

        # Fill all remaining custom question dropdowns with Claude
        log("[greenhouse] Filling custom question dropdowns with Claude...")
        await _gh_select_all_remaining(page, PROFILE)

        await human_delay(500, 1000)

        if not DRY_RUN:
            await check_and_solve(page)
            await submit_and_confirm(page, "#submit_app, button[type='submit'], input[type='submit']", "greenhouse", screenshot)
        else:
            await screenshot(page, "greenhouse_dryrun")
            log("[greenhouse] 🔍 DRY RUN — form filled but not submitted")

    except Exception as e:
        log(f"[greenhouse] ❌ Error: {e}")
        await screenshot(page, "greenhouse_error")
        raise
    finally:
        await browser.close()
        await pw.stop()

if __name__ == "__main__":
    url = sys.argv[sys.argv.index("--url") + 1] if "--url" in sys.argv else \
          "https://job-boards.greenhouse.io/scoutmotors/jobs/5128323007"
    asyncio.run(apply(url))
