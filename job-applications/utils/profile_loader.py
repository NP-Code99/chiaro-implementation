"""
Profile loader — bridges the TypeScript UserProfile (passed via env vars)
into the Python profile dict structure used by all ATS scripts.

Priority order:
  1. APPLY_PROFILE_JSON env var (full profile from TS localStorage)
  2. Individual APPLY_* env vars (basic fields set by queue processor)
  3. profile.yaml fallback (for fields only set at setup time)
"""

import os, json, base64, tempfile, re
from pathlib import Path

_PROFILE_YAML_PATH = Path(__file__).parent.parent / "profile.yaml"


def _load_yaml_profile() -> dict:
    try:
        import yaml
        return yaml.safe_load(_PROFILE_YAML_PATH.read_text()) or {}
    except Exception:
        return {}


def _parse_location(location: str) -> dict:
    """Parse 'City, ST' or 'City, State' into {city, state}."""
    parts = [p.strip() for p in location.split(",")]
    return {
        "city":  parts[0] if parts else "",
        "state": parts[1] if len(parts) > 1 else "",
    }


def _clean_salary(raw: str) -> str:
    """'$120,000 - $150,000' → '120000', '130000' → '130000'."""
    if not raw:
        return ""
    nums = re.findall(r"\d+", raw.replace(",", ""))
    return nums[0] if nums else raw


def _work_auth_flags(work_auth: str) -> tuple[bool, bool, str]:
    """Returns (authorized_to_work, requires_sponsorship, visa_status)."""
    work_auth = (work_auth or "").strip()
    if work_auth in ("US Citizen", "Green Card"):
        return True, False, work_auth
    if work_auth == "H1B Visa":
        return True, False, "H1B Visa"
    if work_auth == "Need Sponsorship":
        return True, True, "Requires sponsorship"
    return True, False, work_auth


def _save_resume_from_b64(b64: str, filename: str) -> str:
    """Write base64 PDF to a temp file and return the path."""
    try:
        data = base64.b64decode(b64)
        suffix = Path(filename).suffix or ".pdf"
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp.write(data)
        tmp.close()
        return tmp.name
    except Exception:
        return ""


