"""Draw the app icon (three macro-coloured arcs around a plate) at the sizes phones ask for.

Usage: python -I tools/build_icons.py public/icons
Only needed if you want to change the icon; the PNGs are already in public/icons.
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

BACKGROUND = (11, 11, 12)
ARCS = [(74, 148, 238), (240, 112, 60), (34, 181, 131)]  # protein, carbs, fat
PLATE = (255, 255, 255)
SUPERSAMPLE = 4


def draw_icon(size, content_scale=1.0):
    big = size * SUPERSAMPLE
    img = Image.new("RGB", (big, big), BACKGROUND)
    d = ImageDraw.Draw(img)
    c = big / 2
    radius = big * 0.29 * content_scale
    stroke = big * 0.105 * content_scale
    gap = 32  # degrees between arcs, before the round caps eat into it
    sweep = 360 / len(ARCS) - gap

    for i, colour in enumerate(ARCS):
        start = -90 + gap / 2 + i * (sweep + gap)
        end = start + sweep
        box = [c - radius - stroke / 2, c - radius - stroke / 2, c + radius + stroke / 2, c + radius + stroke / 2]
        d.arc(box, start, end, fill=colour, width=round(stroke))
        for angle in (start, end):  # round caps
            x = c + radius * math.cos(math.radians(angle))
            y = c + radius * math.sin(math.radians(angle))
            d.ellipse([x - stroke / 2, y - stroke / 2, x + stroke / 2, y + stroke / 2], fill=colour)

    plate = big * 0.085 * content_scale
    d.ellipse([c - plate, c - plate, c + plate, c + plate], fill=PLATE)
    return img.resize((size, size), Image.LANCZOS)


def svg():
    c, radius, stroke, gap = 50, 29, 10.5, 32
    sweep = 360 / len(ARCS) - gap
    paths = []
    for i, (r, g, b) in enumerate(ARCS):
        start = math.radians(-90 + gap / 2 + i * (sweep + gap))
        end = start + math.radians(sweep)
        x1, y1 = c + radius * math.cos(start), c + radius * math.sin(start)
        x2, y2 = c + radius * math.cos(end), c + radius * math.sin(end)
        paths.append(
            f'<path d="M{x1:.2f} {y1:.2f}A{radius} {radius} 0 0 1 {x2:.2f} {y2:.2f}" '
            f'stroke="rgb({r},{g},{b})" stroke-width="{stroke}" stroke-linecap="round" fill="none"/>'
        )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        '<rect width="100" height="100" rx="22" fill="#0b0b0c"/>' + "".join(paths) + '<circle cx="50" cy="50" r="8.5" fill="#fff"/></svg>\n'
    )


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    draw_icon(180).save(out / "icon-180.png", optimize=True)
    draw_icon(192).save(out / "icon-192.png", optimize=True)
    draw_icon(512).save(out / "icon-512.png", optimize=True)
    # Android crops "maskable" icons to a circle or squircle, so keep the artwork inside the middle 72%.
    draw_icon(512, content_scale=0.72).save(out / "icon-maskable-512.png", optimize=True)
    (out / "favicon.svg").write_text(svg(), encoding="utf-8")
    print("icons written to", out)


if __name__ == "__main__":
    main()
