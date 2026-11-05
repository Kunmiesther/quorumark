"""Call the protected ARC preview with checkpointed historical snapshots."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from http.cookiejar import CookieJar
import json
import os
from pathlib import Path
import time
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen


INPUT = Path("backtest_artifacts/arc_valid_opportunities_30d/committee_snapshots.jsonl")
OUTPUT = Path("backtest_artifacts/arc_valid_opportunities_30d/committee_results.jsonl")
SHARE_URL = os.environ["ARC_PREVIEW_SHARE_URL"]
LIMIT = int(os.environ.get("ARC_REPLAY_LIMIT", "0"))
WORKERS = max(1, min(4, int(os.environ.get("ARC_REPLAY_WORKERS", "3"))))


def authenticate() -> tuple[str, str]:
    jar = CookieJar()
    opener = build_opener(HTTPCookieProcessor(jar))
    with opener.open(SHARE_URL, timeout=30) as response:
        response.read(128)
    parts = urlsplit(SHARE_URL)
    endpoint = urlunsplit((parts.scheme, parts.netloc, "/api/review", "", ""))
    cookie = "; ".join(f"{item.name}={item.value}" for item in jar)
    if not cookie:
        raise RuntimeError("Vercel share authentication did not return a cookie")
    return endpoint, cookie


def review(endpoint: str, cookie: str, snapshot: dict) -> dict:
    data = json.dumps(snapshot, separators=(",", ":")).encode()
    for attempt in range(3):
        request = Request(endpoint, data=data, method="POST", headers={
            "content-type": "application/json", "cookie": cookie,
            "user-agent": "TurtleBot-ARC-Shadow-Replay/1.0",
        })
        try:
            with urlopen(request, timeout=70) as response:
                result = json.loads(response.read())
            if not result.get("ok"):
                raise RuntimeError("review returned ok=false")
            return result
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1.5 * (attempt + 1))
    raise AssertionError("unreachable")


def checkpoint(rows: list[dict]) -> None:
    rows.sort(key=lambda row: row["candidate_id"])
    temporary = OUTPUT.with_suffix(".jsonl.tmp")
    temporary.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    temporary.replace(OUTPUT)


def main() -> None:
    snapshots = [json.loads(line) for line in INPUT.read_text().splitlines() if line]
    completed = []
    if OUTPUT.exists():
        completed = [json.loads(line) for line in OUTPUT.read_text().splitlines() if line]
    done = {row["candidate_id"] for row in completed}
    pending = [row for row in snapshots if row["candidate_id"] not in done]
    if LIMIT:
        pending = pending[:LIMIT]
    endpoint, cookie = authenticate()
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(review, endpoint, cookie, row): row for row in pending}
        for future in as_completed(futures):
            result = future.result()
            completed.append(result)
            checkpoint(completed)
            print(f"{len(completed)}/{len(snapshots)} {result['candidate_id']}", flush=True)


if __name__ == "__main__":
    main()
