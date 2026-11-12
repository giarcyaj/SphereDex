"""Turn official product announcements into app release data (logos, banners, dates, products).

Part of the news sweep (.github/workflows/sieve-refresh.yml). For each recent post on the official
English site:

  1. a quoted title still announces the product (Booster Pack "Eternal Ascent" ...). The product
     code comes from the banner file name (BP03-ordersheet-banner-template.png -> BP03) or the text;
  2. a post whose title is not quoted that way is still opened when it links to an official product
     page (/products/td03, /products/td04). The page, not the headline, supplies the type, set, code
     and street date. Trial decks, booster packs and sleeve and card sets are read in English or
     Japanese. Event pages are not: Zoe's Strategy is a special set sold at events, and a Masters
     League post is not a sealed product;
  3. a linked product page takes its street day from the labelled Release Date. That label
     beats the line that only dates the page. A quoted announcement still takes its day from
     the post text, then Tesseract OCR of the banner (--sieve adds a paid Sieve read first);
  4. the banner becomes a timeline thumbnail and, when it is the plain announcement template, the
     set logo is cut out of it (tools/banner_logo.py);
  5. everything is published to the backend (/api/admin/release-img + /api/admin/releases), which
     every app merges into its release timeline, Browse tiles and Sealed list at launch.

A product the catalogue already stores under the same id and the same street day is not published
again. That keeps td-ea-rg, td-ea-bp, box-bp03 and pack-bp03 in place. The uncoded duplicates
box-eternal-ascent and pack-eternal-ascent are not rewritten. Japanese news posts are not this
catalogue: the Japanese site is a separate feed, and a Japanese delay notice is not applied here.

Posts already processed are skipped (the backend remembers them). A post is opened again when
its text changed. A street day is replaced only by a newer absolute asOf, earlier or later on
the calendar. asOf is WordPress modified_gmt, or date_gmt when modified_gmt is absent,
normalized to UTC with a Z suffix. Site-local modified/date are not used. A post whose current
text asserts no street day is not given that clock, so a later edit of an old preorder cannot
restamp a cached day. The same URL without asOf is not a newer edit. Without
BACKEND_ADMIN_KEY the tool skips cleanly. Merge the backend draft before this app draft.

Usage:
  python tools/release_sweep.py                    # sweep + publish
  python tools/release_sweep.py --dry-run          # write stage/releases/ instead of publishing
  python tools/release_sweep.py --force            # reprocess posts the backend has already seen
  python tools/release_sweep.py --sieve            # also read dates with Sieve (spends credits)
"""
from __future__ import annotations

import argparse
import base64
import datetime as _dt
import hashlib
import html as _html
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

POSTS_API = "https://en.palworld-official-cardgame.com/wp-json/wp/v2/posts"
BACKEND = "https://spheredex-backend.craigjayedit.workers.dev"
UA = "SphereDex-news/1.0 (+https://github.com/giarcyaj/SphereDex)"
PER_PAGE = 10

MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}
SHORT = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DATE_RE = re.compile(
    r"\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|"
    r"sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b",
    re.IGNORECASE)
SIGNAL_RE = re.compile(r"on\s*sale|release|launch|available|ships?|arriv", re.IGNORECASE)
_EN_TYPES = (
    r"Booster\s+Pack|Booster\s+Box|Trial\s+Deck|Starter\s+Deck|"
    r"Sleeve\s*(?:&|and)\s*Card\s+Set|Card\s+Set|Premium\s+\w+(?:\s+\w+)?|Special\s+\w+(?:\s+\w+)?"
)
_JA_TYPES = r"ブースターパック|ブースターボックス|トライアルデッキ|スターターデッキ|スリーブ\s*[&＆]\s*カードセット"
TYPES = _EN_TYPES + "|" + _JA_TYPES
# Japanese product titles quote with 「」 and put 第3弾 between the type and the set name.
_QUOTED = "[\"“”「」『』]"
TITLE_RE = re.compile(
    "(" + TYPES + ")"
    "(?:[ \t\u3000]*第\\s*\\d+\\s*弾)?"
    "[ \t\u3000]*" + _QUOTED + "([^\"“”「」『』]{2,80})" + _QUOTED,
    re.IGNORECASE)
CODE_RE = re.compile(r"(?<![A-Z0-9])E?((?:BP|TD|SS|PR)\d{2})(?!\d)", re.IGNORECASE)
# The app and backend PR 37 already publish these ids. products_for would otherwise mint td-td03
# beside td-ea-rg. Colour initials are the published id; the code stays on the row.
CANONICAL_PRODUCT_IDS = {
    ("TD03", "deck"): "td-ea-rg",
    ("TD04", "deck"): "td-ea-bp",
}
_TYPE_EN = {
    "トライアルデッキ": "Trial Deck",
    "スターターデッキ": "Starter Deck",
    "ブースターパック": "Booster Pack",
    "ブースターボックス": "Booster Box",
    "スリーブ&カードセット": "Sleeve & Card Set",
    "スリーブ＆カードセット": "Sleeve & Card Set",
}
_SET_EN = (
    ("パルパゴスの夜明け", "Dawn of Palpagos"),
    ("目覚めし伝説", "Legends Awaken"),
    ("果てなき飛翔", "Eternal Ascent"),
)
_COLOUR_EN = {
    "レッド": "Red", "ブルー": "Blue", "グリーン": "Green",
    "パープル": "Purple", "イエロー": "Yellow", "カラーレス": "Colorless",
}
_EVENT_PAGE = re.compile(
    r"special\s*set|masters\s*league|マスターズリーグ|開催記念|tournament",
    re.IGNORECASE)
_UNQUOTED_SEALED = re.compile(
    r"^(Sleeve\s*(?:&|and)\s*Card\s+Set|スリーブ\s*[&＆]\s*カードセット)\s+(.+)$",
    re.IGNORECASE)
_RELEASE_LABEL = re.compile(
    r"Release Date:\s*([A-Za-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+20\d{2})",
    re.IGNORECASE)
