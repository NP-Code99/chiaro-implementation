"""
Live debug + apply script for a single BambooHR URL.
Run:  python debug_bamboohr.py
It prints every form field it finds, fills them, and saves screenshots at each step.
Browser stays open 60s on error so you can inspect.
"""
import asyncio, json, time, os, yaml
from pathlib import Path
from playwright.async_api import async_playwright

URL = "https://lxt.bamboohr.com/careers/526?utm_source=startup.jobs&utm_medium=organic"
PROFILE = yaml.safe_load(Path("profile.yaml").read_text())
P = PROFILE["personal"]
A = P.get("address", {})
E = PROFILE["employment"]
RESUME = PROFILE.get("resume_path", "")
DRY_RUN = True  # ← set False to actually submit

os.makedirs("results", exist_ok=True)


async def ss(page, name):
    path = f"results/debug_{name}_{int(time.time())}.png"
    await page.screenshot(path=path, full_page=True)
    print(f"  📸 {path}")
    return path


async def dump_fields(page):
    """Print every input, select, textarea on the page."""
    fields = await page.evaluate("""() => {
        const els = [...document.querySelectorAll('input, select, textarea')];
        return els.map(el => ({
            tag:  el.tagName,
            type: el.type || '',
            id:   el.id || '',
            name: el.name || '',
            placeholder: el.placeholder || '',
            value: el.value || '',
            visible: el.offsetParent !== null,
        }));
    }""")
    print("\n── FIELDS ON PAGE ──────────────────────────────────")
    for f in fields:
        if f["visible"]:
            print(f"  {f['tag']:10} id={f['id']!r:20} name={f['name']!r:25} "
                  f"type={f['type']!r:12} placeholder={f['placeholder']!r}")
    print("────────────────────────────────────────────────────\n")
    return fields


async def safe_fill(page, selector, value, label):
    """Fill a field by selector; log result."""
    if not value or str(value).startswith("["):
        print(f"  – skip '{label}' (no value in profile.yaml)")
        return False
    try:
        el = await page.wait_for_selector(selector, timeout=4000, state="visible")
        await el.scroll_into_view_if_needed()
        await asyncio.sleep(0.3)
        await el.fill("")
        await el.type(str(value), delay=70)
        print(f"  ✓ {label}")
        return True
    except Exception as e:
        print(f"  ✗ {label}: {e}")
        return False


async def safe_select(page, selector, value, label):
    try:
        await page.select_option(selector, label=value, timeout=4000)
        print(f"  ✓ {label} (select)")
        return True
    except Exception:
        pass
    try:
        await page.select_option(selector, value=value, timeout=2000)
        print(f"  ✓ {label} (select by value)")
        return True
    except Exception as e:
        print(f"  ✗ {label}: {e}")
        return False


async def try_click_apply(page):
    """Click Apply button; return True if we land on a form."""
    for text in ["Apply for This Job", "Apply Now", "Apply for this job", "Apply"]:
        try:
            btn = await page.query_selector(
                f"a:has-text('{text}'), button:has-text('{text}')"
            )
            if btn:
                print(f"  ▶ Clicking '{text}'…")
                # Intercept popup/new tab
                async with page.expect_navigation(timeout=10000, wait_until="networkidle") as nav:
                    await btn.click()
                await nav.value
                print(f"  ✓ Navigated to: {page.url}")
                return True
        except Exception as e:
            # Navigation may not fire (SPA / modal); just wait
            try:
                await page.wait_for_selector("input[name='firstName'], #firstName", timeout=5000)
                print(f"  ✓ Form appeared after clicking '{text}'")
                return True
            except Exception:
                pass
    return False


