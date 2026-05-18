"""
Greenhouse Job Board API filler — zero browser, pure HTTP.

Handles both URL patterns:
  A) Direct:   https://job-boards.greenhouse.io/scoutmotors/jobs/5128323007
  B) Embedded: https://www.digicert.com/careers?gh_jid=8524673002#application_form

Falls back to Playwright if the board token cannot be found or the API rejects.

Entry point called by autofill_orchestrator: apply(url)
"""

import asyncio, re, sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.cover_letter import generate_cover_letter
from utils.logger import log
from utils.profile_loader import load_profile

BOARDS_API = "https://boards-api.greenhouse.io/v1/boards"

DRY_RUN = "--dry-run" in sys.argv


# ── URL parsing ───────────────────────────────────────────────────────────────

def parse_greenhouse_url(url: str) -> tuple[str | None, str | None]:
    """Return (board_token, job_id) for any Greenhouse URL format."""
    # Pattern A: direct board URL
    m = re.search(r"greenhouse\.io/([^/?#]+)/jobs/(\d+)", url)
    if m:
        return m.group(1), m.group(2)

    # Pattern B: embedded gh_jid= param
    m = re.search(r"gh_jid=(\d+)", url)
    if m:
        job_id = m.group(1)
        board_token = _extract_board_token_from_page(url)
        return board_token, job_id

    return None, None


