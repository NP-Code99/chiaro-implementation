"""
Greenhouse Job Board API filler — zero browser, pure HTTP.

Handles URL patterns:
  A) Direct US:  https://job-boards.greenhouse.io/BOARD/jobs/JOB_ID
  B) Direct EU:  https://job-boards.eu.greenhouse.io/BOARD/jobs/JOB_ID
  C) Embedded:   https://company.com/careers?gh_jid=JOB_ID

Falls back to Playwright if board token cannot be found or API rejects.
Entry point called by autofill_orchestrator: apply(url)
"""

import asyncio, re, sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.cover_letter import generate_cover_letter
from utils.logger import log
from utils.profile_loader import load_profile

BOARDS_API_US    = "https://boards-api.greenhouse.io/v1/boards"
BOARDS_SUBMIT_US = "https://boards.greenhouse.io"
BOARDS_SUBMIT_EU = "https://boards.eu.greenhouse.io"

DRY_RUN = "--dry-run" in sys.argv


# ── URL parsing ───────────────────────────────────────────────────────────────

def parse_greenhouse_url(url: str) -> tuple[str | None, str | None, str, bool]:
    """
    Return (board_token, job_id, api_base, is_eu).
    Always uses BOARDS_API_US for reads — eu.greenhouse.io jobs use the same read API.
    is_eu flag controls which submit host to use.
    """
    api_base = BOARDS_API_US
    is_eu    = "eu.greenhouse.io" in url

    # Pattern A: direct board URL (US or EU)
    m = re.search(r"greenhouse\.io/([^/?#]+)/jobs/(\d+)", url)
    if m:
        return m.group(1), m.group(2), api_base, is_eu

    # Pattern B: embedded gh_jid= param
    m = re.search(r"gh_jid=(\d+)", url)
    if m:
        job_id = m.group(1)
        board_token = _extract_board_token_from_page(url, api_base)
        return board_token, job_id, api_base, is_eu

    # Pattern C: large numeric ID in URL path (e.g. cribl.io/job-detail/5990909004/)
    # Try the hostname as board token, probe API to confirm
    m = re.search(r"/(\d{9,})", url)
    if m:
        job_id = m.group(1)
        from urllib.parse import urlparse
        hostname = (urlparse(url).hostname or "").replace("www.", "")
        candidate = hostname.split(".")[0]
        if candidate:
            probe = requests.get(f"{api_base}/{candidate}/jobs/{job_id}", timeout=8)
            if probe.status_code == 200:
                log(f"[greenhouse_api] Pattern C matched: token={candidate}, id={job_id}")
                return candidate, job_id, api_base, is_eu
        # Fallback: try HTML extraction
        board_token = _extract_board_token_from_page(url, api_base)
        return board_token, job_id, api_base, is_eu

    return None, None, api_base, is_eu


