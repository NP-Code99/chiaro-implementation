"""
Orchestrator — applies to all jobs via Scrapfly + playwright-stealth engine.

Usage:
  python main.py                              # Dry-run all URLs
  python main.py --submit                     # Submit all
  python main.py --submit --platform trakstar # Submit only Trakstar URLs
  python main.py --submit --url "https://..." # Submit a single URL
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

async def run_all(urls: list, platform_filter: str | None = None):
    # Import here so env vars (SCRAPFLY_API_KEY etc.) are already set
    from apply_engine_scrapfly import apply

    results = []
    for url in urls:
        ats = detect_ats(url)
        if platform_filter and ats != platform_filter:
            continue

        log(f"\n[main] ▶ {ats.upper()} → {url}")
        try:
            await apply(url)
            results.append({"url": url, "ats": ats, "status": "✅ SUCCESS"})
        except Exception as err:
            log(f"[main] ❌ Failed: {err}")
            results.append({"url": url, "ats": ats, "status": f"❌ FAILED: {err}"})

        # Brief pause between applications
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
