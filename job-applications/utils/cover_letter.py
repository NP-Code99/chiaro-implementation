"""
Generate a tailored cover letter via the Claude API.
"""
import os
from anthropic import Anthropic

_client: Anthropic | None = None

def _get_client() -> Anthropic | None:
    global _client
    if _client is None:
        key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not key:
            return None
        try:
            _client = Anthropic(api_key=key)
        except Exception:
            return None
    return _client

def generate_cover_letter(
    job_title: str,
    company: str,
    profile: dict,
    tone: str = "Professional",
) -> str:
    skills    = profile.get("skills", "")
    exp_years = profile.get("employment", {}).get("years_of_experience", "")
    name      = f"{profile['personal']['first_name']} {profile['personal']['last_name']}"

    prompt = f"""
Write a {tone.lower()} cover letter for {name} applying to the {job_title} role at {company}.

Candidate profile:
- Skills: {skills}
- Years of experience: {exp_years}
- Current title: {profile['employment'].get('current_title', '')}

Requirements:
- 3 short paragraphs maximum
- Highlight relevant skills for the role
- Sound human, not robotic
- Do not include a date or address header
- End with a confident but polite closing
- Plain text only, no markdown
"""
    ai = _get_client()
    if not ai:
        return (
            f"I'm excited to apply for the {job_title} role at {company}. "
            f"My background in {skills or 'software engineering'} makes me a strong fit. "
            f"I look forward to contributing to your team."
        )
    response = ai.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=600,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.content[0].text.strip()
