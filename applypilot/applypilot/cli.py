"""
ApplyPilot CLI — entry point for all commands.

Usage:
  applypilot init
  applypilot run
  applypilot apply [--workers N] [--dry-run] [--headless]
  applypilot status
"""
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

import click
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).parent.parent
OUTPUT_DIR = BASE_DIR / "output"
PROFILE_PATH = BASE_DIR / "profile.json"


def _setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
        datefmt="%H:%M:%S",
    )


def _load_profile() -> dict:
    if not PROFILE_PATH.exists():
        click.echo(f"[error] profile.json not found at {PROFILE_PATH}. Run `applypilot init` first.", err=True)
        sys.exit(1)
    return json.loads(PROFILE_PATH.read_text())


def _load_jobs_path() -> Path:
    scraper_output = os.environ.get("SCRAPER_OUTPUT_PATH", "")
    if scraper_output:
        p = Path(scraper_output)
    else:
        p = OUTPUT_DIR / "pipeline_results.json"
    if not p.exists():
        click.echo(f"[error] Jobs file not found: {p}\nRun `applypilot run` first, or set SCRAPER_OUTPUT_PATH.", err=True)
        sys.exit(1)
    return p


@click.group()
@click.option("--verbose", "-v", is_flag=True, default=False, help="Enable debug logging")
@click.pass_context
def cli(ctx: click.Context, verbose: bool) -> None:
    """ApplyPilot — autonomous job application pipeline."""
    ctx.ensure_object(dict)
    ctx.obj["verbose"] = verbose
    _setup_logging(verbose)


# ── init ──────────────────────────────────────────────────────────────────────

@cli.command()
def init() -> None:
    """First-time setup wizard — creates profile.json and .env."""
    click.echo("\n=== ApplyPilot Setup Wizard ===\n")

    profile: dict = {}
    profile["name"] = click.prompt("Full name")
    profile["email"] = click.prompt("Email")
    profile["phone"] = click.prompt("Phone (optional)", default="")
    profile["location"] = click.prompt("Location (city, state)")
    profile["linkedin"] = click.prompt("LinkedIn URL (optional)", default="")
    profile["work_authorization"] = click.prompt("Work authorization (e.g. US Citizen, H1B)", default="US Citizen")
    profile["desired_salary_min"] = click.prompt("Minimum desired salary (USD)", default=0, type=int)
    profile["desired_salary_max"] = click.prompt("Maximum desired salary (USD)", default=0, type=int)
    profile["remote_preference"] = click.prompt("Remote preference (remote/hybrid/onsite/any)", default="any")
    profile["skills"] = click.prompt("Top skills (comma-separated)").split(",")
    profile["years_experience"] = click.prompt("Total years of experience", type=int, default=0)
    profile["summary"] = click.prompt("Brief professional summary (2-3 sentences)")
    profile["experience"] = []
    profile["education"] = []
    profile["eeo"] = {
        "gender": click.prompt("Gender (optional, for EEO)", default="Prefer not to say"),
        "ethnicity": click.prompt("Ethnicity (optional, for EEO)", default="Prefer not to say"),
        "veteran": click.prompt("Veteran status (optional, for EEO)", default="No"),
        "disability": click.prompt("Disability status (optional, for EEO)", default="No"),
    }

    PROFILE_PATH.write_text(json.dumps(profile, indent=2))
    click.echo(f"\n[✓] Profile saved to {PROFILE_PATH}")

    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        openai_key = click.prompt("\nOpenAI API key")
        capsolver_key = click.prompt("CapSolver API key (optional)", default="")
        scraper_path = click.prompt("Path to startup.jobs scraper JSON output", default="")
        env_path.write_text(
            f"OPENAI_API_KEY={openai_key}\n"
            f"CAPSOLVER_API_KEY={capsolver_key}\n"
            f"SCRAPER_OUTPUT_PATH={scraper_path}\n"
        )
        click.echo(f"[✓] .env saved to {env_path}")

    OUTPUT_DIR.mkdir(exist_ok=True)
    click.echo("\n[✓] Setup complete. Run `applypilot run` next.\n")