_JA_RELEASE = re.compile(r"発売日\s*(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")
_OFFICIAL_HOSTS = {
    "en.palworld-official-cardgame.com",
    "palworld-official-cardgame.com",
    "www.palworld-official-cardgame.com",
}
# The bare official host is the Japanese site. en. is the English catalogue this sweep publishes.
_JA_NEWS_HOSTS = {"palworld-official-cardgame.com", "www.palworld-official-cardgame.com"}
COLOURS = ("red", "blue", "green", "purple", "yellow", "colorless")

SIEVE_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["products"],
    "properties": {"products": {"type": "array", "items": {
        "type": "object", "additionalProperties": False,
        "required": ["set_name", "product_type", "product_code", "release_date"],
        "properties": {k: {"type": "string"} for k in ("set_name", "product_type", "product_code", "release_date")},
    }}},
}
SIEVE_INSTRUCTION = (
    "This is an official Palworld OFFICIAL CARD GAME product announcement. For each product it announces, "
    "extract set_name (e.g. Eternal Ascent), product_type (Booster Pack, Trial Deck, ...), product_code if shown "
    "anywhere including image file names (e.g. BP03), and release_date (the on-sale date, as 'Month D, YYYY'). "
    "Dates are often printed only inside the page's banner image (e.g. 'On Sale January 29, 2027'), so read the "
    "text inside the images too. Use an empty string when a value is not present.")


# ---- parsing ---------------------------------------------------------------------------------------

def strip_html(fragment: str) -> str:
    text = re.sub(r"<[^>]+>", " ", fragment or "")
    return re.sub(r"\s+", " ", _html.unescape(text)).strip()


def _english_type(raw: str) -> str:
    compact = re.sub(r"\s+", "", raw or "").replace("＆", "&")
    if compact in _TYPE_EN:
        return _TYPE_EN[compact]
    return " ".join(w.capitalize() if w.islower() else w for w in (raw or "").split())


def _english_set(name: str) -> str:
    text = name or ""
    for ja, en in _SET_EN:
        text = text.replace(ja, en)
    for ja, en in _COLOUR_EN.items():
        text = text.replace(ja, en)
    return " ".join(text.split())


def parse_title(title: str) -> tuple[str, str] | None:
    """('Booster Pack', 'Eternal Ascent') from an announcement title, or None.

    English quotes and Japanese 「」 both count. The type has to be one of the sealed
    product words. A headline with no quotes (the English trial deck posts) is None:
    the product page is what names those.
    """
    match = TITLE_RE.search(_html.unescape(title or ""))
    if not match:
        return None
    return _english_type(match.group(1)), _english_set(match.group(2))


def find_code(*texts: str) -> str:
    for text in texts:
        m = CODE_RE.search(text or "")
        if m:
            return m.group(1).upper()
    return ""


def _format_match(m: re.Match) -> str:
    month = MONTHS.get(m.group(1)[:3].lower())
    day, year = int(m.group(2)), int(m.group(3))
    try:
        _dt.date(year, month, day)
    except (TypeError, ValueError):
        return ""
    return f"{SHORT[month]} {day}, {year}"


def parse_date(text: str) -> str:
    """The release date in the feed's 'Jan 29, 2027' style: the first date after a release signal
    (on sale, release, available, ...), else the first date at all; '' when there is none."""
    found = []
    for m in DATE_RE.finditer(text or ""):
        formatted = _format_match(m)
        if not formatted:
            continue
        signalled = bool(SIGNAL_RE.search((text or "")[max(0, m.start() - 40):m.start()]))
        found.append((not signalled, m.start(), formatted))
    return min(found)[2] if found else ""


def product_family(ptype: str) -> str:
    kind = (ptype or "").lower()
    if "booster" in kind:
        return "booster"
    if "deck" in kind:
        return "deck"
    return ""


def _window_family(window: str) -> str:
    deck = bool(re.search(r"trial deck|starter deck", window, re.IGNORECASE))
    booster = bool(re.search(r"booster", window, re.IGNORECASE))
    if deck and not booster:
        return "deck"
    if booster and not deck:
        return "booster"
    return ""


_REVISED_RE = re.compile(
    r"\b(after|moved to|postponed to|rescheduled to|delayed to|corrected to|brought forward to)\b",
    re.IGNORECASE)
_SUPERSEDED_RE = re.compile(
    r"\b(before|originally|previously|instead of|original date)\b",
    re.IGNORECASE)


def _region(window: str) -> str:
    """'jp' or 'en' when the clause names one region, else ''."""
    jp = re.search(r"\bjapanese\b|\bjp release\b", window or "", re.IGNORECASE) is not None
    en = re.search(r"\benglish\b", window or "", re.IGNORECASE) is not None
    if jp and not en:
        return "jp"
    if en and not jp:
        return "en"
    return ""


