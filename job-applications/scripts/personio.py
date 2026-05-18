"""
Personio application script.
Target: https://ionity-gmbh.jobs.personio.de/job/2634069?apply
"""
import asyncio, sys, yaml
from pathlib import Path
from utils.browser import new_browser, human_delay, screenshot
from utils.captcha import check_and_solve
from utils.form_filler import fill_text, select_option, upload_file, check_checkbox_by_label, submit_and_confirm
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
    log(f"\n[personio] Starting → {url}")
    pw, browser, _, page = await new_browser()

    try:
        await page.goto(url, wait_until="networkidle", timeout=30000)
        await check_and_solve(page)
        await human_delay(1500, 2500)

        for btn in ["Apply Now", "Apply", "Jetzt bewerben"]:
            try:
                await page.click(f"text={btn}", timeout=4000)
                await human_delay(1000, 2000)
                break
            except Exception:
                pass

        await check_and_solve(page)
        log("[personio] Filling form fields...")

        await fill_text(page, "input[name='first_name'], input[placeholder*='First']", P["first_name"], "First Name")
        await fill_text(page, "input[name='last_name'], input[placeholder*='Last']", P["last_name"], "Last Name")
        await fill_text(page, "input[name='email'], input[type='email']", P["email"], "Email")
        await fill_text(page, "input[name='phone'], input[type='tel']", P["phone"], "Phone")
        await fill_text(page, "input[name*='linkedin'], input[placeholder*='LinkedIn']", P["linkedin"], "LinkedIn")

        await fill_text(
            page,
            "input[name*='salary'], input[placeholder*='salary'], input[placeholder*='Salary']",
            str(E.get("desired_salary", "")),
            "Salary Expectation"
        )

        await fill_text(
            page,
            "input[name*='start_date'], input[placeholder*='available'], input[name*='earliest']",
            E.get("available_start_date", ""),
            "Available Start Date"
        )

        await upload_file(
            page,
            "input[type='file'][name*='resume'], input[type='file'][name*='cv'], input[type='file']",
            PROFILE["resume_path"],
            "Resume/CV"
        )

        cl_path = PROFILE.get("cover_letter_path", "")
        if cl_path and cl_path != "generate":
            try:
                await upload_file(page, "input[type='file'][name*='cover']", cl_path, "Cover Letter")
            except Exception:
                pass
        else:
            for sel in ["textarea[name*='cover'], textarea[placeholder*='motivat'], textarea[name*='letter']"]:
                try:
                    el = await page.query_selector(sel)
                    if el:
                        cl = generate_cover_letter("Internship", "IONITY", PROFILE, PROFILE.get("cover_letter_tone", "Professional"))
                        await fill_text(page, sel, cl, "Cover Letter")
                        break
                except Exception:
                    pass

        await check_checkbox_by_label(page, "privacy policy")
        await check_checkbox_by_label(page, "data protection")
        await check_checkbox_by_label(page, "Datenschutz")

        if not DRY_RUN:
            await submit_and_confirm(page, "button[type='submit'], input[type='submit'], button:has-text('Submit'), button:has-text('Send Application')", "personio", screenshot)
        else:
            await screenshot(page, "personio_dryrun")
            log("[personio] 🔍 DRY RUN — form filled but not submitted")

    except Exception as e:
        log(f"[personio] ❌ Error: {e}")
        await screenshot(page, "personio_error")
        raise
    finally:
        await browser.close()
        await pw.stop()

if __name__ == "__main__":
    url = sys.argv[sys.argv.index("--url") + 1] if "--url" in sys.argv else \
          "https://ionity-gmbh.jobs.personio.de/job/2634069?apply"
    asyncio.run(apply(url))
