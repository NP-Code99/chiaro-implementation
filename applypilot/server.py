"""
ApplyPilot FastAPI microservice — port 8765.

Called by the Next.js job queue when a user swipes right.
Receives job + profile JSON, runs the multi-board Playwright engine,
and returns the structured result.

Start with:  uvicorn server:app --port 8765 --reload
Or via:      python server.py
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path

BASE_DIR = Path(__file__).parent
sys.path.insert(0, str(BASE_DIR))

from dotenv import load_dotenv
load_dotenv(BASE_DIR / ".env")

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from applypilot.apply.engine import run_apply, detect_board

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s  %(message)s")
log = logging.getLogger("applypilot.server")

app = FastAPI(title="ApplyPilot", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request / Response schemas ────────────────────────────────────────────────

class JobPayload(BaseModel):
    id: str = ""
    title: str = ""
    company: str = ""
    applyUrl: str
    location: str = ""
    description: str = ""


class ApplyRequest(BaseModel):
    job: JobPayload
    profile: dict = Field(default_factory=dict)
    applicationId: str = ""
    dryRun: bool = False


class ApplyResponse(BaseModel):
    status: str           # "applied" | "failed" | "needs_review"
    errorMessage: str = ""
    screenshotUrl: str = ""
    board: str = ""
    pendingQuestions: list[str] = Field(default_factory=list)
    blockerFields: list[str] = Field(default_factory=list)


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"ok": True, "service": "applypilot"}


@app.post("/apply", response_model=ApplyResponse)
async def apply_endpoint(req: ApplyRequest):
    apply_url = req.job.applyUrl
    if not apply_url:
        raise HTTPException(status_code=400, detail="job.applyUrl is required")

    job_dict = req.job.model_dump()
    # Rename to match engine expectations
    job_dict["title"] = req.job.title
    job_dict["company"] = req.job.company

    board = detect_board(apply_url)
    log.info("apply request: board=%s url=%s appId=%s dry=%s",
             board, apply_url, req.applicationId, req.dryRun)

    ss_dir = Path("/tmp/applypilot_screenshots") / (req.applicationId or "job")

    try:
        result = await run_apply(
            apply_url=apply_url,
            profile=req.profile,
            job=job_dict,
            dry_run=req.dryRun,
            screenshot_dir=ss_dir,
        )
    except Exception as exc:
        log.exception("run_apply raised for %s", apply_url)
        return ApplyResponse(status="failed", errorMessage=str(exc), board=board)

    log.info("result: status=%s board=%s appId=%s", result.status, board, req.applicationId)

    return ApplyResponse(
        status=result.status,
        errorMessage=result.error_message,
        screenshotUrl=result.screenshot_url,
        board=board,
        pendingQuestions=result.pending_questions,
        blockerFields=result.blocker_fields,
    )


@app.get("/boards")
async def list_boards():
    """Return which boards are supported and their detection patterns."""
    return {
        "greenhouse": "greenhouse.io",
        "lever": "lever.co",
        "workday": "workday.com / myworkdayjobs.com",
        "ashby": "ashbyhq.com",
        "bamboohr": "bamboohr.com",
        "smartrecruiters": "smartrecruiters.com",
        "generic": "all others (AI-driven)",
    }


# ── Dev entry point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("APPLYPILOT_PORT", "8765"))
    log.info("Starting ApplyPilot server on port %d", port)
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=False)