def best_date(text: str, ptype: str = "") -> str:
    """The street date that belongs to this product.

    A delay notice states the old day first ('before' / 'originally') and the new day after.
    A mixed announcement states a trial deck day and a booster day. The matching clause wins.
    When nothing distinguishes the dates, the first signalled date stands, as parse_date did.
    """
    raw = text or ""
    matches = [m for m in DATE_RE.finditer(raw) if _format_match(m)]
    if not matches:
        return ""
    family = product_family(ptype)
    anchors = [m.start() for m in re.finditer(re.escape(ptype), raw, re.IGNORECASE)] if ptype else []

    def same_sentence(a: int, b: int) -> bool:
        lo, hi = sorted((a, b))
        return re.search(r"[.\n!?]", raw[lo:hi]) is None

    def score(m: re.Match) -> int:
        window = raw[max(0, m.start() - 160):min(len(raw), m.end() + 90)]
        before = raw[max(0, m.start() - 70):m.start()]
        value = 0
        kind = _window_family(window)
        if family and kind == family:
            value += 5
        elif family and kind and kind != family:
            value -= 8
        if anchors and any(same_sentence(m.start(), anchor) for anchor in anchors):
            value += 8
        if _REVISED_RE.search(before):
            value += 6
        if _SUPERSEDED_RE.search(before):
            value -= 6
        if _region(window) == "jp":
            value -= 30  # this sweep is the English catalogue; a Japanese-only clause is not its date
        if SIGNAL_RE.search(before):
            value += 2
        return value

    if len(matches) == 1:
        if _region(raw[max(0, matches[0].start() - 80):min(len(raw), matches[0].end() + 40)]) == "jp":
            return ""
        return _format_match(matches[0])

    def role(m: re.Match) -> str:
        """The marker closest to the date. 'corrected to March, instead of June' must not mark June as corrected."""
        before = raw[max(0, m.start() - 80):m.start()]
        revised = _REVISED_RE.search(before)
        superseded = _SUPERSEDED_RE.search(before)
        if revised and superseded:
            return "revised" if revised.start() > superseded.start() else "superseded"
        if revised:
            return "revised"
        if superseded:
            return "superseded"
        return ""

    def fitting(pool: list[re.Match]) -> list[re.Match]:
        kept = []
        for m in pool:
            kind = _window_family(raw[max(0, m.start() - 160):min(len(raw), m.end() + 90)])
            if family and kind and kind != family:
                continue
            if _region(raw[max(0, m.start() - 80):min(len(raw), m.end() + 40)]) == "jp":
                continue
            kept.append(m)
        return kept

    revised = fitting([m for m in matches if role(m) == "revised"])
    superseded = [m for m in matches if role(m) == "superseded"]
    # The correction is the revised clause, or the date that is not the one being replaced.
    # Last in the text, not the later calendar day: a brought-forward date is still the new one.
    chosen_pool = revised
    if not chosen_pool and superseded:
        chosen_pool = fitting([m for m in matches if m not in superseded])
    if chosen_pool:
        return _format_match(max(chosen_pool, key=lambda m: m.start()))

    ranked = sorted(matches, key=lambda m: (score(m), -m.start()), reverse=True)
    best = ranked[0]
    if family and score(best) < 0:
        return ""
    if _region(raw[max(0, best.start() - 80):min(len(raw), best.end() + 40)]) == "jp":
        return ""
    # Equal scores keep the earlier mention (score, then reversed start, so the first match wins ties).
    return _format_match(best) or parse_date(raw)


def is_past(date: str, today: _dt.date | None = None) -> bool:
    m = DATE_RE.search(date or "")
    if not m:
        return False
    return _dt.date(int(m.group(3)), MONTHS[m.group(1)[:3].lower()], int(m.group(2))) <= (today or _dt.date.today())


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:40]


def _is_sealed_type(ptype: str) -> bool:
    """Booster packs, trial decks and sleeve and card sets. Not a special set or a promo kit."""
    kind = (ptype or "").lower()
    if "special" in kind or "premium" in kind:
        return False
    return "booster" in kind or "deck" in kind or "sleeve" in kind or kind == "card set"


def _is_event_source(title: str, url: str) -> bool:
    """Zoe's Strategy and Masters League pages are events, even when they carry a date."""
    return _EVENT_PAGE.search(f"{title}\n{url}") is not None


def page_title(html: str) -> str:
    match = re.search(r"<title>(.*?)</title>", html or "", re.IGNORECASE | re.DOTALL)
    if not match:
        return ""
    return strip_html(match.group(1)).split("|")[0].strip()


def product_release_date(text: str) -> str:
    """The labelled street date. The line that dates the page itself is not the street date."""
    labeled = _RELEASE_LABEL.search(text or "")
    if labeled:
        return parse_date(labeled.group(1))
    ja = _JA_RELEASE.search(text or "")
    if not ja:
        return ""
    year, month, day = int(ja.group(1)), int(ja.group(2)), int(ja.group(3))
    try:
        _dt.date(year, month, day)
    except ValueError:
        return ""
    return f"{SHORT[month]} {day}, {year}"


def parse_product_page(page: str, url: str) -> dict | None:
    """Sealed product facts from an official product page.

    None for accessories, for a special set sold at events, and for a page that does not
    label a street date. The code is the page slug (td03 -> TD03).
    """
    title = page_title(page)
    if not title or _is_event_source(title, url):
        return None
    parsed = parse_title(title)
    if not parsed:
        plain = _UNQUOTED_SEALED.match(title)
        if plain:
            parsed = (_english_type(plain.group(1)), _english_set(plain.group(2)))
    if not parsed or not _is_sealed_type(parsed[0]):
        return None
    code = find_code(urllib.parse.urlparse(url).path, title)
    date = product_release_date(strip_html(page))
    if not code or not date:
        return None
    return {"ptype": parsed[0], "set_name": parsed[1], "code": code, "date": date}


def product_page_urls(html: str, post_link: str) -> list[str]:
    """Official product-page links in a news post. /events/ links are not product pages."""
    if not post_link:
        return []
    post_host = urllib.parse.urlparse(post_link).netloc.lower()
    found: list[str] = []
    for match in re.finditer(r"""href=["']([^"']+)["']""", html or "", re.IGNORECASE):
        href = _html.unescape(match.group(1)).strip()
        absolute = urllib.parse.urljoin(post_link, href)
        parts = urllib.parse.urlparse(absolute)
        host = parts.netloc.lower()
        if host not in _OFFICIAL_HOSTS and host != post_host:
            continue
        if "/products/" not in parts.path:
            continue
        url = f"{parts.scheme}://{parts.netloc}{parts.path}".rstrip("/")
        if url not in found:
            found.append(url)
    return found


def _japanese_news_post(link: str) -> bool:
    """Japanese site news is not an English catalogue update. Product pages are read either way."""
    return urllib.parse.urlparse(link or "").netloc.lower() in _JA_NEWS_HOSTS


def _read_page(get, url: str) -> str:
    try:
        data = get(url, timeout=60)
    except TypeError:
        data = get(url)
    except (OSError, ValueError):
        return ""
    if isinstance(data, str):
        return data
    if not data:
        return ""
    return bytes(data).decode("utf-8", "replace")


