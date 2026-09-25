#!/usr/bin/env python3
"""Rebuild the WEB, Android and iOS bundles from the canonical src/paldeck.html.

The canonical (src/paldeck.html) carries two markers, /*FONT_INJECT*/ and <!--CARD_IMG_INJECT-->,
where the big inlined FONT block and the window.CARD_IMG={...} block live in the BUILT docs. This
script lifts those two injected blocks out of the current built docs and re-inserts them into the
new canonical, so editing app code never disturbs the fonts or the card art map.

Built pages carry boundary comments so subsequent rebuilds can preserve their current injected
blocks and platform wrappers even after multiple uncommitted source edits. Older, unmarked pages
are matched against the current or last committed canonical. If neither matches, --baseline must
point to the exact canonical used for their previous build. All pages are checked before writing.

Artwork: every platform loads card and Pal art from img/ files, never inline base64 (an 18MB inline
Android html tripped Play's "Memory usage: bad behavior" vital). docs/app/img + the WEB CARD_IMG block
and the page's PAL_ART map are the single source of truth, and the script now refuses to produce a
bundle whose artwork it cannot resolve: it checks every declared entry against the web folder BEFORE
writing, and against all three img/ folders after mirroring. A missing file never throws at runtime -
the tile just falls back to a card image or a gradient - so without this the loss is silent.
After rebuilding, this script
  1. forces the Android CARD_IMG block to equal the WEB one (so relative "img/X.jpg" paths resolve to
     file:///android_asset/img/ on Android and spheredex://app/img/ on iOS),
  2. mirrors docs/app/img into app/src/main/assets/img and ios/SphereDex/SphereDex/Resources/img
     (adds, updates and deletes, so all three folders are byte identical),
  3. copies the Android html over ios/SphereDex/SphereDex/Resources/spheredex.html (the old manual cp).
New card art therefore only needs the web img file plus its entry in the WEB CARD_IMG block.

Usage:
  python tools/rebuild.py                    # build from src/paldeck.html
  python tools/rebuild.py --src /tmp/p.html  # build from another canonical (testing); relative to cwd
  python tools/rebuild.py --baseline /tmp/previous.html  # migrate an older unmarked local build
"""
import argparse, filecmp, hashlib, json, os, re, shutil, subprocess

FM = "/*FONT_INJECT*/"
CM = "<!--CARD_IMG_INJECT-->"
BUILD_MARKERS = (
    "<!--SPHEREDEX_CANONICAL_START-->",
    "/*SPHEREDEX_FONT_START*/", "/*SPHEREDEX_FONT_END*/",
    "<!--SPHEREDEX_CARD_IMG_START-->", "<!--SPHEREDEX_CARD_IMG_END-->",
    "<!--SPHEREDEX_CANONICAL_END-->",
)
# The web wrapper used to carry the service worker registration, which meant it existed only in the BUILT
# page: losing it would have cost every web user offline support, with nothing in the canonical to show it
# had ever been there. The registration lives in src/paldeck.html now (inert under file: and spheredex:),
# so any copy still sitting in a derived wrapper is dropped here and every built page ends up with exactly
# one. Stripped for every platform, not just WEB: the wrapper is derived from the LAST COMMITTED canonical,
# so until this change is committed the old registration is still in the tail the apps inherit too.
SW_REG_RE = re.compile(r"\s*<script>(?:(?!</script>).)*?serviceWorker\.register(?:(?!</script>).)*?</script>\s*", re.S)
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))  # the android/ repo root

WEB_HTML = "docs/app/index.html"
ANDROID_HTML = "app/src/main/assets/spheredex.html"
IOS_HTML = "ios/SphereDex/SphereDex/Resources/spheredex.html"
WEB_IMG = "docs/app/img"
APP_IMG = [("ANDROID", "app/src/main/assets/img"), ("IOS", "ios/SphereDex/SphereDex/Resources/img")]

def read(p):
    with open(p, "r", encoding="utf-8") as f:
        return f.read()

def write(p, s):
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(s)

def split_canonical(P):
    if P.count(FM) != 1 or P.count(CM) != 1:
        raise ValueError("canonical must contain exactly one FONT and CARD_IMG injection marker")
    if any(marker in P for marker in BUILD_MARKERS):
        raise ValueError("canonical contains generated build markers; use the source HTML instead")
    iF = P.index(FM); iC = P.index(CM)
    if iF >= iC:
        raise ValueError("expected FONT marker before CARD_IMG marker")
    return P[:iF], P[iF + len(FM):iC], P[iC + len(CM):]

