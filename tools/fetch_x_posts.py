"""Fetch the latest @PalworldOCG_EN posts through the official X API v2.

x.com's robots.txt is Disallow: /, so Sieve (correctly) refuses to scrape it. The X API
is the sanctioned route. This tool turns recent posts into the same
{title, date, summary, link, image} rows the Sieve pipeline produces, written as a
session directory under stage/sieve so tools/news_feed.py consolidates them unchanged.
Links point at x.com and images at pbs.twimg.com, so news_feed classifies them as
x:PalworldOCG_EN and the app credits them to X.

Secrets (Infisical, never a file): X_BEARER_TOKEN is required; X_USER_ID is optional and
saves the username lookup call on every run. When the token is unset the tool stages
nothing and exits 0, so the rest of the feed still publishes.

The API is billed per request/post read, so each run reads at most --max posts
(default 10, the API minimum is 5).

Usage:
  infisical run --env=dev -- python tools/fetch_x_posts.py          # fetch + stage session
  python tools/fetch_x_posts.py --print                            # also print the rows as JSON
  python tools/fetch_x_posts.py --offline FILE                     # stage rows from a saved API payload
"""
from __future__ import annotations

import argparse
import datetime as _dt
import html as _html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

API = "https://api.x.com/2"
USERNAME = "PalworldOCG_EN"
TITLE_MAX = 120
SUMMARY_MAX = 300
TCO = re.compile(r"https?://t\.co/\S+")

GetJson = Callable[[str, str], dict]


