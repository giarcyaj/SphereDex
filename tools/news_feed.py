"""Build the app news feed from staged Sieve scrape sessions."""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


FIELDS = ("title", "date", "summary", "link", "image")
CONTAINER_KEYS = ("items", "result", "results", "rows", "data", "posts", "articles")
X_HOSTS = {"x.com", "www.x.com", "twitter.com", "www.twitter.com"}


def _rows_from_json(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict):
        for key in CONTAINER_KEYS:
            nested = value.get(key)
            if isinstance(nested, (list, dict)):
                return _rows_from_json(nested)
        if any(key in value for key in (*FIELDS, "text", "url")):
            return [value]
    return []


def _read_json(path: Path) -> list[dict[str, Any]]:
    try:
        return _rows_from_json(json.loads(path.read_text(encoding="utf-8-sig")))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return []


def _read_csv(path: Path) -> list[dict[str, Any]]:
    try:
        with path.open(encoding="utf-8-sig", newline="") as handle:
            return [dict(row) for row in csv.DictReader(handle)]
    except (OSError, UnicodeError, csv.Error):
        return []


def _session_record(session_dir: Path) -> dict[str, Any]:
    try:
        data = json.loads(session_dir.with_suffix(".json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _session_rows(session_dir: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    # Never publish schema-failing inline results or attachments from that run.
    record = _session_record(session_dir)
    conformance = record.get("schema_conformance") or {}
    if isinstance(conformance, dict) and conformance.get("status") == "fail":
        return rows
    rows.extend(_read_json(session_dir / "result.json"))
    files_dir = session_dir / "files"
    if files_dir.is_dir():
        for path in sorted(files_dir.glob("*.json")):
            rows.extend(_read_json(path))
        for path in sorted(files_dir.glob("*.csv")):
            rows.extend(_read_csv(path))
    return rows


def _image_url(row: dict[str, Any]) -> str:
    image = row.get("image") or row.get("image_url") or row.get("card_image") or ""
    if isinstance(image, list):
        image = next((value for value in image if value), "")
    return str(image).strip()


def _source_for(link: str, instruction: str = "", image: str = "") -> str:
    host = (urlparse(link).hostname or "").lower()
    image_host = (urlparse(image).hostname or "").lower()
    if host in X_HOSTS or image_host == "pbs.twimg.com" or re.search(r"\b(?:x|twitter)\b", instruction, re.IGNORECASE):
        return "x:PalworldOCG_EN"
    return "official"


def _normalise(row: dict[str, Any], instruction: str = "") -> dict[str, str] | None:
    title = str(row.get("title") or row.get("text") or row.get("content") or "").strip()
    link = str(row.get("link") or row.get("url") or "").strip()
    image = _image_url(row)
    source = _source_for(link, instruction, image)
    if not title:
        return None
    # Some scrapers return a post's text and image but omit its permalink. Keep
    # the source navigable rather than discarding the otherwise useful post.
    if not link and source.startswith("x:"):
        link = "https://x.com/PalworldOCG_EN"
    if not link:
        return None
    item = {key: str(row.get(key) or "").strip() for key in FIELDS}
    item["title"] = title
    item["date"] = str(row.get("date") or row.get("published_at") or "").strip()
    item["summary"] = str(row.get("summary") or row.get("description") or "").strip()
    item["link"] = link
    item["image"] = image
    item["source"] = source
    return item


def build_news_feed(root: Path, limit: int = 40) -> tuple[list[dict[str, str]], dict[str, int]]:
    """Read clean inline/delivered sessions and return deduplicated rows plus counts."""
    sessions = sorted(path for path in root.iterdir() if path.is_dir()) if root.is_dir() else []
    counts = {"sessions": len(sessions), "official": 0, "x": 0, "invalid": 0, "unverified": 0}
    rows: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for session in sessions:
        record = _session_record(session)
        instruction = str(record.get("instruction") or "")
        conformance = record.get("schema_conformance") or {}
        if isinstance(conformance, dict) and conformance.get("status") == "fail":
            counts["unverified"] += len(_read_json(session / "result.unverified.json"))
            files_dir = session / "files"
            if files_dir.is_dir():
                counts["unverified"] += sum(len(_read_json(p)) for p in files_dir.glob("*.json"))
                counts["unverified"] += sum(len(_read_csv(p)) for p in files_dir.glob("*.csv"))
            continue
        for raw in _session_rows(session):
            item = _normalise(raw, instruction)
            if not item:
                counts["invalid"] += 1
                continue
            key = (item["title"].casefold(), item["link"].casefold())
            if key in seen:
                continue
            seen.add(key)
            counts["x" if item["source"].startswith("x:") else "official"] += 1
            rows.append(item)
        counts["unverified"] += len(_read_json(session / "result.unverified.json"))
    counts["items"] = min(len(rows), limit)
    return rows[:limit], counts


def _unusable_session_summaries(root: Path) -> list[str]:
    """Return short Sieve explanations for sessions which produced no clean rows."""
    messages: list[str] = []
    sessions = sorted(path for path in root.iterdir() if path.is_dir()) if root.is_dir() else []
    for session in sessions:
        if _session_rows(session):
            continue
        record = _session_record(session)
        refusal = record.get("refusal") or {}
        if isinstance(refusal, dict) and refusal:
            detail = refusal.get("message") or refusal.get("code") or "refused"
            messages.append("{0}: {1}".format(session.name, " ".join(str(detail).split())[:1200]))
            continue
        try:
            data = json.loads((session / "summary.json").read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        summary = data.get("summary") if isinstance(data, dict) else None
        if isinstance(summary, (dict, list)):
            summary = json.dumps(summary, ensure_ascii=False)
        if summary:
            messages.append("{0}: {1}".format(session.name, " ".join(str(summary).split())[:1200]))
    return messages


def _write_github_output(path: Path, counts: dict[str, int]) -> None:
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write("official_items={official}\nx_items={x}\nfeed_items={items}\nunverified_items={unverified}\n".format(**counts))


def write_news_feed(root: Path, output: Path, limit: int = 40) -> dict[str, int]:
    items, counts = build_news_feed(root, limit=limit)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Sieve feed: {official} official, {x} X, {invalid} invalid item(s) from {sessions} session(s); skipped {unverified} unverified item(s)".format(**counts))
    for explanation in _unusable_session_summaries(root):
        print("Sieve session produced no clean structured rows: " + explanation)
    print("Consolidated {0} -> {1}".format(len(items), output))
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="Sieve session directory (stage/sieve)")
    parser.add_argument("--output", type=Path, required=True, help="consolidated feed JSON path")
    parser.add_argument("--limit", type=int, default=40, help="maximum feed items (default: 40)")
    parser.add_argument("--github-output", type=Path, help="write source counts to GitHub Actions output")
    args = parser.parse_args(argv)
    if args.limit < 1:
        parser.error("--limit must be positive")
    counts = write_news_feed(args.root, args.output, limit=args.limit)
    if args.github_output:
        _write_github_output(args.github_output, counts)
    return 0 if counts["items"] else 1


if __name__ == "__main__":
    sys.exit(main())
