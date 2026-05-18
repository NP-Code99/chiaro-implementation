"""
Lever application script.
Target: https://jobs.lever.co/zensurance/30cc67bb-bfc9-4f27-9d2b-b50b9186004d/apply
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
    global PROFILE, P, E
    try:
        PROFILE = yaml.safe_load(_PROFILE_YAML.read_text())
    except Exception:
        PROFILE = {}
    P = PROFILE.get("personal", {})
    E = PROFILE.get("employment", {})

PROFILE: dict = {}; P: dict = {}; E: dict = {}
_load()
DRY_RUN = "--dry-run" in sys.argv

async def apply(url: str):
    _load()
    global DRY_RUN
    DRY_RUN = "--dry-run" in sys.argv
    log(f"\n[lever] Starting → {url}")
    pw, browser, _, page = await new_browser()

    try:
        await page.goto(url, wait_until="networkidle", timeout=30000)
        await check_and_solve(page)
        await human_delay(1500, 2500)

        log("[lever] Filling form fields...")

        await fill_text(page, "input[name='name']", f"{P['first_name']} {P['last_name']}", "Full Name")
        await fill_text(page, "input[name='email']", P["email"], "Email")
        await fill_text(page, "input[name='phone']", P["phone"], "Phone")
        await fill_text(page, "input[name='org']", E.get("current_company", ""), "Current Company")
        await fill_text(page, "input[name='urls[LinkedIn]'], input[placeholder*='LinkedIn']", P["linkedin"], "LinkedIn")
        await fill_text(page, "input[name='urls[Portfolio]'], input[placeholder*='Portfolio']", P.get("portfolio", ""), "Portfolio")

        await upload_file(page, "input[type='file']", PROFILE["resume_path"], "Resume")

        cl_sel = "textarea[name='comments'], textarea[placeholder*='cover'], textarea[placeholder*='additional']"
        try:
            el = await page.query_selector(cl_sel)
            if el:
                cl = generate_cover_letter("the role", "Zensurance", PROFILE, PROFILE.get("cover_letter_tone", "Professional"))
                await fill_text(page, cl_sel, cl, "Cover Letter / Comments")
        except Exception:
            pass

        await select_option(page, "select[name*='source'], select[name*='hear']", "Job Board", "Referral Source")

        if not DRY_RUN:
            await submit_and_confirm(page, "button[type='submit'], .application-submit button", "lever", screenshot)
        else:
            await screenshot(page, "lever_dryrun")
            log("[lever] 🔍 DRY RUN — form filled but not submitted")

    except Exception as e:
        log(f"[lever] ❌ Error: {e}")
        await screenshot(page, "lever_error")
        raise
    finally:
        await browser.close()
        await pw.stop()

if __name__ == "__main__":
    url = sys.argv[sys.argv.index("--url") + 1] if "--url" in sys.argv else \
          "https://jobs.lever.co/zensurance/30cc67bb-bfc9-4f27-9d2b-b50b9186004d/apply"
    asyncio.run(apply(url))