def derive_wrapper(P, D):
    A, B, C = split_canonical(P)
    posA = D.index(A); PREFIX = D[:posA]; afterA = posA + len(A)
    posB = D.index(B, afterA); FONT = D[afterA:posB]; afterB = posB + len(B)
    posC = D.index(C, afterB); CARDIMG = D[afterB:posC]; SUFFIX = D[posC + len(C):]
    assert PREFIX + A + FONT + B + CARDIMG + C + SUFFIX == D, "round-trip mismatch deriving wrapper"
    return PREFIX, FONT, CARDIMG, SUFFIX

def build(Pnew, PREFIX, FONT, CARDIMG, SUFFIX):
    A, B, C = split_canonical(Pnew)
    start, font_start, font_end, card_start, card_end, end = BUILD_MARKERS
    return (PREFIX + start + A + font_start + FONT + font_end + B +
            card_start + CARDIMG + card_end + C + end + SUFFIX)

def extract_wrapper(D, baselines):
    """Preserve existing assets/wrappers; fail closed on incomplete generated boundaries."""
    counts = [D.count(marker) for marker in BUILD_MARKERS]
    if any(counts):
        if counts != [1] * len(BUILD_MARKERS):
            raise ValueError("missing or duplicate generated build boundary")
        positions = [D.index(marker) for marker in BUILD_MARKERS]
        if positions != sorted(positions):
            raise ValueError("generated build boundaries are out of order")
        return (D[:positions[0]],
                D[positions[1] + len(BUILD_MARKERS[1]):positions[2]],
                D[positions[3] + len(BUILD_MARKERS[3]):positions[4]],
                D[positions[5] + len(BUILD_MARKERS[5]):])
    for baseline in baselines:
        try:
            return derive_wrapper(baseline, D)
        except ValueError:
            pass
    raise ValueError("unmarked bundle does not match its canonical; use --baseline PATH with "
                     "the source used for the previous build (existing files were not changed)")

# ---- Artwork preflight ------------------------------------------------------------------------------
# A missing art file is never a crash: the palette card falls back to a set image, a Pal tile falls back
# to one of its cards, and a hero image falls back to a gradient. That is the point of the fallbacks, and
# it is also why a gap can ship unnoticed for weeks. So every declared reference is resolved against the
# folders on disk, once before anything is written and once after the mirrors run.
ART_FOLDERS = [("web", WEB_IMG)] + [(name.lower(), rel) for name, rel in APP_IMG]
CARD_IMG_AT = re.compile(r"window\.CARD_IMG\s*=")
PAL_ART_AT = re.compile(r"var\s+PAL_ART\s*=\s*\{.*?\};", re.S)
PALDEX_PAGE = 'id="page-paldex"'
INLINE = "data:"


class ArtError(Exception):
    """A card or Pal artwork reference the build cannot resolve to a file on disk."""


def parse_js_map(text):
    """The { ... } object in text as a dict, or None when it cannot be read at all."""
    if not text:
        return None
    a = text.find("{"); b = text.rfind("}")
    if a < 0 or b <= a:
        return None
    body = text[a:b + 1]
    try:
        return json.loads(body)
    except ValueError:
        # A hand-edited block with a trailing comma still gets checked rather than skipped: dropping the
        # check is how a missing file reaches a release.
        pairs = re.findall(r'"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"', body)
        return dict(pairs) if pairs else None


def card_img_block(page):
    """The generated CARD_IMG map from a built page (it sits on its own line), or None."""
    m = CARD_IMG_AT.search(page)
    if not m:
        return None
    end = page.find("\n", m.end())
    return page[m.end():end if end > 0 else len(page)]


def art_file(value):
    """The img/ file a reference must resolve to, or None when it is not an img/ path."""
    if not isinstance(value, str):
        return None
    v = value.strip()
    if not v or v.startswith(INLINE):
        return None                                  # inline art: nothing to look up
    if v.startswith("img/"):
        return v[len("img/"):]
    return v if re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*$", v) else None   # a bare file name


