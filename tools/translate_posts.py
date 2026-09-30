"""Turn Japanese official X posts into English headlines, with a cache and a safe fallback.

The official Japanese account (@PalworldOCG) posts reveals, countdowns and event news most days,
usually before the English account does, but an English app showing Japanese headlines reads as a
bug. This translates the headline only, never the fetch: every post is already fetched through the
official X API, so nothing here can invent a post that does not exist. The worst an outage can do is
leave a headline in Japanese.

Design notes, in the order they matter:

  FALLBACK FIRST. Nothing in this module raises. A missing key, a dead endpoint, a malformed reply or
  a model that ignores the format all end the same way: the row is returned untouched and the post is
  published in Japanese. A post in the wrong language beats a missing post.

  CACHE BY LINK. An X post never changes, so its translation never needs redoing. Without this the
  hourly workflow would re-translate the same ten posts 24 times a day. The cache is keyed on the post
  link, which is stable and unique, and is written back after every run.

  ONLY WHAT NEEDS IT. Rows with no CJK are skipped before any call, so the English account never costs
  anything.

  NO DASHES. The app's copy rule bans hyphens and dashes in user facing text. The prompt says so and
  the output is stripped as well, because a model instruction is not a guarantee.

Secrets: XAI_API_KEY comes from the environment (Infisical in CI), never a file, and is never printed.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

API_URL = "https://api.x.ai/v1/chat/completions"
# Model choice, measured on the real feed rather than assumed:
#   grok-4.6                       best output, translated card names and correct official Pal names,
#                                  but timed out at 90s even with two posts per call. Unusable here.
#   grok-4.20-0309-non-reasoning   fast and always finished, but transliterated Japanese names about
#                                  half the time (Fubukitsune, Boruzekusu), which is worse than
#                                  useless to an English reader. Unusable.
#   grok-4.3                       finishes comfortably, never transliterates, and when it is unsure
#                                  of a name it describes the post instead. Says less, never wrong.
# Override with XAI_MODEL if a better one appears.
DEFAULT_MODEL = "grok-4.3"
CACHE_NAME = "translations.json"
HEADLINE_MAX = 90
# The quality/latency trade. A reasoning model follows the naming rule reliably but is slow, so it
# gets small batches; a fast model can take ten at once but transliterates Japanese names about
# half the time, which is worse than useless. Small batches with the better model won.
BATCH_MAX = int(os.environ.get("XAI_BATCH", "3") or 2)
TIMEOUT = 90                # generous: a slow reply costs a retry next run, a short cap costs the batch

# Any hiragana, katakana or CJK ideograph means the post is not English.
CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]")
# The copy rule: no hyphen, en dash or em dash in anything a reader sees.
DASHES = re.compile(r"\s*[‐-―−-]\s*")

SYSTEM = (
    "You are a precise Japanese to English translator for trading card game news. "
    "You never invent a fact, a date, a product or a card that is not in the source. "
    "You obey formatting rules exactly. You output only the JSON asked for."
)

RULES = """Produce ONE short English headline for each numbered post, for a news list in an English
language Palworld Trading Card Game app.

Rules:
1. Translate faithfully. Never invent a fact, a date, a product or a card that is not in the source.
2. A headline, not a full translation. Under 80 characters.
3. Strip decorative framing: slashes, brackets such as the ones used for emphasis, divider lines,
   hashtags and emoji.
4. NEVER use a hyphen, an en dash or an em dash. Use a comma, or rewrite. This is a hard rule.
5. NEVER romanise a Japanese name. Writing "Fubukitsune" or "Boruzekusu" in Latin letters is
   forbidden and useless to an English reader. For any Pal or card name you have three choices, in
   this order of preference:
   a. Use the Pal's official English name if you are confident of it.
   b. Otherwise translate the meaning of the card name.
   c. Otherwise leave the name out entirely and describe what happened.
   Never transliterate. Never guess an official English name you are unsure of.
6. Use official English product names where they exist, for example "Booster Pack Vol. 2".