def load_profile() -> dict:
    """
    Return a profile dict matching the profile.yaml structure.
    Reads from APPLY_PROFILE_JSON → individual env vars → profile.yaml.
    """
    yaml_profile = _load_yaml_profile()
    yaml_personal = yaml_profile.get("personal", {})
    yaml_addr     = yaml_personal.get("address", {})
    yaml_employ   = yaml_profile.get("employment", {})
    yaml_auth     = yaml_profile.get("work_authorization", {})
    yaml_demo     = yaml_profile.get("demographics", {})

    # ── Source: APPLY_PROFILE_JSON (full TypeScript UserProfile JSON) ──────────
    ts_profile: dict = {}
    raw_json = os.environ.get("APPLY_PROFILE_JSON", "")
    if raw_json:
        try:
            ts_profile = json.loads(raw_json)
        except Exception:
            pass

    # ── Map TypeScript fields → Python fields ──────────────────────────────────
    first_name = (
        ts_profile.get("firstName")
        or os.environ.get("APPLY_FIRST_NAME")
        or yaml_personal.get("first_name", "")
    )
    last_name = (
        ts_profile.get("lastName")
        or os.environ.get("APPLY_LAST_NAME")
        or yaml_personal.get("last_name", "")
    )
    email = (
        ts_profile.get("email")
        or os.environ.get("APPLY_EMAIL")
        or yaml_personal.get("email", "")
    )
    phone = (
        ts_profile.get("phone")
        or os.environ.get("APPLY_PHONE")
        or yaml_personal.get("phone", "")
    )
    linkedin = (
        ts_profile.get("linkedin")
        or os.environ.get("APPLY_LINKEDIN")
        or yaml_personal.get("linkedin", "")
    )
    github = (
        ts_profile.get("github")
        or yaml_personal.get("github", "")
    )

    # Location parsing
    loc_raw = ts_profile.get("location", "")
    loc = _parse_location(loc_raw) if loc_raw else {}
    city    = loc.get("city")  or yaml_addr.get("city", "")
    state   = loc.get("state") or yaml_addr.get("state", "")
    street  = yaml_addr.get("street", "")
    zip_    = yaml_addr.get("zip", "")
    country = yaml_addr.get("country", "United States")

    # Work auth
    auth_authorized, auth_sponsorship, visa_status = _work_auth_flags(
        ts_profile.get("workAuth", "")
    )
    if not ts_profile.get("workAuth"):
        auth_authorized  = yaml_auth.get("authorized_to_work", True)
        auth_sponsorship = yaml_auth.get("requires_sponsorship", False)
        visa_status      = yaml_auth.get("visa_status", "")

    # Salary
    salary_raw = ts_profile.get("desiredSalary", "") or str(yaml_employ.get("desired_salary", ""))
    desired_salary = _clean_salary(salary_raw)

    # Years of experience
    years_exp_raw = ts_profile.get("yearsExp", "") or str(yaml_employ.get("years_of_experience", ""))
    years_exp = years_exp_raw.split("-")[0] if "-" in years_exp_raw else years_exp_raw

    # Skills / bio
    skills = yaml_profile.get("skills", "") or ts_profile.get("bio", "")

    # Resume path — env var first, then base64 decode, then yaml
    resume_path = (
        os.environ.get("APPLY_RESUME_PATH")
        or yaml_profile.get("resume_path", "")
    )
    resume_b64 = ts_profile.get("resumeBase64", "")
    if resume_b64 and (not resume_path or not Path(resume_path).exists()):
        filename = ts_profile.get("resumeFilename", "resume.pdf")
        resume_path = _save_resume_from_b64(resume_b64, filename)

    # Phone country code
    phone_country_code = (
        ts_profile.get("phoneCountryCode")
        or yaml_personal.get("phone_country_code", "+1")
    )

    # Assemble final profile dict matching profile.yaml structure
    profile = {
        "personal": {
            "first_name": first_name,
            "last_name":  last_name,
            "email":      email,
            "phone":      phone,
            "phone_country_code": phone_country_code,
            "linkedin":   linkedin,
            "github":     github,
            "portfolio":  yaml_personal.get("portfolio", ""),
            "address": {
                "street":  street,
                "city":    city,
                "state":   state,
                "zip":     zip_,
                "country": country,
            },
        },
        "work_authorization": {
            "authorized_to_work":   auth_authorized,
            "requires_sponsorship": auth_sponsorship,
            "visa_status":          visa_status,
        },
        "employment": {
            "desired_salary":       desired_salary,
            "salary_currency":      yaml_employ.get("salary_currency", "USD"),
            "available_start_date": yaml_employ.get("available_start_date", ""),
            "willing_to_relocate":  yaml_employ.get("willing_to_relocate", False),
            "employment_type":      yaml_employ.get("employment_type", "Full-time"),
            "years_of_experience":  years_exp,
            "current_title":        yaml_employ.get("current_title", ""),
            "current_company":      yaml_employ.get("current_company", ""),
        },
        "education":    yaml_profile.get("education", []),
        "skills":       skills,
        "resume_path":  resume_path,
        "cover_letter_path": yaml_profile.get("cover_letter_path", "generate"),
        "demographics": {
            "gender":           ts_profile.get("gender")           or yaml_demo.get("gender",           "Prefer not to say"),
            "ethnicity":        ts_profile.get("ethnicity")        or yaml_demo.get("ethnicity",        "Prefer not to say"),
            "veteran_status":   ts_profile.get("veteranStatus")    or yaml_demo.get("veteran_status",   "I don't wish to answer"),
            "disability_status":ts_profile.get("disabilityStatus") or yaml_demo.get("disability_status","I don't wish to answer"),
        },
        "cover_letter_tone": yaml_profile.get("cover_letter_tone", "Professional"),
        "custom_answers":    yaml_profile.get("custom_answers", {}),
    }
    return profile


def write_profile_yaml(profile: dict) -> None:
    """Write profile dict back to profile.yaml so legacy scripts can read it."""
    try:
        import yaml
        _PROFILE_YAML_PATH.write_text(yaml.dump(profile, allow_unicode=True, default_flow_style=False))
    except Exception as e:
        print(f"[profile_loader] ⚠ Could not write profile.yaml: {e}")


def check_required(profile: dict) -> tuple[bool, list[str]]:
    """Return (is_complete, missing_fields). Blocks auto-fill if incomplete."""
    required = {
        "first_name": profile["personal"]["first_name"],
        "last_name":  profile["personal"]["last_name"],
        "email":      profile["personal"]["email"],
        "phone":      profile["personal"]["phone"],
        "resume_path":profile["resume_path"],
    }
    missing = [k for k, v in required.items() if not v]
    return len(missing) == 0, missing