def _linked_row_eligible(row: dict, catalog: dict | None, today: _dt.date | None) -> bool:
    """A product reached only because a post linked its page.

    A row already on file is handed to the merge, which leaves it when the street day matches.
    A day before today, for an id the catalogue does not have, is a back catalogue mention
    (a sales post linking BP01), not a new release.
    """
    if not row.get("date"):
        return False
    if _find_product(_catalog_products(catalog), row.get("id") or ""):
        return True
    day = (today or _dt.date.today()) - _dt.timedelta(days=1)
    return not is_past(row["date"], day)


def split_colours(set_name: str) -> tuple[str, list[str]]:
    """'Eternal Ascent Red·Green' -> ('Eternal Ascent', ['Red', 'Green']).

    The official pages use the katakana middle dot ・ between colours. The app's own
    name uses ·. Both split here.
    """
    words = re.split(r"[\s·・･/,&\-]+", set_name)
    colours = []
    while words and words[-1].lower() in COLOURS:
        colours.insert(0, words.pop().capitalize())
    return " ".join(words).strip(), colours


def products_for(ptype: str, set_name: str, code: str, date: str, link: str, banner_key: str,
                 today: _dt.date | None = None) -> list[dict]:
    """App sealed-product rows for one announcement, following the app's own id conventions
    (box-bp02 / pack-bp02 / td-...)."""
    base_set, colours = split_colours(set_name)
    c = code.lower()
    pre = not is_past(date, today)
    common = {"set": base_set, "date": date, "pre": pre, "banner": banner_key, "box": "", "link": link}
    kind = ptype.lower()
    if "booster" in kind:
        key = c or slug(base_set)
        return [
            {**common, "id": f"box-{key}", "name": "Booster Box", "sub": "", "code": code,
             "q": f"Palworld {base_set} Booster Box"},
            {**common, "id": f"pack-{key}", "name": "Booster Pack", "sub": "", "code": "",
             "q": f"Palworld {base_set} Booster Pack"},
        ]
    if "deck" in kind:
        name = "Trial Deck" + (", " + " · ".join(colours) if colours else "")
        return [{**common, "id": f"td-{c or slug(set_name)}", "name": name, "sub": "Starter deck", "code": code,
                 "q": f"Palworld {base_set} Trial Deck {' '.join(colours)}".strip()}]
    return [{**common, "id": c or slug(f"{base_set}-{ptype}"), "name": ptype, "sub": "", "code": code,
             "q": f"Palworld {base_set} {ptype}"}]


# ---- sources -----------------------------------------------------------------------------------------

def http_get(url: str, headers: dict | None = None, timeout: float = 60.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_posts(get=http_get) -> list[dict]:
    posts = json.loads(get(f"{POSTS_API}?per_page={PER_PAGE}&orderby=date&order=desc&_embed=wp:featuredmedia"))
    if not isinstance(posts, list):
        raise ValueError("unexpected WP payload: expected a JSON array")
    return [p for p in posts if isinstance(p, dict)]


def featured_image(post: dict) -> str:
    media = ((post.get("_embedded") or {}).get("wp:featuredmedia") or [{}])[0] or {}
    url = str(media.get("source_url") or "")
    if url:
        return url
    m = re.search(r"<img[^>]+src=[\"']([^\"']+)", str((post.get("content") or {}).get("rendered") or ""))
    return _html.unescape(m.group(1)) if m else ""


def tesseract_path() -> str:
    found = shutil.which("tesseract")
    if found:
        return found
    win = Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe")
    return str(win) if win.exists() else ""


def ocr_text(image_bytes: bytes) -> str:
    """Banner text via Tesseract (greyscale at 1600px, which reads the big date line cleanly)."""
    exe = tesseract_path()
    if not exe:
        return ""
    from PIL import Image
    im = Image.open(io.BytesIO(image_bytes)).convert("L")
    im = im.resize((1600, max(1, round(im.height * 1600 / im.width))))
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "banner.png")
        im.save(path)
        try:
            out = subprocess.run([exe, path, "stdout", "--psm", "3"], capture_output=True, timeout=120)
        except (OSError, subprocess.TimeoutExpired):
            return ""
    return out.stdout.decode("utf-8", "replace")


class SieveReader:
    """Reads a post (banner text included) with Sieve. Disables itself after a credits or auth
    failure so one empty balance costs one request, not one per post."""

    def __init__(self, enabled: bool):
        self.client = None
        if enabled and os.environ.get("SIEVE_API_KEY"):
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            import sieve
            self.sieve = sieve
            self.client = sieve.SieveClient()

    def release(self, link: str, set_name: str) -> tuple[str, str]:
        """(date, code) for set_name, '' where unknown."""
        if not self.client:
            return "", ""
        try:
            started = self.client.start_run(SIEVE_INSTRUCTION, target_urls=[link], output_schema=SIEVE_SCHEMA)
            run = self.client.poll(started["session_id"], max_wait=420)
        except (self.sieve.PaymentRequired, self.sieve.Unauthorized) as exc:
            print(f"release-sweep: Sieve unavailable ({exc}); using OCR and post text", file=sys.stderr)
            self.client = None
            return "", ""
        except Exception as exc:   # a refused or failed run must not stop the sweep
            print(f"release-sweep: Sieve run failed ({exc}); using OCR and post text", file=sys.stderr)
            return "", ""
        if not self.sieve.is_clean(run):
            return "", ""
        rows = ((run.get("result") or {}).get("products") or []) if isinstance(run.get("result"), dict) else []
        want = split_colours(set_name)[0].lower()
        for row in rows:
            if want and want in str(row.get("set_name", "")).lower():
                return parse_date(str(row.get("release_date", ""))), find_code(str(row.get("product_code", "")))
        return "", ""


# ---- sweep -------------------------------------------------------------------------------------------

