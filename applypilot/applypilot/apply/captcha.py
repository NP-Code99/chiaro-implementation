"""CapSolver integration for CAPTCHA solving."""
import logging
import os
import time

import requests

log = logging.getLogger(__name__)
API_KEY = os.environ.get("CAPSOLVER_API_KEY", "")
BASE_URL = "https://api.capsolver.com"


def _post(endpoint: str, payload: dict) -> dict:
    resp = requests.post(f"{BASE_URL}{endpoint}", json=payload, timeout=30)
    resp.raise_for_status()
    return resp.json()


def _create_task(task: dict) -> str:
    data = _post("/createTask", {"clientKey": API_KEY, "task": task})
    if data.get("errorCode"):
        raise RuntimeError(f"CapSolver error: {data}")
    return data["taskId"]


def _get_result(task_id: str, max_wait: int = 120) -> dict:
    deadline = time.time() + max_wait
    while time.time() < deadline:
        data = _post("/getTaskResult", {"clientKey": API_KEY, "taskId": task_id})
        status = data.get("status")
        if status == "ready":
            return data.get("solution", {})
        if data.get("errorCode"):
            raise RuntimeError(f"CapSolver task failed: {data}")
        time.sleep(3)
    raise TimeoutError(f"CapSolver task {task_id} timed out after {max_wait}s")


def solve_turnstile(website_url: str, website_key: str) -> str:
    """Solve Cloudflare Turnstile. Returns the token."""
    task_id = _create_task({
        "type": "AntiTurnstileTaskProxyLess",
        "websiteURL": website_url,
        "websiteKey": website_key,
    })
    solution = _get_result(task_id)
    log.info("Turnstile solved for %s", website_url)
    return solution["token"]


def solve_recaptcha_v2(website_url: str, website_key: str) -> str:
    """Solve reCAPTCHA v2. Returns g-recaptcha-response."""
    task_id = _create_task({
        "type": "ReCaptchaV2TaskProxyLess",
        "websiteURL": website_url,
        "websiteKey": website_key,
    })
    solution = _get_result(task_id)
    log.info("reCAPTCHA v2 solved for %s", website_url)
    return solution["gRecaptchaResponse"]


def solve_hcaptcha(website_url: str, website_key: str) -> str:
    """Solve hCaptcha. Returns the token."""
    task_id = _create_task({
        "type": "HCaptchaTaskProxyLess",
        "websiteURL": website_url,
        "websiteKey": website_key,
    })
    solution = _get_result(task_id)
    log.info("hCaptcha solved for %s", website_url)
    return solution["gRecaptchaResponse"]


async def inject_captcha_solution(page, captcha_type: str, token: str) -> None:
    """Inject a solved CAPTCHA token into the page DOM."""
    if captcha_type in ("recaptcha", "turnstile"):
        await page.evaluate(
            f"document.querySelector('[name=g-recaptcha-response]') && "
            f"(document.querySelector('[name=g-recaptcha-response]').value = '{token}')"
        )
    elif captcha_type == "hcaptcha":
        await page.evaluate(
            f"document.querySelector('[name=h-captcha-response]') && "
            f"(document.querySelector('[name=h-captcha-response]').value = '{token}')"
        )
