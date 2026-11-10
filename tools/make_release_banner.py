"""Render the Home "latest update" banner for a SphereDex release.

The picture matches the five-row UPDATE_2_4_5 banner: dark navy, a faint grid, a huge faint
version behind the wordmark, a bright cyan version, three coloured bullets, and a right-hand
panel of five numbered rows with cyan corner brackets. The footer credit stays
"CARDS © POCKETPAIR / BUSHIROAD".

Latin text uses the app faces in docs/fonts (Chakra Petch 500, 600 and 700). Any glyph those
subsets lack is drawn with Noto Sans CJK, which replaces the old Windows-only Yu Gothic faces.
The banner itself stays in the language of the copy you pass. Japanese is not added just so the
fallback font is exercised; the script checks that fallback on its own.

Run from the repo root:

    python tools/make_release_banner.py 2.4.8 \\
        "Print your whole collection" "Share wants and spares" "Find your closest winning decks" \\
        --caption "LIVE IN THE APP" \\
        --row "Print your collection|With prices, or without" \\
        --row "Find your cards|Grouped by where you keep them" \\
        --row "Share wants and spares|Prices only if you choose" \\
        --row "Closest winning decks|Built decks hold their copies" \\
        --row "Track grading|Log the grade when it returns"

That writes docs/app/img/UPDATE_2_4_8.webp and a PNG at tmp/banner-2.4.8.png.
tools/rebuild.py mirrors docs/app/img into the Android and iOS bundles. "LIVE IN THE APP" is
the caption that ships. The default caption is "UPDATE PREVIEW", for a draft render. For 2.4.8
the committed file in docs/app/img is the live banner.

--held writes a side copy under release-notes/held instead of the app image folder. The copies
that ship are docs/app/img and the Android and iOS mirrors.
"""

import argparse
import hashlib
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
W, H = 1600, 900
FONTS = ROOT / "docs" / "fonts"
LATIN = {weight: FONTS / ("chakra-petch-%d.woff2" % weight) for weight in (500, 600, 700)}

# Noto Sans CJK is the fallback for any glyph the Chakra subsets do not carry (© included, when a
# face lacks it). These are the faces a checkout or a normal Linux/macOS font install would have.
# NOTO_CJK_REGULAR / NOTO_CJK_BOLD override the search.
NOTO_REGULAR = (
    "NotoSansCJKjp-Regular.otf",
    "NotoSansCJK-Regular.ttc",
    "NotoSansCJK-Regular.otf",
)
NOTO_BOLD = (
    "NotoSansCJKjp-Bold.otf",
    "NotoSansCJK-Bold.ttc",
    "NotoSansCJK-Bold.otf",
)
NOTO_DIRS = (
    FONTS,
    Path("/tmp/fonts"),
    Path("/usr/local/share/fonts"),
    Path("/usr/share/fonts/opentype/noto"),
    Path("/usr/share/fonts/noto-cjk"),
    Path("/usr/share/fonts/truetype/noto"),
    Path.home() / ".local/share/fonts",
    Path("/Library/Fonts"),
    Path("/System/Library/Fonts"),
)

BG = (8, 22, 31)
GRID = (16, 46, 58)
FAINT_NUMBER = (9, 47, 58)
CYAN = (18, 227, 245)
PURPLE = (176, 124, 252)
GREEN = (55, 200, 103)
AMBER = (255, 176, 32)
GREY = (201, 213, 223)
NUM_INK = (8, 22, 31)
LABEL = (236, 227, 214)
WHITE = (240, 244, 246)
MUTED = (150, 184, 204)
CAPTION = (102, 145, 173)
CREDIT = (169, 188, 203)
PANEL = (17, 29, 39)
PANEL_EDGE = (40, 58, 70)
ROW = (14, 28, 38)
ROW_EDGE = (38, 56, 68)
RULE = (42, 59, 67)
# Same order as the 2.4.5 banner: cyan, purple, green, amber, grey.
BADGES = (CYAN, PURPLE, GREEN, AMBER, GREY)
# The three bullets use the first, third and fourth badge colours, as 2.4.5 does.
BULLET_COLOURS = (CYAN, GREEN, AMBER)

