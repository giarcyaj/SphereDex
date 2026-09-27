"""Turn official product announcements into app release data (logos, banners, dates, products).

Part of the news sweep (.github/workflows/sieve-refresh.yml). For each recent post on the official
site whose title announces a product (e.g. 'Booster Pack "Eternal Ascent" Preorders Now Available!'):

  1. product type and set name come from the title, the product code from the banner's file name
     (BP03-ordersheet-banner-template.png -> BP03) or the post text;
  2. the release date comes from Tesseract OCR of the banner, then the post text - announcement
     dates are often printed only in the banner (--sieve adds a paid Sieve read of the page first);
  3. the banner becomes a timeline thumbnail and, when it is the plain announcement template, the
     set logo is cut out of it (tools/banner_logo.py);
  4. everything is published to the backend (/api/admin/release-img + /api/admin/releases), which
     every app merges into its release timeline, Browse tiles and Sealed list at launch.

Posts already processed with the same banner are skipped (the backend remembers them), so each
announcement is processed once. Without BACKEND_ADMIN_KEY the tool skips cleanly.

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
TYPES = r"Booster\s+Pack|Booster\s+Box|Trial\s+Deck|Starter\s+Deck|Sleeve\s*(?:&|and)\s*Card\s+Set|Card\s+Set|Premium\s+\w+(?:\s+\w+)?|Special\s+\w+(?:\s+\w+)?"
TITLE_RE = re.compile(r"(" + TYPES + r")\s*[\"“”]([^\"“”]{2,60})[\"“”]", re.IGNORECASE)
CODE_RE = re.compile(r"(?<![A-Z0-9])E?((?:BP|TD|SS|PR)\d{2})(?!\d)", re.IGNORECASE)
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


def parse_title(title: str) -> tuple[str, str] | None:
    """('Booster Pack', 'Eternal Ascent') from an announcement title, or None."""
    m = TITLE_RE.search(_html.unescape(title or ""))
    if not m:
        return None
    ptype = " ".join(w.capitalize() if w.islower() else w for w in m.group(1).split())
    return ptype, " ".join(m.group(2).split())


def find_code(*texts: str) -> str:
    for text in texts:
        m = CODE_RE.search(text or "")
        if m:
            return m.group(1).upper()
    return ""


def parse_date(text: str) -> str:
    """The release date in the feed's 'Jan 29, 2027' style: the first date after a release signal
    (on sale, release, available, ...), else the first date at all; '' when there is none."""
    found = []
    for m in DATE_RE.finditer(text or ""):
        month = MONTHS.get(m.group(1)[:3].lower())
        day, year = int(m.group(2)), int(m.group(3))
        try:
            _dt.date(year, month, day)
        except (TypeError, ValueError):
            continue
        signalled = bool(SIGNAL_RE.search((text or "")[max(0, m.start() - 40):m.start()]))
        found.append((not signalled, m.start(), f"{SHORT[month]} {day}, {year}"))
    return min(found)[2] if found else ""


def is_past(date: str, today: _dt.date | None = None) -> bool:
    m = DATE_RE.search(date or "")
    if not m:
        return False
    return _dt.date(int(m.group(3)), MONTHS[m.group(1)[:3].lower()], int(m.group(2))) <= (today or _dt.date.today())


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:40]


def split_colours(set_name: str) -> tuple[str, list[str]]:
    """'Eternal Ascent Red·Green' -> ('Eternal Ascent', ['Red', 'Green'])."""
    words = re.split(r"[\s·/,&\-]+", set_name)
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

def sweep(posts: list[dict], seen: dict, *, force: bool, sieve: SieveReader, get=http_get,
          today: _dt.date | None = None) -> tuple[dict, dict[str, bytes]]:
    """Payload {products, sets, posts} and images {key: webp bytes} for new announcement posts."""
    payload: dict = {"products": [], "sets": {}, "posts": {}}
    images: dict[str, bytes] = {}
    for post in posts:
        title = strip_html(str((post.get("title") or {}).get("rendered") or ""))
        link = str(post.get("link") or "")
        parsed = parse_title(title)
        if not parsed or not link.startswith("https://"):
            continue
        ptype, set_name = parsed
        image_url = featured_image(post)
        if not force and seen.get(link) == image_url:
            continue
        text = strip_html(str((post.get("content") or {}).get("rendered") or ""))
        code = find_code(os.path.basename(image_url), title, text)
        date, sieve_code = sieve.release(link, set_name)
        code = code or sieve_code
        image_bytes = b""
        if image_url:
            try:
                image_bytes = get(image_url, timeout=120)
            except (OSError, ValueError) as exc:
                print(f"release-sweep: banner download failed for {link}: {exc}", file=sys.stderr)
        if not date and image_bytes:
            date = parse_date(ocr_text(image_bytes))
        date = date or parse_date(f"{title} {text}")
        base = (code or slug(set_name).upper().replace("-", "_"))[:40]
        banner_key = logo_key = ""
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
        rows = products_for(ptype, set_name, code, date, link, banner_key, today)
        payload["products"].extend(rows)
        base_set = rows[0]["set"]
        entry = payload["sets"].setdefault(base_set, {"logo": "", "release": ""})
        if logo_key:
            entry["logo"] = logo_key
        if date and (not entry["release"] or _sort_key(date) < _sort_key(entry["release"])):
            entry["release"] = date
        payload["posts"][link] = image_url
        print(f"release-sweep: {title!r} -> {len(rows)} product(s), code={code or '?'}, date={date or '?'}, "
              f"logo={'yes' if logo_key else 'no'}")
    return payload, images


def _sort_key(date: str) -> tuple:
    m = DATE_RE.search(date)
    return (int(m.group(3)), MONTHS[m.group(1)[:3].lower()], int(m.group(2))) if m else (9999, 0, 0)


def backend_call(method: str, path: str, key: str, body: dict | None = None, base: str = BACKEND) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers={
        "User-Agent": UA, "X-Admin-Key": key, "Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def publish(payload: dict, images: dict[str, bytes], key: str, base: str = BACKEND, call=backend_call) -> dict:
    payload = {**payload, "img": {}}
    for img_key, data in images.items():
        res = call("PUT", f"/api/admin/release-img/{img_key}", key,
                   {"type": "image/webp", "data": base64.b64encode(data).decode("ascii")}, base)
        payload["img"][img_key] = res["path"]
    return call("POST", "/api/admin/releases", key, payload, base)


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
    except (OSError, ValueError) as exc:
        print(f"release-sweep: fetch failed: {exc}", file=sys.stderr)
        write_github_output(args.github_output, "failed", 0)
        return 1
    payload, images = sweep(posts, seen, force=args.force, sieve=SieveReader(args.sieve))
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
