"""
Dumps every form field and custom question label from the BambooHR apply page.
Run: python dump_questions.py
"""
import asyncio, json
from playwright.async_api import async_playwright

URL = "https://lxt.bamboohr.com/careers/526?utm_source=startup.jobs&utm_medium=organic"

async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False, args=["--disable-blink-features=AutomationControlled"])
        ctx = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        )
        await ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined})")
        page = await ctx.new_page()

        await page.goto(URL, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(3)

        # Click Apply
        for text in ["Apply for This Job", "Apply Now", "Apply"]:
            btn = await page.query_selector(f"a:has-text('{text}'), button:has-text('{text}')")
            if btn:
                await btn.click()
                break

        await page.wait_for_selector("#firstName", timeout=10000)
        await asyncio.sleep(1)

        # Dump all question labels and their associated inputs
        data = await page.evaluate("""() => {
            const results = [];

            // Get all form rows/groups
            const rows = document.querySelectorAll(
                '.fab-FormColumn, .fab-FormRow, [class*="FormGroup"], [class*="Question"], ' +
                'fieldset, .customQuestion, [data-field-id]'
            );

            rows.forEach(row => {
                const label = row.querySelector('label, legend, [class*="label"], [class*="Label"]');
                const inputs = [...row.querySelectorAll('input, select, textarea')];
                if (inputs.length === 0) return;

                const labelText = label ? label.textContent.trim() : '(no label)';
                const inputInfo = inputs.map(inp => ({
                    id: inp.id,
                    name: inp.name,
                    type: inp.type || inp.tagName.toLowerCase(),
                    value: inp.value,
                    // For radio buttons, get the label next to them
                    radioLabel: inp.type === 'radio'
                        ? (inp.parentElement?.querySelector('label')?.textContent?.trim() ||
                           inp.closest('label')?.textContent?.trim() || inp.value)
                        : null,
                    // For selects, get all options
                    options: inp.tagName === 'SELECT'
                        ? [...inp.options].map(o => ({ value: o.value, text: o.text }))
                        : null,
                }));

                results.push({ label: labelText, inputs: inputInfo });
            });

            return results;
        }""")

        print("\n" + "="*70)
        print("BAMBOOHR FORM STRUCTURE")
        print("="*70)
        for group in data:
            print(f"\n  LABEL: {group['label']!r}")
            for inp in group['inputs']:
                if inp['options']:
                    print(f"    SELECT  name={inp['name']!r}  id={inp['id']!r}")
                    for opt in inp['options'][:10]:
                        print(f"            option value={opt['value']!r} text={opt['text']!r}")
                elif inp['type'] == 'radio':
                    print(f"    RADIO   name={inp['name']!r}  label={inp['radioLabel']!r}  value={inp['value']!r}")
                else:
                    print(f"    {inp['type'].upper():8} name={inp['name']!r}  id={inp['id']!r}")

        # Also dump submit button info
        submit_btns = await page.evaluate("""() => {
            return [...document.querySelectorAll('button[type=submit], input[type=submit], button')].map(b => ({
                text: b.textContent.trim(),
                type: b.type,
                id: b.id,
            })).filter(b => b.text);
        }""")
        print("\n── SUBMIT BUTTONS ──")
        for b in submit_btns:
            print(f"  {b}")

        print("\n[Done — closing in 5s]")
        await asyncio.sleep(5)
        await browser.close()

asyncio.run(main())