# ── run ───────────────────────────────────────────────────────────────────────

@cli.command("run")
@click.option("--min-score", default=7, show_default=True, help="Minimum score threshold (1-10)")
@click.option("--scraper-output", default=None, help="Path to scraper JSON file (overrides .env)")
@click.pass_context
def run_cmd(ctx: click.Context, min_score: int, scraper_output: str | None) -> None:
    """Run stages 1-3: score, tailor, cover letter."""
    from .pipeline import run_pipeline

    profile = _load_profile()
    jobs_path = Path(scraper_output) if scraper_output else _load_jobs_path()
    OUTPUT_DIR.mkdir(exist_ok=True)

    jobs = run_pipeline(jobs_path, profile, OUTPUT_DIR, min_score=min_score)
    click.echo(f"\n[✓] Pipeline complete — {len(jobs)} jobs ready for apply stage.\n")


# ── apply ─────────────────────────────────────────────────────────────────────

@cli.command("apply")
@click.option("--workers", default=1, show_default=True, type=int, help="Number of parallel Chrome instances")
@click.option("--dry-run", is_flag=True, default=False, help="Fill forms but do not submit")
@click.option("--headless", is_flag=True, default=False, help="Run browser in headless mode")
@click.option("--user-id", default="default", show_default=True, help="Session user ID")
@click.pass_context
def apply_cmd(ctx: click.Context, workers: int, dry_run: bool, headless: bool, user_id: str) -> None:
    """Run stage 4: auto-apply to all qualified jobs."""
    from .pipeline import run_apply

    profile = _load_profile()
    results_path = OUTPUT_DIR / "pipeline_results.json"
    if not results_path.exists():
        click.echo("[error] No pipeline results found. Run `applypilot run` first.", err=True)
        sys.exit(1)
    jobs: list[dict] = json.loads(results_path.read_text())

    mode = "DRY RUN — " if dry_run else ""
    click.echo(f"\n[ApplyPilot] {mode}Applying to {len(jobs)} jobs with {workers} worker(s)...\n")

    results = asyncio.run(
        run_apply(
            jobs,
            profile,
            user_id=user_id,
            workers=workers,
            dry_run=dry_run,
            headless=headless,
            output_dir=OUTPUT_DIR,
        )
    )

    submitted = sum(1 for r in results if r.get("_apply_result") == "submitted")
    failed = sum(1 for r in results if "error" in str(r.get("_apply_result", "")))
    click.echo(f"\n[✓] Done — {submitted} submitted, {failed} failed out of {len(results)} total.\n")


# ── status ────────────────────────────────────────────────────────────────────

@cli.command("status")
def status_cmd() -> None:
    """Show pipeline statistics."""
    results_path = OUTPUT_DIR / "pipeline_results.json"
    apply_path = OUTPUT_DIR / "apply_results.json"

    click.echo("\n=== ApplyPilot Status ===\n")

    if results_path.exists():
        jobs: list[dict] = json.loads(results_path.read_text())
        scores = [j.get("_score", {}).get("score", 0) for j in jobs]
        click.echo(f"Pipeline results:  {len(jobs)} qualified jobs")
        if scores:
            click.echo(f"  Score range: {min(scores)} – {max(scores)} (avg {sum(scores)/len(scores):.1f})")
    else:
        click.echo("Pipeline results:  not run yet")

    if apply_path.exists():
        applied: list[dict] = json.loads(apply_path.read_text())
        by_result: dict[str, int] = {}
        for r in applied:
            key = r.get("_apply_result", "unknown")
            by_result[key] = by_result.get(key, 0) + 1
        click.echo(f"\nApply results:     {len(applied)} total")
        for k, v in sorted(by_result.items()):
            click.echo(f"  {k}: {v}")
    else:
        click.echo("Apply results:     not run yet")

    click.echo()


def main() -> None:
    cli(obj={})


if __name__ == "__main__":
    main()