# Geometry measured off docs/app/img/UPDATE_2_4_5.webp (1600x900).
PANEL_BOX = (880, 96, 1519, 692)
BADGE_TOPS = (144, 257, 369, 481, 593)
BADGE_BOX = (924, 50)  # left, size
ROW_LEFT, ROW_RIGHT, ROW_HEIGHT = 904, 1494, 100
TITLE_X = 1000
# Bullet dots and lines. Size 50 matched the reference; longer 2.4.8 copy is fitted down so the
# longest line keeps the reference's gap before the panel.
BULLET_X = 133
BULLET_BASELINES = (520, 626, 732)
DOT_CENTRES = ((90, 504), (90, 610), (90, 716))
RULE_Y = 782
CAPTION_BASELINE = 766
CREDIT_BASELINE = 846
SAFE_MARGIN = 48
PANEL_GAP = 16


def font(path, size):
    return ImageFont.truetype(str(path), size)


def find_noto(names, env_key):
    override = os.environ.get(env_key, "").strip()
    candidates = []
    if override:
        candidates.append(Path(override))
    for directory in NOTO_DIRS:
        for name in names:
            candidates.append(directory / name)
    for path in candidates:
        if path.is_file():
            return path
    return None


def load_faces():
    missing = [weight for weight, path in LATIN.items() if not path.is_file()]
    if missing:
        raise SystemExit("app font missing from docs/fonts: " + ", ".join(str(LATIN[w]) for w in missing))
    regular = find_noto(NOTO_REGULAR, "NOTO_CJK_REGULAR")
    bold = find_noto(NOTO_BOLD, "NOTO_CJK_BOLD") or regular
    if regular is None:
        raise SystemExit(
            "Noto Sans CJK was not found. Install NotoSansCJKjp-Regular.otf (and Bold) or set "
            "NOTO_CJK_REGULAR. Looked in docs/fonts, /tmp/fonts, and the usual system font directories."
        )
    return regular, bold


def has_glyph(face, ch):
    """True when the font draws ch itself rather than its missing-glyph box."""
    if ch.isspace():
        return True
    return glyph_pixels(face, ch) != glyph_pixels(face, "\uffff")


def glyph_pixels(face, ch):
    left, top, right, bottom = face.getbbox(ch)
    image = Image.new("L", (max(1, right - left), max(1, bottom - top)))
    ImageDraw.Draw(image).text((-left, -top), ch, font=face, fill=255)
    return (left, top, right, bottom), image.tobytes()


def face_for(ch, primary, fallback, used):
    if has_glyph(primary, ch):
        used["primary"].add(ch)
        return primary
    if has_glyph(fallback, ch):
        used["fallback"].add(ch)
        return fallback
    used["missing"].add(ch)
    return primary


def text_width(text, primary, fallback, spacing, used):
    widths = []
    for ch in text:
        face = face_for(ch, primary, fallback, used)
        widths.append(face.getlength(ch))
    return sum(widths) + spacing * max(0, len(text) - 1), widths


def draw_runs(draw, xy, text, primary, fallback, fill, spacing=0.0, anchor_right=False, used=None):
    """Draw text a character at a time so a missing glyph can use the fallback face.

    y is the baseline (Pillow anchor 'ls'). Returns the ink box (left, top, right, bottom).
    """
    if used is None:
        used = {"primary": set(), "fallback": set(), "missing": set()}
    chars = [(ch, face_for(ch, primary, fallback, used)) for ch in text]
    widths = [face.getlength(ch) for ch, face in chars]
    total = sum(widths) + spacing * max(0, len(chars) - 1)
    x, y = xy
    if anchor_right:
        x -= total
    left, top, right, bottom = x + total, y, x, y
    cursor = x
    for (ch, face), width in zip(chars, widths):
        draw.text((cursor, y), ch, font=face, fill=fill, anchor="ls")
        if not ch.isspace():
            glyph_left, glyph_top, glyph_right, glyph_bottom = face.getbbox(ch)
            ascent, _descent = face.getmetrics()
            left = min(left, cursor + glyph_left)
            right = max(right, cursor + glyph_right)
            top = min(top, y + glyph_top - ascent)
            bottom = max(bottom, y + glyph_bottom - ascent)
        cursor += width + spacing
    if not text.strip():
        return (x, y, x, y)
    return (left, top, right, bottom)