def art_refs(page, note=None):
    """[(label, key, value)] for every artwork reference a built page declares.

    Fails when the page has a PalDex screen but no readable PAL_ART map: that combination ships a screen
    where every Palette tile falls back to a card image, which is the silent degradation this guards."""
    note = note or (lambda msg: None)
    refs = []
    block = card_img_block(page)
    cards = parse_js_map(block) if block is not None else None
    if block is None:
        note("no window.CARD_IMG map found in the built page")
    elif cards is None:
        note("could not parse the CARD_IMG block to check its img files")
    else:
        inline = sum(1 for v in cards.values()
                     if isinstance(v, str) and v.strip().startswith(INLINE))
        if inline:
            note("CARD_IMG still holds %d inline data:image URI(s); move that art into %s" % (inline, WEB_IMG))
        refs += [("CARD_IMG", k, v) for k, v in cards.items()]
    m = PAL_ART_AT.search(page)
    pals = parse_js_map(m.group(0)) if m else None
    if not pals:
        if PALDEX_PAGE in page:
            raise ArtError("the built page has a PalDex screen but no readable PAL_ART map, so every Pal "
                           "tile would fall back to one of its cards")
    else:
        refs += [("PAL_ART", k, v) for k, v in pals.items()]
    return refs


def missing_art(refs, folder):
    """[(label, key, reason)] for every reference this folder cannot resolve."""
    bad = []
    for label, key, value in refs:
        if isinstance(value, str) and value.strip().startswith(INLINE):
            continue
        name = art_file(value)
        if name is None:
            bad.append((label, key, "%r is not an img/ file name" % (value,)))
        elif not os.path.isfile(os.path.join(REPO, folder, name)):
            bad.append((label, key, "img/%s is missing from %s" % (name, folder)))
    return bad


def check_art(page, folders, hint, note=None):
    """Fail loudly when a declared card or Pal artwork file is absent from any target folder."""
    refs = art_refs(page, note)
    counts = {}
    for label, _, _ in refs:
        counts[label] = counts.get(label, 0) + 1
    tally = ", ".join("%s %d" % (k, v) for k, v in sorted(counts.items()))
    problems = []
    for label, folder in folders:
        bad = missing_art(refs, folder)
        if bad:
            lines = "\n      ".join("%s[%s]: %s" % (l, k, why) for l, k, why in bad[:10])
            more = "" if len(bad) <= 10 else "\n      ... and %d more" % (len(bad) - 10)
            problems.append("    %s (%s): %d of %d artwork %s unresolved\n      %s%s"
                            % (folder, label, len(bad), len(refs),
                               "entry" if len(bad) == 1 else "entries", lines, more))
    if problems:
        raise ArtError("artwork declared by the built page cannot be resolved to a file on disk:\n" +
                       "\n".join(problems) +
                       "\n    Each platform loads these as relative img/ files, so a missing one degrades a"
                       " tile silently instead of failing." +
                       "\n    Declared: " + tally + "\n    " + hint)
    print("[ART] %d artwork entries (%s) resolve in %s" % (len(refs), tally,
                                                           ", ".join(f for _, f in folders)))

def mirror(src, dst):
    """Make dst hold exactly the files of src (byte compare). Returns (total, added, updated, deleted)."""
    os.makedirs(dst, exist_ok=True)
    names = sorted(n for n in os.listdir(src) if os.path.isfile(os.path.join(src, n)))
    added = updated = deleted = 0
    keep = set(names)
    # Delete first: on a case insensitive disk (NTFS, APFS) a case only rename would otherwise pass the
    # exists check against the old name, then the delete pass would remove the only copy.
    for n in os.listdir(dst):
        p = os.path.join(dst, n)
        if n not in keep and os.path.isfile(p):
            os.remove(p); deleted += 1
    for n in names:
        s = os.path.join(src, n); d = os.path.join(dst, n)
        if not os.path.exists(d):
            shutil.copyfile(s, d); added += 1
        elif not filecmp.cmp(s, d, shallow=False):
            shutil.copyfile(s, d); updated += 1
    return len(names), added, updated, deleted