async def main():
    print(f"\n{'='*60}")
    print(f"  BambooHR Debug Apply")
    print(f"  URL: {URL}")
    print(f"  DRY_RUN: {DRY_RUN}")
    print(f"{'='*60}\n")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
            ],
        )
        ctx = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="en-US",
        )
        await ctx.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )
        page = await ctx.new_page()

        try:
            # ── 1. Load the page ────────────────────────────────────────────
            print("1. Loading page…")
            await page.goto(URL, wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(3)
            await ss(page, "01_landed")
            print(f"   URL now: {page.url}")

            # ── 2. Check if form is already visible ─────────────────────────
            form_visible = await page.query_selector("input[name='firstName'], #firstName")
            if form_visible:
                print("2. Form already visible — no Apply button needed")
            else:
                print("2. Looking for Apply button…")
                await dump_fields(page)
                await ss(page, "02_before_apply_click")
                clicked = await try_click_apply(page)
                if not clicked:
                    # Try navigating directly to the /apply URL
                    apply_url = page.url.split("?")[0].rstrip("/") + "/apply"
                    print(f"   No button found; trying direct apply URL: {apply_url}")
                    await page.goto(apply_url, wait_until="domcontentloaded", timeout=15000)
                    await asyncio.sleep(2)
                await ss(page, "03_after_apply_click")

            # Wait for the form
            print("3. Waiting for form fields…")
            try:
                await page.wait_for_selector(
                    "input[name='firstName'], #firstName, input[name='email']",
                    timeout=10000, state="visible"
                )
                print("   ✓ Form is ready")
            except Exception:
                print("   ✗ Form fields not found — dumping page for inspection")
                await dump_fields(page)
                await ss(page, "04_form_not_found")
                print("   Keeping browser open 60s for manual inspection…")
                await asyncio.sleep(60)
                return

            await dump_fields(page)
            await ss(page, "05_form_ready")

            # ── 3. Fill fields ──────────────────────────────────────────────
            print("4. Filling form fields…")

            await safe_fill(page, "input[name='firstName'], #firstName", P["first_name"], "First Name")
            await safe_fill(page, "input[name='lastName'], #lastName",   P["last_name"],  "Last Name")
            await safe_fill(page, "input[name='email'], #email",         P["email"],       "Email")
            await safe_fill(page, "input[name='phone'], #phone",         P["phone"],       "Phone")

            # Address block
            await safe_fill(page, "input[name='address'], #address",     A.get("street",""), "Street")
            await safe_fill(page, "input[name='city'], #city",           A.get("city",""),   "City")
            await safe_fill(page, "input[name='zip'], #zip, input[name='postalCode']",
                            A.get("zip",""), "ZIP")

            # Country — try native select first, then Select2 widget
            country = A.get("country", "United States")
            if not await safe_select(page, "select[name='country']", country, "Country"):
                # Select2 custom dropdown
                try:
                    triggers = [
                        ".country-select .select2-selection",
                        "[data-field='country'] .select2-selection",
                        "select[name='country'] + span .select2-selection",
                    ]
                    for trig in triggers:
                        el = await page.query_selector(trig)
                        if el:
                            await el.click()
                            await asyncio.sleep(0.5)
                            search = await page.query_selector(".select2-search__field, input[role='combobox']")
                            if search:
                                await search.type(country[:4], delay=80)
                                await asyncio.sleep(0.5)
                            opt = await page.query_selector(f".select2-results__option:has-text('{country}')")
                            if opt:
                                await opt.click()
                                print(f"  ✓ Country (Select2)")
                            break
                except Exception as e:
                    print(f"  ✗ Country (Select2): {e}")

            await asyncio.sleep(0.5)

            # State
            state = A.get("state", "")
            if state:
                if not await safe_select(page, "select[name='state'], #state", state, "State"):
                    print(f"  ✗ State '{state}' — leaving default")

            await ss(page, "06_fields_filled")

            # ── 4. Resume upload ────────────────────────────────────────────
            if RESUME and not RESUME.startswith("["):
                print("5. Uploading resume…")
                try:
                    inp = await page.wait_for_selector("input[type='file']", timeout=5000)
                    await inp.set_input_files(RESUME)
                    print("   ✓ Resume uploaded")
                    await asyncio.sleep(1)
                except Exception as e:
                    print(f"   ✗ Resume upload: {e}")
            else:
                print("5. Skipping resume — set resume_path in profile.yaml")

            await ss(page, "07_resume_uploaded")

            # ── 5. Submit ───────────────────────────────────────────────────
            if DRY_RUN:
                print("\n🔍 DRY RUN — not submitting. Browser stays open 30s.")
                await ss(page, "08_dryrun_final")
                await asyncio.sleep(30)
            else:
                print("6. Submitting…")
                for sel in [
                    "button[type='submit']",
                    "input[type='submit']",
                    "button:has-text('Submit Application')",
                    "button:has-text('Submit')",
                ]:
                    try:
                        btn = await page.wait_for_selector(sel, timeout=3000)
                        if btn:
                            await btn.scroll_into_view_if_needed()
                            await btn.click()
                            print(f"   ✓ Clicked submit ({sel})")
                            await asyncio.sleep(5)
                            await ss(page, "09_submitted")
                            break
                    except Exception:
                        continue

        except Exception as e:
            print(f"\n❌ Unhandled error: {e}")
            await ss(page, "ERROR")
            print("   Browser stays open 60s for inspection…")
            await asyncio.sleep(60)
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