def fit_size(path, text, size, max_width, fallback_path, minimum=18):
    """Largest size at or below `size` whose text stays within max_width, fallback included."""
    while size > minimum:
        primary = font(path, size)
        fallback = font(fallback_path, size)
        width, _widths = text_width(text, primary, fallback, 0, {"primary": set(), "fallback": set(), "missing": set()})
        if width <= max_width:
            return size
        size -= 1
    return size


def glow(img, box, colour, radius, strength):
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse(box, fill=colour + (strength,))
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(radius)))


def rounded_badge(draw, box, fill):
    draw.rounded_rectangle(box, radius=12, fill=fill)


def reject_dashes(label, text):
    if any(ch in text for ch in "-–—"):
        raise SystemExit("%s contains a dash, rewrite it: %r" % (label, text))


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Render a five-row SphereDex release banner.")
    parser.add_argument("version", help="Release version, for example 2.4.8")
    parser.add_argument("highlights", nargs="*", help="Exactly three bullet lines, in order")
    parser.add_argument("--highlight", action="append", default=[], help="Bullet line. Repeat for three.")
    parser.add_argument("--row", action="append", default=[], metavar="TITLE|SUBTITLE",
                        help="One panel row. Repeat for five, title and subtitle split on the first |.")
    parser.add_argument("--caption", default="UPDATE PREVIEW",
                        help="Right-hand caption. LIVE IN THE APP is the caption that ships.")
    parser.add_argument("--held", action="store_true",
                        help="Write under release-notes/held instead of docs/app/img. The app image folder is what ships.")
    parser.add_argument("--out-webp", default=None)
    parser.add_argument("--out-png", default=None)
    args = parser.parse_args(argv)
    highlights = args.highlight or args.highlights
    if args.highlight and args.highlights:
        parser.error("pass highlights either as three positional lines or as --highlight, not both")
    if len(highlights) != 3:
        parser.error("exactly three highlights are required")
    if len(args.row) != 5:
        parser.error("exactly five --row TITLE|SUBTITLE values are required")
    rows = []
    for raw in args.row:
        if "|" not in raw:
            parser.error("row must be Title|Subtitle: %r" % raw)
        title, subtitle = raw.split("|", 1)
        title, subtitle = title.strip(), subtitle.strip()
        if not title or not subtitle:
            parser.error("row title and subtitle are both required: %r" % raw)
        rows.append((title, subtitle))
    version = args.version.strip()
    if not version or any(ch in version for ch in "/\\"):
        parser.error("version must be a plain number such as 2.4.8")
    parts = version.split(".")
    if not 1 <= len(parts) <= 3 or not all(part.isdigit() for part in parts):
        parser.error("version must look like 2.4.8")
    for label, text in [("highlight", h) for h in highlights] + [("caption", args.caption)]:
        reject_dashes(label, text)
    for title, subtitle in rows:
        reject_dashes("row", title)
        reject_dashes("row", subtitle)
    slug = version.replace(".", "_")
    if args.held:
        webp = ROOT / "release-notes" / "held" / ("UPDATE_%s.webp" % slug)
        png = ROOT / "tmp" / ("banner-%s-live.png" % version)
    else:
        webp = ROOT / "docs" / "app" / "img" / ("UPDATE_%s.webp" % slug)
        png = ROOT / "tmp" / ("banner-%s.png" % version)
    if args.out_webp:
        webp = Path(args.out_webp)
    if args.out_png:
        png = Path(args.out_png)
    return {
        "version": version,
        "highlights": highlights,
        "rows": rows,
        "caption": args.caption,
        "held": args.held,
        "webp": webp,
        "png": png,
    }


