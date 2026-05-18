"""
CAPTCHA handler — Cloudflare Turnstile + reCAPTCHA v2 (CapSolver) + hCaptcha.

Strategy:
  Turnstile  → mouse-move + click checkbox → wait for cf-turnstile-response token (3 retries)
  reCAPTCHA  → CapSolver API auto-solve → inject gRecaptchaResponse token
  hCaptcha   → prompt human to solve manually
  Any failure → pause and ask human operator to solve, then continue
"""

import asyncio, json, os, random
from utils.browser import human_delay

# ── CapSolver ─────────────────────────────────────────────────────────────────
try:
    import capsolver as _capsolver
    _CAPSOLVER_AVAILABLE = True
except ImportError:
    _capsolver = None  # type: ignore[assignment]
    _CAPSOLVER_AVAILABLE = False

CAPSOLVER_KEY = os.environ.get(
    "CAPSOLVER_API_KEY",
    "CAP-3B64A18B30B50A0278278C10BD9E97D6FAD840D982632D2A061F4E121A6B7083",
)

# ── Selectors ─────────────────────────────────────────────────────────────────
TURNSTILE_SEL  = "iframe[src*='challenges.cloudflare.com']"
RECAPTCHA_SEL  = "iframe[src*='recaptcha']"
HCAPTCHA_SEL   = "iframe[src*='hcaptcha']"


# ── Turnstile ─────────────────────────────────────────────────────────────────

async def solve_turnstile(page, max_attempts: int = 3) -> bool:
    for attempt in range(1, max_attempts + 1):
        try:
            iframe_el = await page.wait_for_selector(TURNSTILE_SEL, timeout=8000)
            if iframe_el is None:
                return True

            box = await iframe_el.bounding_box()
            if box:
                cx = box["x"] + box["width"] / 2
                cy = box["y"] + box["height"] / 2
                await page.mouse.move(
                    cx + random.uniform(-5, 5),
                    cy + random.uniform(-5, 5),
                    steps=random.randint(8, 20),
                )
                await human_delay(400, 900)
                await page.mouse.click(cx, cy)

            await asyncio.sleep(3)
            token = await page.evaluate(
                "() => document.querySelector('[name=cf-turnstile-response]')?.value || ''"
            )
            if token:
                print(f"[captcha] Turnstile solved on attempt {attempt}")
                return True

            print(f"[captcha] Turnstile attempt {attempt} failed, retrying...")
            await human_delay(1500, 3000)

        except Exception as e:
            print(f"[captcha] Turnstile error on attempt {attempt}: {e}")

    print("\n[captcha] ⚠️  Could not auto-solve Turnstile.")
    print("[captcha] Please solve the CAPTCHA in the browser window, then press ENTER.")
    input()
    return True


# ── reCAPTCHA v2 (CapSolver) ──────────────────────────────────────────────────

async def _extract_recaptcha_sitekey(page) -> str:
    return await page.evaluate("""() => {
        const el = document.querySelector('.g-recaptcha[data-sitekey]')
                || document.querySelector('[data-sitekey]');
        if (el?.dataset?.sitekey) return el.dataset.sitekey;
        const iframe = document.querySelector('iframe[src*="recaptcha"]');
        if (iframe) {
            const src = iframe.getAttribute('src') || '';
            const m = src.match(/[?&]k=([^&]+)/);
            if (m) return m[1];
        }
        return '';
    }""")


async def _inject_recaptcha_token(page, token: str) -> None:
    await page.evaluate(f"""() => {{
        // Inject into hidden textarea
        const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
        if (ta) {{
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
                  .set.call(ta, {json.dumps(token)});
            ta.dispatchEvent(new Event('change', {{bubbles: true}}));
        }}
        // Fire callback if defined
        const el = document.querySelector('.g-recaptcha[data-callback]');
        if (el?.dataset?.callback && window[el.dataset.callback]) {{
            window[el.dataset.callback]({json.dumps(token)});
        }}
        // Also try ___grecaptcha_cfg callback
        try {{
            const id = Object.keys(___grecaptcha_cfg.clients || {{}})[0];
            const client = ___grecaptcha_cfg.clients[id];
            Object.values(client).forEach(v => {{
                if (v && typeof v.callback === 'function') v.callback({json.dumps(token)});
            }});
        }} catch (_) {{}}
    }}""")


async def solve_recaptcha_v2(page, page_url: str) -> bool:
    """Auto-solve reCAPTCHA v2 via CapSolver, fall back to manual."""
    if _CAPSOLVER_AVAILABLE and CAPSOLVER_KEY:
        try:
            _capsolver.api_key = CAPSOLVER_KEY
            sitekey = await _extract_recaptcha_sitekey(page)
            if not sitekey:
                print("[captcha] ⚠ reCAPTCHA: could not extract sitekey")
            else:
                print(f"[captcha] Solving reCAPTCHA v2 via CapSolver (sitekey: {sitekey[:20]}…)")
                solution = await asyncio.to_thread(
                    _capsolver.solve,
                    {
                        "type":       "ReCaptchaV2TaskProxyLess",
                        "websiteURL": page_url,
                        "websiteKey": sitekey,
                    },
                )
                token = solution.get("gRecaptchaResponse", "")
                if token:
                    await _inject_recaptcha_token(page, token)
                    print("[captcha] ✅ reCAPTCHA v2 solved and token injected")
                    return True
                print("[captcha] ⚠ CapSolver returned empty token")
        except Exception as e:
            print(f"[captcha] CapSolver failed: {e}")
    else:
        reason = "capsolver not installed" if not _CAPSOLVER_AVAILABLE else "no API key"
        print(f"[captcha] CapSolver unavailable ({reason})")

    # Manual fallback
    print("\n[captcha] ⚠️  Please solve the reCAPTCHA in the browser window.")
    print("[captcha] Press ENTER when done → ")
    input()
    return True


# ── Main dispatcher ───────────────────────────────────────────────────────────

async def check_and_solve(page, page_url: str = "") -> bool:
    """Detect which CAPTCHA type is present and solve it."""
    try:
        if await page.query_selector(TURNSTILE_SEL):
            return await solve_turnstile(page)

        if await page.query_selector(RECAPTCHA_SEL):
            url = page_url or page.url
            return await solve_recaptcha_v2(page, url)

        if await page.query_selector(HCAPTCHA_SEL):
            print("\n[captcha] ⚠️  hCaptcha detected — please solve it in the browser.")
            input("[captcha] Press ENTER when done → ")
            return True

    except Exception as e:
        print(f"[captcha] check_and_solve error: {e}")

    return True