# WordPress *_gmt is UTC with no suffix. asOf itself must carry Z or a numeric offset.
# The backend stores UTC as YYYY-MM-DDTHH:mm:ss.sssZ and rejects a naive string.
_WP_GMT = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?$")
_ASOF = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2}|[+-]\d{4})$")
_ASOF_FUTURE = _dt.timedelta(hours=24)


def serialize_wp_gmt(raw: str) -> str:
    """Turn a WordPress *_gmt value into an asOf. Naive in, Z appended. Not a valid asOf until then."""
    text = (raw or "").strip()
    if not text or not _WP_GMT.match(text):
        return ""
    stamped = text + "Z"
    if len(stamped) > 40 or asof_utc(stamped, check_future=False) is None:
        return ""
    return stamped


def asof_utc(value: str, now: _dt.datetime | None = None, *, check_future: bool = True) -> _dt.datetime | None:
    """Absolute instant. Naive strings are rejected, including a raw *_gmt value. A stamp more
    than 24 hours ahead of now is rejected, matching the backend."""
    text = (value or "").strip()
    if not text or len(text) > 40:
        return None
    match = _ASOF.match(text)
    if not match:
        return None
    year, month, day = int(match.group(1)), int(match.group(2)), int(match.group(3))
    hour, minute, second = int(match.group(4)), int(match.group(5)), int(match.group(6))
    if month < 1 or month > 12 or day < 1 or hour > 23 or minute > 59 or second > 59:
        return None
    frac = (match.group(7) or ".")[1:]
    micro = int((frac + "000000")[:6]) if frac else 0
    try:
        parsed = _dt.datetime(year, month, day, hour, minute, second, micro, tzinfo=_dt.timezone.utc)
    except ValueError:
        return None
    if parsed.month != month or parsed.day != day:
        return None
    zone = match.group(8)
    if zone != "Z":
        sign = -1 if zone[0] == "-" else 1
        digits = zone[1:].replace(":", "")
        off = sign * (int(digits[:2]) * 60 + int(digits[2:])) 
        parsed -= _dt.timedelta(minutes=off)
    if check_future:
        clock = now or _dt.datetime.now(_dt.timezone.utc)
        if clock.tzinfo is None:
            clock = clock.replace(tzinfo=_dt.timezone.utc)
        if parsed > clock + _ASOF_FUTURE:
            return None
    return parsed


def post_asof(post: dict, now: _dt.datetime | None = None) -> str:
    """modified_gmt, or date_gmt only when modified_gmt is absent. Site-local fields are ignored.

    The returned string has Z appended. A present but unusable modified_gmt does not fall through
    to date_gmt. A stamp more than 24 hours in the future is not returned.
    """
    if str(post.get("modified_gmt") or "").strip():
        raw = str(post.get("modified_gmt")).strip()
    elif str(post.get("date_gmt") or "").strip():
        raw = str(post.get("date_gmt")).strip()
    else:
        return ""
    stamped = serialize_wp_gmt(raw)
    if not stamped or asof_utc(stamped, now) is None:
        return ""
    return stamped


def stored_asof(product: dict | None) -> str:
    """The asOf string when it is already an absolute stamp. A naive string is not one."""
    if not product:
        return ""
    text = str(product.get("asOf") or "").strip()
    return text if asof_utc(text) is not None else ""


def keeps_current(incoming_asof: str, product: dict | None) -> bool:
    """True when this stamp must not replace the product's day.

    A newer absolute asOf wins in either calendar direction. An equal or older stamp does not.
    The first valid stamp may replace an unstamped day. A missing stamp does not replace a day,
    including when the URL is the same. URL equality is not revision evidence.
    """
    if not product or not product.get("date"):
        return False
    inc = asof_utc(incoming_asof)
    if not inc:
        return True
    cur = asof_utc(stored_asof(product))
    if not cur:
        return False
    return inc <= cur


def _should_revisit(post: dict, ptype: str, set_name: str, title: str, text: str,
                    catalog: dict | None) -> bool:
    """A seen post is worth reading again only when its current text asserts a different day
    and that assertion has a newer stamp.

    No asserted day means do not reopen it. A later edit that names no street day must not
    inherit the catalogue's cached day. With no catalogue, a seen post stays seen.
    """
    if not _catalog_products(catalog):
        return False
    date = best_date(f"{title}\n{text}", ptype)
    if not date:
        return False
    sample = products_for(ptype, set_name, "", date, "", "", None)[0]
    resolved = resolve_row(sample, catalog)
    current = _find_product(_catalog_products(catalog), resolved["id"])
    if current is None:
        return False
    return not keeps_current(post_asof(post), current)


def _product_window(text: str, set_name: str, ptype: str = "") -> str:
    """Text around this product, so a trial deck code earlier in the post is not borrowed."""
    raw = text or ""
    if ptype and set_name:
        typed = re.search(re.escape(ptype) + r".{0,120}" + re.escape(set_name), raw, re.IGNORECASE | re.DOTALL)
        if typed:
            return raw[max(0, typed.start() - 40):typed.end() + 80]
    at = raw.lower().find((set_name or "").lower())
    if at < 0:
        return raw
    return raw[max(0, at - 80):at + 180]


