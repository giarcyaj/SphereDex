"""Turn Japanese official X posts into English, with a cache and a safe fallback.

The official Japanese account (@PalworldOCG) posts reveals, countdowns and event news most days,
usually before the English account does, but an English app showing Japanese text reads as a bug.
This translates what a reader sees, never the fetch: every post is already fetched through the
official X API, so nothing here can invent a post that does not exist. The worst an outage can do is
leave a post in Japanese.

Design notes, in the order they matter:

  BOTH FIELDS. A news card shows a headline and the post's body underneath, so translating only the
  headline leaves half the card in Japanese, which looks more broken than leaving all of it alone.
  Each field is handled on its own: a field that was already English is never rewritten, and a field
  the model skips keeps its original rather than being blanked.

  FALLBACK FIRST. Nothing in this module raises. A missing key, a dead endpoint, a malformed reply or
  a model that ignores the format all end the same way: the row is returned untouched and the post is
  published in Japanese. A post in the wrong language beats a missing post.

  CACHE BY LINK. An X post never changes, so its translation never needs redoing. Without this the
  hourly workflow would re-translate the same ten posts 24 times a day. The cache is keyed on the post
  link, which is stable and unique, and is written back after every run. Only a complete answer is
  cached, so a half translated post is retried next run instead of being frozen that way. An entry
  written before bodies were translated counts as incomplete and is simply redone once.

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
# fetch_x_posts caps a post's body at 300 characters before it ever gets here, so there is nothing
# to gain from allowing a longer translation than the original could have been.
SUMMARY_MAX = 300
# The quality/latency trade. A reasoning model follows the naming rule reliably but is slow, so it
# gets small batches; a fast model can take ten at once but transliterates Japanese names about
# half the time, which is worse than useless. Small batches with the better model won.
BATCH_MAX = int(os.environ.get("XAI_BATCH", "3") or 2)
TIMEOUT = 90                # generous: a slow reply costs a retry next run, a short cap costs the batch

# Any hiragana, katakana or CJK ideograph means the post is not English.
CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]")
# The copy rule: no hyphen, en dash or em dash in anything a reader sees.
DASHES = re.compile(r"\s*[‐-―−-]\s*")
# A full stop that really ends a sentence, so "Booster Pack Vol. 2" is not mistaken for one. The
# next thing has to look like the start of a sentence, which a digit does not.
SENTENCE_END = re.compile(r"[.!?](?=\s+[A-Z(\"']|$)")

SYSTEM = (
    "You are a precise Japanese to English translator for trading card game news. "
    "You never invent a fact, a date, a product or a card that is not in the source. "
    "You obey formatting rules exactly. You output only the JSON asked for."
)

RULES = """For each numbered post, produce an English headline AND an English version of the post's
body, for a news list in an English language Palworld Trading Card Game app.

Rules:
1. Translate faithfully. Never invent a fact, a date, a product or a card that is not in the source.
2. "headline" is a headline, not a full translation. Under 80 characters.
3. "summary" is the post's own body in plain English, under 240 characters, ending on a complete
   sentence. Anything past 300 characters is cut off, so do not go near it. Keep every fact, date,
   time and product name the body gives. It may repeat the headline's subject, that is expected.
4. Strip decorative framing from both: slashes, brackets such as the ones used for emphasis, divider
   lines, hashtags and emoji.
5. NEVER use a hyphen, an en dash or an em dash. Use a comma, or rewrite. This is a hard rule.
6. NEVER romanise a Japanese name. Writing "Fubukitsune" or "Boruzekusu" in Latin letters is
   forbidden and useless to an English reader. For any Pal or card name you have three choices, in
   this order of preference:
   a. Use the Pal's official English name if you are confident of it.
   b. Otherwise translate the meaning of the card name.
   c. Otherwise leave the name out entirely and describe what happened.
   Never transliterate. Never guess an official English name you are unsure of.
7. Use official English product names where they exist, for example "Booster Pack Vol. 2".
8. If a field is already in English, give it back as it is.