def _extract_board_token_from_page(url: str, api_base: str) -> str | None:
    """
    Fetch the company page HTML and extract the Greenhouse board token.
    Falls back to hostname-derived token validated against the API.
    """
    from urllib.parse import urlparse

    try:
        resp = requests.get(url, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
        html = resp.text
        patterns = [
            r'data-board-token=["\']([^"\']+)["\']',
            r'"boardToken"\s*:\s*"([^"]+)"',
            r'Greenhouse\.Settings\s*=.*?"([a-z0-9_]+)"',
            r'boards(?:\.eu)?\.greenhouse\.io/([a-z0-9_]+)',
            r'token["\s:=]+["\']([a-z0-9_]{4,40})["\']',
        ]
        for pattern in patterns:
            match = re.search(pattern, html, re.IGNORECASE)
            if match:
                candidate = match.group(1).lower()
                if re.match(r'^[a-z0-9_]+$', candidate):
                    log(f"[greenhouse_api] Board token from HTML: {candidate}")
                    return candidate
    except Exception as e:
        log(f"[greenhouse_api] HTML extraction failed: {e}")

    # Hostname fallback: digicert.com → "digicert", probe API to confirm
    try:
        parsed = urlparse(url)
        hostname = (parsed.hostname or "").replace("www.", "")
        candidate = hostname.split(".")[0]
        if candidate and re.match(r'^[a-z0-9_]+$', candidate):
            probe = requests.get(f"{api_base}/{candidate}/jobs", timeout=8)
            if probe.status_code == 200:
                log(f"[greenhouse_api] Board token from hostname: {candidate}")
                return candidate
    except Exception as e:
        log(f"[greenhouse_api] Hostname probe failed: {e}")

    return None


# ── API calls ─────────────────────────────────────────────────────────────────

def fetch_job_questions(board_token: str, job_id: str, api_base: str) -> dict:
    """GET job details + all application questions from Greenhouse Job Board API."""
    url = f"{api_base}/{board_token}/jobs/{job_id}"
    resp = requests.get(url, params={"questions": "true"}, timeout=10)
    if resp.status_code != 200:
        raise RuntimeError(f"Greenhouse API {resp.status_code}: {resp.text[:200]}")
    return resp.json()


# ── Dropdown value helpers ────────────────────────────────────────────────────

def _pick_value(values: list, *preferences: str, fallback_first: bool = True) -> int | str | None:
    """
    Search `values` list for the first option whose label contains any of
    the preference strings (case-insensitive). Returns the value ID.
    Falls back to the first option if fallback_first=True.
    """
    for pref in preferences:
        for v in values:
            if pref.lower() in v.get("label", "").lower():
                return v["value"]
    return values[0]["value"] if (fallback_first and values) else None


def _pick_no(values: list) -> int | str:
    """Return the value ID of the 'No' option, or last option as fallback."""
    for v in values:
        if v.get("label", "").strip().lower() == "no":
            return v["value"]
    return values[-1]["value"] if values else 0


def _pick_yes(values: list) -> int | str:
    """Return the value ID of the 'Yes' option, or first option as fallback."""
    for v in values:
        if v.get("label", "").strip().lower() == "yes":
            return v["value"]
    return values[0]["value"] if values else 1


def _pick_country(values: list, country: str = "United States") -> int | str | None:
    """Find the value ID matching the candidate's country from a country dropdown."""
    country_lower = country.lower()
    # Pass 1: exact match
    for v in values:
        if v.get("label", "").lower() == country_lower:
            return v["value"]
    # Pass 2: label contains the full country string (handles "United States of America (USA)")
    for v in values:
        if country_lower in v.get("label", "").lower():
            return v["value"]
    # Pass 3: label starts with a meaningful prefix (≥8 chars to avoid "Unite" matching UAE)
    prefix = country_lower[:max(8, len(country_lower))]
    for v in values:
        if v.get("label", "").lower().startswith(prefix):
            return v["value"]
    return values[0]["value"] if values else None


# ── Answer mapping ────────────────────────────────────────────────────────────

def map_answers(questions: list, profile: dict, cover_letter_text: str) -> dict:
    """
    Walk every question from the API and return a flat {field_name: value}
    dict ready to POST. Logs any question that couldn't be fully resolved.
    """
    p  = profile.get("personal", {})
    wa = profile.get("work_authorization", {})
    e  = profile.get("employment", {})
    d  = profile.get("demographics", {})
    addr = p.get("address", {})

    answers: dict = {}

    for question in questions:
        raw_label = question.get("label", "")
        label     = raw_label.lower()

        for field in question.get("fields", []):
            name   = field["name"]
            q_type = field["type"]
            values = field.get("values", [])

            # ── Skip file-type fields (handled separately as multipart) ───
            if q_type == "input_file":
                continue

            # ── Standard built-in fields ──────────────────────────────────
            if name == "first_name":
                answers[name] = p.get("first_name", "")

            elif name == "last_name":
                answers[name] = p.get("last_name", "")

            elif name == "email":
                answers[name] = p.get("email", "")

            elif name == "phone":
                answers[name] = p.get("phone", "")

            elif name == "resume_text":
                pass  # skip — resume uploaded as file

            # ── Cover letter text area ────────────────────────────────────
            elif name in ("cover_letter_text", "cover_letter"):
                answers[name] = cover_letter_text

            # ── Preferred / display name ──────────────────────────────────
            elif any(k in label for k in ["preferred first name", "preferred name", "display name", "nickname"]):
                answers[name] = p.get("first_name", "")

            # ── Current company ───────────────────────────────────────────
            elif any(k in label for k in ["current company", "current employer", "employer name", "company name"]):
                val = e.get("current_company", "")
                answers[name] = "N/A" if val.startswith("[") else val

            # ── Current job title ─────────────────────────────────────────
            elif any(k in label for k in ["current job title", "current title", "current position", "job title"]):
                val = e.get("current_title", "")
                answers[name] = "Student" if val.startswith("[") else val

            # ── City — use word-boundary to avoid matching "capacity" etc. ─
            elif re.search(r'\bcity\b', label) and "state" not in label and not values:
                answers[name] = addr.get("city", "")

            elif any(k in label for k in ["current location: city", "current city"]) and not values:
                answers[name] = addr.get("city", "")

            # ── State (text) ──────────────────────────────────────────────
            elif re.search(r'\bstate\b', label) and not values:
                answers[name] = addr.get("state", "")

            # ── State (dropdown) ──────────────────────────────────────────
            elif re.search(r'\bstate\b', label) and values:
                state_val = addr.get("state", "")
                answers[name] = _pick_value(values, state_val) or values[0]["value"]

            # ── Country / Location dropdown ───────────────────────────────
            # Guard: skip if "country" only appears in context of work auth/sponsorship
            elif any(k in label for k in ["country", "location", "where are you located", "where do you live", "where are you based"]) and values \
                    and not any(k in label for k in ["sponsorship", "authorized", "authorization", "right to work"]):
                raw_country = addr.get("country", "United States")
                # Strip placeholder text like "[YOUR COUNTRY — e.g. United States]"
                country = "United States" if raw_country.startswith("[") else raw_country
                answers[name] = _pick_country(values, country)

            # ── Work authorization / right to work ────────────────────────
            elif any(k in label for k in ["authorized", "eligible to work", "legally authorized",
                                           "right to work", "work in the us", "work authorization",
                                           "work permit", "require a work"]):
                auth = wa.get("authorized_to_work", True)
                if q_type == "yes_no":
                    answers[name] = 1 if auth else 0
                elif values:
                    answers[name] = _pick_yes(values) if auth else _pick_no(values)
                else:
                    answers[name] = "Yes" if auth else "No"

            # ── Sponsorship ───────────────────────────────────────────────
            elif any(k in label for k in ["sponsorship", "require sponsorship", "visa sponsor",
                                           "need sponsorship", "require a visa"]):
                needs = wa.get("requires_sponsorship", False)
                if q_type == "yes_no":
                    answers[name] = 1 if needs else 0
                elif values:
                    answers[name] = _pick_yes(values) if needs else _pick_no(values)
                else:
                    answers[name] = "Yes" if needs else "No"

            # ── Salary ────────────────────────────────────────────────────
            elif any(k in label for k in ["salary", "compensation", "expected pay", "desired pay", "desired salary"]):
                answers[name] = str(e.get("desired_salary", ""))

            # ── Start date ────────────────────────────────────────────────
            elif any(k in label for k in ["start date", "earliest start", "when can you join",
                                           "when can you start", "available to start"]):
                answers[name] = e.get("available_start_date", "")

            # ── LinkedIn ──────────────────────────────────────────────────
            elif "linkedin" in label:
                answers[name] = p.get("linkedin", "")

            # ── GitHub ────────────────────────────────────────────────────
            elif "github" in label:
                answers[name] = p.get("github", "")

            # ── Portfolio / website ───────────────────────────────────────
            elif any(k in label for k in ["portfolio", "personal site", "personal website", "website url",
                                           "website"]) and q_type == "input_text":
                portfolio = p.get("portfolio", "")
                portfolio = "" if portfolio.startswith("[") else portfolio
                answers[name] = portfolio or p.get("github", "")

            # ── Availability / start date (text) ─────────────────────────
            elif any(k in label for k in ["availability", "when can you start", "when are you available",
                                           "earliest start", "available to start"]) and q_type != "multi_value_single_select":
                start = e.get("available_start_date", "immediately")
                answers[name] = f"I am available to start {start}. I am flexible and can accommodate the team's needs."

            # ── Cover letter / additional info ────────────────────────────
            elif any(k in label for k in ["cover letter", "additional information", "tell us", "why are you",
                                           "motivation", "anything else", "other details"]):
                answers[name] = cover_letter_text

            # ── Relocate ──────────────────────────────────────────────────
            elif "relocat" in label:
                val = e.get("willing_to_relocate", False)
                if values:
                    answers[name] = _pick_yes(values) if val else _pick_no(values)
                else:
                    answers[name] = "Yes" if val else "No"

            # ── Remote ────────────────────────────────────────────────────
            elif any(k in label for k in ["remote", "work from home"]):
                answers[name] = _pick_yes(values) if values else "Yes"

            # ── Years of experience ───────────────────────────────────────
            elif any(k in label for k in ["years of experience", "how many years", "experience level",
                                           "years experience"]):
                yrs = str(e.get("years_of_experience", ""))
                if values:
                    answers[name] = _pick_value(values, yrs) or values[0]["value"]
                else:
                    answers[name] = yrs

            # ── Education level ───────────────────────────────────────────
            elif any(k in label for k in ["highest level of education", "education level",
                                           "highest education", "degree"]):
                edu_list = profile.get("education", [])
                edu_str  = (edu_list[0].get("degree", "") if edu_list and isinstance(edu_list[0], dict) else "").lower()
                if values:
                    for kw in ["master", "bachelor", "phd", "doctorate", "associate"]:
                        if kw in edu_str:
                            match = _pick_value(values, kw, fallback_first=False)
                            if match:
                                answers[name] = match
                                break
                    else:
                        answers[name] = values[0]["value"]
                else:
                    answers[name] = edu_str or "Bachelor's Degree"

            # ── How did you hear / referral source ────────────────────────
            elif any(k in label for k in ["how did you hear", "how did you find",
                                           "where did you hear", "source"]):
                # Prefer "Job Board", then "Online", then first option
                answers[name] = _pick_value(values, "job board", "startup", "online", "internet", "website")

            # ── Data privacy / GDPR consent ───────────────────────────────
            elif any(k in label for k in ["data privacy", "privacy notice", "gdpr",
                                           "privacy policy", "data protection"]):
                # Pick "Acknowledged" or first option
                answers[name] = _pick_value(values, "acknowledged", "accept", "agree", "yes")

            # ── Recording / interview consent ─────────────────────────────
            elif any(k in label for k in ["recording", "consent to a recording", "record this session",
                                           "consent to record"]):
                answers[name] = _pick_yes(values) if values else "Yes"

            # ── Consent / general acknowledgement ────────────────────────
            elif any(k in label for k in ["i confirm", "i agree", "i acknowledge", "i certify", "i consent",
                                           "i understand", "i accept"]):
                answers[name] = _pick_yes(values) if values else "Yes"

            # ── "Have you worked with X before" / prior company experience ─
            elif any(k in label for k in ["have you worked with", "have you worked at",
                                           "worked with us before", "previously worked with",
                                           "in any capacity"]):
                answers[name] = _pick_no(values) if values else "No"

            # ── "Are you a graduate / alumnus of X" ───────────────────────
            elif any(k in label for k in ["are you a graduate", "are you an alumnus",
                                           "are you an alumni", "graduate of a"]):
                answers[name] = _pick_no(values) if values else "No"

            # ── Prior employment at this specific company ─────────────────
            elif any(k in label for k in ["do you currently work for", "previously been employed by",
                                           "are you currently employed by", "ever worked for",
                                           "former employee"]):
                answers[name] = _pick_no(values) if values else "No"

            # ── Conflict of interest ──────────────────────────────────────
            elif any(k in label for k in ["conflict of interest", "professional or personal connections",
                                           "connections to individuals"]):
                answers[name] = _pick_no(values) if values else "No"

            # ── Conditional follow-up (if yes, please describe...) ────────
            elif any(k in label for k in ["if yes, please", "if referred, please",
                                           "if so, please", "if applicable"]):
                answers[name] = ""

            # ── On-site / in-person requirement ──────────────────────────
            elif any(k in label for k in ["on-site requirements", "on-site work", "in-person meetings",
                                           "able to meet the on-site"]):
                answers[name] = _pick_yes(values) if values else "Yes"

            # ── "Are you subject to restrictions" (non-compete etc.) ──────
            elif any(k in label for k in ["subject to any restriction", "non-compete", "restrictive covenant"]):
                answers[name] = ""  # leave blank

            # ── Any remaining dropdown — use first sensible option ────────
            elif q_type in ("multi_value_single_select", "multi_value_multi_select",
                            "multi_select", "single_select") and values:
                log(f"[greenhouse_api] ⚠  Fallback select: '{raw_label[:60]}' — first option")
                answers[name] = values[0]["value"]

            # ── Unknown text field ────────────────────────────────────────
            else:
                log(f"[greenhouse_api] ⚠  Unanswered: '{raw_label[:60]}' (type={q_type})")

    # ── EEOC demographics ─────────────────────────────────────────────────────
    GENDER_MAP = {
        "Male": "1", "Female": "2", "Non-binary": "3", "Prefer not to say": "3",
    }
    RACE_MAP = {
        "Hispanic": "1", "White": "2", "Black": "3", "Asian": "6",
        "Two or more races": "8", "Prefer not to say": "10",
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
    is_eu: bool = False,
) -> dict:
    """POST the application via multipart/form-data to Greenhouse boards submit endpoint.

    Greenhouse expects fields wrapped as job_application[field_name] for text/select fields,
    and job_application[resume] / job_application[cover_letter] for file uploads.
    The job_id is sent as a top-level field.
    """
    submit_host = BOARDS_SUBMIT_EU if is_eu else BOARDS_SUBMIT_US
    url = f"{submit_host}/{board_token}/jobs/{job_id}"

    if not resume_path or not Path(resume_path).exists():
        return {"status": "error", "message": f"Resume not found: {resume_path}"}

    # Wrap all answer fields under job_application[...] — skip job_id (sent top-level)
    raw = dict(answers)
    raw.pop("job_id", None)
    data: dict = {"job_id": job_id}
    for k, v in raw.items():
        data[f"job_application[{k}]"] = v

    files: dict = {}
    files["job_application[resume]"] = (
        "resume.pdf", open(resume_path, "rb"), "application/pdf"
    )
    if cover_letter_path and cover_letter_path not in ("generate", ""):
        cl_p = Path(cover_letter_path)
        if cl_p.exists():
            files["job_application[cover_letter]"] = (
                "cover_letter.pdf", open(cover_letter_path, "rb"), "application/pdf"
            )

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": f"{submit_host}/{board_token}/jobs/{job_id}",
        "Accept": "application/json, text/html, */*",
        "X-Requested-With": "XMLHttpRequest",
    }

    try:
        resp = requests.post(url, data=data, files=files, headers=headers,
                             timeout=30, allow_redirects=True)
        if resp.status_code in (200, 201):
            log(f"[greenhouse_api] ✅ Submitted (HTTP {resp.status_code}) — {resp.url}")
            return {"status": "success", "response_code": resp.status_code, "final_url": resp.url}
        log(f"[greenhouse_api] ❌ HTTP {resp.status_code}: {resp.text[:400]}")
        return {"status": "error", "message": f"HTTP {resp.status_code}: {resp.text[:300]}",
                "response_code": resp.status_code}
    except Exception as exc:
        log(f"[greenhouse_api] ❌ Request error: {exc}")
        return {"status": "error", "message": str(exc)}


