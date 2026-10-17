"""Rewrite the 60 Associate cards in Spanish, pixel-editing the original art.

Only the text zone (title + both ability paragraphs) is erased and redrawn;
the illustration, top stat icons, type badge, border, stars and card number
are preserved exactly as scanned. Icons used inline (thug, money, gun, ...)
are the ones extracted from the real cards (data/icons/*.png), not words.
"""
import json
import os
import re
import numpy as np
from PIL import Image, ImageDraw, ImageFont

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(BASE, "data", "source_sheets")
ICON_DIR = os.path.join(BASE, "data", "icons")
OUT_DIR = os.path.join(BASE, "assets", "cards")
os.makedirs(OUT_DIR, exist_ok=True)

CELL_W, CELL_H = 425, 660
LEFT, RIGHT = 16, 16
TEXT_W = CELL_W - LEFT - RIGHT

FONT_DIR = r"C:\Windows\Fonts"
TITLE_FONT_PATH = os.path.join(FONT_DIR, "impact.ttf")
BODY_FONT_PATH = os.path.join(FONT_DIR, "arialbd.ttf")

sheets = {
    1: Image.open(os.path.join(SRC_DIR, "Scarface Cards - 1W.jpg")),
    2: Image.open(os.path.join(SRC_DIR, "Scarface Cards - 2W.jpg")),
}

ICON_CACHE = {}


def get_icon(name, target_h):
    key = (name, target_h)
    if key in ICON_CACHE:
        return ICON_CACHE[key]
    im = Image.open(os.path.join(ICON_DIR, f"{name}.png")).convert("RGBA")
    w = int(im.width * target_h / im.height)
    im = im.resize((max(w, 1), target_h), Image.LANCZOS)
    ICON_CACHE[key] = im
    return im


WORD_ICON = [
    (r"\bNivel de Crimen\b", "crimerate"),
    (r"\bMatones\b", "thug"),
    (r"\bMat[oó]n\b", "thug"),
    (r"\bDinero\b", "money"),
    (r"\bArmas\b", "gun"),
    (r"\bArma\b", "gun"),
    (r"\bAlcohol\b", "alcohol"),
    (r"\bAutos\b", "car"),
    (r"\bAuto\b", "car"),
    (r"\bCamiones\b", "truck"),
    (r"\bCami[oó]n\b", "truck"),
    (r"\bPolic[ií]a\b", "police"),
]
WORD_ICON_RE = re.compile("|".join(f"(?P<g{i}>{pat})" for i, (pat, _) in enumerate(WORD_ICON)))
ICON_BY_GROUP = {f"g{i}": icon for i, (_, icon) in enumerate(WORD_ICON)}

TYPE_ICON = {
    "Corrupción": "suit_corruption",
    "Contrabando": "suit_bootlegging",
    "Apuestas": "suit_gambling",
    "Robo": "suit_theft",
    "Vicio": "suit_vice",
    "Violencia": "suit_violence",
}


def tokenize(text):
    """Split into ('text', str) / ('icon', name) tokens, then into words/icons for wrapping."""
    tokens = []
    pos = 0
    for m in WORD_ICON_RE.finditer(text):
        if m.start() > pos:
            tokens.append(("text", text[pos:m.start()]))
        icon = ICON_BY_GROUP[m.lastgroup]
        tokens.append(("icon", icon))
        pos = m.end()
    if pos < len(text):
        tokens.append(("text", text[pos:]))

    # explode text tokens into word-level tokens (keep spaces attached to following word)
    words = []
    for kind, val in tokens:
        if kind == "icon":
            words.append(("icon", val))
        else:
            for w in re.findall(r"\S+\s*", val):
                words.append(("word", w))
    return words


