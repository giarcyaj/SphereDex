#!/usr/bin/env python3
"""Rebuild the WEB, Android and iOS bundles from the canonical src/paldeck.html.

The canonical (src/paldeck.html) carries two markers, /*FONT_INJECT*/ and <!--CARD_IMG_INJECT-->,
where the big inlined FONT block and the window.CARD_IMG={...} block live in the BUILT docs. This
script lifts those two injected blocks out of the current built docs and re-inserts them into the
new canonical, so editing app code never disturbs the fonts or the card art map.

P_old = the LAST COMMITTED src/paldeck.html (which matches the built docs on disk, since src + docs
are committed together). P_new = the current working src/paldeck.html (or --src PATH). So the flow is
simply: edit src/paldeck.html, run this, then commit src + docs together. No external scratch file needed.

Card art: every platform loads it from img/ files, never inline base64 (an 18MB inline Android html
tripped Play's "Memory usage: bad behavior" vital). docs/app/img + the WEB CARD_IMG block are the
single source of truth; after rebuilding, this script
  1. forces the Android CARD_IMG block to equal the WEB one (so relative "img/X.jpg" paths resolve to
     file:///android_asset/img/ on Android and spheredex://app/img/ on iOS),
  2. mirrors docs/app/img into app/src/main/assets/img and ios/SphereDex/SphereDex/Resources/img
     (adds, updates and deletes, so all three folders are byte identical),
  3. copies the Android html over ios/SphereDex/SphereDex/Resources/spheredex.html (the old manual cp).
New card art therefore only needs the web img file plus its entry in the WEB CARD_IMG block.

Usage:
  python tools/rebuild.py                    # build from src/paldeck.html
  python tools/rebuild.py --src /tmp/p.html  # build from another canonical (testing); relative to cwd
"""
import argparse, filecmp, hashlib, io, json, os, re, shutil, subprocess

FM = "/*FONT_INJECT*/"
CM = "<!--CARD_IMG_INJECT-->"
# The web wrapper used to carry the service worker registration, which meant it existed only in the BUILT
# page: losing it would have cost every web user offline support, with nothing in the canonical to show it
# had ever been there. The registration lives in src/paldeck.html now (inert under file: and spheredex:),
# so any copy still sitting in a derived wrapper is dropped here and every built page ends up with exactly
# one. Stripped for every platform, not just WEB: the wrapper is derived from the LAST COMMITTED canonical,
# so until this change is committed the old registration is still in the tail the apps inherit too.
SW_REG_RE = re.compile(r"\s*<script>.*?serviceWorker\.register.*?</script>\s*", re.S)
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
    iF = P.index(FM); iC = P.index(CM)
    assert iF < iC, "expected FONT marker before CARD_IMG marker"
    return P[:iF], P[iF + len(FM):iC], P[iC + len(CM):]

def derive_wrapper(P, D):
    A, B, C = split_canonical(P)
    posA = D.index(A); PREFIX = D[:posA]; afterA = posA + len(A)
    posB = D.index(B, afterA); FONT = D[afterA:posB]; afterB = posB + len(B)
    posC = D.index(C, afterB); CARDIMG = D[afterB:posC]; SUFFIX = D[posC + len(C):]
    assert PREFIX + A + FONT + B + CARDIMG + C + SUFFIX == D, "round-trip mismatch deriving wrapper"
    return PREFIX, FONT, CARDIMG, SUFFIX

def build(Pnew, PREFIX, FONT, CARDIMG, SUFFIX):
    iF = Pnew.index(FM); iC = Pnew.index(CM); assert iF < iC
    A = Pnew[:iF]; B = Pnew[iF + len(FM):iC]; C = Pnew[iC + len(CM):]
    return PREFIX + A + FONT + B + CARDIMG + C + SUFFIX

