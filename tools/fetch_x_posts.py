"""Fetch the latest posts of both official Palworld TCG X accounts through the official X API v2.

x.com's robots.txt is Disallow: /, so Sieve (correctly) refuses to scrape it. The X API
is the sanctioned route. This tool turns recent posts into the same
{title, date, summary, link, image} rows the Sieve pipeline produces, plus "published" (the
post's exact time as an ISO instant, so two posts made on the same day keep their order),
written as a session directory under stage/sieve so tools/news_feed.py consolidates them
unchanged. Links point at x.com and images at pbs.twimg.com, so news_feed classifies them as
x:<handle> and the app credits them to X.

Secrets (Infisical, never a file): X_BEARER_TOKEN is required; X_USER_ID is optional and
saves the username lookup call for the first account. When the token is unset the tool stages
nothing and exits 0, so the rest of the feed still publishes.

The API is billed per post read, and a post never changes, so reading the same ten posts again
on every run pays twice for nothing. --cursor names a small JSON file that remembers the newest
post id seen per account (and each account's user id, which saves the lookup call), and with it
every run is one of two kinds:

  full         the newest --max posts per account (default 10, the API minimum is 5), following
               the API's next page (at most 3 pages) while an account is still short of --max.
               Used when there is no readable cursor, when the last full read is over 20 hours
               old, or with --full. Only a full read in which every account answered with at
               least 3 posts reports status "ok", and "ok" is what lets the workflow tell the
               backend to drop stored posts that were deleted on X. Anything less is "partial",
               and the next run tries the full read again.
  incremental  only the posts newer than each account's since_id, 5 per page (the API minimum),
               following the API's next page while it says there are more, up to --max per
               account. It reports status "incremental", never "ok": a batch of new posts says
               nothing about which older posts still exist, so it must never prune.

Usage:
  infisical run --env=dev -- python tools/fetch_x_posts.py          # full read + stage session
  infisical run --env=dev -- python tools/fetch_x_posts.py --cursor stage/sieve/x_cursor.json
                                                                   # full or incremental, by the cursor
  ... --cursor stage/sieve/x_cursor.json --full                     # force a full read
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
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, NamedTuple

try:                                   # translation is a nicety, never a reason not to fetch
    import translate_posts
except ImportError:                    # pragma: no cover
    translate_posts = None

API = "https://api.x.com/2"
# Both official accounts. The Japanese one posts reveals and countdowns most days, usually ahead
# of the English account, and its posts are in Japanese: the app shows each one credited to its
# own handle so the reader can see which is which. USERNAME stays the default for every helper
# signature below, so single account callers and the tests are unchanged.
USERNAMES = ["PalworldOCG_EN", "PalworldOCG"]
USERNAME = USERNAMES[0]
TITLE_MAX = 120
SUMMARY_MAX = 300
TCO = re.compile(r"https?://t\.co/\S+")
POST_ID = re.compile(r"[0-9]{1,25}")
# The API will not return fewer than 5 posts a page, so an incremental read asks for exactly that:
# between two runs four hours apart each account has usually made none or one new post.
INCREMENTAL_PAGE = 5
# A full read is due once the last one is over 20 hours old rather than 24. Runs come roughly every
# 4 hours and never on the exact second, so a 24 hour rule would keep landing a few minutes short and
# push the full read back a whole run; 20 hours gives about one full read a day, whatever the drift.
FULL_EVERY = _dt.timedelta(hours=20)
# The API takes retweets and replies out of a page after cutting it (exclude=retweets,replies), so a
# page can hold fewer posts than were asked for even when the account has plenty. A full read follows
# the next page until it has --max posts, but gives up after 3 pages so a timeline of nothing but
# replies cannot keep the run paying.
FULL_PAGES = 3
# A full read is what lets the backend delete every stored post missing from the batch, so an account
# that answers a working call with fewer posts than this is not trusted as its current set: one quiet
# answer from X would otherwise wipe that account's posts from the app. Both accounts post most days, so
# a genuine full read clears this easily.
MIN_FULL_POSTS = 3

GetJson = Callable[[str, str], dict]


def parse_instant(value: object) -> _dt.datetime | None:
    """An ISO 8601 timestamp that carries a zone, as an aware datetime; None for anything else.

    A bare date or a clock time with no zone is not an instant, and guessing its zone would invent
    a publish time, so those count as unparseable.
    """
    text = str(value or "").strip()
    if not text:
        return None
    if text[-1] in "Zz":
        text = text[:-1] + "+00:00"
    try:
        parsed = _dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def iso_instant(value: object) -> str:
    """'2026-09-25T10:00:00.000Z' -> '2026-09-25T10:00:00Z' (UTC), or '' when it is not an instant."""
    parsed = parse_instant(value)
    try:
        return parsed.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if parsed else ""
    except (OverflowError, ValueError):            # a year 1 time with an offset, say
        return ""


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
        row = {
            "title": title,
            "date": format_date(str(tweet.get("created_at") or "")),
            "summary": " ".join(text.split())[:SUMMARY_MAX],
            "link": f"https://x.com/{username}/status/{tid}",
            "image": image,
        }
        # "date" stays the day it always was; "published" adds the exact time, which is what lets
        # the backend put the 02:00 reveal above the 01:00 announcement from the same morning.
        published = iso_instant(tweet.get("created_at"))
        if published:
            row["published"] = published
        rows.append(row)
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


def resolve_user_id(token: str, username: str = USERNAME, get: GetJson | None = None) -> str:
    get = get or _get_json
    data = get(f"{API}/users/by/username/{urllib.parse.quote(username)}", token)
    uid = str((data.get("data") or {}).get("id") or "")
    if not uid:
        raise ValueError(f"X API returned no user id for @{username}: {api_error(data)}")
    return uid


def fetch_page(token: str, user_id: str, max_results: int = 10, since_id: str = "",
               pagination_token: str = "", get: GetJson | None = None) -> dict:
    """One raw /2/users/:id/tweets page. since_id limits it to posts newer than that id."""
    get = get or _get_json
    params = {
        "max_results": max(5, min(100, max_results)),
        "exclude": "retweets,replies",
        "expansions": "attachments.media_keys",
        "media.fields": "url,preview_image_url,type",
        "tweet.fields": "created_at,note_tweet",
    }
    if since_id:
        params["since_id"] = since_id
    if pagination_token:
        params["pagination_token"] = pagination_token
    payload = get(f"{API}/users/{user_id}/tweets?{urllib.parse.urlencode(params)}", token)
    if "data" not in payload and payload.get("errors"):
        raise ValueError(f"X API error: {api_error(payload)}")
    return payload


def _post_id(value: object) -> str:
    text = str(value or "").strip()
    return text if POST_ID.fullmatch(text) else ""


def newest_post_id(payload: dict, current: str = "") -> str:
    """The newest post id in a raw API payload: meta.newest_id, or the highest id in data.

    Read from the payload itself, never from the rows that survive tidy_rows. A link only follow up
    that the feed drops is still a post the API has billed for, and a cursor left behind it would
    pay to read it again on every run.
    """
    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    data = payload.get("data") if isinstance(payload.get("data"), list) else []
    ids = [_post_id(meta.get("newest_id")), _post_id(current)]
    ids += [_post_id(tweet.get("id")) for tweet in data if isinstance(tweet, dict)]
    ids = [i for i in ids if i]
    return max(ids, key=int) if ids else ""


def post_ids(payload: dict) -> list[str]:
    """Every post id in a raw API payload, counted before the feed drops any of them."""
    data = payload.get("data") if isinstance(payload.get("data"), list) else []
    return [i for i in (_post_id(tweet.get("id")) for tweet in data if isinstance(tweet, dict)) if i]


def next_page(payload: dict) -> str:
    """The token for the API's next page, or "" when it says there are no more."""
    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
    return str(meta.get("next_token") or "")


