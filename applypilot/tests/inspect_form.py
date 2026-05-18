"""
Universal form inspector — dumps every input, select, textarea, and button
on any job application page so we can write precise fillers.

Usage:
    .venv/bin/python tests/inspect_form.py <URL>
    .venv/bin/python tests/inspect_form.py https://jobs.lever.co/figma/...
    .venv/bin/python tests/inspect_form.py https://jobs.ashbyhq.com/ramp/...
"""
import asyncio
import json
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(BASE_DIR))

from dotenv import load_dotenv
load_dotenv(BASE_DIR / ".env")

from playwright.async_api import async_playwright

SCREENSHOTS_DIR = BASE_DIR / "tests" / "screenshots" / "inspect"
SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)


JS_DUMP = """
() => {
    const label_for = (el) => {
        if (el.id) {
            const lbl = document.querySelector(`label[for="${el.id}"]`);
            if (lbl) return lbl.innerText.trim().slice(0, 80);
        }
        // Walk up to find wrapping label or legend
        let p = el.parentElement;
        for (let i = 0; i < 4; i++) {
            if (!p) break;
            const lbl = p.querySelector('label, legend');
            if (lbl && lbl.innerText.trim()) return lbl.innerText.trim().slice(0, 80);
            const aria = p.getAttribute('aria-label') || p.getAttribute('aria-labelledby');
            if (aria) return aria.slice(0, 80);
            p = p.parentElement;
        }
        return el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
    };

    const fields = [];

    // Inputs
    document.querySelectorAll('input:not([type=hidden])').forEach(el => {
        fields.push({
            tag: 'input',
            type: el.type || 'text',
            id: el.id,
            name: el.name,
            placeholder: el.placeholder,
            required: el.required,
            'aria-haspopup': el.getAttribute('aria-haspopup'),
            'aria-controls': el.getAttribute('aria-controls'),
            class: el.className.slice(0, 60),
            label: label_for(el),
            value: el.value.slice(0, 40),
        });
    });

    // Textareas
    document.querySelectorAll('textarea').forEach(el => {
        fields.push({
            tag: 'textarea',
            id: el.id,
            name: el.name,
            required: el.required,
            class: el.className.slice(0, 60),
            label: label_for(el),
        });
    });

    // Native selects
    document.querySelectorAll('select').forEach(el => {
        const opts = [...el.options].map(o => o.text.trim()).filter(Boolean);
        fields.push({
            tag: 'select',
            id: el.id,
            name: el.name,
            required: el.required,
            label: label_for(el),
            options: opts.slice(0, 8),
        });
    });

    // Buttons
    const btns = [...document.querySelectorAll('button, input[type=submit]')]
        .map(b => ({tag: b.tagName.toLowerCase(), type: b.type, text: b.innerText?.trim().slice(0,40), id: b.id, class: b.className.slice(0,60)}))
        .filter(b => b.text);

    // File inputs
    const files = [...document.querySelectorAll('input[type=file]')]
        .map(f => ({tag:'file', id: f.id, name: f.name, accept: f.accept, label: label_for(f)}));

    // CAPTCHA markers
    const captcha = {
        recaptcha: !!document.querySelector('.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"]'),
        hcaptcha: !!document.querySelector('.h-captcha, [data-hcaptcha-widget-id]'),
        turnstile: !!document.querySelector('.cf-turnstile'),
    };

    return { fields, buttons: btns, files, captcha, title: document.title, url: location.href };
}
"""


async def inspect(url: str) -> None:
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
        )
        ctx = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 900},
        )
        await ctx.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )
        page = await ctx.new_page()
        print(f"\n→ Navigating to {url}")
        await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(4000)

        # Screenshot
        board = (
            "greenhouse" if "greenhouse.io" in url else
            "lever"      if "lever.co"      in url else
            "ashby"      if "ashbyhq.com"   in url else
            "workday"    if "workday"        in url else
            "bamboohr"   if "bamboohr"       in url else
            "unknown"
        )
        ss_path = SCREENSHOTS_DIR / f"{board}_form.png"
        await page.screenshot(path=str(ss_path), full_page=True)
        print(f"  Screenshot → {ss_path}")

        data = await page.evaluate(JS_DUMP)
        await browser.close()

    print(f"\n{'='*60}")
    print(f"  BOARD: {board.upper()}")
    print(f"  TITLE: {data['title']}")
    print(f"  URL:   {data['url']}")
    print(f"{'='*60}")

    print(f"\n── INPUTS ({len(data['fields'])}) ──────────────────────────────")
    for f in data['fields']:
        haspopup = f' haspopup={f["aria-haspopup"]}' if f.get("aria-haspopup") else ""
        controls = f' controls={f["aria-controls"]}' if f.get("aria-controls") else ""
        print(
            f'  [{f["tag"].upper():8}] id={f.get("id",""):30} type={f.get("type",""):10}'
            f' req={f.get("required",""):5}{haspopup}{controls}'
        )
        print(f'           label="{f.get("label","")}"  class={f.get("class","")[:40]}')

    print(f"\n── FILE INPUTS ({len(data['files'])}) ─────────────────────────────")
    for f in data['files']:
        print(f'  id={f.get("id",""):30} accept={f.get("accept","")}  label="{f.get("label","")}"')

    print(f"\n── BUTTONS ({len(data['buttons'])}) ──────────────────────────────────")
    for b in data['buttons']:
        print(f'  [{b.get("type",""):6}] id={b.get("id",""):20} text="{b.get("text","")}"')

    print(f"\n── CAPTCHA ────────────────────────────────────────────────────")
    for k, v in data['captcha'].items():
        print(f'  {k}: {v}')

    # Save raw JSON
    out_path = SCREENSHOTS_DIR / f"{board}_fields.json"
    out_path.write_text(json.dumps(data, indent=2))
    print(f"\n  Raw JSON → {out_path}\n")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: .venv/bin/python tests/inspect_form.py <URL>")
        sys.exit(1)
    asyncio.run(inspect(sys.argv[1]))
