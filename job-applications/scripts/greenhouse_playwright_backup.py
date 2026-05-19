"""
Greenhouse Playwright filler.

Primary path: fetch questions from the API, compute answers with map_answers(),
then fill the new Remix-based job-boards.greenhouse.io UI via Playwright.

The new Greenhouse UI uses:
  - <input id="field_name"> for text/email/phone fields
  - <input id="question_XXXXXXX"> for custom text questions
  - React Select components with aria-labelledby="field_name-label" for dropdowns
  - <input id="resume"> / <input id="cover_letter"> hidden file inputs
  - <select id="gender"> etc. for EEO native selects

Falls back to blind best-effort fill when API is unavailable.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.browser import new_browser, human_delay, screenshot
from utils.logger import log
from utils.profile_loader import load_profile

DRY_RUN = "--dry-run" in sys.argv


# ── React Select helper ────────────────────────────────────────────────────────

async def _fill_dropdown(page, field_name: str, label_text: str) -> bool:
    """
    Fill a React Select dropdown for a given Greenhouse field_name.
    DOM structure: INPUT#field_name[role=combobox] → input-container → value-container → select__control
    Must use Playwright's native mouse click (not JS .click()) to trigger React events.
    """
    try:
        # The React Select combobox input has id matching the field name
        inp = await page.query_selector(f'input#{field_name}[role="combobox"]')
        if not inp:
            inp = await page.query_selector(f'input[aria-labelledby*="{field_name}-label"]')
        if not inp:
            log(f"  ✗ dropdown {field_name}: input not found")
            return False

        await inp.scroll_into_view_if_needed()
        await human_delay(150, 250)

        # Get center coordinates of the .select__control div (3 levels above the input)
        # input → input-container → value-container → select__control
        coords = await page.evaluate("""(fn) => {
            const inp = document.querySelector(`input#${fn}[role="combobox"]`)
                     || document.querySelector(`input[aria-labelledby*="${fn}-label"]`);
            if (!inp) return null;
            const ctrl = inp.parentElement?.parentElement?.parentElement;
            if (!ctrl) return null;
            const r = ctrl.getBoundingClientRect();
            return {x: r.left + r.width / 2, y: r.top + r.height / 2};
        }""", field_name)

        if coords:
            await page.mouse.click(coords["x"], coords["y"])
        else:
            await inp.click()
        await human_delay(300, 500)

        # Open the dropdown: ArrowDown on the focused input (most reliable for React Select)
        await inp.focus()
        await human_delay(150, 250)
        await inp.press("ArrowDown")
        await human_delay(400, 600)

        # Wait for at least one NEW visible option to appear
        # The ITI phone library pre-renders 244+ hidden [role=option] elements —
        # only count visible ones (offsetParent !== null).
        visible_opts = []
        for _ in range(10):  # poll up to ~2s
            visible_opts = await page.evaluate("""() =>
                Array.from(document.querySelectorAll('[role="option"]'))
                    .filter(o => o.offsetParent !== null)
                    .map(o => o.textContent.trim())
            """)
            if visible_opts:
                break
            await human_delay(200, 250)

        if not visible_opts:
            log(f"  ✗ dropdown {field_name}: no visible options after ArrowDown")
            await page.keyboard.press("Escape")
            return False

        # Click the matching visible option via JavaScript (avoids stale handle issues)
        label_lower = label_text.lower()
        matched = await page.evaluate("""([labelLower]) => {
            const opts = Array.from(document.querySelectorAll('[role="option"]'))
                             .filter(o => o.offsetParent !== null);
            // Exact match first
            for (const o of opts) {
                if (o.textContent.trim().toLowerCase() === labelLower) {
                    o.click();
                    return o.textContent.trim();
                }
            }
            // Substring match
            for (const o of opts) {
                const t = o.textContent.trim().toLowerCase();
                if (t.includes(labelLower) || labelLower.includes(t)) {
                    o.click();
                    return o.textContent.trim();
                }
            }
            return null;
        }""", [label_lower])

        if matched:
            log(f"  ✓ dropdown '{field_name}' ← {matched}")
            await human_delay(150, 300)
            return True

        log(f"  ✗ dropdown '{field_name}': no visible option matched '{label_text}' (got: {visible_opts[:4]})")
        await page.keyboard.press("Escape")
        return False

    except Exception as exc:
        log(f"  ✗ dropdown '{field_name}': {exc}")
        try:
            await page.keyboard.press("Escape")
        except Exception:
            pass
        return False


# ── EEO native selects ─────────────────────────────────────────────────────────

def _eeo_hint(field: str, profile_val: str) -> list[str]:
    """Return ordered label hints for Greenhouse EEO options, best match first."""
    v = profile_val.lower()
    if field == "veteran_status":
        if "not" in v or "no" in v:
            return ["I am not a protected veteran", "not a protected", "I don't wish", "Decline"]
        return ["I don't wish to answer", "Decline", "I am not a protected veteran"]
    if field == "disability_status":
        if "no" in v and "disability" in v:
            return ["No, I do not have a disability", "I do not have", "I do not want", "Decline"]
        return ["I do not want", "Decline", "No, I do not have a disability"]
    if field == "hispanic_ethnicity":
        return ["Decline", "I don't wish", "No"]
    # gender, race, other: profile value first, then Decline fallbacks
    return [profile_val, "Decline To Self Identify", "Decline", "I don't wish"]


async def _fill_eeo(page, profile: dict) -> None:
    """Fill Greenhouse EEOC React Select dropdowns at the bottom of the form."""
    d = profile.get("demographics", {})
    eeo_fields = [
        ("gender",            d.get("gender", "Prefer not to say")),
        ("hispanic_ethnicity", "Prefer not to say"),
        ("race",              d.get("ethnicity", "Prefer not to say")),
        ("veteran_status",    d.get("veteran_status", "I don't wish to answer")),
        ("disability_status", d.get("disability_status", "I don't wish to answer")),
    ]
    for field_name, profile_val in eeo_fields:
        inp = await page.query_selector(f"input#{field_name}[role='combobox']")
        if not inp:
            continue
        hints = _eeo_hint(field_name, profile_val)
        for hint in hints:
            ok = await _fill_dropdown(page, field_name, hint)
            if ok:
                break


# ── Core form filler ───────────────────────────────────────────────────────────

async def _fill_form_with_answers(
    page,
    questions: list,
    answers: dict,
    profile: dict,
) -> None:
    """
    Fill the new Greenhouse React UI using pre-computed answers from map_answers().

    answers keys match the API field names (e.g. 'first_name', 'question_17835864004').
    For dropdown fields the answer value is the option value ID; we reverse-look it up
    to get the human label and interact with the React Select.
    """
    resume_path = profile.get("resume_path", "")

    # Build a map: field_name → {type, values, label_for_chosen}
    # so we can resolve dropdown value IDs back to human labels
    field_meta: dict[str, dict] = {}
    for q in questions:
        for f in q.get("fields", []):
            name = f["name"]
            ftype = f["type"]
            values = f.get("values", [])
            ans = answers.get(name)
            chosen_label = None
            if values and ans is not None:
                for v in values:
                    if str(v["value"]) == str(ans):
                        chosen_label = v["label"]
                        break
            field_meta[name] = {
                "type": ftype,
                "values": values,
                "chosen_label": chosen_label,
            }

    # Fill text / textarea fields
    for q in questions:
        for f in q.get("fields", []):
            name = f["name"]
            ftype = f["type"]
            ans = answers.get(name)
            if ans is None or ftype == "input_file":
                continue

            if ftype in ("input_text",):
                # Skip React Select inputs (they have role=combobox; handled as dropdowns)
                is_select = await page.evaluate(
                    f"""() => document.querySelector('input#{name}')?.getAttribute('role') === 'combobox'"""
                )
                if is_select:
                    continue
                try:
                    await page.wait_for_selector(f"#{name}", timeout=1500, state="visible")
                    await page.fill(f"#{name}", str(ans))
                    log(f"  ✓ text #{name} ← {str(ans)[:60]}")
                    await human_delay(100, 200)
                except Exception:
                    pass

            elif ftype == "textarea":
                # The textarea is hidden until the user clicks "Enter manually".
                # Click the reveal button first if the textarea isn't already visible.
                reveal_btn_id = name.replace("_", "-")  # cover_letter_text → cover_letter-text
                try:
                    btn = await page.query_selector(f"#{reveal_btn_id}")
                    if btn:
                        await btn.click()
                        await human_delay(300, 500)
                except Exception:
                    pass
                # Now fill the textarea (try both ID formats)
                html_id = name.replace("_", "-")
                for sel in (f"#{name}", f"#{html_id}"):
                    try:
                        el = await page.query_selector(sel)
                        if el and await el.evaluate("el => el.tagName") == "TEXTAREA":
                            await page.fill(sel, str(ans))
                            log(f"  ✓ textarea {sel} ← {str(ans)[:60]}")
                            await human_delay(100, 200)
                            break
                    except Exception:
                        pass

    # Set phone country code via the React Select with id="country"
    # Determine which country to search for based on profile dial code
    dial_code = (profile.get("personal", {}).get("phone_country_code") or profile.get("phone_country_code") or "+1").strip()
    _DIAL_TO_COUNTRY = {
        "+1": "United States", "+44": "United Kingdom", "+91": "India",
        "+61": "Australia", "+49": "Germany", "+33": "France", "+81": "Japan",
        "+86": "China", "+55": "Brazil", "+52": "Mexico", "+65": "Singapore",
        "+971": "United Arab Emirates", "+972": "Israel", "+31": "Netherlands",
        "+46": "Sweden", "+47": "Norway", "+45": "Denmark", "+358": "Finland",
        "+41": "Switzerland", "+48": "Poland",
    }
    country_search = _DIAL_TO_COUNTRY.get(dial_code, "United States")
    try:
        inp = await page.query_selector('input#country[role="combobox"]')
        if inp:
            await inp.scroll_into_view_if_needed()
            await human_delay(200, 300)
            # Click the .select__control (3 levels above the input)
            coords = await page.evaluate("""() => {
                const inp = document.querySelector('input#country[role="combobox"]');
                if (!inp) return null;
                const ctrl = inp.parentElement?.parentElement?.parentElement;
                if (!ctrl) return null;
                const r = ctrl.getBoundingClientRect();
                return {x: r.left + r.width / 2, y: r.top + r.height / 2};
            }""")
            if coords:
                await page.mouse.click(coords["x"], coords["y"])
            else:
                await inp.click()
            await human_delay(300, 500)
            await inp.focus()
            await inp.press("ArrowDown")
            await human_delay(400, 600)
            # Type the country name to filter options
            await inp.type(country_search, delay=50)
            await human_delay(400, 600)
            country_search_lower = country_search.lower()
            matched = await page.evaluate(f"""() => {{
                const opts = Array.from(document.querySelectorAll('[role="option"]'))
                                 .filter(o => o.offsetParent !== null);
                for (const o of opts) {{
                    if (o.textContent.trim().toLowerCase().includes('{country_search_lower}')) {{
                        o.click();
                        return o.textContent.trim();
                    }}
                }}
                return null;
            }}""")
            if matched:
                log(f"  ✓ phone country code ← {matched}")
            else:
                log(f"  – phone country code: no match found")
                await page.keyboard.press("Escape")
        else:
            log(f"  – phone country code: input#country not found")
    except Exception as exc:
        log(f"  – phone country code: {exc}")

    # Upload resume (the file input is visually hidden; use force)
    if resume_path and Path(resume_path).exists():
        try:
            await page.set_input_files("#resume", resume_path)
            log(f"  ✓ resume uploaded: {Path(resume_path).name}")
            await human_delay(1000, 2000)
        except Exception as exc:
            log(f"  ✗ resume upload: {exc}")

    # Fill dropdown fields (React Select)
    for q in questions:
        for f in q.get("fields", []):
            name = f["name"]
            ftype = f["type"]
            if ftype not in ("multi_value_single_select", "multi_value_multi_select",
                             "single_select", "multi_select"):
                continue
            meta = field_meta.get(name, {})
            chosen_label = meta.get("chosen_label")
            if not chosen_label:
                log(f"  – skip dropdown #{name}: no label resolved")
                continue
            await _fill_dropdown(page, name, chosen_label)

    # Scroll to reveal any lazy-rendered fields
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight / 2)")
    await human_delay(600, 900)
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    await human_delay(600, 900)

    # EEO section
    await _fill_eeo(page, profile)


# ── Main entry points ──────────────────────────────────────────────────────────

async def apply_with_answers(
    url: str,
    questions: list,
    answers: dict,
    profile: dict,
) -> None:
    """
    Called by greenhouse.py after it has computed answers via the API.
    Fills and submits the form using Playwright.
    """
    global DRY_RUN
    DRY_RUN = "--dry-run" in sys.argv

    log(f"\n[greenhouse_pw] ── Browser fill (pre-computed answers) ──")
    log(f"[greenhouse_pw] URL: {url}")

    pw, browser, _, page = await new_browser()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=35000)
        await human_delay(1500, 2500)

        log(f"[greenhouse_pw] Filling {len(answers)} fields...")
        await _fill_form_with_answers(page, questions, answers, profile)

        await human_delay(500, 1000)

        if DRY_RUN:
            await screenshot(page, "greenhouse_dryrun")
            log("[greenhouse_pw] 🔍 DRY RUN — form filled, not submitted")
            return

        # Submit
        submit_sel = "#submit_app, button[type='submit'], input[type='submit']"
        try:
            btn = await page.wait_for_selector(submit_sel, timeout=5000, state="visible")
            await btn.scroll_into_view_if_needed()
            await human_delay(500, 1000)
            await btn.click()
            log("[greenhouse_pw] Clicked submit button")
        except Exception as exc:
            log(f"[greenhouse_pw] ✗ Submit button not found: {exc}")
            await screenshot(page, "greenhouse_submit_error")
            return

        # Wait for confirmation — Greenhouse may redirect to various URLs
        confirmed = False
        try:
            await page.wait_for_url(
                lambda u: any(kw in u for kw in ("confirmation", "confirm", "success", "thank")),
                timeout=25000,
            )
            log(f"[greenhouse_pw] ✅ Submitted — redirected to: {page.url}")
            confirmed = True
        except Exception:
            pass

        if not confirmed:
            # Check for success/thank-you text in DOM
            post_text = await page.evaluate("() => document.body.innerText.toLowerCase()")
            success_keywords = ("thank you", "application received", "successfully submitted",
                                "we've received", "you have applied", "already applied")
            for kw in success_keywords:
                if kw in post_text:
                    log(f"[greenhouse_pw] ✅ Submitted — found '{kw}' in page text")
                    confirmed = True
                    break

        if not confirmed:
            # Check for validation errors (form still showing with errors)
            validation_errors = await page.evaluate("""() =>
                Array.from(document.querySelectorAll('[class*="error-message"], [class*="field-error"], [aria-invalid="true"]'))
                    .map(e => e.textContent.trim()).filter(t => t.length > 1)
            """)
            if validation_errors:
                log(f"[greenhouse_pw] ✗ Validation errors after submit: {validation_errors[:3]}")
            else:
                log(f"[greenhouse_pw] ⚠️  Submit clicked — current URL: {page.url}")

        await screenshot(page, "greenhouse_post_submit" if not confirmed else "greenhouse_confirmed")

    except Exception as exc:
        log(f"[greenhouse_pw] ❌ Error: {exc}")
        await screenshot(page, "greenhouse_error")
        raise
    finally:
        await browser.close()
        await pw.stop()


async def apply(url: str) -> None:
    """
    Standalone entry point. Fetches questions from the API, computes answers,
    then fills the browser form.
    """
    global DRY_RUN
    DRY_RUN = "--dry-run" in sys.argv

    from scripts.greenhouse import (
        parse_greenhouse_url,
        fetch_job_questions,
        map_answers,
    )
    from utils.cover_letter import generate_cover_letter

    profile = load_profile()
    board_token, job_id, api_base, _ = parse_greenhouse_url(url)

    if not board_token or not job_id:
        log("[greenhouse_pw] ❌ Cannot parse URL — giving up")
        return

    try:
        job_data = fetch_job_questions(board_token, job_id, api_base)
        questions = job_data.get("questions", [])
    except Exception as exc:
        log(f"[greenhouse_pw] ❌ API fetch failed: {exc} — cannot pre-compute answers")
        questions = []

    cl_text = ""
    try:
        cl_path = profile.get("cover_letter_path", "generate")
        if not cl_path or cl_path == "generate":
            cl_text = generate_cover_letter(
                job_title=job_data.get("title", "the role") if questions else "the role",
                company=board_token.replace("-", " ").replace("_", " ").title(),
                profile=profile,
                tone=profile.get("cover_letter_tone", "Professional"),
            )
    except Exception as exc:
        log(f"[greenhouse_pw] Cover letter failed: {exc}")

    answers = map_answers(questions, profile, cl_text) if questions else {}
    answers["job_id"] = job_id

    await apply_with_answers(url, questions, answers, profile)


if __name__ == "__main__":
    if "--url" in sys.argv:
        _url = sys.argv[sys.argv.index("--url") + 1]
    else:
        _url = "https://job-boards.greenhouse.io/correlationone/jobs/5997984004"
    asyncio.run(apply(_url))