Return ONLY a JSON array of objects with keys "n", "headline" and "summary". No other text."""

PostFetch = Callable[[str, dict, dict], dict]


def needs_title(row: dict) -> bool:
    """True when the headline is Japanese. Checked per field so an English one is left alone."""
    return bool(CJK.search(str(row.get("title") or "")))


def needs_summary(row: dict) -> bool:
    """True when the body a reader sees under the headline is Japanese."""
    return bool(CJK.search(str(row.get("summary") or "")))


def needs_translation(row: dict) -> bool:
    """True when a row carries Japanese in any part a reader sees."""
    return needs_title(row) or needs_summary(row)


def tidy_text(text: str, cap: int) -> str:
    """Enforce the copy rule and a length cap on whatever the model returned."""
    out = DASHES.sub(", ", str(text or "")).strip()
    out = re.sub(r"\s{2,}", " ", out).strip(" ,")
    if len(out) <= cap:
        return out
    cut = out[:cap]
    space = cut.rfind(" ")
    return (cut[:space] if space > cap * 0.6 else cut).rstrip(" ,")


def tidy_headline(text: str) -> str:
    return tidy_text(text, HEADLINE_MAX)


def tidy_summary(text: str) -> str:
    """Cap the body, ending on a sentence rather than mid clause wherever one is close enough.

    A reader sees this under the headline, so a plain character cut leaves copy like "cards are
    usable from the", which reads as a bug rather than as a shortened post. Backing up to the last
    sentence end is better whenever that still keeps most of the text; failing that the cut is
    marked with an ellipsis so it reads as shortened on purpose.
    """
    cut = tidy_text(text, SUMMARY_MAX)
    if len(cut) == len(tidy_text(text, SUMMARY_MAX + 8)):
        return cut                                          # it fitted, nothing was lost
    ends = [m.end() for m in SENTENCE_END.finditer(cut)]
    if ends and ends[-1] >= SUMMARY_MAX * 0.6:
        return cut[:ends[-1]]
    return cut.rstrip(" ,.") + "…"


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


def _parse_reply(body: dict, count: int) -> dict[int, dict]:
    """Pull {index: {"headline", "summary"}} out of the reply, tolerating fenced or padded JSON.

    Whatever a row does not carry is simply absent, and the caller decides what that means for the
    post it belongs to. Nothing here rejects a reply for being half an answer.
    """
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
    out: dict[int, dict] = {}
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        try:
            n = int(row.get("n"))
        except (TypeError, ValueError):
            continue
        if not 0 <= n < count:
            continue
        got = {"headline": tidy_headline(row.get("headline")),
               "summary": tidy_summary(row.get("summary"))}
        if any(got.values()):
            out[n] = got
    return out


def translate_batch(items: list[dict], key: str, model: str, post: PostFetch = _post_json) -> dict[int, dict]:
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


def _wanted(row: dict, got: dict) -> dict:
    """The fields this row needs, taken from a model reply or a cache entry and tidied.

    Keyed the way the cache is keyed so one shape serves both. A field the row does not need is
    absent entirely, which is why a cache entry for an English titled post carries no headline. A
    field the row needs but did not get is present and empty, which is how the caller spots a half
    answer without having to re-derive what was asked for.
    """
    out = {}
    if needs_title(row):
        out["headline"] = tidy_headline(got.get("headline"))
    if needs_summary(row):
        out["summary"] = tidy_summary(got.get("summary"))
    return out


def _apply(row: dict, fields: dict) -> dict:
    """Replace only the fields that came back, keeping each original alongside."""
    out = dict(row)
    if fields.get("headline"):
        out["title"], out["title_original"] = fields["headline"], row.get("title")
    if fields.get("summary"):
        out["summary"], out["summary_original"] = fields["summary"], row.get("summary")
    return out


def translate_rows(rows: list[dict], cache_path: Path, key: str = "", model: str = "",
                   post: PostFetch = _post_json) -> tuple[list[dict], dict]:
    """Return rows with Japanese headlines and bodies replaced where possible, plus a stats dict.

    A field is only ever replaced by a real translation. Anything else leaves it exactly as it
    arrived, so the worst outcome is a post that publishes in Japanese.
    """
    key = key or os.environ.get("XAI_API_KEY", "").strip()
    model = model or os.environ.get("XAI_MODEL", "").strip() or DEFAULT_MODEL
    cache = load_cache(cache_path)
    stats = {"considered": 0, "cached": 0, "translated": 0, "partial": 0, "failed": 0,
             "skipped_no_key": 0}

    pending: list[tuple[int, dict]] = []
    out = list(rows)
    for i, row in enumerate(rows):
        if not needs_translation(row):
            continue
        stats["considered"] += 1
        hit = cache.get(str(row.get("link") or ""))
        fields = _wanted(row, hit if isinstance(hit, dict) else {})
        if all(fields.values()):
            out[i] = _apply(row, fields)
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
            fields = _wanted(row, got.get(n) or {})
            if not any(fields.values()):
                stats["failed"] += 1
                continue
            out[idx] = _apply(row, fields)
            if all(fields.values()):
                stats["translated"] += 1
                cache[str(row.get("link") or "")] = fields
            else:
                # Half an answer is used but never cached, so the missing half is retried next run.
                stats["partial"] += 1

    if stats["translated"]:
        save_cache(cache_path, cache)
    return out, stats


def cache_path_for(root: Path) -> Path:
    return Path(root) / CACHE_NAME