def _extract_board_token_from_page(url: str) -> str | None:
    """
    Fetch the company page and extract the Greenhouse board token.
    Falls back to the hostname-derived token and validates it against the API.
    """
    from urllib.parse import urlparse

    html_token: str | None = None
    try:
        resp = requests.get(url, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
        html = resp.text
        patterns = [
            r'data-board-token=["\']([^"\']+)["\']',
            r'"boardToken"\s*:\s*"([^"]+)"',
            r'Greenhouse\.Settings\s*=.*?"([a-z0-9_]+)"',
            r'boards\.greenhouse\.io/([a-z0-9_]+)',
            r'token["\s:=]+["\']([a-z0-9_]{4,40})["\']',
        ]
        for pattern in patterns:
            match = re.search(pattern, html, re.IGNORECASE)
            if match:
                candidate = match.group(1).lower()
                if re.match(r'^[a-z0-9_]+$', candidate):
                    html_token = candidate
                    log(f"[greenhouse_api] Extracted board token from HTML: {html_token}")
                    return html_token
    except Exception as e:
        log(f"[greenhouse_api] HTML extraction failed: {e}")

    # Fallback: derive token from hostname (e.g., digicert.com → "digicert")
    # and verify it returns a valid jobs list from the API.
    try:
        parsed   = urlparse(url)
        hostname = parsed.hostname or ""
        # Strip common subdomains and the TLD
        parts = hostname.replace("www.", "").split(".")
        candidate = parts[0] if parts else ""
        if candidate and re.match(r'^[a-z0-9_]+$', candidate):
            probe = requests.get(f"{BOARDS_API}/{candidate}/jobs", timeout=8)
            if probe.status_code == 200:
                log(f"[greenhouse_api] Board token confirmed via hostname: {candidate}")
                return candidate
    except Exception as e:
        log(f"[greenhouse_api] Hostname-derived token probe failed: {e}")

    return None


# ── API calls ─────────────────────────────────────────────────────────────────

def fetch_job_questions(board_token: str, job_id: str) -> dict:
    """GET the job + all questions from the Greenhouse Job Board API."""
    url = f"{BOARDS_API}/{board_token}/jobs/{job_id}"
    resp = requests.get(url, params={"questions": "true"}, timeout=10)
    if resp.status_code != 200:
        raise RuntimeError(f"Greenhouse API {resp.status_code}: {resp.text[:200]}")
    return resp.json()


# ── Answer mapping ────────────────────────────────────────────────────────────

def map_answers(questions: list, profile: dict, cover_letter_text: str) -> dict:
    """
    Walk every question from the API and map answers from the profile dict.
    Returns a flat {field_name: value} dict ready to POST.
    """
    p  = profile.get("personal", {})
    wa = profile.get("work_authorization", {})
    e  = profile.get("employment", {})
    d  = profile.get("demographics", {})

    answers: dict = {}

    for question in questions:
        label = question.get("label", "").lower()

        for field in question.get("fields", []):
            name   = field["name"]
            q_type = field["type"]
            values = field.get("values", [])

            # ── Standard built-in fields ──────────────────────────────────
            if name == "first_name":
                answers[name] = p.get("first_name", "")
            elif name == "last_name":
                answers[name] = p.get("last_name", "")
            elif name == "email":
                answers[name] = p.get("email", "")
            elif name == "phone":
                answers[name] = p.get("phone", "")
            elif name in ("resume", "resume_text"):
                pass  # handled as a file upload; skip text field

            # ── Preferred / display name ──────────────────────────────────
            elif any(k in label for k in ["preferred first name", "preferred name", "display name", "nickname"]):
                answers[name] = p.get("first_name", "")

            # ── City ──────────────────────────────────────────────────────
            elif any(k in label for k in ["current location", "city", "current city"]) and "state" not in label:
                answers[name] = p.get("address", {}).get("city", "")

            # ── State ─────────────────────────────────────────────────────
            elif any(k in label for k in ["state of residence", "current state", "state"]) and q_type in ("multi_value_single_select", "single_select"):
                state_val = p.get("address", {}).get("state", "")
                # Try to match label against available options
                if values and state_val:
                    for v in values:
                        if state_val.lower() in v.get("label", "").lower() or v.get("label", "").lower().startswith(state_val.lower()):
                            answers[name] = v["value"]
                            break
                    else:
                        answers[name] = values[0]["value"] if values else state_val
                else:
                    answers[name] = state_val

            # ── Consent / confirmation checkboxes ─────────────────────────
            elif any(k in label for k in ["i confirm", "i agree", "i acknowledge", "i certify", "i consent"]):
                answers[name] = values[0]["value"] if values else "Yes"

            # ── Prior employment at this company ──────────────────────────
            elif any(k in label for k in ["do you currently work for", "previously been employed by", "are you currently employed by"]):
                for v in values:
                    if "no" in v.get("label", "").lower():
                        answers[name] = v["value"]
                        break
                else:
                    answers[name] = values[-1]["value"] if values else "No"

            # ── Conflict of interest / connections ────────────────────────
            elif any(k in label for k in ["do you have any professional or personal connections", "do you have any conflicts"]):
                for v in values:
                    if "no" in v.get("label", "").lower():
                        answers[name] = v["value"]
                        break
                else:
                    answers[name] = values[-1]["value"] if values else "No"

            # ── Conditional follow-up text fields (blank when answer is No) ─
            elif any(k in label for k in ["if yes, please", "if referred, please"]):
                answers[name] = ""  # leave blank

            # ── On-site / in-person requirement ──────────────────────────
            elif any(k in label for k in ["on-site requirements", "on-site work", "in-person"]):
                for v in values:
                    if "yes" in v.get("label", "").lower():
                        answers[name] = v["value"]
                        break
                else:
                    answers[name] = values[0]["value"] if values else "Yes"

            # ── Education level ───────────────────────────────────────────
            elif any(k in label for k in ["highest level of education", "education level", "degree"]):
                edu_list = profile.get("education", [])
                edu_str = (edu_list[0].get("degree", "") if edu_list and isinstance(edu_list[0], dict) else "").lower()
                if values:
                    # Try to match degree keyword to available options
                    degree_keywords = ["bachelor", "master", "phd", "doctorate", "associate", "high school"]
                    matched = None
                    for kw in degree_keywords:
                        if kw in edu_str:
                            for v in values:
                                if kw in v.get("label", "").lower():
                                    matched = v["value"]
                                    break
                            if matched:
                                break
                    answers[name] = matched or values[0]["value"]
                else:
                    answers[name] = edu_str or "Bachelor's Degree"

            # ── Work authorization ────────────────────────────────────────
            elif any(k in label for k in ["authorized", "eligible to work", "legally authorized"]):
                auth = wa.get("authorized_to_work", True)
                answers[name] = (1 if auth else 0) if q_type == "yes_no" else ("Yes" if auth else "No")

            # ── Sponsorship ───────────────────────────────────────────────
            elif any(k in label for k in ["sponsorship", "require sponsorship", "visa sponsor"]):
                needs = wa.get("requires_sponsorship", False)
                answers[name] = (1 if needs else 0) if q_type == "yes_no" else ("Yes" if needs else "No")

            # ── Salary ────────────────────────────────────────────────────
            elif any(k in label for k in ["salary", "compensation", "expected pay", "desired pay"]):
                answers[name] = str(e.get("desired_salary", ""))

            # ── Start date ────────────────────────────────────────────────
            elif any(k in label for k in ["start date", "available", "earliest start", "when can you join"]):
                answers[name] = e.get("available_start_date", "")

            # ── LinkedIn ──────────────────────────────────────────────────
            elif "linkedin" in label:
                answers[name] = p.get("linkedin", "")

            # ── GitHub ────────────────────────────────────────────────────
            elif "github" in label:
                answers[name] = p.get("github", "")

            # ── Portfolio / website ───────────────────────────────────────
            elif any(k in label for k in ["portfolio", "personal site", "personal website"]):
                answers[name] = p.get("portfolio") or p.get("github", "")

            # ── Cover letter / additional info ────────────────────────────
            elif any(k in label for k in ["cover letter", "additional information", "tell us", "why are you", "motivation"]):
                answers[name] = cover_letter_text

            # ── Relocate ──────────────────────────────────────────────────
            elif "relocat" in label:
                answers[name] = "Yes" if e.get("willing_to_relocate", False) else "No"

            # ── Remote ────────────────────────────────────────────────────
            elif any(k in label for k in ["remote", "work from home"]):
                answers[name] = "Yes"

            # ── Years of experience ───────────────────────────────────────
            elif any(k in label for k in ["years of experience", "how many years", "experience level"]):
                answers[name] = str(e.get("years_of_experience", ""))

            # ── Referral source ───────────────────────────────────────────
            elif any(k in label for k in ["how did you hear", "how did you find", "referral", "source"]):
                for v in values:
                    if any(x in v.get("label", "").lower() for x in ["job board", "online", "internet", "website"]):
                        answers[name] = v["value"]
                        break
                else:
                    answers[name] = values[0]["value"] if values else "Job Board"

            # ── Any select with values — pick first option ────────────────
            elif q_type in ("multi_select", "single_select", "multi_value_single_select", "multi_value_multi_select") and values:
                log(f"[greenhouse_api] ⚠  Unanswered select: '{question['label']}' — using first option")
                answers[name] = values[0]["value"]

            # ── Unknown ───────────────────────────────────────────────────
            else:
                log(f"[greenhouse_api] ⚠  Unanswered question: '{question['label']}' (type: {q_type})")

    # EEOC demographics (numeric codes)
    GENDER_MAP = {
        "Male": "1", "Female": "2",
        "Non-binary": "3", "Prefer not to say": "3",
    }
    RACE_MAP = {
        "Hispanic": "1", "White": "2", "Black": "3",
        "Asian": "6", "Two or more races": "8",
        "Prefer not to say": "10",
    }
    VETERAN_MAP = {
        "Not a veteran": "1", "Veteran": "2",
        "Prefer not to say": "3", "I don't wish to answer": "3",
    }
    DISABILITY_MAP = {
        "No disability": "2", "Has disability": "1",
        "Prefer not to say": "3", "I don't wish to answer": "3",
    }

    answers["gender"]            = GENDER_MAP.get(d.get("gender", ""), "3")
    answers["race"]              = RACE_MAP.get(d.get("ethnicity", ""), "10")
    answers["veteran_status"]    = VETERAN_MAP.get(d.get("veteran_status", ""), "3")
    answers["disability_status"] = DISABILITY_MAP.get(d.get("disability_status", ""), "3")

    return answers


# ── Submission ────────────────────────────────────────────────────────────────

def submit_application(
    board_token: str,
    job_id: str,
    answers: dict,
    resume_path: str,
    cover_letter_path: str | None = None,
) -> dict:
    """POST the application via multipart/form-data."""
    url   = f"{BOARDS_API}/{board_token}/apps"
    data  = dict(answers)
    files: dict = {}

    if not resume_path or not Path(resume_path).exists():
        return {"status": "error", "message": f"Resume not found: {resume_path}"}

    files["resume"] = ("resume.pdf", open(resume_path, "rb"), "application/pdf")

    if cover_letter_path and cover_letter_path not in ("generate", ""):
        cl_p = Path(cover_letter_path)
        if cl_p.exists():
            files["cover_letter"] = ("cover_letter.pdf", open(cover_letter_path, "rb"), "application/pdf")

    try:
        resp = requests.post(url, data=data, files=files, timeout=30)
        if resp.status_code in (200, 201):
            log(f"[greenhouse_api] ✅ Submitted (HTTP {resp.status_code})")
            return {"status": "success", "response_code": resp.status_code}
        log(f"[greenhouse_api] ❌ HTTP {resp.status_code}: {resp.text[:300]}")
        return {"status": "error", "message": f"HTTP {resp.status_code}: {resp.text[:200]}", "response_code": resp.status_code}
    except Exception as e:
        log(f"[greenhouse_api] ❌ Request error: {e}")
        return {"status": "error", "message": str(e)}


# ── Main entry point ──────────────────────────────────────────────────────────

async def apply(url: str) -> None:
    """
    Entry point called by autofill_orchestrator._run_legacy_strategy.
    Raises on non-recoverable failure (orchestrator catches it).
    """
    global DRY_RUN
    DRY_RUN = "--dry-run" in sys.argv

    log(f"\n[greenhouse_api] ── Starting API application ──")
    log(f"[greenhouse_api] URL: {url}")

    profile = load_profile()
    p = profile["personal"]

    # 1. Parse URL
    board_token, job_id = parse_greenhouse_url(url)

    if not board_token:
        log("[greenhouse_api] ❌ Cannot extract board token — falling back to Playwright")
        from scripts.greenhouse_playwright_backup import apply as pw_apply
        await pw_apply(url)
        return

    if not job_id:
        raise RuntimeError("Could not extract job_id from Greenhouse URL")

    log(f"[greenhouse_api] Board token: {board_token}  |  Job ID: {job_id}")

    # 2. Fetch questions
    try:
        job_data  = fetch_job_questions(board_token, job_id)
        questions = job_data.get("questions", [])
        log(f"[greenhouse_api] Fetched {len(questions)} questions")
    except Exception as e:
        log(f"[greenhouse_api] ❌ API fetch failed: {e} — falling back to Playwright")
        from scripts.greenhouse_playwright_backup import apply as pw_apply
        await pw_apply(url)
        return

    # 3. Cover letter
    cl_text = ""
    try:
        cl_path = profile.get("cover_letter_path", "generate")
        if not cl_path or cl_path == "generate":
            job_title = job_data.get("title", "the role")
            company   = board_token.replace("-", " ").replace("_", " ").title()
            cl_text   = generate_cover_letter(
                job_title=job_title,
                company=company,
                profile=profile,
                tone=profile.get("cover_letter_tone", "Professional"),
            )
            log(f"[greenhouse_api] Generated cover letter ({len(cl_text)} chars)")
    except Exception as e:
        log(f"[greenhouse_api] Cover letter generation failed: {e}")

    # 4. Map answers
    answers = map_answers(questions, profile, cl_text)
    answers["job_id"] = job_id

    log(f"[greenhouse_api] Mapped {len(answers)} answers:")
    for k, v in answers.items():
        display = str(v)[:60] + "..." if len(str(v)) > 60 else str(v)
        log(f"  {k:40} → {display}")

    # 5. Dry run
    if DRY_RUN:
        log("[greenhouse_api] 🔍 DRY RUN — payload built, not submitting")
        return

    # 6. Submit
    result = submit_application(
        board_token=board_token,
        job_id=job_id,
        answers=answers,
        resume_path=profile.get("resume_path", ""),
        cover_letter_path=profile.get("cover_letter_path"),
    )

    if result["status"] != "success":
        # Non-200 from the API — fall back to Playwright
        log(f"[greenhouse_api] API submission failed ({result['message']}) — falling back to Playwright")
        from scripts.greenhouse_playwright_backup import apply as pw_apply
        await pw_apply(url)


# ── URL parsing tests ─────────────────────────────────────────────────────────

def test_url_parsing() -> None:
    TEST_CASES = [
        {
            "label":        "Direct board URL",
            "url":          "https://job-boards.greenhouse.io/scoutmotors/jobs/5128323007",
            "expect_token": "scoutmotors",
            "expect_id":    "5128323007",
        },
        {
            "label":        "Embedded gh_jid URL",
            "url":          "https://www.digicert.com/careers?gh_jid=8524673002#application_form",
            "expect_token": None,  # extracted from live page — just verify non-None
            "expect_id":    "8524673002",
        },
    ]
    for tc in TEST_CASES:
        token, job_id = parse_greenhouse_url(tc["url"])
        assert job_id == tc["expect_id"], f"Job ID mismatch for {tc['label']}: {job_id}"
        if tc["expect_token"]:
            assert token == tc["expect_token"], f"Token mismatch for {tc['label']}: {token}"
        else:
            assert token is not None, f"Token was None for {tc['label']}"
        print(f"✅ {tc['label']}: token={token}, job_id={job_id}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", help="URL to apply to")
    parser.add_argument("--test-parse", action="store_true", help="Run URL parsing tests")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.test_parse:
        test_url_parsing()
    elif args.url:
        asyncio.run(apply(args.url))
    else:
        parser.print_help()