def sweep(posts: list[dict], seen: dict, *, force: bool, sieve: SieveReader, get=http_get,
          today: _dt.date | None = None, catalog: dict | None = None) -> tuple[dict, dict[str, bytes]]:
    """Payload {products, sets, posts, retire} and images {key: webp bytes}.

    `retire` names uncoded duplicate ids the catalogue still holds for a product this sweep
    corrected. publish() does not send it: the live releases endpoint merges by id and has no
    delete. The list is for a reviewed republish, not an automatic wipe.
    """
    payload: dict = {"products": [], "sets": {}, "posts": {}, "retire": []}
    images: dict[str, bytes] = {}
    catalog = catalog or {"products": [], "sets": {}}
    for post in posts:
        title = strip_html(str((post.get("title") or {}).get("rendered") or ""))
        link = str(post.get("link") or "")
        raw_html = str((post.get("content") or {}).get("rendered") or "")
        text = strip_html(raw_html)
        if not link.startswith("https://") or _japanese_news_post(link):
            continue
        parsed = parse_title(title)
        # A quoted title is the announcement. Anything else is opened only for the product
        # pages it links, which is how the unquoted trial deck posts are read.
        page_urls = [] if parsed else product_page_urls(raw_html, link)
        if not parsed and not page_urls:
            continue
        image_url = featured_image(post)
        stamp = announcement_stamp(image_url, title, text)
        if not force and seen.get(link) == stamp:
            continue
        if parsed and not force and link in seen and not _should_revisit(post, parsed[0], parsed[1], title, text, catalog):
            continue
        linked_checked = False
        fetch_ok = True
        logo_key = ""
        if parsed:
            ptype, set_name = parsed
            text_date = best_date(f"{title}\n{text}", ptype)
            sieve_date, sieve_code = sieve.release(link, set_name)
            after_type = text[text.lower().find(ptype.lower()):] if ptype and ptype.lower() in text.lower() else ""
            code = find_code(os.path.basename(image_url), title, after_type[:180], _product_window(text, set_name, ptype)) or sieve_code
            # The post text is the announcement. Sieve only fills a date the text does not state.
            date = text_date or sieve_date
            image_bytes = b""
            if image_url:
                try:
                    image_bytes = get(image_url, timeout=120)
                except (OSError, ValueError) as exc:
                    print(f"release-sweep: banner download failed for {link}: {exc}", file=sys.stderr)
                if image_bytes and not date:
                    read = ocr_text(image_bytes)
                    date = best_date(read, ptype) or parse_date(read)
            base = (code or slug(set_name).upper().replace("-", "_"))[:40]
            banner_key = ""
            if image_bytes:
                try:
                    import banner_logo   # numpy + Pillow: installed by the sweep workflow, not the test job
                    from PIL import Image
                    im = Image.open(io.BytesIO(image_bytes))
                    banner_key = f"REL_BANNER_{base}"
                    images[banner_key] = banner_logo.webp_bytes(banner_logo.banner_thumb(im), 82)
                    logo = banner_logo.cut_logo(im)
                    if logo is not None:
                        logo_key = f"REL_LOGO_{base}"
                        images[logo_key] = banner_logo.webp_bytes(logo, 90)
                except Exception as exc:   # an unreadable banner still leaves the product and its date
                    print(f"release-sweep: banner processing failed for {link}: {exc}", file=sys.stderr)
            items = [{"ptype": ptype, "set_name": set_name, "date": date, "code": code, "banner": banner_key, "linked": False}]
            items.extend({**extra, "banner": "", "linked": False} for extra in _body_extras(text, (ptype, set_name)))
        else:
            linked_checked = True
            text_date = sieve_date = ""
            code = date = ""
            items = []
            for url in page_urls:
                page = _read_page(get, url)
                if not page:
                    fetch_ok = False
                    print(f"release-sweep: product page unreadable for {link}: {url}", file=sys.stderr)
                    continue
                info = parse_product_page(page, url)
                if not info:
                    continue
                items.append({**info, "banner": "", "linked": True})
            if items:
                code, date = items[0]["code"], items[0]["date"]
        emitted = 0
        for item in items:
            # Stamp only a day this fetch actually asserts. A newer edit with no street day
            # must not lend its clock to a cached date.
            revision = post_asof(post) if item.get("date") else ""
            rows = products_for(item["ptype"], item["set_name"], item["code"], item["date"], link,
                                item["banner"], today)
            for row in rows:
                resolved = resolve_row(row, catalog)
                if item.get("linked") and not _linked_row_eligible(resolved, catalog, today):
                    continue
                if revision:
                    resolved["asOf"] = revision
                else:
                    resolved.pop("asOf", None)
                if not _merge_row(payload, resolved, catalog):
                    continue
                emitted += 1
                base_set = resolved["set"]
                entry = payload["sets"].setdefault(base_set, {"logo": "", "release": ""})
                if logo_key and item.get("banner"):
                    entry["logo"] = logo_key
                elif not entry["logo"]:
                    stored = (catalog.get("sets") or {}).get(base_set) or {}
                    entry["logo"] = stored.get("logo") or ""
        # A linked page that failed to download is not remembered, so the next run tries it.
        # A post whose sealed products are already on file is remembered, so it is not opened again.
        remember = fetch_ok and (emitted or text_date or sieve_date or (text and not image_url) or linked_checked)
        if remember:
            payload["posts"][link] = stamp
        if not emitted:
            continue
        print(f"release-sweep: {title!r} -> {emitted} product row(s), code={code or '?'}, date={date or '?'}, "
              f"logo={'yes' if logo_key else 'no'}")
    for name in list(payload["sets"]):
        release = backed_set_release(name, catalog, payload["products"])
        if release:
            payload["sets"][name]["release"] = release
    payload["retire"] = alias_ids(catalog, payload["products"])
    if payload["retire"]:
        print("release-sweep: duplicate ids to retire after review (not sent by publish): "
              + ", ".join(payload["retire"]))
    return payload, images


def _sort_key(date: str) -> tuple:
    m = DATE_RE.search(date or "")
    if not m:
        return (9999, 0, 0)
    formatted = _format_match(m)
    if not formatted:
        return (9999, 0, 0)
    return (int(m.group(3)), MONTHS[m.group(1)[:3].lower()], int(m.group(2)))


def kind_of(name: str) -> str:
    n = (name or "").lower()
    if "box" in n:
        return "box"
    if "pack" in n:
        return "pack"
    if "deck" in n:
        return "deck"
    return "other"


def code_in_id(pid: str) -> str:
    m = re.search(r"(?:^|-)((?:bp|td|ss|pr)\d{2})$", pid or "", re.IGNORECASE)
    return m.group(1).upper() if m else ""


def announcement_stamp(image_url: str, title: str, text: str) -> str:
    raw = "\n".join((image_url or "", title or "", text or ""))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]


