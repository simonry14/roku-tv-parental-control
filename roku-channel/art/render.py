"""
Renders the channel artwork (roku-channel/images/*) from the SVG sources in this folder.

    pip install playwright pillow && python -m playwright install chromium
    python roku-channel/art/render.py

Only needed if you change the artwork; the rendered images are committed. Colours match the
dashboard's dark theme ("living room at dusk"): midnight #10152a, dusk violet #a494ff.
"""
import base64
from io import BytesIO
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

ART = Path(__file__).resolve().parent
OUT = ART.parent / "images"
FONTS = ART.parent / "fonts"

# (source svg, output file, width, height, transparent background)
JOBS = [
    ("background.svg", "background.jpg", 1920, 1080, False),
    ("tile.svg", "icon_focus_fhd.png", 540, 405, False),
    ("tile.svg", "icon_focus_hd.png", 290, 218, False),
] + [(f"icon-{k}.svg", f"{k}.png", 176, 176, True) for k in
     ["blocked", "budget", "schedule", "lock", "warning", "message", "info"]]


def font(name: str) -> str:
    return "data:font/ttf;base64," + base64.b64encode((FONTS / name).read_bytes()).decode()


def page(svg: str, w: int, h: int) -> str:
    return f"""<!doctype html><html><head><style>
@font-face {{ font-family: Rubik; font-weight: 500; src: url('{font("Rubik-Medium.ttf")}'); }}
@font-face {{ font-family: Rubik; font-weight: 600; src: url('{font("Rubik-SemiBold.ttf")}'); }}
html, body {{ margin: 0; background: transparent; }}
svg {{ display: block; width: {w}px; height: {h}px; }}
</style></head><body>{svg}</body></html>"""


def main() -> None:
    OUT.mkdir(exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for src, out, w, h, transparent in JOBS:
            svg = (ART / src).read_text(encoding="utf8")
            pg = browser.new_page(viewport={"width": w, "height": h})
            pg.set_content(page(svg, w, h))
            pg.evaluate("document.fonts.ready")
            png = pg.screenshot(omit_background=transparent, clip={"x": 0, "y": 0, "width": w, "height": h})
            pg.close()
            img = Image.open(BytesIO(png))
            if out.endswith(".jpg"):
                img.convert("RGB").save(OUT / out, quality=90, optimize=True, progressive=False)
            else:
                img.save(OUT / out, optimize=True)
            print(f"{out:24} {w}x{h}  {(OUT / out).stat().st_size // 1024} KB")
        browser.close()


if __name__ == "__main__":
    main()
