"""
Trakstar application script.
Targets:
  https://caixamagica.hire.trakstar.com/jobs/fk0zv8a/?apply=true
  https://footballradar.hire.trakstar.com/jobs/fk0zvva/?apply=true
  https://xideral.hire.trakstar.com/jobs/fk0zx3n/?apply=true
"""
import asyncio, sys, yaml
from pathlib import Path
from utils.browser import new_browser, human_delay, screenshot
from utils.captcha import check_and_solve
from utils.form_filler import fill_text, select_option, upload_file, submit_and_confirm
from utils.cover_letter import generate_cover_letter
from utils.logger import log

_PROFILE_YAML = Path(__file__).parent.parent / "profile.yaml"

def _load():
    global PROFILE, P
    try:
        PROFILE = yaml.safe_load(_PROFILE_YAML.read_text())
    except Exception:
        PROFILE = {}
    P = PROFILE.get("personal", {})

PROFILE: dict = {}; P: dict = {}
_load()
DRY_RUN = "--dry-run" in sys.argv

async def apply(url: str):
    _load()
    global DRY_RUN
    DRY_RUN = "--dry-run" in sys.argv
    log(f"\n[trakstar] Starting → {url}")
    pw, browser, _, page = await new_browser()

    try:
        await page.goto(url, wait_until="networkidle", timeout=30000)
        await check_and_solve(page)
        await human_delay(1500, 2500)

        for step in range(1, 6):
            log(f"[trakstar] Filling step {step}...")
            await check_and_solve(page)

            await fill_text(page, "input[name*='first'], input[placeholder*='First']", P["first_name"], "First Name")
            await fill_text(page, "input[name*='last'], input[placeholder*='Last']", P["last_name"], "Last Name")
            await fill_text(page, "input[type='email'], input[name*='email']", P["email"], "Email")
            await fill_text(page, "input[type='tel'], input[name*='phone']", P["phone"], "Phone")
            await fill_text(page, "input[name*='linkedin'], input[placeholder*='LinkedIn']", P["linkedin"], "LinkedIn")

            await upload_file(page, "input[type='file']", PROFILE["resume_path"], "Resume")

            for cl_sel in ["textarea[name*='cover'], textarea[placeholder*='cover'], textarea[name*='letter']"]:
                try:
                    el = await page.query_selector(cl_sel)
                    if el:
                        cl = generate_cover_letter("the role", "the company", PROFILE, PROFILE.get("cover_letter_tone", "Professional"))
                        await fill_text(page, cl_sel, cl, "Cover Letter")
                        break
                except Exception:
                    pass

            next_clicked = False
            for btn in ["button:has-text('Next')", "button:has-text('Continue')", "input[value='Next']"]:
                try:
                    el = await page.query_selector(btn)
                    if el:
                        await el.click()
                        await human_delay(1000, 2000)
                        next_clicked = True
                        break
                except Exception:
                    pass

            submit_el = await page.query_selector("button[type='submit'], input[type='submit'], button:has-text('Submit')")
            if submit_el:
                break

            if not next_clicked:
                break

        if not DRY_RUN:
            await submit_and_confirm(page, "button[type='submit'], input[type='submit'], button:has-text('Submit')", "trakstar", screenshot)
        else:
            await screenshot(page, "trakstar_dryrun")
            log("[trakstar] 🔍 DRY RUN — form filled but not submitted")

    except Exception as e:
        log(f"[trakstar] ❌ Error: {e}")
        await screenshot(page, "trakstar_error")
        raise
    finally:
        await browser.close()
        await pw.stop()

if __name__ == "__main__":
    url = sys.argv[sys.argv.index("--url") + 1] if "--url" in sys.argv else \
          "https://caixamagica.hire.trakstar.com/jobs/fk0zv8a/?apply=true"
    asyncio.run(apply(url))
