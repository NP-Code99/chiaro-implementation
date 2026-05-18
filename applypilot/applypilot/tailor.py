"""Stage 2 — Generate a tailored resume for a specific job."""
import json
import logging
import re
from pathlib import Path
from typing import Any

from .ai_client import chat

log = logging.getLogger(__name__)

_SYSTEM = """
You are an expert technical resume writer. Given a candidate profile and a job listing,
produce a tailored resume in plain Markdown.

Rules:
- NEVER fabricate facts — only reorganize and reframe real information from the profile
- Reorder experience bullets to put the most relevant ones first
- Inject exact keywords from the job description naturally
- Keep total length to 1 page (≈500-700 words)
- Format: name + contact at top, then Summary, Skills, Experience, Education
- Do NOT include an Objective section

Return ONLY the Markdown resume content, no extra commentary.
"""


def tailor_resume(job: dict[str, Any], profile: dict[str, Any], output_dir: Path) -> Path:
    """Generate and save a tailored resume. Returns the output file path."""
    user_prompt = f"""
CANDIDATE PROFILE:
{json.dumps(profile, indent=2)}

TARGET JOB:
Title: {job.get('title')}
Company: {job.get('company')}
Description:
{job.get('description', '')}

Score rationale: {job.get('_score', {}).get('rationale', '')}
Key strengths to highlight: {json.dumps(job.get('_score', {}).get('strengths', []))}
"""
    content = chat(_SYSTEM, user_prompt, temperature=0.3, max_tokens=2048)

    safe_name = re.sub(r"[^\w\-]", "_", f"{job.get('company', 'co')}_{job.get('title', 'role')}")[:60]
    out_path = output_dir / f"resume_{safe_name}.md"
    out_path.write_text(content, encoding="utf-8")
    log.info("Tailored resume → %s", out_path)
    return out_path
