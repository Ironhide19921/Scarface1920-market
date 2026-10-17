import json
import os
from PIL import Image
import numpy as np

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(BASE, "data", "source_sheets")
OUT_DIR = os.path.join(BASE, "assets", "cards")
os.makedirs(OUT_DIR, exist_ok=True)

COLS, ROWS = 6, 5
CELL_W, CELL_H = 425, 660
SCAN_START, SCAN_END = 200, 480  # window to look for the full-width divider line above the title
DARK_THRESHOLD = 90
WIDTH_FRACTION = 0.85
MARGIN = 4  # px of safety margin above the detected divider

sheets_color = {
    1: Image.open(os.path.join(SRC_DIR, "Scarface Cards - 1W.jpg")),
    2: Image.open(os.path.join(SRC_DIR, "Scarface Cards - 2W.jpg")),
}
sheets_gray = {k: np.array(v.convert("L")) for k, v in sheets_color.items()}

cards = json.load(open(os.path.join(BASE, "data", "cards.json"), encoding="utf-8"))


def find_divider(gray_sheet, x0, y0):
    cell = gray_sheet[y0:y0 + CELL_H, x0:x0 + CELL_W]
    for y in range(SCAN_START, SCAN_END):
        row = cell[y]
        dark_frac = np.mean(row < DARK_THRESHOLD)
        if dark_frac > WIDTH_FRACTION:
            return y
    return SCAN_END  # fallback


report = []
for c in cards:
    sheet_color = sheets_color[c["sheet"]]
    gray = sheets_gray[c["sheet"]]
    x0 = c["col"] * CELL_W
    y0 = c["row"] * CELL_H
    divider_y = find_divider(gray, x0, y0)
    crop_h = max(divider_y - MARGIN, 150)
    crop = sheet_color.crop((x0, y0, x0 + CELL_W, y0 + crop_h))
    out_path = os.path.join(OUT_DIR, f"{c['id']}.jpg")
    crop.save(out_path, quality=90)
    report.append((c["id"], divider_y, crop_h))

print(f"sliced {len(cards)} cards into {OUT_DIR}")
heights = [r[2] for r in report]
print("crop height min/max/avg:", min(heights), max(heights), sum(heights) / len(heights))
for r in sorted(report, key=lambda r: r[1])[:5]:
    print("lowest divider:", r)
for r in sorted(report, key=lambda r: -r[1])[:5]:
    print("highest divider:", r)