def check_card_img(block):
    """Warn (never fail) if the CARD_IMG block carries inline art or points at a missing img file."""
    if "data:image" in block:
        print("[WARN] CARD_IMG still holds inline data:image URIs; move that art into %s" % WEB_IMG)
    try:
        m = json.loads(block[block.index("{"):block.rindex("}") + 1])
    except ValueError:
        print("[WARN] could not parse the CARD_IMG block to check its img files")
        return
    missing = [v for v in m.values() if v.startswith("img/")
               and not os.path.isfile(os.path.join(REPO, "docs/app", v))]
    if missing:
        print("[WARN] CARD_IMG points at %d missing file(s): %s" % (len(missing), ", ".join(missing)))
    else:
        print("[CARD_IMG] %d entries, every img/ file present in %s" % (len(m), WEB_IMG))

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

ap = argparse.ArgumentParser(description="Rebuild the WEB, Android and iOS bundles from the canonical html.")
ap.add_argument("--src", default=None, help="canonical html to build from (default: <repo>/src/paldeck.html)")
args = ap.parse_args()
src_path = os.path.abspath(args.src) if args.src else os.path.join(REPO, "src", "paldeck.html")

# P_old = last committed canonical (matches the built docs); P_new = current working canonical.
P_old = subprocess.run(["git", "-C", REPO, "show", "HEAD:src/paldeck.html"],
                       capture_output=True, text=True, encoding="utf-8", check=True).stdout
P_new = read(src_path)

web_cardimg = None
for name, rel in [("WEB", WEB_HTML), ("ANDROID", ANDROID_HTML)]:
    path = os.path.join(REPO, rel)
    D = read(path)
    PREFIX, FONT, CARDIMG, SUFFIX = derive_wrapper(P_old, D)
    SUFFIX = SW_REG_RE.sub("", SUFFIX)   # the registration comes from the canonical, never from the wrapper
    if name == "WEB":
        web_cardimg = CARDIMG
        check_card_img(CARDIMG)
    else:
        CARDIMG = web_cardimg   # the apps read the same img/ paths as the web, never inline base64
    newD = build(P_new, PREFIX, FONT, CARDIMG, SUFFIX)
    write(path, newD)
    print("[%s] %s  ->  %d bytes (was %d)" % (name, rel, len(newD.encode("utf-8")), len(D.encode("utf-8"))))

for name, rel in APP_IMG:
    total, added, updated, deleted = mirror(os.path.join(REPO, WEB_IMG), os.path.join(REPO, rel))
    print("[%s] %s  <-  %s: %d files (%d added, %d updated, %d deleted)"
          % (name, rel, WEB_IMG, total, added, updated, deleted))

# ---- Stamp the build into the service worker -------------------------------------------------------
# The shell cache is keyed by this stamp, so every release starts a clean cache and an emergency release is
# a real kill switch. It used to be one literal name that no release ever touched, which meant nothing ever
# evicted a stale entry. Card art lives in its own long lived cache, so this does not re-download 14MB.
SW = "docs/app/sw.js"
_sw_path = os.path.join(REPO, SW)
if os.path.exists(_sw_path):
    _web = io.open(os.path.join(REPO, WEB_HTML), encoding="utf-8").read()
    _m = re.search(r'var APP_VERSION\s*=\s*"([^"]+)"', _web)
    _ver = _m.group(1) if _m else "0"
    _hash = hashlib.sha1(_web.encode("utf-8")).hexdigest()[:8]
    _stamp = "%s-%s" % (_ver, _hash)
    _sw = io.open(_sw_path, encoding="utf-8", newline="").read()
    _new = re.sub(r"const BUILD = '[^']*';", "const BUILD = '%s';" % _stamp, _sw, count=1)
    if _new != _sw:
        io.open(_sw_path, "w", encoding="utf-8", newline="").write(_new)
    print("[WEB] %s  <-  build stamp %s" % (SW, _stamp))

shutil.copyfile(os.path.join(REPO, ANDROID_HTML), os.path.join(REPO, IOS_HTML))
print("[IOS] %s  <-  copy of %s (%d bytes)"
      % (IOS_HTML, ANDROID_HTML, os.path.getsize(os.path.join(REPO, IOS_HTML))))

print("[OK] WEB, Android and iOS rebuilt from %s (baseline = HEAD:src)." % src_path)