# ── Main entry point ──────────────────────────────────────────────────────────

async def apply(url: str) -> None:
    """Entry point called by autofill_orchestrator. Raises on hard failure."""
    global DRY_RUN
    DRY_RUN = "--dry-run" in sys.argv

    log(f"\n[greenhouse_api] ── Starting API application ──")
    log(f"[greenhouse_api] URL: {url}")

    profile = load_profile()

    # 1. Parse URL → board_token, job_id, api_base, is_eu
    board_token, job_id, api_base, _ = parse_greenhouse_url(url)

    if not board_token:
        log("[greenhouse_api] ❌ Cannot extract board token — falling back to Playwright")
        from scripts.greenhouse_playwright_backup import apply as pw_apply
        await pw_apply(url)
        return

    if not job_id:
        raise RuntimeError("Could not extract job_id from Greenhouse URL")

    eu_tag = " [EU]" if "eu.greenhouse.io" in url else ""
    log(f"[greenhouse_api] Board: {board_token}{eu_tag}  |  Job ID: {job_id}")

    # 2. Fetch questions
    try:
        job_data  = fetch_job_questions(board_token, job_id, api_base)
        questions = job_data.get("questions", [])
        log(f"[greenhouse_api] Fetched {len(questions)} questions from API")
    except Exception as exc:
        log(f"[greenhouse_api] ❌ API fetch failed: {exc} — falling back to Playwright")
        from scripts.greenhouse_playwright_backup import apply as pw_apply
        await pw_apply(url)
        return

    # 3. Generate cover letter
    cl_text = ""
    try:
        cl_path = profile.get("cover_letter_path", "generate")
        if not cl_path or cl_path == "generate":
            cl_text = generate_cover_letter(
                job_title=job_data.get("title", "the role"),
                company=board_token.replace("-", " ").replace("_", " ").title(),
                profile=profile,
                tone=profile.get("cover_letter_tone", "Professional"),
            )
            log(f"[greenhouse_api] Cover letter generated ({len(cl_text)} chars)")
    except Exception as exc:
        log(f"[greenhouse_api] Cover letter generation failed: {exc}")

    # 4. Map all answers
    answers = map_answers(questions, profile, cl_text)
    answers["job_id"] = job_id

    log(f"[greenhouse_api] Mapped {len(answers)} answers:")
    for k, v in answers.items():
        display = str(v)[:70] + "..." if len(str(v)) > 70 else str(v)
        log(f"  {k:45} → {display}")

    # 5. Dry-run: stop here
    if DRY_RUN:
        log("[greenhouse_api] 🔍 DRY RUN — payload ready, not submitting")
        return

    # 6. Submit via Playwright (uses pre-computed answers to fill the browser form)
    from scripts.greenhouse_playwright_backup import apply_with_answers
    await apply_with_answers(url, questions, answers, profile)