class AccountRead(NamedTuple):
    rows: list[dict]
    newest_id: str      # the newest post id the API returned, "" when it returned none
    user_id: str        # the account's numeric id, worth remembering: looking it up is a billed call
    posts: int = 0      # how many posts the API returned, before the feed drops any of them


def fetch_account(token: str, user_id: str = "", max_results: int = 10, username: str = USERNAME,
                  get: GetJson | None = None, since_id: str = "") -> AccountRead:
    """Read one account. Without since_id this is the full read of its newest max_results posts.

    A full read follows the API's next page while the account is still short of max_results posts,
    because the API takes retweets and replies out of a page after cutting it and one page can come
    back nearly empty. Every page asks for the same max_results: X's pagination docs only ever pair a
    pagination_token with the page size that produced it, so changing it mid chain is not something to
    rely on. FULL_PAGES caps the number of calls, and X bills a post read once per UTC day however
    many pages it shows up on.

    With since_id only newer posts come back, INCREMENTAL_PAGE at a time. The pages are followed
    while the API offers another, because a busy reveal morning can bring more than five posts
    between two runs and stopping at the first page would skip the older ones: the cursor moves
    past them. max_results still caps the total, so an incremental read never reads more posts
    than a full one.
    """
    get = get or _get_json
    uid = user_id or resolve_user_id(token, username, get)
    max_results = max(5, min(100, max_results))
    rows: list[dict] = []
    seen: set[str] = set()
    newest, page = "", ""
    for _ in range(-(-max_results // INCREMENTAL_PAGE) if since_id else FULL_PAGES):
        ask = INCREMENTAL_PAGE if since_id else max_results
        payload = fetch_page(token, uid, ask, since_id, page, get)
        rows.extend(rows_from_payload(payload, username))
        seen.update(post_ids(payload))
        newest = newest_post_id(payload, newest)
        page = next_page(payload)
        if not page or len(seen) >= max_results:
            break
    return AccountRead(tidy_rows(rows), newest, uid, len(seen))


def fetch_rows(token: str, user_id: str = "", max_results: int = 10,
               username: str = USERNAME, get: GetJson | None = None, since_id: str = "") -> list[dict]:
    return fetch_account(token, user_id, max_results, username, get, since_id).rows


def load_cursor(path: Path | None) -> dict:
    """Where the last read got to, or an empty cursor (meaning: do a full read) if it cannot be trusted.

    A missing, unreadable, corrupt or oddly shaped file is not an error: the worst it can cost is one
    full read, which is exactly what every run did before the cursor existed. Anything that is not a
    plain numeric post or user id is dropped rather than sent to the API.
    """
    cursor: dict = {"accounts": {}}
    if not path:
        return cursor
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return cursor
    if not isinstance(data, dict):
        return cursor
    full_at = iso_instant(data.get("full_at"))
    if full_at:
        cursor["full_at"] = full_at
    accounts = data.get("accounts")
    for handle, entry in (accounts.items() if isinstance(accounts, dict) else []):
        if not isinstance(entry, dict):
            continue
        kept = {key: _post_id(entry.get(key)) for key in ("since_id", "user_id")}
        kept = {key: value for key, value in kept.items() if value}
        if kept:
            cursor["accounts"][str(handle)] = kept
    return cursor


def save_cursor(path: Path | None, cursor: dict) -> None:
    """Write the cursor atomically: a run killed half way leaves the previous file, never half a file."""
    if not path:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(cursor, indent=2, sort_keys=True) + "\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read_mode(cursor: dict, now: _dt.datetime, force_full: bool = False) -> tuple[str, str]:
    """("full" or "incremental", why). Anything doubtful means full: it costs more but is always right."""
    if force_full:
        return "full", "--full was passed"
    full_at = parse_instant(cursor.get("full_at"))
    if full_at is None:
        return "full", "no earlier full read on record"
    age = now - full_at
    if age < _dt.timedelta(0):
        return "full", "the last full read is dated in the future"
    hours = age.total_seconds() / 3600
    if age > FULL_EVERY:
        return "full", f"the last full read was {hours:.1f} hours ago"
    return "incremental", f"only posts newer than the last seen; the last full read was {hours:.1f} hours ago"


# A post is worth showing when it says something on its own. Measured against a real two account
# fetch: link only follow ups ("product details here") carry no image and a 7 to 19 character summary,
# while every genuine post carries an image and 129 to 295. Multi part posts also lead with a
# decorative line, so a post whose title is punctuation or a lone symbol keeps its art and borrows the
# first real line of its own summary rather than showing up as a slash.
FRAGMENT_TITLE = re.compile(r"^[\W_\s]*$", re.UNICODE)
LINK_ONLY_MIN = 40


def first_text_line(summary: str) -> str:
    """The first line of a post body that is actual prose rather than a divider or a bare link."""
    for line in str(summary or "").splitlines():
        line = TCO.sub("", line).strip()
        if len(line) >= 4 and not FRAGMENT_TITLE.match(line):
            return line[:TITLE_MAX]
    return ""


# The split announcement habit belongs to the Japanese account; the English one posts short complete
# thoughts like "Tournament results are up." that must not be mistaken for a fragment. So the length
# test only applies to posts that are actually in Japanese, and English filler stays the backend's job
# (SOCIAL_SKIP), which is where it already was.
CJK = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]")


def worth_showing(row: dict) -> bool:
    """Drop the link only half of a split announcement: no art, and nothing to read but a pointer."""
    if row.get("image"):
        return True
    body = str(row.get("summary") or "").strip()
    if not CJK.search(str(row.get("title") or "") + body):
        return True                                   # English: not this filter's problem
    return len(body) >= LINK_ONLY_MIN


def tidy_rows(rows: list[dict]) -> list[dict]:
    out = []
    for row in rows:
        if not worth_showing(row):
            continue
        title = str(row.get("title") or "").strip()
        if not title or FRAGMENT_TITLE.match(title):
            better = first_text_line(row.get("summary", ""))
            if not better:
                continue                      # nothing readable anywhere in it
            row = {**row, "title": better}
        out.append(row)
    return out


def translated(rows: list[dict], root: Path) -> list[dict]:
    """English headlines and bodies for the Japanese account, cached between runs.

    Japanese posts are the reason this exists: the app is English and Japanese text reads as a bug.
    Everything here degrades to "publish it in Japanese": no module, no key, no network and a
    confused model all leave the rows exactly as they arrived.
    """
    if translate_posts is None:
        return rows
    try:
        rows, stats = translate_posts.translate_rows(rows, translate_posts.cache_path_for(root))
    except Exception as exc:                       # never let a nicety break the fetch
        print(f"x-api: translation skipped ({exc})", file=sys.stderr)
        return rows
    if stats["considered"]:
        print("x-api: translated {translated} post(s), {cached} from cache, {partial} part done, "
              "{failed} left in the original".format(**stats))
    return rows


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
        "instruction": "Latest " + ", ".join("@" + u for u in USERNAMES) + " posts from the official X API v2",
        "source": "x-api",
    }, ensure_ascii=False), encoding="utf-8")
    (session / "files" / "scrape_results.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return session


def write_github_output(path: Path | None, status: str, posts: int,
                        accounts: dict[str, int] | None = None) -> None:
    """status= and posts= (the staged rows), then posts_<handle>= for each account read.

    The per account lines count what the API returned for that account, before the feed drops any,
    so the log shows which account came back short when a full read reports "partial".
    """
    if path:
        lines = [f"status={status}", f"posts={posts}"]
        lines += [f"posts_{handle}={count}" for handle, count in (accounts or {}).items()]
        with path.open("a", encoding="utf-8") as out:
            out.write("\n".join(lines) + "\n")


def main(argv: list[str] | None = None, get: GetJson | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path("stage/sieve"), help="session directory (default: stage/sieve)")
    parser.add_argument("--max", dest="max_results", type=int, default=10,
                        help="posts per account on a full read, and the cap on an incremental one (5-100, default 10)")
    parser.add_argument("--cursor", type=Path,
                        help="JSON file remembering where the last read got to (CI: stage/sieve/x_cursor.json); "
                             "without it every run is a full read and nothing is saved")
    parser.add_argument("--full", action="store_true", help="do a full read even when the cursor allows an incremental one")
    parser.add_argument("--print", dest="print_rows", action="store_true", help="print staged rows as JSON")
    parser.add_argument("--offline", type=Path, help="stage rows from a saved /2/users/:id/tweets payload instead of fetching")
    parser.add_argument("--github-output", type=Path,
                        help="write status, posts and posts_<handle> for each account to GitHub Actions output")
    args = parser.parse_args(argv)

    cursor: dict | None = None
    counts: dict[str, int] | None = None
    failed: list[str] = []
    status = "ok"
    if args.offline:
        rows = translated(
            tidy_rows(rows_from_payload(json.loads(args.offline.read_text(encoding="utf-8")))),
            args.root)
    else:
        token = os.environ.get("X_BEARER_TOKEN", "").strip()
        if not token:
            print("x-api: X_BEARER_TOKEN is not set - skipping X posts (not an error)")
            write_github_output(args.github_output, "skipped", 0, {handle: 0 for handle in USERNAMES})
            return 0
        now = _dt.datetime.now(_dt.timezone.utc)
        cursor = load_cursor(args.cursor)
        mode, why = read_mode(cursor, now, args.full)
        print(f"x-api: {mode} read ({why})")
        # One account failing must not look like a complete set: the backend treats an "ok" status as
        # permission to delete every stored X post, so a partial fetch reports "partial" instead and
        # the workflow leaves the stored posts alone. The same goes for an account whose full read
        # worked but came back with fewer than MIN_FULL_POSTS posts ("short"): the other account's
        # posts would still make the batch look complete, and that account's stored posts would go.
        rows, short = [], []
        counts = {handle: 0 for handle in USERNAMES}
        pinned_id = os.environ.get("X_USER_ID", "").strip()
        for i, handle in enumerate(USERNAMES):
            entry = dict(cursor["accounts"].get(handle) or {})
            since = entry.get("since_id", "") if mode == "incremental" else ""
            # X_USER_ID, when set, pins only the first handle; the rest use the id the cursor
            # remembered, and only an account with no remembered id is looked up by name.
            known_id = (pinned_id if i == 0 else "") or entry.get("user_id", "")
            try:
                got = fetch_account(token, known_id, args.max_results, handle, get, since)
            except urllib.error.HTTPError as exc:
                # The body is the API's JSON error; it never echoes the bearer token.
                try:
                    detail = api_error(json.loads(exc.read().decode("utf-8")))
                except (OSError, ValueError):
                    detail = exc.reason
                print(f"x-api fetch failed for @{handle}: HTTP {exc.code} {detail}", file=sys.stderr)
                failed.append(handle)
            except (OSError, ValueError) as exc:
                print(f"x-api fetch failed for @{handle}: {exc}", file=sys.stderr)
                failed.append(handle)
            else:
                rows.extend(got.rows)
                entry["user_id"] = got.user_id
                # Advanced only after a read that worked. A failed account keeps its old since_id,
                # so the next run asks again for everything it missed.
                if got.newest_id:
                    entry["since_id"] = got.newest_id
                print(f"x-api: @{handle}: {len(got.rows)} post(s)" + (f" newer than {since}" if since else ""))
                counts[handle] = got.posts
                if mode == "full" and got.posts < MIN_FULL_POSTS:
                    # Its rows are still staged and its since_id still moves on, exactly as for any
                    # read that worked; only the status and full_at treat it like a failure.
                    short.append(handle)
                    print(f"x-api: @{handle} returned only {got.posts} post(s) on a full read, fewer than "
                          f"{MIN_FULL_POSTS}, so this run reports partial and the next run reads in full again",
                          file=sys.stderr)
            if handle in failed:
                # Forget a remembered user id after a failure, so a stale one can never lock an
                # account out for good. It costs one lookup on the next run.
                entry.pop("user_id", None)
            if entry:
                cursor["accounts"][handle] = entry
            else:
                cursor["accounts"].pop(handle, None)
        # Left alone after a failed or short account, so the next run is a full read again rather
        # than waiting most of a day for the next chance to prune.
        if mode == "full" and not failed and not short:
            cursor["full_at"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        if len(failed) == len(USERNAMES):
            save_cursor(args.cursor, cursor)
            write_github_output(args.github_output, "failed", 0, counts)
            return 1
        rows = translated(rows, args.root)
        if failed or short:
            status = "partial"
        elif mode == "incremental":
            # Never "ok": the workflow only sends x_complete (which prunes) on "ok", and a batch of
            # new posts is not the account's current set.
            status = "incremental"
    session = stage_session(rows, args.root)
    if failed:
        print(f"x-api: staged {len(rows)} post(s) from "
              f"{len(USERNAMES) - len(failed)} of {len(USERNAMES)} accounts -> {session}")
    else:
        print(f"x-api: staged {len(rows)} post(s) -> {session}")
    if cursor is not None:
        # Saved only once the posts are staged, so a run that dies before then reads them again.
        save_cursor(args.cursor, cursor)
    write_github_output(args.github_output, status, len(rows), counts)
    if args.print_rows:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
