"""Fetch the official Palworld TCG news posts for the app's News and Home feed.

Replaces the Sieve scrape of en.palworld-official-cardgame.com/news/: the site's WordPress REST
API (/wp-json/wp/v2/posts) carries every news post with its title, publish date, excerpt,
permalink and featured image, free and structured, so no AI extraction (or credits) is needed.
Rows use the {title, date, summary, link, image} shape the Sieve pipeline produced and are
written as a session directory under stage/sieve, so tools/news_feed.py consolidates them
unchanged alongside the card-reveal and X sessions.

Robots: en.palworld-official-cardgame.com/robots.txt disallows only /wordpress/wp-admin/.

Usage:
  python tools/fetch_official_news.py                     # fetch + stage session
  python tools/fetch_official_news.py --print             # also print the rows as JSON
  python tools/fetch_official_news.py --offline FILE      # stage rows from a saved API payload
  python tools/fetch_official_news.py --github-output "$GITHUB_OUTPUT"   # status=ok|failed, items=N
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import sys
import urllib.request
from pathlib import Path

from fetch_card_reveals import API, extract_images, format_date, strip_html

PER_PAGE = 20
# Featured images are uploaded at up to 4800px; the feed shows them as cards, so take the
# largest WordPress-generated size that is still light.
IMAGE_SIZES = ("large", "medium_large", "1536x1536")
USER_AGENT = "SphereDex-news/1.0 (+https://github.com/giarcyaj/SphereDex)"


def featured_image(post: dict) -> str:
    media = ((post.get("_embedded") or {}).get("wp:featuredmedia") or [{}])[0] or {}
    sizes = (media.get("media_details") or {}).get("sizes") or {}
    for name in IMAGE_SIZES:
        url = str((sizes.get(name) or {}).get("source_url") or "")
        if url:
            return url
    return str(media.get("source_url") or "")


def pick_row(post: dict) -> dict | None:
    title = strip_html(str((post.get("title") or {}).get("rendered") or ""))
    link = str(post.get("link") or "").strip()
    if not title or not link:
        return None
    content_html = str((post.get("content") or {}).get("rendered") or "")
    summary = strip_html(str((post.get("excerpt") or {}).get("rendered") or ""))
    if not summary:
        summary = strip_html(content_html)
    images = extract_images(content_html)
    return {
        "title": title,
        "date": format_date(str(post.get("date_gmt") or post.get("date") or "")),
        "summary": summary[:300],
        "link": link,
        "image": featured_image(post) or (images[0] if images else ""),
    }


def rows_from_posts(posts: object) -> list[dict]:
    if not isinstance(posts, list):
        raise ValueError("unexpected API payload: expected a JSON array of posts")
    rows: list[dict] = []
    seen: set[str] = set()
    for post in posts:
        row = pick_row(post) if isinstance(post, dict) else None
        if row and row["link"].casefold() not in seen:
            seen.add(row["link"].casefold())
            rows.append(row)
    return rows


def fetch_rows(timeout: float = 30.0) -> list[dict]:
    req = urllib.request.Request(
        f"{API}?per_page={PER_PAGE}&orderby=date&order=desc&_embed=wp:featuredmedia",
        headers={"User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return rows_from_posts(json.loads(resp.read().decode("utf-8")))


def stage_session(rows: list[dict], root: Path, stamp: str | None = None) -> Path:
    """Write rows as a Sieve-style session so news_feed.py consolidates them unchanged."""
    stamp = stamp or _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    session = root / f"official-news-{stamp}"
    (session / "files").mkdir(parents=True, exist_ok=True)
    session.with_suffix(".json").write_text(json.dumps({
        "session_id": session.name,
        "instruction": "Palworld TCG official news posts (official REST API)",
        "source": "official-rest",
    }, ensure_ascii=False), encoding="utf-8")
    (session / "files" / "scrape_results.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return session


def write_github_output(path: Path | None, status: str, items: int) -> None:
    if path:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"status={status}\nitems={items}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("stage/sieve"), help="session directory (default: stage/sieve)")
    parser.add_argument("--print", dest="print_rows", action="store_true", help="print staged rows as JSON")
    parser.add_argument("--offline", type=Path, help="stage rows from a saved API payload instead of fetching")
    parser.add_argument("--github-output", type=Path, help="append status/items to this GitHub Actions output file")
    args = parser.parse_args(argv)

    try:
        if args.offline:
            rows = rows_from_posts(json.loads(args.offline.read_text(encoding="utf-8")))
        else:
            rows = fetch_rows()
    except (OSError, ValueError) as exc:
        print(f"official-news fetch failed: {exc}", file=sys.stderr)
        write_github_output(args.github_output, "failed", 0)
        return 1
    session = stage_session(rows, args.root)
    print(f"official-news: staged {len(rows)} post(s) -> {session}")
    if args.print_rows:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    write_github_output(args.github_output, "ok", len(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