def format_date(value: str) -> str:
    """X ISO timestamp -> the feed's 'Sep 25, 2026' style (portable: no %-d)."""
    day = str(value)[:10]
    try:
        parsed = _dt.date.fromisoformat(day)
    except ValueError:
        return day
    months = ("", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    return f"{months[parsed.month]} {parsed.day}, {parsed.year}"


def clean_text(text: str) -> str:
    """Post text without t.co shortlinks (they only point back at the attached media)."""
    text = TCO.sub("", _html.unescape(text or ""))
    return "\n".join(" ".join(line.split()) for line in text.splitlines()).strip()


def make_title(text: str) -> str:
    first = next((line for line in text.splitlines() if line.strip()), "")
    return first if len(first) <= TITLE_MAX else first[:TITLE_MAX - 1].rstrip() + "…"


def pick_image(tweet: dict, media_by_key: dict[str, dict]) -> str:
    """First photo URL, falling back to a video/GIF preview frame."""
    keys = ((tweet.get("attachments") or {}).get("media_keys") or [])
    media = [media_by_key[k] for k in keys if k in media_by_key]
    for item in media:
        if item.get("type") == "photo" and item.get("url"):
            return str(item["url"])
    for item in media:
        if item.get("preview_image_url"):
            return str(item["preview_image_url"])
    return ""


def rows_from_payload(payload: dict, username: str = USERNAME) -> list[dict]:
    """Turn a /2/users/:id/tweets response into feed rows."""
    media_by_key = {str(m.get("media_key")): m for m in ((payload.get("includes") or {}).get("media") or [])
                    if isinstance(m, dict) and m.get("media_key")}
    rows: list[dict] = []
    seen: set[str] = set()
    for tweet in payload.get("data") or []:
        if not isinstance(tweet, dict) or not tweet.get("id"):
            continue
        tid = str(tweet["id"])
        if tid in seen:
            continue
        # Posts over 280 characters carry their full text in note_tweet.
        text = clean_text(str((tweet.get("note_tweet") or {}).get("text") or tweet.get("text") or ""))
        image = pick_image(tweet, media_by_key)
        title = make_title(text)
        if not title:
            continue
        seen.add(tid)
        rows.append({
            "title": title,
            "date": format_date(str(tweet.get("created_at") or "")),
            "summary": " ".join(text.split())[:SUMMARY_MAX],
            "link": f"https://x.com/{username}/status/{tid}",
            "image": image,
        })
    return rows


def _get_json(url: str, token: str) -> dict:
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "User-Agent": "SphereDex-news/1.0 (+https://github.com/giarcyaj/SphereDex)",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError("unexpected X API payload: expected a JSON object")
    return data


def resolve_user_id(token: str, username: str = USERNAME, get: GetJson = _get_json) -> str:
    data = get(f"{API}/users/by/username/{urllib.parse.quote(username)}", token)
    uid = str((data.get("data") or {}).get("id") or "")
    if not uid:
        raise ValueError(f"X API returned no user id for @{username}: {api_error(data)}")
    return uid


def fetch_rows(token: str, user_id: str = "", max_results: int = 10,
               username: str = USERNAME, get: GetJson = _get_json) -> list[dict]:
    uid = user_id or resolve_user_id(token, username, get)
    query = urllib.parse.urlencode({
        "max_results": max(5, min(100, max_results)),
        "exclude": "retweets,replies",
        "expansions": "attachments.media_keys",
        "media.fields": "url,preview_image_url,type",
        "tweet.fields": "created_at,note_tweet",
    })
    payload = get(f"{API}/users/{uid}/tweets?{query}", token)
    if "data" not in payload and payload.get("errors"):
        raise ValueError(f"X API error: {api_error(payload)}")
    return rows_from_payload(payload, username)


def api_error(data: dict) -> str:
    errors = data.get("errors") or []
    first = errors[0] if errors and isinstance(errors[0], dict) else data
    return str(first.get("detail") or first.get("title") or first.get("message") or "no detail")[:300]


def stage_session(rows: list[dict], root: Path, stamp: str | None = None) -> Path:
    """Write rows as a Sieve-style session so news_feed.py consolidates them unchanged."""
    stamp = stamp or _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    session = root / f"x-api-{stamp}"
    (session / "files").mkdir(parents=True, exist_ok=True)
    (session.with_suffix(".json")).write_text(json.dumps({
        "session_id": session.name,
        "instruction": f"Latest @{USERNAME} posts from the official X API v2",
        "source": "x-api",
    }, ensure_ascii=False), encoding="utf-8")
    (session / "files" / "scrape_results.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return session


def write_github_output(path: Path | None, status: str, posts: int) -> None:
    if path:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"status={status}\nposts={posts}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path("stage/sieve"), help="session directory (default: stage/sieve)")
    parser.add_argument("--max", dest="max_results", type=int, default=10, help="posts to read per run (5-100, default 10)")
    parser.add_argument("--print", dest="print_rows", action="store_true", help="print staged rows as JSON")
    parser.add_argument("--offline", type=Path, help="stage rows from a saved /2/users/:id/tweets payload instead of fetching")
    parser.add_argument("--github-output", type=Path, help="write status/posts to GitHub Actions output")
    args = parser.parse_args(argv)

    if args.offline:
        rows = rows_from_payload(json.loads(args.offline.read_text(encoding="utf-8")))
    else:
        token = os.environ.get("X_BEARER_TOKEN", "").strip()
        if not token:
            print("x-api: X_BEARER_TOKEN is not set - skipping X posts (not an error)")
            write_github_output(args.github_output, "skipped", 0)
            return 0
        try:
            rows = fetch_rows(token, os.environ.get("X_USER_ID", "").strip(), args.max_results)
        except urllib.error.HTTPError as exc:
            # The body is the API's JSON error; it never echoes the bearer token.
            try:
                detail = api_error(json.loads(exc.read().decode("utf-8")))
            except (OSError, ValueError):
                detail = exc.reason
            print(f"x-api fetch failed: HTTP {exc.code} {detail}", file=sys.stderr)
            write_github_output(args.github_output, "failed", 0)
            return 1
        except (OSError, ValueError) as exc:
            print(f"x-api fetch failed: {exc}", file=sys.stderr)
            write_github_output(args.github_output, "failed", 0)
            return 1
    session = stage_session(rows, args.root)
    print(f"x-api: staged {len(rows)} post(s) -> {session}")
    write_github_output(args.github_output, "ok", len(rows))
    if args.print_rows:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
