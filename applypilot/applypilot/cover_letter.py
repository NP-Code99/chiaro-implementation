"""Stage 3 — Generate a targeted cover letter per job."""
import json
import logging
import re
from pathlib import Path
from typing import Any

from .ai_client import chat

log = logging.getLogger(__name__)

_SYSTEM = """
You are an expert cover letter writer. Write a concise, compelling cover letter that:
- Opens with a specific hook referencing the company or role
- Maps 2-3 of the candidate's achievements directly to the job requirements
- Shows genuine interest in THIS company (use details from the job description)
- Closes with a clear call to action
- Tone: professional but human — avoid corporate-speak and filler phrases

Length: 3 short paragraphs max (~200-250 words)
Format: Plain text (no Markdown), no salutation header

Return ONLY the cover letter body, nothing else.
"""


def generate_cover_letter(job: dict[str, Any], profile: dict[str, Any], output_dir: Path) -> Path:
    """Generate and save a cover letter. Returns the output file path."""
    user_prompt = f"""
CANDIDATE PROFILE:
{json.dumps(profile, indent=2)}

TARGET JOB:
Title: {job.get('title')}
Company: {job.get('company')}
Description:
{job.get('description', '')}

Key strengths to reference: {json.dumps(job.get('_score', {}).get('strengths', []))}
"""
    content = chat(_SYSTEM, user_prompt, temperature=0.5, max_tokens=1024)

    safe_name = re.sub(r"[^\w\-]", "_", f"{job.get('company', 'co')}_{job.get('title', 'role')}")[:60]
    out_path = output_dir / f"cover_{safe_name}.txt"
    out_path.write_text(content, encoding="utf-8")
    log.info("Cover letter → %s", out_path)
    return out_path
