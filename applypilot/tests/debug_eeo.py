"""Quick script to dump the HTML around EEO fields so we know the exact Select2 structure."""
import asyncio
from playwright.async_api import async_playwright

JOB_URL = "https://job-boards.greenhouse.io/covar/jobs/5097883007"

async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        page = await browser.new_page(user_agent=(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ))
        await page.goto(JOB_URL, wait_until="networkidle")

        # Dump the outerHTML of each EEO field's parent container
        for fid in ["gender", "hispanic_ethnicity", "veteran_status", "disability_status"]:
            html = await page.evaluate(f"""
                () => {{
                    const el = document.getElementById('{fid}');
                    if (!el) return 'NOT FOUND: {fid}';
                    return el.tagName + ' | type=' + (el.type||'') + ' | classes=' + el.className + '\\n' +
                           'PARENT: ' + el.parentElement?.outerHTML?.slice(0, 500);
                }}
            """)
            print(f"\n=== #{fid} ===")
            print(html)

        await browser.close()

asyncio.run(main())
