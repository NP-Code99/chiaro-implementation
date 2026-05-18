"""
Persistent browser session management with AES-256 encryption at rest.
"""
import base64
import json
import logging
import os
import secrets
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

log = logging.getLogger(__name__)

SESSIONS_DIR = Path(__file__).parent.parent.parent / "sessions"
SESSIONS_DIR.mkdir(exist_ok=True)

# Derive a 32-byte key from the env var (hex-encoded) or generate one
_RAW_KEY = os.environ.get("SESSION_ENCRYPTION_KEY", "")
if _RAW_KEY:
    _KEY = bytes.fromhex(_RAW_KEY)
else:
    # Generate and persist to .session_key for this machine
    _KEY_FILE = SESSIONS_DIR / ".session_key"
    if _KEY_FILE.exists():
        _KEY = bytes.fromhex(_KEY_FILE.read_text().strip())
    else:
        _KEY = secrets.token_bytes(32)
        _KEY_FILE.write_text(_KEY.hex())
        _KEY_FILE.chmod(0o600)


def _session_path(user_id: str) -> Path:
    return SESSIONS_DIR / f"{user_id}.enc"


def save_session(user_id: str, storage_state: dict) -> None:
    """Encrypt and persist storageState to disk."""
    plaintext = json.dumps(storage_state).encode()
    aesgcm = AESGCM(_KEY)
    nonce = secrets.token_bytes(12)
    ciphertext = aesgcm.encrypt(nonce, plaintext, None)
    payload = base64.b64encode(nonce + ciphertext).decode()
    _session_path(user_id).write_text(payload)
    log.info("Session saved for user %s", user_id)


def load_session(user_id: str) -> dict | None:
    """Decrypt and return storageState, or None if no session exists."""
    path = _session_path(user_id)
    if not path.exists():
        return None
    try:
        raw = base64.b64decode(path.read_text())
        nonce, ciphertext = raw[:12], raw[12:]
        aesgcm = AESGCM(_KEY)
        plaintext = aesgcm.decrypt(nonce, ciphertext, None)
        return json.loads(plaintext)
    except Exception as exc:
        log.warning("Failed to decrypt session for %s: %s", user_id, exc)
        return None


def delete_session(user_id: str) -> None:
    path = _session_path(user_id)
    if path.exists():
        path.unlink()
        log.info("Session deleted for user %s", user_id)
