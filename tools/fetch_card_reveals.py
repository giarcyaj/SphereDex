"""Fetch newly revealed Palworld TCG cards from the official cardlist site.

Option A from docs/x-reveal-source-proposal.md: x.com is robots-blocked (Disallow: /),
but the official site permits crawling and exposes a WordPress REST API
(/wp-json/wp/v2/posts) that carries every news post, including card-reveal posts whose
content embeds the cardlist card art. This tool turns those posts into the same
{title, date, summary, link, image} rows the Sieve pipeline produces, written as a
session directory under stage/sieve so tools/news_feed.py consolidates them unchanged
(same shape, same dedupe, same --github-output counts).

Robots: en.palworld-official-cardgame.com/robots.txt disallows only
/wordpress/wp-admin/ (checked 2026-09-26). The REST API is public site content.

Usage:
  python tools/fetch_card_reveals.py                     # fetch + stage session
  python tools/fetch_card_reveals.py --print             # also print the rows as JSON
  python tools/fetch_card_reveals.py --offline FILE      # stage rows from a saved payload
"""
from __future__ import annotations

import argparse
import datetime as _dt
import html as _html
import json
import re
import sys
import urllib.request
from pathlib import Path

API = "https://en.palworld-official-cardgame.com/wp-json/wp/v2/posts"
PER_PAGE = 20
# Reveal heuristics, kept in step with the app's reveal slide matching
# (featuredSlides in src/paldeck.html: /card reveal|reveal|new card/i on text,
# /cardlist|palworld.*card/i on the image URL).
REVEAL_TEXT = re.compile(r"\bcard reveal\b|\breveal\b|\bnew card\b", re.IGNORECASE)
IMG_TAG = re.compile(r"<img[^>]+src=[\"']([^\"']+)[\"']", re.IGNORECASE)
WP_UPLOADS = re.compile(r"/wordpress/wp-content/uploads/", re.IGNORECASE)


def strip_html(fragment: str) -> str:
    text = re.sub(r"<[^>]+>", " ", fragment or "")
    text = _html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def format_date(value: str) -> str:
    """WordPress ISO date -> the feed's 'Sep 25, 2026' style (portable: no %-d)."""
    day = str(value)[:10]
    try:
        parsed = _dt.date.fromisoformat(day)
    except ValueError:
        return day
    months = ("", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    return f"{months[parsed.month]} {parsed.day}, {parsed.year}"


def extract_images(content_html: str) -> list[str]:
    """Card art URLs from a post body, best first: cardlist assets, then uploads images."""
    ranked: list[tuple[int, str]] = []
    seen: set[str] = set()
    for url in IMG_TAG.findall(content_html or ""):
        url = _html.unescape(url)
        if "en.palworld-official-cardgame.com" not in urlparse_host(url):
            continue
        rank = 0 if "/cardlist/" in url or "/images/cardlist/" in url else (1 if WP_UPLOADS.search(url) else 2)
        if rank < 2 and url not in seen:
            seen.add(url)
            ranked.append((rank, url))
    ranked.sort(key=lambda pair: pair[0])   # stable: document order within a rank
    return [url for _, url in ranked]


def urlparse_host(url: str) -> str:
    from urllib.parse import urlparse
    return (urlparse(url).hostname or "")


def pick_row(post: dict) -> dict | None:
    """Turn one WP post into a feed row, or None when it is not a card reveal."""
    title = strip_html(str((post.get("title") or {}).get("rendered") or ""))
    link = str(post.get("link") or "").strip()
    if not title or not link:
        return None
    content_html = str((post.get("content") or {}).get("rendered") or "")
    summary = strip_html(str((post.get("excerpt") or {}).get("rendered") or ""))[:300]
    text = f"{title} {summary} {strip_html(content_html)}"
    images = extract_images(content_html)
    # A reveal needs reveal wording AND an official image (cardlist art preferred, uploads ok).
    if not REVEAL_TEXT.search(text) or not images:
        return None
    return {
        "title": title,
        "date": format_date(str(post.get("date_gmt") or post.get("date") or "")),
        "summary": summary,
        "link": link,
        "image": images[0],
    }


def fetch_rows(timeout: float = 30.0) -> list[dict]:
    req = urllib.request.Request(
        f"{API}?per_page={PER_PAGE}&orderby=date&order=desc",
        headers={"User-Agent": "SphereDex-news/1.0 (+https://github.com/giarcyaj/SphereDex)"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        posts = json.loads(resp.read().decode("utf-8"))
    if not isinstance(posts, list):
        raise ValueError("unexpected API payload: expected a JSON array of posts")
    rows: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for post in posts:
        if not isinstance(post, dict):
            continue
        row = pick_row(post)
        if row:
            key = (row["title"].casefold(), row["link"].casefold())
            if key not in seen:
                seen.add(key)
                rows.append(row)
    return rows


def stage_session(rows: list[dict], root: Path, stamp: str | None = None) -> Path:
    """Write rows as a Sieve-style session so news_feed.py consolidates them unchanged."""
    stamp = stamp or _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    session = root / f"card-reveals-{stamp}"
    (session / "files").mkdir(parents=True, exist_ok=True)
    (session.with_suffix(".json")).write_text(json.dumps({
        "session_id": session.name,
        "instruction": "Extract Palworld TCG official card-reveal posts with card art (official REST API)",
        "source": "official-rest",
    }, ensure_ascii=False), encoding="utf-8")
    (session / "files" / "scrape_results.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return session


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("stage/sieve"), help="session directory (default: stage/sieve)")
    parser.add_argument("--print", dest="print_rows", action="store_true", help="print staged rows as JSON")
    parser.add_argument("--offline", type=Path, help="stage rows from a saved JSON payload instead of fetching")
    args = parser.parse_args(argv)

    if args.offline:
        rows = [r for r in json.loads(args.offline.read_text(encoding="utf-8")) if isinstance(r, dict)]
    else:
        try:
            rows = fetch_rows()
        except (OSError, ValueError) as exc:
            print(f"card-reveals fetch failed: {exc}", file=sys.stderr)
            return 1
    if not rows:
        print("card-reveals: no reveal posts found in the latest window (not an error)")
    session = stage_session(rows, args.root)
    print(f"card-reveals: staged {len(rows)} row(s) -> {session}")
    if args.print_rows:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
