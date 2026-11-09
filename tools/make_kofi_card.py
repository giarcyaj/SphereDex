"""Render the Ko-fi featured image for a SphereDex release.

Run from the repo root:

    python tools/make_kofi_card.py                      # the release the headliner can describe
    python tools/make_kofi_card.py --version 2.4.6
    python tools/make_kofi_card.py --bullet "..." --bullet "..."

Writes tmp/koupdate-<version>.png at 2400x1260, the size Ko-fi's Blog "Featured image" field takes.

The bullets come from RELEASE_HIGHLIGHTS in src/paldeck.html, the same three lines the app's own Home
headliner shows, so the card cannot drift from what the release actually says. A store train bump
with no lines of its own keeps the newest earlier release, which is what the headliner does. Pass
--bullet to override them (a post that covers two releases wants its own wider list); every bullet
still goes through the no dashes check either way.

Rendering is headless Chrome against tools/kofi_card.html, not Pillow, because the card is a CSS
layout with blurs, a grid and real Chakra Petch. Three gotchas, all learned the hard way and all
still load bearing:
  - Pass a separate --user-data-dir or an already running Chrome swallows the launch, writes no file
    and reports no error.
  - Never redirect Chrome's stderr (no 2>$null, no 2>&1): it turns a clean exit into a failure here.
  - Quote --window-size when a shell is involved, or the comma splits the argument.
"""

import argparse
import io
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.abspath(os.path.join(__file__, "..")))
APP = os.path.join(ROOT, "src", "paldeck.html")
TEMPLATE = os.path.join(ROOT, "tools", "kofi_card.html")
OUT_DIR = os.path.join(ROOT, "tmp")

W, H = 1200, 630
SCALE = 2
# The canvas minus .pad's 70px sides, minus the dot and its 19px gap.
BULLET_ROOM = W - 140 - 32
# Chakra Petch 500 averages a little over half its size per character across this copy.
CHAR_RATIO = 0.52
BULLET_PX_MAX, BULLET_PX_MIN = 26, 17

# One per bullet, in order, cycling if a post carries more than five.
DOTS = [
    ("--cyan", "18,227,245"),
    ("--green", "55,200,106"),
    ("--gold", "255,176,32"),
    ("--purple", "183,123,224"),
    ("--red", "255,123,114"),
]

CHROME_CANDIDATES = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

DASHES = "-\u2010\u2011\u2012\u2013\u2014\u2015\u2212"


def find_chrome():
    env = os.environ.get("CHROME")
    if env and os.path.exists(env):
        return env
    for p in CHROME_CANDIDATES:
        if os.path.exists(p):
            return p
    raise SystemExit("no Chrome found: set CHROME to its path")


def app_version(src):
    m = re.search(r'var APP_VERSION\s*=\s*"([^"]+)"', src)
    if not m:
        raise SystemExit("APP_VERSION not found in src/paldeck.html")
    return m.group(1)


def highlight_map(src):
    """RELEASE_HIGHLIGHTS object from the app source, decoded from its JS escapes."""
    m = re.search(r"var RELEASE_HIGHLIGHTS\s*=\s*\{", src)
    if not m:
        raise SystemExit("RELEASE_HIGHLIGHTS not found in src/paldeck.html")
    start = m.end() - 1
    depth, i = 0, start
    while i < len(src):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                break
        i += 1
    return json.loads(src[start:i + 1])


def ver_num(v):
    """Same ordering as verNum in src/paldeck.html."""
    p = str(v or "").split(".")

    def part(i):
        if i >= len(p) or not p[i].isdigit():
            return 0
        return int(p[i])

    return part(0) * 10000 + part(1) * 100 + part(2)


def described_version(src):
    """The release the headliner can describe.

    A feature release has its own lines. A store train bump can ship with nothing new
    to announce, and the headliner keeps the newest earlier release.
    """
    version = app_version(src)
    body = highlight_map(src)

    def filled(v):
        return any(str(x).strip() for x in body.get(v, []))

    if filled(version):
        return version
    earlier = [v for v in body if ver_num(v) < ver_num(version) and filled(v)]
    if not earlier:
        raise SystemExit("no release highlights at or before %s" % version)
    return max(earlier, key=ver_num)


