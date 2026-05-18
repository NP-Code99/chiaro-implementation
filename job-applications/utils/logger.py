"""Simple logger that writes to results/run_[timestamp].log and prints to console."""
import os, time

_log_path = None

def _get_log_path():
    global _log_path
    if _log_path is None:
        os.makedirs("results", exist_ok=True)
        _log_path = f"results/run_{int(time.time())}.log"
    return _log_path

def log(message: str):
    ts = time.strftime("%H:%M:%S")
    line = f"[{ts}] {message}"
    print(line)
    with open(_get_log_path(), "a") as f:
        f.write(line + "\n")
