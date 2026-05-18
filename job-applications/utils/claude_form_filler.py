"""
Universal Claude-driven form filler.

Strategy:
  1. Extract all interactive form elements from the page via JS
  2. Send the full form structure + user profile to Claude in one API call
  3. Claude returns a JSON action plan (fill, select, check, upload, click)
  4. Execute each action with Playwright

This replaces ATS-specific selector scripts with a single intelligent filler
that works on any job application form.
"""

import asyncio, json, os, re
from pathlib import Path
from utils.logger import log

# ── Anthropic client ───────────────────────────────────────────────────────────

try:
    import anthropic as _anthropic
    _CLAUDE_AVAILABLE = bool(os.environ.get("ANTHROPIC_API_KEY"))
except ImportError:
    _anthropic = None
    _CLAUDE_AVAILABLE = False

_MODEL = "claude-haiku-4-5-20251001"

# ── DOM extraction ─────────────────────────────────────────────────────────────

_EXTRACT_JS = """
() => {
  function getLabel(el) {
    // 1. aria-label
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    // 2. aria-labelledby
    const lbId = el.getAttribute('aria-labelledby');
    if (lbId) {
      const lb = document.getElementById(lbId);
      if (lb) return lb.innerText.trim();
    }
    // 3. <label for="id">
    if (el.id) {
      const lb = document.querySelector('label[for="' + el.id + '"]');
      if (lb) return lb.innerText.trim();
    }
    // 4. wrapping <label>
    const parent = el.closest('label');
    if (parent) return parent.innerText.replace(el.value || '', '').trim();
    // 5. preceding sibling / parent text
    const container = el.closest('[class*="field"], [class*="form"], [class*="input"], div');
    if (container) {
      const lbEl = container.querySelector('label, [class*="label"]');
      if (lbEl && !lbEl.contains(el)) return lbEl.innerText.trim();
    }
    // 6. placeholder
    return el.placeholder || el.name || el.id || '';
  }

  const fields = [];

  // text / email / tel / url / number inputs
  document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"]):not([type="checkbox"]):not([type="radio"])').forEach(el => {
    if (!el.offsetParent) return; // skip hidden
    fields.push({
      tag: 'input',
      type: el.type || 'text',
      id: el.id, name: el.name,
      label: getLabel(el),
      placeholder: el.placeholder,
      value: el.value,
      required: el.required,
      selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : null),
    });
  });

  // textareas
  document.querySelectorAll('textarea').forEach(el => {
    if (!el.offsetParent) return;
    fields.push({
      tag: 'textarea',
      type: 'textarea',
      id: el.id, name: el.name,
      label: getLabel(el),
      placeholder: el.placeholder,
      value: el.value,
      required: el.required,
      selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : null),
    });
  });

  // selects (native)
  document.querySelectorAll('select').forEach(el => {
    if (!el.offsetParent) return;
    const options = Array.from(el.options).map(o => o.text.trim()).filter(Boolean);
    fields.push({
      tag: 'select',
      type: 'select',
      id: el.id, name: el.name,
      label: getLabel(el),
      options: options,
      value: el.value,
      required: el.required,
      selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : null),
    });
  });

  // custom dropdowns (React Select, Greenhouse custom questions, etc.)
  const customDropSelectors = ['[role="combobox"]', '[aria-haspopup="listbox"]'];
  const seenCustom = new Set();
  customDropSelectors.forEach(csel => {
    document.querySelectorAll(csel).forEach(el => {
      if (!el.offsetParent) return;
      if (el.tagName === 'SELECT' || el.tagName === 'INPUT') return; // already captured
      const label = getLabel(el);
      if (!label || seenCustom.has(label)) return;
      // Skip if it looks already filled (has single-value text, not placeholder)
      const placeholder = el.querySelector('[class*="placeholder"]');
      const singleVal = el.querySelector('[class*="single-value"], [class*="value"]');
      const currentText = singleVal ? singleVal.innerText.trim() : (el.innerText || '').trim();
      if (!placeholder && currentText && !['select...', 'select', ''].includes(currentText.toLowerCase())) return;
      seenCustom.add(label);
      // Build selector
      let elSel = el.id ? '#' + el.id : null;
      if (!elSel && el.getAttribute('aria-controls')) elSel = '[aria-controls="' + el.getAttribute('aria-controls') + '"]';
      if (!elSel) {
        const allOfType = Array.from(document.querySelectorAll(csel)).filter(e => e.tagName !== 'SELECT' && e.tagName !== 'INPUT');
        elSel = 'CUSTOM_INDEX:' + allOfType.indexOf(el) + ':' + csel;
      }
      fields.push({
        tag: 'custom-select',
        type: 'custom-select',
        label: label,
        selector: elSel,
        currentText: currentText,
      });
    });
  });

  // checkboxes
  document.querySelectorAll('input[type="checkbox"]').forEach(el => {
    if (!el.offsetParent) return;
    fields.push({
      tag: 'input',
      type: 'checkbox',
      id: el.id, name: el.name,
      label: getLabel(el),
      checked: el.checked,
      required: el.required,
      selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : null),
    });
  });

  // file inputs
  document.querySelectorAll('input[type="file"]').forEach(el => {
    if (!el.offsetParent) return;
    const label = getLabel(el).toLowerCase();
    const kind = label.includes('cover') ? 'cover_letter' : 'resume';
    fields.push({
      tag: 'input',
      type: 'file',
      id: el.id, name: el.name,
      label: getLabel(el),
      fileKind: kind,
      selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : null),
    });
  });

  // submit buttons
  document.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])').forEach(el => {
    if (!el.offsetParent) return;
    const txt = (el.innerText || el.value || '').trim();
    if (!txt) return;
    fields.push({
      tag: 'button',
      type: 'submit',
      label: txt,
      selector: el.id ? '#' + el.id : null,
    });
  });

  return fields;
}
"""