def highlights(src, version):
    """RELEASE_HIGHLIGHTS[version] as written in the app, decoded from its JS escapes."""
    body = highlight_map(src)
    if version not in body:
        raise SystemExit(
            "no RELEASE_HIGHLIGHTS for %s (have %s): add them, or pass --bullet"
            % (version, ", ".join(sorted(body)[-4:]))
        )
    return [str(x).strip() for x in body[version] if str(x).strip()]


def bullet_px(bullets):
    longest = max(len(b) for b in bullets)
    fits = int(BULLET_ROOM / (CHAR_RATIO * longest))
    return max(BULLET_PX_MIN, min(BULLET_PX_MAX, fits))


def rows_html(bullets):
    out = []
    for n, text in enumerate(bullets):
        var, rgb = DOTS[n % len(DOTS)]
        out.append(
            '      <div class="row"><i class="dot" style="background:var(%s);'
            'box-shadow:0 0 14px rgba(%s,.6)"></i><span>%s</span></div>'
            % (var, rgb, text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
        )
    return "\n".join(out)


def visible_text(html):
    """What a reader actually sees: no styles, no comments, no base64, no tags."""
    s = re.sub(r"<style[\s\S]*?</style>", " ", html)
    s = re.sub(r"<!--[\s\S]*?-->", " ", s)
    s = re.sub(r"base64,[^\"']+", " ", s)
    return re.sub(r"<[^>]+>", " ", s)


def main():
    ap = argparse.ArgumentParser(description="Render the Ko-fi card for a release")
    ap.add_argument("--version", help="release version; defaults to the release the headliner can describe")
    ap.add_argument("--bullet", action="append", default=[],
                    help="override the bullets; repeat for each line")
    ap.add_argument("--out", help="output png path; defaults to tmp/koupdate-<version>.png")
    args = ap.parse_args()

    src = io.open(APP, encoding="utf-8").read()
    version = args.version or described_version(src)
    bullets = args.bullet or highlights(src, version)
    if not bullets:
        raise SystemExit("no bullets to draw")

    html = io.open(TEMPLATE, encoding="utf-8").read()
    html = (html.replace("__BULLET_PX__", str(bullet_px(bullets)))
                .replace("__ROWS__", rows_html(bullets))
                .replace("__VERSION__", version))

    # The card is public copy, so it answers to the same rule as every other user facing string.
    seen = visible_text(html)
    for bad in DASHES:
        if bad in seen:
            raise SystemExit("a dash reached the card copy: %r" % bad)
    if version not in seen:
        raise SystemExit("the version is not on the card")

    os.makedirs(OUT_DIR, exist_ok=True)
    filled = os.path.join(OUT_DIR, "kofi-%s.html" % version)
    io.open(filled, "w", encoding="utf-8", newline="\n").write(html)
    png = args.out or os.path.join(OUT_DIR, "koupdate-%s.png" % version)
    if os.path.exists(png):
        os.remove(png)

    profile = tempfile.mkdtemp(prefix="kofi-card-")
    subprocess.check_call([
        find_chrome(), "--headless=new", "--disable-gpu", "--no-first-run", "--no-sandbox",
        "--user-data-dir=" + profile, "--allow-file-access-from-files", "--hide-scrollbars",
        "--force-device-scale-factor=%d" % SCALE, "--window-size=%d,%d" % (W, H),
        "--virtual-time-budget=4000",
        "--screenshot=" + png.replace("\\", "/"),
        "file:///" + filled.replace("\\", "/"),
    ])
    if not os.path.exists(png):
        raise SystemExit("Chrome wrote no file: check that --user-data-dir is separate and that "
                         "nothing is redirecting its stderr")

    size = ""
    try:
        from PIL import Image
        with Image.open(png) as im:
            size = " %dx%d" % im.size
            if im.size != (W * SCALE, H * SCALE):
                raise SystemExit("card is %dx%d, expected %dx%d"
                                 % (im.size[0], im.size[1], W * SCALE, H * SCALE))
    except ImportError:
        pass
    print("%s: %d bytes%s" % (png, os.path.getsize(png), size))
    print("bullets: %d at %dpx" % (len(bullets), bullet_px(bullets)))


if __name__ == "__main__":
    sys.exit(main())
