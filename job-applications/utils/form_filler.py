"""
Reusable form field helpers.
Every function wraps its action in try/except and logs failures without crashing.

IMPORTANT: Playwright does NOT support comma-separated multi-selectors in fill/click/etc.
All helpers here split on ", " and try each selector individually.
"""
import asyncio, random
from utils.browser import human_delay
from utils.logger import log


def _split_selectors(selector: str) -> list[str]:
    """Split a comma-separated selector string into individual selectors."""
    return [s.strip() for s in selector.split(",") if s.strip()]


async def fill_text(page, selector: str, value: str, label="field"):
    """Try each comma-separated selector until one matches, then type into it."""
    if not value or str(value).strip() == "":
        log(f"  – skipping '{label}' (empty value)")
        return

    for sel in _split_selectors(selector):
        try:
            el = await page.wait_for_selector(sel, timeout=2000)
            if not el:
                continue
            await el.scroll_into_view_if_needed()
            await human_delay(300, 700)
            await el.fill("")
            await el.type(str(value), delay=random.randint(60, 120))
            log(f"  ✓ filled '{label}' = '{value}'")
            return
        except Exception:
            continue

    log(f"  ✗ could not fill '{label}' (no selector matched)")


async def select_option(page, selector: str, value: str, label="dropdown"):
    """Try native select_option first, fall back to clicking a custom dropdown."""
    for sel in _split_selectors(selector):
        try:
            await page.wait_for_selector(sel, timeout=2000)
            await human_delay()
            try:
                await page.select_option(sel, label=value)
                log(f"  ✓ selected '{label}' = '{value}'")
                return
            except Exception:
                # Custom dropdown — click it then click the option text
                await page.click(sel)
                await human_delay(300, 600)
                await page.click(f"text={value}")
                log(f"  ✓ custom-selected '{label}' = '{value}'")
                return
        except Exception:
            continue

    log(f"  ✗ could not select '{label}' (no selector matched)")


async def select_by_value(page, selector: str, value: str, label="dropdown"):
    """Select by option value attribute instead of visible text."""
    for sel in _split_selectors(selector):
        try:
            await page.wait_for_selector(sel, timeout=2000)
            await human_delay()
            await page.select_option(sel, value=value)
            log(f"  ✓ selected by value '{label}' = '{value}'")
            return
        except Exception:
            continue

    log(f"  ✗ could not select by value '{label}'")


async def upload_file(page, selector: str, filepath: str, label="file upload"):
    """Try each selector for file inputs."""
    for sel in _split_selectors(selector):
        try:
            await page.wait_for_selector(sel, timeout=2000)
            await page.set_input_files(sel, filepath)
            log(f"  ✓ uploaded '{label}' = '{filepath}'")
            return
        except Exception:
            continue

    log(f"  ✗ could not upload '{label}' (no selector matched)")


async def check_checkbox_by_label(page, label_text: str):
    candidates = [
        f"label:has-text('{label_text}') input[type=checkbox]",
        f"input[type=checkbox][aria-label*='{label_text}']",
        f"input[type=checkbox][name*='{label_text.lower()}']",
    ]
    for sel in candidates:
        try:
            await page.check(sel, timeout=2000)
            log(f"  ✓ checked checkbox: '{label_text}'")
            return
        except Exception:
            continue

    log(f"  ✗ could not check '{label_text}'")


async def click_button(page, selector: str, label="button") -> bool:
    """
    Try each comma-separated selector for a button click.
    Returns True if a button was found and clicked, False otherwise.
    Automatically falls back to JS .click() when an overlay intercepts pointer events.
    """
    for sel in _split_selectors(selector):
        try:
            el = await page.wait_for_selector(sel, timeout=3000, state="visible")
            if not el:
                continue
            await el.scroll_into_view_if_needed()
            await human_delay(300, 600)
            try:
                await el.click(timeout=4000)
            except Exception:
                # Overlay intercept — force JS click
                await page.evaluate(
                    "(el) => el.click()",
                    await el.element_handle(),
                )
            log(f"  ✓ clicked '{label}'")
            return True
        except Exception:
            continue

    # Last-resort: find by text using JS across the whole document
    js_selectors = [
        "button[type='submit']",
        "input[type='submit']",
        "button:not([type])",
    ]
    for js_sel in js_selectors:
        try:
            clicked = await page.evaluate(f"""() => {{
                const el = document.querySelector("{js_sel}");
                if (el && el.offsetParent !== null) {{ el.click(); return true; }}
                return false;
            }}""")
            if clicked:
                log(f"  ✓ clicked '{label}' (JS fallback)")
                return True
        except Exception:
            continue

    log(f"  ✗ could not click '{label}' (no selector matched)")
    return False