def sample_bg_color(cell_rgb, y0, y1):
    """Sample the parchment background from the left/right margins of a band
    (never the center, where title/body text or icons sit)."""
    arr = np.array(cell_rgb)
    y0, y1 = max(y0, 0), min(y1, arr.shape[0])
    strip = np.concatenate([arr[y0:y1, 2:11], arr[y0:y1, -11:-2]], axis=1)
    return tuple(int(v) for v in strip.reshape(-1, 3).mean(axis=0))


def find_divider(gray, y_start, y_end, dark_thresh=90, width_frac=0.85):
    for y in range(y_start, y_end):
        if (gray[y] < dark_thresh).mean() > width_frac:
            return y
    return None


def find_border_bottom(gray, y_start=480):
    """Find the card's own bottom border line.

    Cards don't all fill their full 660px cell: some sit noticeably higher,
    leaving a run of pure white page margin below them (occasionally with a
    stray dark fleck further down from the next row bleeding in). So instead
    of scanning from the very bottom up, we scan downward from inside the
    card and remember the last genuinely dark row seen *before* we hit a
    sustained run of pure white — that run marks leaving the card itself.
    """
    last_dark = None
    white_run = 0
    for y in range(y_start, CELL_H):
        m = gray[y].mean()
        if m < 130:
            last_dark = y
            white_run = 0
        elif m > 252:
            white_run += 1
            if white_run >= 6 and last_dark is not None:
                return last_dark
        else:
            white_run = 0
    return last_dark if last_dark is not None else CELL_H - 6


def render_card(card, out_path):
    sheet = sheets[card["sheet"]]
    x0, y0 = card["col"] * CELL_W, card["row"] * CELL_H
    cell = sheet.crop((x0, y0, x0 + CELL_W, y0 + CELL_H)).convert("RGB")
    gray = np.array(cell.convert("L"))

    d1 = find_divider(gray, 150, 480, dark_thresh=90, width_frac=0.85)
    if d1 is None:
        d1 = 390
    border_bottom = find_border_bottom(gray)
    footer_top = border_bottom - 34
    footer_top = max(footer_top, d1 + 140)
    footer_top = min(footer_top, 636)

    bg = sample_bg_color(cell, d1, footer_top)

    draw = ImageDraw.Draw(cell)
    draw.rectangle([0, d1, CELL_W, footer_top], fill=bg)

    # bottom-left type label ("ASSOCIATE") is left untouched from the original scan

    # ---- title ----
    title = card["name"]["es"].upper()
    title_size = 58
    title_font = ImageFont.truetype(TITLE_FONT_PATH, title_size)
    while title_font.getlength(title) > TEXT_W and title_size > 26:
        title_size -= 2
        title_font = ImageFont.truetype(TITLE_FONT_PATH, title_size)
    title_lines = [title]
    if title_font.getlength(title) > TEXT_W:
        # wrap to two lines on a space closest to the middle
        spaces = [i for i, ch in enumerate(title) if ch == " "]
        if spaces:
            mid = len(title) / 2
            cut = min(spaces, key=lambda i: abs(i - mid))
            title_lines = [title[:cut], title[cut + 1:]]

    cursor_y = d1 + 8

    for tl in title_lines:
        draw.text((LEFT, cursor_y), tl, font=title_font, fill=(15, 12, 10))
        cursor_y += int(title_size * 1.05)

    cursor_y += 6
    draw.line([(LEFT, cursor_y), (CELL_W - RIGHT, cursor_y)], fill=(15, 12, 10), width=3)
    cursor_y += 10

    # ---- body paragraphs (skill + matching skill), auto-shrink to fit footer_top ----
    skill_words = tokenize(card["skill"]["es"])
    match_type_icons = [TYPE_ICON[t.strip()] for t in card["matchType"]["es"].split("/") if t.strip() in TYPE_ICON]
    match_words = tokenize(card["matchSkill"]["es"])

    body_size = 23
    while body_size >= 12:
        body_font = ImageFont.truetype(BODY_FONT_PATH, body_size)
        icon_h = int(body_size * 1.05)
        lh = int(body_size * 1.3)

        skill_lines = wrap_words(skill_words, body_font, TEXT_W, icon_h)
        prefix_tokens, prefix_w = match_prefix_tokens(match_type_icons, body_font, icon_h)
        match_lines = wrap_words(match_words, body_font, TEXT_W - prefix_w, icon_h)

        total_h = len(skill_lines) * lh + 14 + len(match_lines) * lh + 6
        if cursor_y + total_h <= footer_top:
            break
        body_size -= 1
    if os.environ.get("DEBUG_FIT"):
        print(f"[{card['id']}] body_size={body_size} cursor_y={cursor_y} footer_top={footer_top} total_h={total_h} end_y={cursor_y+total_h}")

    y = cursor_y
    y = draw_wrapped(cell, draw, skill_lines, LEFT, y, body_font, icon_h, lh)
    y += 8
    draw.line([(LEFT, y), (CELL_W - RIGHT, y)], fill=(80, 74, 66), width=1)
    y += 8

    cx = draw_match_prefix(cell, draw, prefix_tokens, LEFT, y, body_font, icon_h)
    draw_wrapped(cell, draw, match_lines, LEFT, y, body_font, icon_h, lh, first_line_x=cx)

    cell.save(out_path, quality=92)


