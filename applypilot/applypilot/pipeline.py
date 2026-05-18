"""
Main pipeline orchestration — runs all 4 stages sequentially or in parallel.
"""
import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from .scorer import score_job, filter_jobs
from .tailor import tailor_resume
from .cover_letter import generate_cover_letter
from .apply.browser import get_ready_context
from .apply.form_filler import fill_form
from .apply.session import save_session

log = logging.getLogger(__name__)


def run_pipeline(
    jobs_path: Path,
    profile: dict[str, Any],
    output_dir: Path,
    min_score: int = 7,
) -> list[dict]:
    """
    Stages 1-3: score, tailor, cover letter.
    Returns enriched job list with file paths attached.
    """
    raw_jobs: list[dict] = json.loads(jobs_path.read_text())
    log.info("Loaded %d jobs from %s", len(raw_jobs), jobs_path)

    # Stage 1 — Score
    print(f"[1/3] Scoring {len(raw_jobs)} jobs...")
    scored = [score_job(j, profile) for j in raw_jobs]
    qualified = filter_jobs(scored, min_score)
    print(f"      {len(qualified)}/{len(raw_jobs)} jobs scored ≥{min_score}")

    resume_dir = output_dir / "resumes"
    cover_dir = output_dir / "cover_letters"
    resume_dir.mkdir(parents=True, exist_ok=True)
    cover_dir.mkdir(parents=True, exist_ok=True)

    # Stage 2 — Tailor
    print(f"[2/3] Tailoring resumes for {len(qualified)} jobs...")
    for job in qualified:
        job["_resume_path"] = str(tailor_resume(job, profile, resume_dir))

    # Stage 3 — Cover Letters
    print(f"[3/3] Generating cover letters for {len(qualified)} jobs...")
    for job in qualified:
        job["_cover_path"] = str(generate_cover_letter(job, profile, cover_dir))

    # Persist enriched job list
    enriched_path = output_dir / "pipeline_results.json"
    enriched_path.write_text(json.dumps(qualified, indent=2))
    print(f"\nPipeline results saved → {enriched_path}\n")
    return qualified


async def _apply_one(
    job: dict,
    context: Any,
    profile: dict,
    dry_run: bool,
) -> dict:
    """Apply to a single job URL inside the given context. Returns result dict."""
    url = job.get("url") or job.get("application_url") or job.get("apply_url", "")
    if not url:
        log.warning("No URL for job: %s", job.get("title"))
        return {**job, "_apply_result": "skipped_no_url"}

    resume_path = Path(job["_resume_path"])
    cover_path = Path(job["_cover_path"])

    page = await context.new_page()
    try:
        log.info("Navigating to %s", url)
        await page.goto(url, timeout=30000)
        await page.wait_for_load_state("networkidle", timeout=15000)

        success = await fill_form(page, profile, job, resume_path, cover_path, dry_run=dry_run)
        result = "submitted" if success else "failed"
        log.info("Apply result for %s: %s", job.get("title"), result)
        return {**job, "_apply_result": result}
    except Exception as exc:
        log.error("Apply exception for %s: %s", job.get("title"), exc)
        return {**job, "_apply_result": f"error: {exc}"}
    finally:
        await page.close()


async def run_apply(
    jobs: list[dict],
    profile: dict,
    user_id: str,
    workers: int = 1,
    dry_run: bool = False,
    headless: bool = False,
    output_dir: Path | None = None,
) -> list[dict]:
    """
    Stage 4 — Auto-apply to all qualified jobs.
    Supports parallel workers (each gets its own context on the same browser).
    """
    pw, browser, context = await get_ready_context(user_id, headless=headless)

    if workers > 1:
        # Parallel: create one context per worker, batch jobs
        contexts = [context]
        for _ in range(workers - 1):
            c = await browser.new_context(storage_state=await context.storage_state())
            contexts.append(c)

        async def worker(batch: list[dict], ctx: Any) -> list[dict]:
            results = []
            for job in batch:
                r = await _apply_one(job, ctx, profile, dry_run)
                results.append(r)
            return results

        batch_size = max(1, len(jobs) // workers)
        batches = [jobs[i:i + batch_size] for i in range(0, len(jobs), batch_size)]
        tasks = [worker(b, c) for b, c in zip(batches, contexts)]
        nested = await asyncio.gather(*tasks)
        results = [item for sub in nested for item in sub]
    else:
        results = []
        for job in jobs:
            r = await _apply_one(job, context, profile, dry_run)
            results.append(r)

    # Save updated session state
    updated_state = await context.storage_state()
    save_session(user_id, updated_state)

    await browser.close()
    await pw.stop()

    if output_dir:
        out = output_dir / "apply_results.json"
        out.write_text(json.dumps(results, indent=2))
        print(f"Apply results saved → {out}")

    return results
