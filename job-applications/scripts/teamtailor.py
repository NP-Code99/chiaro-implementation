"""
TeamTailor application script.
Targets:
  https://mindalterai.na.teamtailor.com/jobs/604800-generative-ai-lead
  https://bunnynet.teamtailor.com/jobs/6636274-staff-software-engineer-magic-containers
"""
import asyncio, sys, yaml
from pathlib import Path
from utils.browser import new_browser, human_delay, screenshot
from utils.captcha import check_and_solve
from utils.form_filler import fill_text, upload_file, submit_and_confirm
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
    log(f"\n[teamtailor] Starting → {url}")
    pw, browser, _, page = await new_browser()

    try:
        await page.goto(url, wait_until="networkidle", timeout=30000)
        await check_and_solve(page)
        await human_delay(1500, 2500)

        for btn in ["Apply for this job", "Apply now", "Apply"]:
            try:
                await page.click(f"text={btn}", timeout=4000)
                await human_delay(1000, 2000)
                break
            except Exception:
                pass

        await check_and_solve(page)
        log("[teamtailor] Filling form fields...")

        await fill_text(page, "input[name='first-name'], input[placeholder*='First']", P["first_name"], "First Name")
        await fill_text(page, "input[name='last-name'], input[placeholder*='Last']", P["last_name"], "Last Name")
        await fill_text(page, "input[name='email'], input[type='email']", P["email"], "Email")
        await fill_text(page, "input[name='phone'], input[type='tel']", P["phone"], "Phone")
        await fill_text(page, "input[name*='linkedin'], input[placeholder*='LinkedIn']", P["linkedin"], "LinkedIn")

        await upload_file(page, "input[type='file']", PROFILE["resume_path"], "Resume")

        for sel in ["textarea[name*='cover'], textarea[placeholder*='cover'], textarea[name*='message'], textarea[name*='letter']"]:
            try:
                el = await page.query_selector(sel)
                if el:
                    company = url.split(".teamtailor")[0].split("//")[-1]
                    cl = generate_cover_letter("the role", company, PROFILE, PROFILE.get("cover_letter_tone", "Professional"))
                    await fill_text(page, sel, cl, "Cover Letter")
                    break
            except Exception:
                pass

        all_inputs = await page.query_selector_all(
            "input[type='text']:not([value]):not([name*='name']):not([name*='email']):not([name*='phone'])"
        )
        for inp in all_inputs:
            try:
                placeholder = await inp.get_attribute("placeholder") or ""
                label_text = placeholder.lower()
                if "url" in label_text or "link" in label_text or "website" in label_text:
                    await inp.fill(P.get("portfolio", P.get("linkedin", "")))
                elif "salary" in label_text or "compensation" in label_text:
                    await inp.fill(str(PROFILE["employment"].get("desired_salary", "")))
            except Exception:
                pass

        if not DRY_RUN:
            await submit_and_confirm(page, "button[type='submit'], input[type='submit'], button:has-text('Send application'), button:has-text('Submit')", "teamtailor", screenshot)
        else:
            await screenshot(page, "teamtailor_dryrun")
            log("[teamtailor] 🔍 DRY RUN — form filled but not submitted")

    except Exception as e:
        log(f"[teamtailor] ❌ Error: {e}")
        await screenshot(page, "teamtailor_error")
        raise
    finally:
        await browser.close()
        await pw.stop()

if __name__ == "__main__":
    url = sys.argv[sys.argv.index("--url") + 1] if "--url" in sys.argv else \
          "https://mindalterai.na.teamtailor.com/jobs/604800-generative-ai-lead"
    asyncio.run(apply(url))