def wrap_words(words, font, max_w, icon_h):
    lines, cur, cur_w = [], [], 0
    for kind, val in words:
        if kind == "word":
            w = font.getlength(val)
        else:
            w = get_icon(val, icon_h).width + 6
        if cur and cur_w + w > max_w:
            lines.append(cur)
            cur, cur_w = [], 0
        cur.append((kind, val, w))
        cur_w += w
    if cur:
        lines.append(cur)
    return lines


def match_prefix_tokens(icon_names, font, icon_h):
    """Build the '+ icon / icon / icon: ' prefix tokens (as printed on the
    original cards) and its total pixel width."""
    tokens = [("text", "+ ")]
    width = font.getlength("+ ")
    for i, name in enumerate(icon_names):
        icon = get_icon(name, icon_h)
        tokens.append(("icon", name, icon))
        width += icon.width + 4
        if i < len(icon_names) - 1:
            tokens.append(("text", " / "))
            width += font.getlength(" / ")
    tokens.append(("text", ": "))
    width += font.getlength(": ")
    return tokens, width


def draw_match_prefix(cell, draw, tokens, x, y, font, icon_h):
    cx = x
    for tok in tokens:
        if tok[0] == "text":
            draw.text((cx, y), tok[1], font=font, fill=(20, 16, 12))
            cx += font.getlength(tok[1])
        else:
            _, _, icon = tok
            paste_rgba(cell, icon, cx, y + (font.size - icon_h) // 2 + 2)
            cx += icon.width + 4
    return cx


def paste_rgba(base_rgb_img, icon_rgba, x, y):
    base_rgb_img.paste(icon_rgba, (int(x), int(y)), icon_rgba)


def draw_wrapped(base_img, draw, lines, x, y, font, icon_h, lh, fill=(20, 16, 12), first_line_x=None):
    for li, line in enumerate(lines):
        cx = x if (li > 0 or first_line_x is None) else first_line_x
        for kind, val, w in line:
            if kind == "word":
                draw.text((cx, y), val, font=font, fill=fill)
                cx += w
            else:
                icon = get_icon(val, icon_h)
                iy = y + (font.size - icon_h) // 2 + 2
                paste_rgba(base_img, icon, cx, iy)
                cx += icon.width + 6
        y += lh
    return y


def main():
    cards = json.load(open(os.path.join(BASE, "data", "cards.json"), encoding="utf-8"))
    for card in cards:
        out_path = os.path.join(OUT_DIR, f"{card['id']}.jpg")
        render_card(card, out_path)
        print("done", card["id"])


if __name__ == "__main__":
    main()
