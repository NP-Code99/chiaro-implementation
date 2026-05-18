"""
Generic AI-driven form filler — fallback for unknown job boards.
Uses Claude to analyze the page DOM and produce fill instructions.
"""
from __future__ import annotations

import json
import logging
import random
from pathlib import Path
from typing import Any

from playwright.async_api import Page

from .greenhouse import ApplyResult, SUCCESS_PATTERNS

log = logging.getLogger(__name__)

_SYSTEM = """You are an expert at filling out online job application forms.
Analyze the page HTML and candidate profile, then return fill instructions.
Return ONLY valid JSON:
{
  "fields": [
    {"selector": "<css selector>", "type": "<text|select|radio|checkbox|textarea|file>", "value": "<value>"}
  ],
  "submit_selector": "<css selector or null>"
}
Rules:
- Use exact CSS id selectors (#id) where IDs are visible
- For file inputs: value should be "resume" or "cover_letter"
- For select elements: value should be the option label text
- Skip hidden/disabled fields
"""


async def _snapshot(page: Page) -> str:
    import re
    html = await page.content()
    html = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL)
    html = re.sub(r"<style[^>]*>.*?</style>", "", html, flags=re.DOTALL)
    return html[:10000]


class GenericFiller:
    """AI-driven fallback filler for unknown boards."""

    def __init__(
        self,
        page: Page,
        profile: dict[str, Any],
        job: dict[str, Any],
        resume_path: Path,
        cover_letter_path: Path,
        dry_run: bool = False,
        screenshot_dir: Path | None = None,
    ) -> None:
        self.page = page
        self.profile = profile
        self.job = job
        self.resume_path = resume_path
        self.cover_letter_path = cover_letter_path
        self.dry_run = dry_run
        self.screenshot_dir = screenshot_dir or Path("/tmp/applypilot_screenshots")
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)
        self._ss = 0

    async def _screenshot(self, name: str) -> str:
        self._ss += 1
        path = self.screenshot_dir / f"{self._ss:02d}_{name}.png"
        try:
            await self.page.screenshot(path=str(path), full_page=True)
        except Exception:
            pass
        return str(path)

    async def run(self) -> ApplyResult:
        try:
            snap = await _snapshot(self.page)
            instructions = self._ask_ai(snap)
            if not instructions:
                return ApplyResult(status="needs_review", error_message="AI could not parse form")

            await self._execute(instructions)
            await self._screenshot("pre_submit")

            if self.dry_run:
                return ApplyResult(status="applied", error_message="dry_run")

            return await self._submit(instructions.get("submit_selector"))
        except Exception as exc:
            log.exception("GenericFiller crashed")
            return ApplyResult(status="failed", error_message=str(exc))

    def _ask_ai(self, html: str) -> dict | None:
        try:
            from applypilot.ai_client import chat
            raw = chat(
                _SYSTEM,
                f"PAGE HTML:\n{html}\n\nPROFILE:\n{json.dumps(self.profile, indent=2)}"
                f"\n\nJOB: {self.job.get('title')} at {self.job.get('company')}",
                temperature=0.1,
                json_mode=True,
            )
            return json.loads(raw)
        except Exception as exc:
            log.error("AI form analysis failed: %s", exc)
            return None

    async def _execute(self, instructions: dict) -> None:
        for field in instructions.get("fields", []):
            selector = field.get("selector", "")
            ftype = field.get("type", "text")
            value = field.get("value", "")
            if not selector or not value:
                continue
            try:
                loc = self.page.locator(selector).first
                if ftype == "file":
                    src = self.resume_path if "resume" in value else self.cover_letter_path
                    await loc.set_input_files(str(src))
                elif ftype == "select":
                    await loc.select_option(label=value)
                elif ftype in ("radio", "checkbox"):
                    await loc.check()
                elif ftype == "textarea":
                    await loc.fill(value)
                else:
                    await loc.click()
                    await self.page.wait_for_timeout(random.randint(100, 200))
                    for ch in value:
                        await loc.type(ch, delay=random.randint(40, 90))
                await self.page.wait_for_timeout(random.randint(300, 700))
            except Exception as exc:
                log.warning("Could not fill '%s': %s", selector, exc)

    async def _submit(self, submit_sel: str | None) -> ApplyResult:
        btn = None
        for sel in [
            submit_sel,
            "button[type=submit]",
            "input[type=submit]",
            "button:has-text('Submit')",
            "button:has-text('Apply')",
        ]:
            if not sel:
                continue
            loc = self.page.locator(sel).first
            if await loc.count() > 0:
                btn = loc
                break
        if not btn:
            return ApplyResult(status="needs_review", error_message="No submit button found — manual review needed")

        await btn.scroll_into_view_if_needed()
        await self.page.wait_for_timeout(700)
        await btn.click()

        try:
            await self.page.wait_for_load_state("networkidle", timeout=20000)
        except Exception:
            pass

        ss = await self._screenshot("post_submit")
        text = (await self.page.inner_text("body")).lower()
        success = any(m in text for m in SUCCESS_PATTERNS) or "confirmation" in self.page.url
        if success:
            return ApplyResult(status="applied", screenshot_url=ss)
        return ApplyResult(status="needs_review", error_message=f"Unknown result. URL: {self.page.url}", screenshot_url=ss)