def _catalog_products(catalog: dict | None) -> list[dict]:
    if not isinstance(catalog, dict):
        return []
    products = catalog.get("products")
    return [p for p in products if isinstance(p, dict) and p.get("id")] if isinstance(products, list) else []


def _find_product(products: list[dict], pid: str) -> dict | None:
    for row in products:
        if row.get("id") == pid:
            return row
    return None


def _prefer_known_id(row: dict, code: str, kind: str, matches: list[dict]) -> dict:
    """One catalogue row for this code and kind, or the id the app already publishes."""
    canonical = CANONICAL_PRODUCT_IDS.get((code, kind))
    chosen = matches
    if canonical and len(matches) != 1:
        preferred = [p for p in matches if p.get("id") == canonical]
        if len(preferred) == 1:
            chosen = preferred
    if len(chosen) == 1:
        kept = chosen[0]
        return {**row, "id": kept["id"], "code": kept.get("code") or row.get("code") or ""}
    if canonical:
        return {**row, "id": canonical}
    return row


def resolve_row(row: dict, catalog: dict | None) -> dict:
    """Reuse the canonical id when this set and kind is already published under a product code.

    A delay notice often names the booster and not the code. Emitting box-eternal-ascent beside
    box-bp03 is how the duplicate tiles were created. Packs follow the coded box (pack-bp03).
    A coded trial deck follows the same rule: TD03 is td-ea-rg, not a second id td-td03.
    """
    products = _catalog_products(catalog)
    code = (row.get("code") or "").upper()
    kind = kind_of(row.get("name") or "")
    if code:
        same = [p for p in products if kind_of(p.get("name") or "") == kind
                and ((p.get("code") or "").upper() == code or code_in_id(p.get("id") or "") == code)]
        return _prefer_known_id(row, code, kind, same)
    set_name = row.get("set") or ""
    coded = [p for p in products if p.get("set") == set_name and kind_of(p.get("name") or "") == kind
             and ((p.get("code") or "").upper() or code_in_id(p.get("id") or ""))]
    if len(coded) == 1:
        kept = coded[0]
        return {**row, "id": kept["id"], "code": kept.get("code") or ""}
    if kind == "pack":
        boxes = [p for p in products if p.get("set") == set_name and kind_of(p.get("name") or "") == "box"
                 and ((p.get("code") or "").upper() or code_in_id(p.get("id") or ""))]
        if len(boxes) == 1:
            key = ((boxes[0].get("code") or "") or code_in_id(boxes[0].get("id") or "")).lower()
            match = _find_product(products, f"pack-{key}") if key else None
            if match:
                return {**row, "id": match["id"], "code": match.get("code") or ""}
    return row


def _is_alias(row: dict, products: list[dict]) -> bool:
    """An uncoded row that duplicates a coded product of the same set and kind."""
    if (row.get("code") or "").strip() or code_in_id(row.get("id") or ""):
        return False
    kind = kind_of(row.get("name") or "")
    return any(p.get("id") != row.get("id") and p.get("set") == row.get("set")
               and kind_of(p.get("name") or "") == kind
               and ((p.get("code") or "").upper() or code_in_id(p.get("id") or ""))
               for p in products)


def alias_ids(catalog: dict | None, kept: list[dict]) -> list[str]:
    """Uncoded duplicates of a product this sweep actually published.

    A trial deck must not list box-eternal-ascent for retirement. Those booster rows are a
    separate duplicate, and this sweep does not rewrite them.
    """
    products = _catalog_products(catalog)
    kept_ids = {r.get("id") for r in kept}
    emitted = {(r.get("set"), kind_of(r.get("name") or "")) for r in kept}
    retired = []
    for row in products:
        if (row.get("set"), kind_of(row.get("name") or "")) not in emitted or row.get("id") in kept_ids:
            continue
        if _is_alias(row, products):
            retired.append(row["id"])
    return sorted(retired)


def backed_set_release(set_name: str, catalog: dict | None, emitted: list[dict]) -> str:
    """Earliest concrete street date among this set's real products.

    Trial decks and boosters keep their own dates. The set date is the first of those, so a
    booster postponement does not become the set date while an earlier trial deck is on file,
    and a stale duplicate row does not pull the set date backwards.
    """
    products = [p for p in _catalog_products(catalog) if p.get("set") == set_name and not _is_alias(p, _catalog_products(catalog))]
    by_id = {p["id"]: dict(p) for p in products}
    for row in emitted:
        if row.get("set") == set_name and row.get("id"):
            by_id[row["id"]] = row
    dates = [row.get("date") or "" for row in by_id.values() if row.get("date") and _sort_key(row.get("date") or "") != (9999, 0, 0)]
    return min(dates, key=_sort_key) if dates else ""


def _apply_stamp(existing: dict, row: dict) -> bool:
    """Copy an asserted day when its stamp is newer. An empty date changes nothing."""
    incoming = stored_asof(row)
    if not row.get("date") or keeps_current(incoming, existing):
        return False
    changed = False
    if existing.get("date") != row["date"]:
        existing["date"] = row["date"]
        existing["pre"] = row.get("pre", existing.get("pre"))
        changed = True
    if row.get("link") and existing.get("link") != row.get("link"):
        existing["link"] = row["link"]
        changed = True
    if incoming and existing.get("asOf") != incoming:
        existing["asOf"] = incoming
        changed = True
    if row.get("code") and not existing.get("code"):
        existing["code"] = row["code"]
        changed = True
    if row.get("banner") and not existing.get("banner"):
        existing["banner"] = row["banner"]
        changed = True
    return changed


