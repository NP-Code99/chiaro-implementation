"""
Detect which ATS platform a job URL belongs to.
Returns a string key used to route to the correct filler script.
"""

ATS_PATTERNS: dict[str, list[str]] = {
    "bamboohr":        ["bamboohr.com"],
    "greenhouse":      ["greenhouse.io", "gh_jid=", "boards.greenhouse", "job-boards.greenhouse"],
    "lever":           ["jobs.lever.co", "lever.co/jobs", "lever.co/"],
    "trakstar":        ["hire.trakstar.com", "trakstar.com"],
    "personio":        ["personio.de", "personio.com"],
    "teamtailor":      ["teamtailor.com"],
    "ashby":           ["ashbyhq.com", "jobs.ashbyhq.com"],
    "workday":         ["myworkday.com", "wd1.myworkdayjobs", "wd3.myworkdayjobs", "wd5.myworkdayjobs"],
    "smartrecruiters": ["jobs.smartrecruiters.com", "smartrecruiters.com/job"],
    "icims":           ["icims.com", "careers.icims"],
    "taleo":           ["taleo.net"],
    "successfactors":  ["successfactors.com", "sap.com/careers"],
    "rippling":        ["rippling.com/jobs", "ats.rippling.com"],
    "workable":        ["apply.workable.com"],
    "breezy":          ["breezy.hr"],
    "recruitee":       ["recruitee.com"],
    "jobvite":         ["jobvite.com", "hire.jobvite.com"],
    "jazz":            ["app.jazz.co"],
    "dover":           ["jobs.dover.com"],
}


def detect_ats(url: str) -> str:
    url_lower = url.lower()
    for ats, patterns in ATS_PATTERNS.items():
        if any(p in url_lower for p in patterns):
            return ats
    return "unknown"