Return ONLY a JSON array of objects with keys "n" and "headline". No other text."""

PostFetch = Callable[[str, dict, dict], dict]


def needs_translation(row: dict) -> bool:
    """True when a row carries Japanese in the part a reader sees."""
    return bool(CJK.search(str(row.get("title") or "") + str(row.get("summary") or "")))


def tidy_headline(text: str) -> str:
    """Enforce the copy rule and the length cap on whatever the model returned."""
    out = DASHES.sub(", ", str(text or "")).strip()
    out = re.sub(r"\s{2,}", " ", out).strip(" ,")
    if len(out) <= HEADLINE_MAX:
        return out
    cut = out[:HEADLINE_MAX]
    space = cut.rfind(" ")
    return (cut[:space] if space > HEADLINE_MAX * 0.6 else cut).rstrip(" ,")


def load_cache(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_cache(path: Path, cache: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    except OSError as exc:                                  # a cache we cannot write is not an error
        print(f"translate: could not write cache: {exc}", file=sys.stderr)


def _post_json(url: str, payload: dict, headers: dict) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _parse_reply(body: dict, count: int) -> dict[int, str]:
    """Pull {index: headline} out of the model's reply, tolerating fenced or padded JSON."""
    text = (((body.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
    if not text:
        return {}
    match = re.search(r"\[.*\]", text, re.S)                # ignore any prose or ``` fencing around it
    if not match:
        return {}
    try:
        rows = json.loads(match.group(0))
    except ValueError:
        return {}
    out: dict[int, str] = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        try:
            n = int(row.get("n"))
        except (TypeError, ValueError):
            continue
        headline = tidy_headline(row.get("headline"))
        if 0 <= n < count and headline:
            out[n] = headline
    return out


def translate_batch(items: list[dict], key: str, model: str, post: PostFetch = _post_json) -> dict[int, str]:
    """One API call for up to BATCH_MAX posts. Returns {} on any failure, never raises."""
    if not items or not key:
        return {}
    prompt = RULES + "\n\n" + "\n\n".join(
        f"POST {i}\ntitle: {it.get('title') or ''}\nbody: {str(it.get('summary') or '')[:600]}"
        for i, it in enumerate(items))
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}],
        "temperature": 0,
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    try:
        return _parse_reply(post(API_URL, payload, headers), len(items))
    except urllib.error.HTTPError as exc:
        # The body is the API's own error. It never echoes the key.
        detail = ""
        try:
            detail = exc.read().decode("utf-8")[:200]
        except OSError:
            pass
        print(f"translate: HTTP {exc.code} {exc.reason} {detail}", file=sys.stderr)
    except (OSError, ValueError) as exc:
        print(f"translate: {exc}", file=sys.stderr)
    return {}


def translate_rows(rows: list[dict], cache_path: Path, key: str = "", model: str = "",
                   post: PostFetch = _post_json) -> tuple[list[dict], dict]:
    """Return rows with Japanese headlines replaced where possible, plus a small stats dict.

    A row is only ever replaced by a real headline. Anything else leaves it exactly as it arrived.
    """
    key = key or os.environ.get("XAI_API_KEY", "").strip()
    model = model or os.environ.get("XAI_MODEL", "").strip() or DEFAULT_MODEL
    cache = load_cache(cache_path)
    stats = {"considered": 0, "cached": 0, "translated": 0, "failed": 0, "skipped_no_key": 0}

    pending: list[tuple[int, dict]] = []
    out = list(rows)
    for i, row in enumerate(rows):
        if not needs_translation(row):
            continue
        stats["considered"] += 1
        hit = cache.get(str(row.get("link") or ""))
        headline = tidy_headline((hit or {}).get("headline")) if isinstance(hit, dict) else ""
        if headline:
            out[i] = {**row, "title": headline, "title_original": row.get("title")}
            stats["cached"] += 1
        else:
            pending.append((i, row))

    if pending and not key:
        # Not an error: the posts publish in Japanese and a later run with a key fixes them.
        print("translate: XAI_API_KEY is not set - leaving posts untranslated (not an error)")
        stats["skipped_no_key"] = len(pending)
        return out, stats

    for start in range(0, len(pending), BATCH_MAX):
        chunk = pending[start:start + BATCH_MAX]
        got = translate_batch([r for _, r in chunk], key, model, post)
        for n, (idx, row) in enumerate(chunk):
            headline = got.get(n, "")
            if not headline:
                stats["failed"] += 1
                continue
            out[idx] = {**row, "title": headline, "title_original": row.get("title")}
            cache[str(row.get("link") or "")] = {"headline": headline}
            stats["translated"] += 1

    if stats["translated"]:
        save_cache(cache_path, cache)
    return out, stats


def cache_path_for(root: Path) -> Path:
    return Path(root) / CACHE_NAME