def _merge_row(payload: dict, row: dict, catalog: dict | None = None) -> bool:
    """One id per product. A newer UTC stamp replaces the day. An empty date does not."""
    incoming = stored_asof(row)
    if incoming:
        row["asOf"] = incoming
    else:
        row.pop("asOf", None)
    for existing in payload["products"]:
        if existing.get("id") != row.get("id"):
            continue
        if row.get("date") and existing.get("date") == row.get("date"):
            return False
        return _apply_stamp(existing, row)
    current = _find_product(_catalog_products(catalog), row.get("id") or "")
    # The same street day is already published. Do not rewrite the link, the banner or asOf.
    if current and row.get("date") and current.get("date") == row.get("date"):
        return False
    if not row.get("date"):
        if current and current.get("date"):
            return False
        payload["products"].append(row)
        return True
    if current and _apply_stamp(dict(current), row) is False and keeps_current(incoming, current):
        return False
    if current and current.get("date") == row.get("date") and stored_asof(current) == incoming and (current.get("link") or "") == (row.get("link") or ""):
        return False
    payload["products"].append(row)
    return True


def _body_extras(text: str, title_item: tuple[str, str] | None) -> list[dict]:
    """Other quoted products in the same post, each with its own nearby date and code.

    Used for a mixed trial deck and booster announcement. A mention without its own code is
    left out: a codeless extra becomes a second id for a product the app already tracks.
    """
    extras = []
    seen = set()
    if title_item:
        seen.add((title_item[0].lower(), title_item[1].lower()))
    for match in TITLE_RE.finditer(text or ""):
        ptype = _english_type(match.group(1))
        set_name = _english_set(match.group(2))
        key = (ptype.lower(), set_name.lower())
        if key in seen:
            continue
        window = (text or "")[max(0, match.start() - 80):match.end() + 180]
        code = find_code(window)
        date = best_date(window, ptype)
        if not code or not date:
            continue
        seen.add(key)
        extras.append({"ptype": ptype, "set_name": set_name, "date": date, "code": code})
    return extras


def backend_call(method: str, path: str, key: str, body: dict | None = None, base: str = BACKEND) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers={
        "User-Agent": UA, "X-Admin-Key": key, "Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


# The backend draft accepts these keys plus asOf. srcAt and retire are app/review fields and
# are not sent. asOf is included only when it is a valid UTC instant and the row asserts a day.
_POST_PRODUCT_KEYS = ("id", "set", "name", "sub", "code", "date", "pre", "banner", "box", "q", "link")


def _posted_product(row: dict) -> dict:
    posted = {key: row.get(key, "" if key != "pre" else False) for key in _POST_PRODUCT_KEYS}
    stamp = stored_asof(row)
    if stamp and posted.get("date"):
        posted["asOf"] = stamp
    return posted


def publish(payload: dict, images: dict[str, bytes], key: str, base: str = BACKEND, call=backend_call) -> dict:
    body = {"products": [_posted_product(row) for row in (payload.get("products") or [])],
            "sets": payload.get("sets") or {}, "posts": payload.get("posts") or {}, "img": {}}
    for img_key, data in images.items():
        res = call("PUT", f"/api/admin/release-img/{img_key}", key,
                   {"type": "image/webp", "data": base64.b64encode(data).decode("ascii")}, base)
        body["img"][img_key] = res["path"]
    return call("POST", "/api/admin/releases", key, body, base)


def fetch_catalog(get=http_get, base: str = BACKEND) -> dict:
    """Public release list. No admin key. Empty when the feed cannot be read."""
    try:
        data = json.loads(get(base.rstrip("/") + "/api/releases"))
    except (OSError, ValueError, TypeError):
        return {"products": [], "sets": {}}
    if not isinstance(data, dict):
        return {"products": [], "sets": {}}
    products = data.get("products") if isinstance(data.get("products"), list) else []
    sets = data.get("sets") if isinstance(data.get("sets"), dict) else {}
    return {"products": [p for p in products if isinstance(p, dict)], "sets": sets}


def write_github_output(path: Path | None, status: str, products: int) -> None:
    if path:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"status={status}\nproducts={products}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--backend", default=os.environ.get("BACKEND_URL", BACKEND))
    parser.add_argument("--dry-run", action="store_true", help="write stage/releases/ instead of publishing")
    parser.add_argument("--out", type=Path, default=Path("stage/releases"))
    parser.add_argument("--force", action="store_true", help="reprocess posts the backend has already seen")
    parser.add_argument("--sieve", action="store_true", help="read dates with Sieve before OCR (spends Sieve credits)")
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args(argv)

    key = os.environ.get("BACKEND_ADMIN_KEY", "").strip()
    if not key and not args.dry_run:
        print("release-sweep: BACKEND_ADMIN_KEY is not set - skipping (not an error)")
        write_github_output(args.github_output, "skipped", 0)
        return 0
    try:
        seen = backend_call("GET", "/api/admin/releases", key, base=args.backend).get("posts", {}) if key else {}
        posts = fetch_posts()
        catalog = fetch_catalog(base=args.backend)
    except (OSError, ValueError) as exc:
        print(f"release-sweep: fetch failed: {exc}", file=sys.stderr)
        write_github_output(args.github_output, "failed", 0)
        return 1
    payload, images = sweep(posts, seen, force=args.force, sieve=SieveReader(args.sieve), catalog=catalog)
    count = len(payload["products"])
    if not count:
        print("release-sweep: no new product announcements")
        write_github_output(args.github_output, "ok", 0)
        return 0
    if args.dry_run:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / "payload.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        for img_key, data in images.items():
            (args.out / f"{img_key}.webp").write_bytes(data)
        print(f"release-sweep: dry run, {count} product(s) and {len(images)} image(s) -> {args.out}")
        write_github_output(args.github_output, "ok", count)
        return 0
    try:
        res = publish(payload, images, key, args.backend)
    except (OSError, ValueError, KeyError) as exc:
        detail = exc.read().decode("utf-8", "replace")[:300] if isinstance(exc, urllib.error.HTTPError) else str(exc)
        print(f"release-sweep: publish failed: {detail}", file=sys.stderr)
        write_github_output(args.github_output, "failed", 0)
        return 1
    print(f"release-sweep: published {count} product(s), {len(images)} image(s); backend now holds "
          f"{res.get('products')} product(s) across {res.get('sets')} set(s)")
    write_github_output(args.github_output, "ok", count)
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