# ── URL parsing self-tests ────────────────────────────────────────────────────

def test_url_parsing() -> None:
    TEST_CASES = [
        {
            "label":        "Direct US board URL",
            "url":          "https://job-boards.greenhouse.io/scoutmotors/jobs/5128323007",
            "expect_token": "scoutmotors",
            "expect_id":    "5128323007",
            "expect_eu":    False,
        },
        {
            "label":        "Direct EU board URL",
            "url":          "https://job-boards.eu.greenhouse.io/rtbhouse/jobs/4869107101",
            "expect_token": "rtbhouse",
            "expect_id":    "4869107101",
            "expect_eu":    True,
        },
        {
            "label":        "Direct board with UTM params",
            "url":          "https://job-boards.greenhouse.io/correlationone/jobs/5997984004?utm_source=startup.jobs",
            "expect_token": "correlationone",
            "expect_id":    "5997984004",
            "expect_eu":    False,
        },
        {
            "label":        "Embedded gh_jid URL",
            "url":          "https://www.digicert.com/careers?gh_jid=8524673002#application_form",
            "expect_token": None,
            "expect_id":    "8524673002",
            "expect_eu":    False,
        },
    ]
    for tc in TEST_CASES:
        token, job_id, _, is_eu = parse_greenhouse_url(tc["url"])
        assert job_id == tc["expect_id"],   f"Job ID mismatch for {tc['label']}: got {job_id}"
        if tc["expect_token"]:
            assert token == tc["expect_token"], f"Token mismatch for {tc['label']}: got {token}"
        else:
            assert token is not None,       f"Token was None for {tc['label']}"
        is_eu = "eu.greenhouse.io" in tc["url"]
        assert is_eu == tc["expect_eu"],    f"EU mismatch for {tc['label']}: got {is_eu}"
        print(f"✅ {tc['label']}: token={token}, id={job_id}, eu={is_eu}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--url",        help="Greenhouse job URL to apply to")
    parser.add_argument("--test-parse", action="store_true", help="Run URL parsing tests")
    parser.add_argument("--dry-run",    action="store_true")
    args = parser.parse_args()

    if args.test_parse:
        test_url_parsing()
    elif args.url:
        asyncio.run(apply(args.url))
    else:
        parser.print_help()