def render(spec, faces):
    regular_path, bold_path = faces
    used = {"primary": set(), "fallback": set(), "missing": set()}
    boxes = {}
    img = Image.new("RGBA", (W, H), BG + (255,))

    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    grid_draw = ImageDraw.Draw(grid)
    for x in range(0, W, 48):
        grid_draw.line([(x, 0), (x, H)], fill=GRID + (88,), width=1)
    for y in range(0, H, 48):
        grid_draw.line([(0, y), (W, y)], fill=GRID + (88,), width=1)
    img.alpha_composite(grid)

    draw = ImageDraw.Draw(img)
    # Huge faint version behind the wordmark. It is allowed to run off the left edge; that crop is
    # the same device as the 2.4.5 banner.
    # Sits behind the wordmark and the bright version, clipped on the left, and stops above the bullets.
    draw.text((-36, 408), spec["version"], font=font(LATIN[700], 600), fill=FAINT_NUMBER, anchor="ls")
    glow(img, (720, -120, 1700, 640), (12, 120, 140), 140, 70)

    draw = ImageDraw.Draw(img)
    label = font(LATIN[600], 40)
    label_fallback = font(bold_path, 40)
    boxes["wordmark"] = draw_runs(draw, (80, 122), "SPHEREDEX", label, label_fallback, LABEL, spacing=12, used=used)
    version_font = font(LATIN[700], 230)
    boxes["version"] = draw_runs(
        draw, (76, 318), spec["version"], version_font, font(bold_path, 230), CYAN, used=used)

    panel = PANEL_BOX
    glow(img, (panel[0] - 36, panel[1] - 28, panel[2] + 48, panel[3] + 36), (8, 80, 98), 54, 110)
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(panel, radius=22, fill=PANEL, outline=PANEL_EDGE, width=2)
    # Corner brackets just outside the panel, matching the 2.4.5 arms.
    draw.line([(853, 82), (911, 82)], fill=CYAN, width=3)
    draw.line([(853, 82), (853, 140)], fill=CYAN, width=3)
    draw.line([(1488, 706), (1546, 706)], fill=CYAN, width=3)
    draw.line([(1546, 648), (1546, 706)], fill=CYAN, width=3)

    title_size = 30
    sub_size = 24
    longest_title = max(spec["rows"], key=lambda row: len(row[0]))[0]
    longest_sub = max(spec["rows"], key=lambda row: len(row[1]))[1]
    title_max = ROW_RIGHT - 16 - TITLE_X
    sub_max = title_max
    title_size = fit_size(LATIN[700], longest_title, title_size, title_max, bold_path, minimum=22)
    sub_size = fit_size(LATIN[500], longest_sub, sub_size, sub_max, regular_path, minimum=16)
    title_font = font(LATIN[700], title_size)
    sub_font = font(LATIN[500], sub_size)
    title_fallback = font(bold_path, title_size)
    sub_fallback = font(regular_path, sub_size)
    number_font = font(LATIN[700], 26)

    for index, ((title, subtitle), top, colour) in enumerate(zip(spec["rows"], BADGE_TOPS, BADGES)):
        row_top = top - 24
        row_box = (ROW_LEFT, row_top, ROW_RIGHT, row_top + ROW_HEIGHT)
        draw.rounded_rectangle(row_box, radius=16, fill=ROW, outline=ROW_EDGE, width=2)
        badge = (BADGE_BOX[0], top, BADGE_BOX[0] + BADGE_BOX[1], top + BADGE_BOX[1])
        rounded_badge(draw, badge, colour)
        digit = str(index + 1)
        cx = (badge[0] + badge[2]) / 2
        cy = (badge[1] + badge[3]) / 2 + 1
        draw.text((cx, cy), digit, font=number_font, fill=NUM_INK, anchor="mm")
        boxes["badge-%d" % (index + 1)] = badge
        # Title baseline sits in the upper half of the row; the subtitle sits under it.
        boxes["title-%d" % (index + 1)] = draw_runs(
            draw, (TITLE_X, row_top + 46), title, title_font, title_fallback, WHITE, used=used)
        boxes["sub-%d" % (index + 1)] = draw_runs(
            draw, (TITLE_X, row_top + 78), subtitle, sub_font, sub_fallback, MUTED, used=used)

    if spec["caption"]:
        caption_font = font(LATIN[600], 22)
        boxes["caption"] = draw_runs(
            draw, (1510, CAPTION_BASELINE), spec["caption"], caption_font, font(bold_path, 22),
            CAPTION, spacing=8, anchor_right=True, used=used)

    bullet_max = PANEL_BOX[0] - PANEL_GAP - BULLET_X
    longest_bullet = max(spec["highlights"], key=len)
    bullet_size = fit_size(LATIN[500], longest_bullet, 50, bullet_max, regular_path, minimum=28)
    bullet_font = font(LATIN[500], bullet_size)
    bullet_fallback = font(regular_path, bullet_size)
    for index, (line, colour, baseline, centre) in enumerate(
            zip(spec["highlights"], BULLET_COLOURS, BULLET_BASELINES, DOT_CENTRES)):
        glow(img, (centre[0] - 18, centre[1] - 18, centre[0] + 18, centre[1] + 18), colour, 8, 120)
        draw = ImageDraw.Draw(img)
        draw.ellipse((centre[0] - 8, centre[1] - 8, centre[0] + 8, centre[1] + 8), fill=colour)
        boxes["bullet-%d" % (index + 1)] = draw_runs(
            draw, (BULLET_X, baseline), line, bullet_font, bullet_fallback, WHITE, used=used)

    draw = ImageDraw.Draw(img)
    draw.line([(80, RULE_Y), (1520, RULE_Y)], fill=RULE, width=2)
    credit_font = font(LATIN[600], 26)
    boxes["credit"] = draw_runs(
        draw, (1510, CREDIT_BASELINE), "CARDS © POCKETPAIR / BUSHIROAD", credit_font,
        font(bold_path, 26), CREDIT, spacing=5, anchor_right=True, used=used)
    return img.convert("RGB"), boxes, used, {"title": title_size, "subtitle": sub_size, "bullet": bullet_size}


