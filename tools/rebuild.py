#!/usr/bin/env python3
"""Rebuild the WEB + Android (+ via cp, iOS) bundles from the canonical src/paldeck.html.

The canonical (src/paldeck.html) carries two markers, /*FONT_INJECT*/ and <!--CARD_IMG_INJECT-->,
where the big inlined FONT block and the window.CARD_IMG={...} block live in the BUILT docs. This
script lifts those two injected blocks out of the current built docs and re-inserts them into the
new canonical, so editing app code never disturbs the fonts or the (large) inlined images.

P_old = the LAST COMMITTED src/paldeck.html (which matches the built docs on disk, since src + docs
are committed together). P_new = the current working src/paldeck.html. So the flow is simply:
edit src/paldeck.html, run this, then commit src + docs together. No external scratch file needed.

iOS note: rebuild does NOT touch the iOS bundle; after running, cp the Android asset html over
android/ios/SphereDex/SphereDex/Resources/spheredex.html.
"""
import subprocess, os

FM = "/*FONT_INJECT*/"
CM = "<!--CARD_IMG_INJECT-->"
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))  # the android/ repo root

def read(p):
    with open(p, "r", encoding="utf-8") as f:
        return f.read()

def write(p, s):
    with open(p, "w", encoding="utf-8") as f:
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

# P_old = last committed canonical (matches the built docs); P_new = current working canonical.
P_old = subprocess.run(["git", "-C", REPO, "show", "HEAD:src/paldeck.html"],
                       capture_output=True, text=True, check=True).stdout
P_new = read(os.path.join(REPO, "src/paldeck.html"))

for name, rel in [("WEB", "docs/app/index.html"), ("ANDROID", "app/src/main/assets/spheredex.html")]:
    path = os.path.join(REPO, rel)
    D = read(path)
    PREFIX, FONT, CARDIMG, SUFFIX = derive_wrapper(P_old, D)
    newD = build(P_new, PREFIX, FONT, CARDIMG, SUFFIX)
    write(path, newD)
    print("[%s] %s  ->  %d bytes (was %d)" % (name, rel, len(newD), len(D)))

print("[OK] built docs rebuilt from working src/paldeck.html (baseline = HEAD:src). Now cp to iOS.")
