# Job Application Automation

## Commands
- Install: pip install -r requirements.txt && playwright install chromium
- Run all: python main.py
- Run one: python scripts/greenhouse.py --url "URL_HERE"
- Dry run (no submit): python main.py --dry-run
- Single platform: python main.py --platform greenhouse

## Rules
- NEVER hardcode profile data in scripts — always load from profile.yaml
- Always use wait_for_selector before interacting with any element
- Wrap every field interaction in try/except — log and skip, never crash
- Run headful (visible browser) so Turnstile does not block
- Screenshot every confirmation page to results/
- Log every action to results/run_[timestamp].log