def overlaps(a, b, pad=0):
    return not (a[2] + pad <= b[0] or b[2] + pad <= a[0] or a[3] + pad <= b[1] or b[3] + pad <= a[1])


def validate(image, boxes, used):
    """Reject a banner whose copy collides, leaves the safe area, or drops a glyph."""
    problems = []
    if image.size != (W, H):
        problems.append("size %s is not %dx%d" % (image.size, W, H))
    if used["missing"]:
        problems.append("missing glyphs: " + "".join(sorted(used["missing"])))
    canvas = (SAFE_MARGIN, 36, W - SAFE_MARGIN, H - 28)
    for name, box in boxes.items():
        if box[0] < canvas[0] or box[1] < canvas[1] or box[2] > canvas[2] or box[3] > canvas[3]:
            problems.append("%s %s leaves the safe area %s" % (name, _round(box), canvas))
    panel = PANEL_BOX
    for name in ("wordmark", "version", "bullet-1", "bullet-2", "bullet-3", "credit"):
        if name in boxes and overlaps(boxes[name], panel, pad=0):
            problems.append("%s overlaps the panel" % name)
    for index in range(1, 6):
        title = boxes["title-%d" % index]
        sub = boxes["sub-%d" % index]
        badge = boxes["badge-%d" % index]
        if title[2] > ROW_RIGHT - 8 or sub[2] > ROW_RIGHT - 8:
            problems.append("row %d text passes the row's right edge" % index)
        if overlaps(title, badge) or overlaps(sub, badge):
            problems.append("row %d text overlaps its number" % index)
        if overlaps(title, sub):
            problems.append("row %d title overlaps its subtitle" % index)
    names = list(boxes)
    for i, left in enumerate(names):
        for right in names[i + 1:]:
            if left.startswith("badge") or right.startswith("badge"):
                continue
            if overlaps(boxes[left], boxes[right]):
                problems.append("%s overlaps %s" % (left, right))
    return problems