async def answer_yes_no(page, question_text: str, answer: str):
    """Find a yes/no question by text and click the appropriate answer."""
    try:
        label = await page.query_selector(f"text={question_text}")
        if label:
            parent = await label.evaluate_handle("el => el.closest('div,fieldset,section')")
            for sel in [
                f"button:has-text('{answer}')",
                f"label:has-text('{answer}')",
                f"input[value='{answer}']",
            ]:
                try:
                    btn = await parent.query_selector(sel)
                    if btn:
                        await btn.click()
                        log(f"  ✓ answered '{question_text}' = '{answer}'")
                        return
                except Exception:
                    continue
        log(f"  ✗ could not find yes/no for: '{question_text}'")
    except Exception as e:
        log(f"  ✗ yes/no error for '{question_text}': {e}")


# ── Submission confirmation ────────────────────────────────────────────────────
# These must be SPECIFIC enough that they only appear AFTER a real submission.
# Do NOT add generic words like "confirmation", "thank you", or "success" alone —
# they appear on many non-submission pages.

_CONFIRM_TEXTS = [
    # Explicit submission language
    "successfully submitted",
    "application has been submitted",
    "application was submitted",
    "application submitted successfully",
    "your application has been received",
    "we received your application",
    "we have received your application",
    "your application is complete",
    "your submission was received",
    "your submission has been received",
    # ATS-specific phrases
    "thank you for applying",          # Greenhouse, Lever
    "thank you for your application",  # BambooHR, Workday
    "thank you for submitting",
    "thanks for applying",             # Lever
    "we'll review your application",
    "we will review your application",
    "application is under review",
    "your application is now under review",
    "application confirmation",        # specific phrase, not just "confirmation"
]

# URL fragments that unambiguously signal a post-submission page
_CONFIRM_URL_PARTS = [
    "thank-you", "thankyou", "thank_you",
    "application-submitted", "apply-submitted",
    "application-complete", "apply-complete",
    "application-received",
    "application-confirmation",
]


async def check_submission_confirmed(page) -> bool:
    """
    Return True ONLY if the page shows unambiguous submission confirmation text.
    Both text and URL checks require application-specific phrases — generic words
    like 'success', 'thank you', or 'confirmation' alone do NOT count.
    """
    current_url = page.url.lower()
    for part in _CONFIRM_URL_PARTS:
        if part in current_url:
            log(f"  ✅ Confirmation URL match: '{part}' in {current_url[:80]}")
            return True
    try:
        body = (await page.inner_text("body")).lower()
        for phrase in _CONFIRM_TEXTS:
            if phrase in body:
                log(f"  ✅ Confirmation text match: '{phrase}'")
                return True
    except Exception:
        pass
    log("  ✗ No submission confirmation found on page")
    return False


async def submit_and_confirm(page, selector: str, ats: str, screenshot_fn=None) -> None:
    """
    Click the submit button then verify a confirmation page appears.
    Raises RuntimeError if the button isn't found OR if no confirmation is detected.
    """
    import asyncio
    clicked = await click_button(page, selector, "Submit")
    if not clicked:
        raise RuntimeError("Submit button not found — could not submit application")

    log(f"[{ats}] Submit clicked — waiting for confirmation...")
    await asyncio.sleep(5)

    confirmed = await check_submission_confirmed(page)
    if not confirmed:
        # One more wait for slow redirects
        await asyncio.sleep(4)
        confirmed = await check_submission_confirmed(page)

    if screenshot_fn:
        await screenshot_fn(page, f"{ats}_confirmation")

    if not confirmed:
        raise RuntimeError(
            "Submit clicked but no confirmation found — application status unknown"
        )
    log(f"[{ats}] ✅ Submission confirmed")