def main(argv=None):
    ap = argparse.ArgumentParser(description="Rebuild the WEB, Android and iOS bundles from the canonical html.")
    ap.add_argument("--src", default=None, help="canonical html to build from (default: <repo>/src/paldeck.html)")
    ap.add_argument("--baseline", default=None, help="previous canonical for older unmarked bundles; relative to cwd")
    args = ap.parse_args(argv)
    src_path = os.path.abspath(args.src) if args.src else os.path.join(REPO, "src", "paldeck.html")
    P_new = read(src_path)
    split_canonical(P_new)
    baselines = [read(os.path.abspath(args.baseline))] if args.baseline else [P_new]
    inputs = [(name, rel, read(os.path.join(REPO, rel)))
              for name, rel in [("WEB", WEB_HTML), ("ANDROID", ANDROID_HTML)]]
    # Marked builds no longer depend on Git or on the source at the preceding build.
    if not args.baseline and any(not any(marker in D for marker in BUILD_MARKERS)
                                 for _, _, D in inputs):
        try:
            old = subprocess.run(["git", "-C", REPO, "show", "HEAD:src/paldeck.html"],
                                 capture_output=True, text=True, encoding="utf-8", check=True)
            baselines.append(old.stdout)
        except (OSError, subprocess.CalledProcessError):
            pass  # A matching current source still supports a first build outside a Git checkout.

    # Prepare both platforms before writing anything. A stale Android baseline must not leave the
    # web half-rebuilt, and injected assets always come from the current bundles on disk.
    pending = []
    web_cardimg = None
    for name, rel, D in inputs:
        try:
            PREFIX, FONT, CARDIMG, SUFFIX = extract_wrapper(D, baselines)
        except ValueError as exc:
            ap.error("%s: %s" % (rel, exc))
        SUFFIX = SW_REG_RE.sub("", SUFFIX)
        if name == "WEB":
            web_cardimg = CARDIMG
        else:
            CARDIMG = web_cardimg   # all platforms use the web img/ paths
        pending.append((name, rel, D, build(P_new, PREFIX, FONT, CARDIMG, SUFFIX)))
    # Before a single byte is written: the web img folder is what the other two are mirrored from, so a
    # bundle whose own artwork is not on disk has nothing correct to produce.
    art_note = lambda msg: print("[WARN] " + msg)
    web_new = next(newD for name, _, _, newD in pending if name == "WEB")
    try:
        check_art(web_new, [("web", WEB_IMG)], "Add the file(s) to %s and re-run." % WEB_IMG, art_note)
    except ArtError as exc:
        ap.error(str(exc))
    for name, rel, D, newD in pending:
        write(os.path.join(REPO, rel), newD)
        print("[%s] %s  ->  %d bytes (was %d)" % (name, rel, len(newD.encode("utf-8")), len(D.encode("utf-8"))))

    for name, rel in APP_IMG:
        total, added, updated, deleted = mirror(os.path.join(REPO, WEB_IMG), os.path.join(REPO, rel))
        print("[%s] %s  <-  %s: %d files (%d added, %d updated, %d deleted)"
              % (name, rel, WEB_IMG, total, added, updated, deleted))

    # And after the mirrors, against the folders the shells actually load art from.
    try:
        check_art(read(os.path.join(REPO, WEB_HTML)), ART_FOLDERS,
                  "docs/app/img is the source of truth; the two app folders are mirrored from it.",
                  art_note)
    except ArtError as exc:
        raise SystemExit("[rebuild] FAILED after writing: %s\nThe bundle pages are written but an app img "
                         "folder cannot resolve them; add the file(s) and re-run." % exc)

    # A content stamp changes the shell cache without expiring the separate card-art cache.
    SW = "docs/app/sw.js"
    _sw_path = os.path.join(REPO, SW)
    if os.path.exists(_sw_path):
        _web = read(os.path.join(REPO, WEB_HTML))
        _m = re.search(r'var APP_VERSION\s*=\s*"([^"]+)"', _web)
        _ver = _m.group(1) if _m else "0"
        _hash = hashlib.sha1(_web.encode("utf-8")).hexdigest()[:8]
        _stamp = "%s-%s" % (_ver, _hash)
        with open(_sw_path, encoding="utf-8", newline="") as sw_file:
            _sw = sw_file.read()
        _new = re.sub(r"const BUILD = '[^']*';", "const BUILD = '%s';" % _stamp, _sw, count=1)
        if _new != _sw:
            with open(_sw_path, "w", encoding="utf-8", newline="") as sw_file:
                sw_file.write(_new)
        print("[WEB] %s  <-  build stamp %s" % (SW, _stamp))

    shutil.copyfile(os.path.join(REPO, ANDROID_HTML), os.path.join(REPO, IOS_HTML))
    print("[IOS] %s  <-  copy of %s (%d bytes)"
          % (IOS_HTML, ANDROID_HTML, os.path.getsize(os.path.join(REPO, IOS_HTML))))
    print("[OK] WEB, Android and iOS rebuilt from %s." % src_path)


if __name__ == "__main__":
    main()