def _round(box):
    return tuple(round(v, 1) for v in box)


def prove_fallback(faces):
    """Confirm Noto covers a glyph Chakra does not, and that © can be drawn. Nothing here is painted."""
    regular_path, bold_path = faces
    chakra = font(LATIN[600], 40)
    noto = font(regular_path, 40)
    notes = []
    if has_glyph(chakra, "あ"):
        notes.append("Chakra unexpectedly draws あ")
    elif not has_glyph(noto, "あ"):
        notes.append("Noto Sans CJK does not draw あ, so it is not a usable CJK fallback")
    else:
        notes.append("fallback ok: Chakra lacks あ and Noto Sans CJK draws it")
    copy_face = "Chakra Petch" if has_glyph(chakra, "©") else ("Noto Sans CJK" if has_glyph(noto, "©") else "")
    if not copy_face:
        notes.append("© is missing from both Chakra Petch and Noto Sans CJK")
    else:
        notes.append("© draws with %s" % copy_face)
    bold = font(bold_path, 40)
    if not has_glyph(bold, "©") and not has_glyph(chakra, "©"):
        notes.append("bold fallback cannot draw ©")
    return notes


def sha256(path):
    digest = hashlib.sha256()
    digest.update(path.read_bytes())
    return digest.hexdigest()


def main(argv=None):
    spec = parse_args(sys.argv[1:] if argv is None else argv)
    faces = load_faces()
    fallback_notes = prove_fallback(faces)
    image, boxes, used, sizes = render(spec, faces)
    problems = validate(image, boxes, used)
    for note in fallback_notes:
        if note.startswith("©") or note.startswith("fallback ok"):
            continue
        problems.append(note)
    if problems:
        raise SystemExit("banner failed checks:\n" + "\n".join("  " + item for item in problems))
    spec["webp"].parent.mkdir(parents=True, exist_ok=True)
    spec["png"].parent.mkdir(parents=True, exist_ok=True)
    image.save(spec["webp"], "WEBP", quality=90, method=6)
    image.save(spec["png"], "PNG")
    print("%s: %d bytes, %dx%d, sha256 %s" % (
        spec["webp"].relative_to(ROOT) if spec["webp"].is_relative_to(ROOT) else spec["webp"],
        spec["webp"].stat().st_size, image.size[0], image.size[1], sha256(spec["webp"])))
    png_label = spec["png"].relative_to(ROOT) if spec["png"].is_relative_to(ROOT) else spec["png"]
    print("%s: %d bytes, sha256 %s" % (png_label, spec["png"].stat().st_size, sha256(spec["png"])))
    print("fonts: Chakra Petch 500/600/700 from docs/fonts; Noto Sans CJK fallback %s" % faces[0])
    print("sizes: title %d, subtitle %d, bullet %d" % (sizes["title"], sizes["subtitle"], sizes["bullet"]))
    print("glyphs: %d from Chakra, %d from Noto (%s)" % (
        len(used["primary"]), len(used["fallback"]),
        "".join(sorted(used["fallback"])) or "none needed"))
    for note in fallback_notes:
        print(note)
    for name in (
        "wordmark", "version", "bullet-1", "bullet-2", "bullet-3", "caption", "credit",
        "title-1", "sub-1", "title-4", "sub-2"):
        if name in boxes:
            print("box %s %s" % (name, _round(boxes[name])))
    print("caption: %s" % spec["caption"])
    print("held: %s" % ("yes" if spec["held"] else "no"))
    return spec


if __name__ == "__main__":
    main()
