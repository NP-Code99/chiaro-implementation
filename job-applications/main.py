"""
Orchestrator — applies to all jobs.

Greenhouse URLs are handled by the dedicated API+Playwright pipeline
(scripts/greenhouse.py → scripts/greenhouse_playwright_backup.py).
All other ATS platforms fall through to the Scrapfly+Claude engine.

Usage:
  python main.py                               # Dry-run all URLs
  python main.py --dry-run                     # Explicit dry-run
  python main.py --platform greenhouse         # Only Greenhouse URLs
  python main.py --url "https://..."           # Single URL
"""
import asyncio, sys, os
from utils.ats_detector import detect_ats
from utils.logger import log


URLS = [
    "https://ccbill.bamboohr.com/careers/286",
    "https://caixamagica.hire.trakstar.com/jobs/fk0zv84/?apply=true",
    "https://www.digicert.com/careers?gh_jid=8524673002#application_form",
    "https://footballradar.hire.trakstar.com/jobs/fk0zvva/?apply=true",
    "https://job-boards.greenhouse.io/scoutmotors/jobs/5128323007",
    "https://ionity-gmbh.jobs.personio.de/job/2634069?apply",
    "https://mindalterai.na.teamtailor.com/jobs/604800-generative-ai-lead",
    "https://jobs.lever.co/zensurance/30cc67bb-bfc9-4f27-9d2b-b50b9186004d/apply",
    "https://xideral.hire.trakstar.com/jobs/fk0zx3n/?apply=true",
    "https://bunnynet.teamtailor.com/jobs/6636274-staff-software-engineer-magic-containers",
]


def _resolve_startup_jobs(url: str) -> str:
    """Follow startup.jobs redirect to the real ATS URL (no-op for other URLs)."""
    if "startup.jobs" not in url:
        return url
    try:
        from apply_engine_scrapfly import resolve_startup_jobs_url
        return resolve_startup_jobs_url(url)
    except Exception as exc:
        log(f"[main] startup.jobs resolve failed: {exc} — using original URL")
        return url


async def _apply_one(url: str) -> None:
    """Dispatch a single URL to the correct ATS handler."""
    resolved = _resolve_startup_jobs(url)
    ats = detect_ats(resolved)

    if ats == "greenhouse":
        from scripts.greenhouse import apply as gh_apply
        await gh_apply(resolved)
    else:
        from apply_engine_scrapfly import apply as engine_apply
        await engine_apply(resolved)


async def run_all(urls: list, platform_filter: str | None = None):
    results = []
    for url in urls:
        resolved = _resolve_startup_jobs(url)
        ats = detect_ats(resolved)
        if platform_filter and ats != platform_filter:
            continue

        log(f"\n[main] ▶ {ats.upper()} → {url}")
        try:
            await _apply_one(url)
            results.append({"url": url, "ats": ats, "status": "✅ SUCCESS"})
        except Exception as err:
            log(f"[main] ❌ Failed: {err}")
            results.append({"url": url, "ats": ats, "status": f"❌ FAILED: {err}"})

        await asyncio.sleep(5)

    log("\n" + "═" * 70)
    log("FINAL RESULTS SUMMARY")
    log("═" * 70)
    for r in results:
        log(f"  {r['status']:25} │ {r['ats']:12} │ {r['url'][:60]}")
    log("═" * 70)

if __name__ == "__main__":
    args = sys.argv[1:]
    platform_filter = None
    single_url      = None

    if "--platform" in args:
        platform_filter = args[args.index("--platform") + 1]
    if "--url" in args:
        single_url = args[args.index("--url") + 1]

    # Set env vars so apply_engine_scrapfly picks them up
    os.environ.setdefault("SCRAPFLY_API_KEY",      "scp-live-443c714b108e4137bca2e6b561978171")
    os.environ.setdefault("RESIDENTIAL_PROXY_URL",  "http://djssmwzl:1ynfeqshcsup@p.webshare.io:80")

    urls = [single_url] if single_url else URLS
    asyncio.run(run_all(urls, platform_filter))
