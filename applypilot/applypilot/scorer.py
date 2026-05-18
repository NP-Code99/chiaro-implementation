"""Stage 1 — Score each job 1-10 against the user profile."""
import json
import logging
from typing import Any

from .ai_client import chat

log = logging.getLogger(__name__)

_SYSTEM = """
You are a career advisor. Score how well a job listing matches a candidate's profile.

Return ONLY valid JSON in this exact shape:
{
  "score": <integer 1-10>,
  "rationale": "<one-sentence reason>",
  "strengths": ["<match point>", ...],
  "gaps": ["<gap>", ...]
}

Scoring criteria (weight equally):
- Skills match (required vs. candidate skills)
- Experience level alignment
- Location / remote compatibility
- Salary range vs. candidate expectations
"""


def score_job(job: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    """Return scoring result dict attached to the job."""
    user_prompt = f"""
CANDIDATE PROFILE:
{json.dumps(profile, indent=2)}

JOB LISTING:
Title: {job.get('title', 'Unknown')}
Company: {job.get('company', 'Unknown')}
Description:
{job.get('description', '')}

Extra metadata: {json.dumps({k: v for k, v in job.items() if k not in ('title', 'company', 'description', 'url')}, indent=2)}
"""
    try:
        raw = chat(_SYSTEM, user_prompt, temperature=0.2, json_mode=True)
        result = json.loads(raw)
        job["_score"] = result
        log.info("Scored %s @ %s → %s/10", job.get("title"), job.get("company"), result.get("score"))
        return job
    except Exception as exc:
        log.warning("Scoring failed for %s: %s", job.get("title"), exc)
        job["_score"] = {"score": 0, "rationale": str(exc), "strengths": [], "gaps": []}
        return job


def filter_jobs(jobs: list[dict], min_score: int = 7) -> list[dict]:
    """Return only jobs at or above the minimum score threshold."""
    return [j for j in jobs if j.get("_score", {}).get("score", 0) >= min_score]