async def extract_form_elements(page) -> list[dict]:
    """Extract all visible interactive form elements from the current page."""
    try:
        elements = await page.evaluate(_EXTRACT_JS)
        return [e for e in elements if e.get("label") or e.get("placeholder") or e.get("name")]
    except Exception as exc:
        log(f"[claude-filler] DOM extraction failed: {exc}")
        return []


# ── Claude planning ────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """\
You are an expert at filling job application forms on behalf of candidates.
Given the form's interactive elements and the candidate's profile, return a JSON array
of actions to completely fill the form.

Action types:
  {"action": "fill",   "selector": "CSS_SELECTOR", "value": "TEXT"}
  {"action": "select", "selector": "CSS_SELECTOR", "value": "EXACT_OPTION_TEXT"}
  {"action": "check",  "selector": "CSS_SELECTOR"}
  {"action": "upload", "selector": "CSS_SELECTOR", "fileKind": "resume"|"cover_letter"}
  {"action": "click",  "selector": "CSS_SELECTOR", "label": "BUTTON_TEXT"}

Rules:
- Use the most specific selector available (prefer #id over [name=...])
- For selects, value must exactly match one of the listed options
- For yes/no questions about work authorization: authorized=Yes, sponsorship=No (unless profile says otherwise)
- For demographic/EEO fields (gender, race, veteran, disability): use "Prefer not to say" / "I don't wish to answer" unless profile specifies
- Skip fields where the answer is genuinely unknown and the field is optional
- For cover letter textareas: generate a brief, professional 2-3 sentence cover letter using profile data
- Include a submit button click as the LAST action only if the caller requests it
- Respond with ONLY valid JSON — no markdown, no explanation
"""


async def ask_claude_fill_plan(
    elements: list[dict],
    profile: dict,
    job_title: str = "the role",
    company: str = "the company",
    include_submit: bool = False,
) -> list[dict]:
    """Call Claude API and get back a list of form-fill actions."""
    if not _CLAUDE_AVAILABLE or not _anthropic:
        log("[claude-filler] No API key — cannot generate fill plan")
        return []

    p = profile.get("personal", {})
    e = profile.get("employment", {})
    wa = profile.get("work_authorization", {})

    profile_summary = {
        "first_name":   p.get("first_name", ""),
        "last_name":    p.get("last_name", ""),
        "email":        p.get("email", ""),
        "phone":        p.get("phone", ""),
        "linkedin":     p.get("linkedin", ""),
        "portfolio":    p.get("portfolio", ""),
        "location":     f"{p.get('city', '')}, {p.get('state', '')}",
        "current_title": e.get("current_title", ""),
        "current_company": e.get("current_company", ""),
        "years_experience": e.get("years_experience", ""),
        "desired_salary":   e.get("desired_salary", ""),
        "available_start":  e.get("available_start_date", "2025-09-01"),
        "authorized_to_work": wa.get("authorized_to_work", True),
        "requires_sponsorship": wa.get("requires_sponsorship", False),
        "visa_status":   wa.get("visa_status", ""),
        "skills":        profile.get("skills", [])[:15],
        "summary":       profile.get("summary", ""),
    }

    user_msg = f"""Job: "{job_title}" at "{company}"

Candidate profile:
{json.dumps(profile_summary, indent=2)}

Form elements on the current page:
{json.dumps(elements, indent=2)}

{"Include a submit button click as the last action." if include_submit else "Do NOT include a submit button click — I will handle submission separately."}

Return the JSON action array now."""

    try:
        client = _anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        msg = client.messages.create(
            model=_MODEL,
            max_tokens=2000,
            system=_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_msg}],
        )
        raw = msg.content[0].text.strip()

        # Strip markdown fences if present
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)

        actions = json.loads(raw)
        if not isinstance(actions, list):
            raise ValueError("Expected JSON array")
        log(f"[claude-filler] Claude returned {len(actions)} actions")
        return actions

    except Exception as exc:
        log(f"[claude-filler] Claude API error: {exc}")
        return []


# ── Action executor ────────────────────────────────────────────────────────────

async def _human_delay(lo=300, hi=700):
    await asyncio.sleep(__import__("random").randint(lo, hi) / 1000)


async def _click_custom_dropdown_option(page, ctrl_el, value: str) -> bool:
    """Click a custom dropdown control, wait for options, click the matching one."""
    try:
        await ctrl_el.scroll_into_view_if_needed()
        await _human_delay(200, 400)
        await ctrl_el.click()
        await _human_delay(400, 700)

        option_selectors = [
            '[role="option"]',
            '[class*="__option"]',
            '[class*="react-select__option"]',
        ]
        for opt_sel in option_selectors:
            try:
                await page.wait_for_selector(opt_sel, timeout=2000, state="visible")
                break
            except Exception:
                continue

        val_lower = value.lower()
        opts = await page.query_selector_all('[role="option"], [class*="__option"]')
        for opt in opts:
            text = (await opt.inner_text()).strip()
            if text.lower() == val_lower or val_lower in text.lower() or text.lower() in val_lower:
                await opt.click()
                await _human_delay(200, 300)
                return True

        await page.keyboard.press("Escape")
        return False
    except Exception:
        try:
            await page.keyboard.press("Escape")
        except Exception:
            pass
        return False


async def execute_action_plan(page, actions: list[dict], profile: dict) -> dict[str, bool]:
    """
    Execute each action from Claude's plan.
    Returns {"submitted": bool, "filled_count": int}.
    """
    resume_path     = profile.get("resume_path", "")
    cover_path      = profile.get("cover_letter_path", "")
    filled          = 0
    submitted       = False

    for action in actions:
        act  = action.get("action", "")
        sel  = action.get("selector", "")
        val  = action.get("value", "")

        try:
            if act == "fill":
                if not sel:
                    continue
                el = await page.wait_for_selector(sel, timeout=4000, state="visible")
                if not el:
                    continue
                await el.triple_click()
                await el.type(val, delay=40)
                filled += 1
                log(f"  fill  {sel[:50]:50} ← {val[:60]}")

            elif act == "select":
                if not sel:
                    continue
                # Handle custom dropdowns (React Select, etc.)
                if sel.startswith("CUSTOM_INDEX:"):
                    parts = sel.split(":", 2)
                    idx = int(parts[1])
                    csel = parts[2]
                    controls = await page.query_selector_all(csel)
                    native_filtered = [c for c in controls if await c.evaluate("el => el.tagName !== 'SELECT' && el.tagName !== 'INPUT'")]
                    if idx < len(native_filtered):
                        ctrl = native_filtered[idx]
                        ok = await _click_custom_dropdown_option(page, ctrl, val)
                        if ok:
                            filled += 1
                            log(f"  custom-select [idx={idx}] ← {val[:60]}")
                    continue
                # Try native select first, fall back to custom dropdown click
                try:
                    await page.select_option(sel, label=val)
                    filled += 1
                    log(f"  select {sel[:50]:50} ← {val[:60]}")
                except Exception:
                    # May be a custom dropdown — try click interaction
                    try:
                        ctrl = await page.query_selector(sel)
                        if ctrl:
                            ok = await _click_custom_dropdown_option(page, ctrl, val)
                            if ok:
                                filled += 1
                                log(f"  custom-select {sel[:50]:50} ← {val[:60]}")
                    except Exception:
                        pass

            elif act == "check":
                if not sel:
                    continue
                el = await page.query_selector(sel)
                if el and not await el.is_checked():
                    await el.check()
                    filled += 1
                    log(f"  check  {sel[:60]}")

            elif act == "upload":
                file_kind = action.get("fileKind", "resume")
                fpath = resume_path if file_kind != "cover_letter" else (cover_path or resume_path)
                if not fpath or not Path(fpath).exists():
                    log(f"  skip upload — file not found: {fpath}")
                    continue
                if not sel:
                    sel = "input[type='file']"
                await page.set_input_files(sel, fpath)
                filled += 1
                log(f"  upload {sel[:50]:50} ← {Path(fpath).name} ({file_kind})")

            elif act == "click":
                label = action.get("label", "button")
                # Don't click submit here — caller controls that
                if any(kw in label.lower() for kw in ("submit", "send application", "apply")):
                    continue
                if sel:
                    el = await page.wait_for_selector(sel, timeout=4000, state="visible")
                    if el:
                        await el.click()
                        await _human_delay(800, 1500)
                        log(f"  click  {sel[:50]:50} ({label})")
                else:
                    await page.click(f"text={label}", timeout=4000)
                    await _human_delay(800, 1500)
                    log(f"  click  text={label}")

        except Exception as exc:
            log(f"  ✗ {act} {sel[:50]} — {exc}")
            await _human_delay(200, 400)

    return {"submitted": submitted, "filled_count": filled}


# ── Submission confirmation detection ─────────────────────────────────────────

# Single source of truth — import from form_filler to avoid drift
from utils.form_filler import check_submission_confirmed


# ── Main entry point ───────────────────────────────────────────────────────────

async def claude_fill_form(
    page,
    profile: dict,
    job_title: str = "the role",
    company: str = "the company",
    dry_run: bool = False,
) -> bool:
    """
    Use Claude to fill the current form page and optionally submit.

    Returns True ONLY if the page shows a submission confirmation after submit.
    Raises RuntimeError if submit button not found or no confirmation detected.
    """
    log("[claude-filler] Extracting form elements...")
    elements = await extract_form_elements(page)

    if not elements:
        log("[claude-filler] No form elements found on page")
        return False

    log(f"[claude-filler] Found {len(elements)} form elements — asking Claude for fill plan...")
    actions = await ask_claude_fill_plan(
        elements, profile, job_title, company, include_submit=False
    )

    if not actions:
        log("[claude-filler] No action plan returned — falling back to manual fill")
        return False

    log(f"[claude-filler] Executing {len(actions)} actions...")
    result = await execute_action_plan(page, actions, profile)
    log(f"[claude-filler] Filled {result['filled_count']} fields")

    if dry_run:
        log("[claude-filler] DRY RUN — skipping submit")
        return True

    # Submit
    log("[claude-filler] Looking for submit button...")
    submit_selectors = [
        "button[type='submit']",
        "input[type='submit']",
        "button:has-text('Submit Application')",
        "button:has-text('Submit')",
        "button:has-text('Send Application')",
        "button:has-text('Apply')",
    ]
    clicked = False
    for sel in submit_selectors:
        try:
            btn = page.locator(sel).first
            if await btn.count() == 0:
                continue
            await btn.scroll_into_view_if_needed()
            await _human_delay(500, 900)
            await btn.click(timeout=5000)
            log("[claude-filler] Submit button clicked — waiting for confirmation...")
            clicked = True
            break
        except Exception:
            continue

    if not clicked:
        raise RuntimeError("Submit button not found — application was NOT submitted")

    # Wait for page to settle then check for confirmation
    await asyncio.sleep(5)
    confirmed = await check_submission_confirmed(page)
    if confirmed:
        log("[claude-filler] ✅ Submission confirmed by page")
        return True

    # Give it a bit more time (some ATSes have slow redirects)
    await asyncio.sleep(3)
    confirmed = await check_submission_confirmed(page)
    if confirmed:
        log("[claude-filler] ✅ Submission confirmed by page (delayed)")
        return True

    raise RuntimeError("Submit clicked but no confirmation found on page — application status unknown")
