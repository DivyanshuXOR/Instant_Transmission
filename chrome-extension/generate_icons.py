"""Generate extension icons for Instant Transmission."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math

def create_icon(size: int, path: str):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx, cy = size / 2, size / 2
    r = size * 0.45

    # Dark circle background
    draw.ellipse(
        [cx - r, cy - r, cx + r, cy + r],
        fill=(13, 17, 23, 255),
        outline=(79, 195, 247, 255),
        width=max(2, size // 24),
    )

    # Lightning bolt ⚡
    bolt_size = size * 0.45
    bx, by = cx, cy - bolt_size * 0.1
    points = [
        (bx - bolt_size * 0.15, by - bolt_size * 0.45),  # top left
        (bx + bolt_size * 0.2, by - bolt_size * 0.45),   # top right
        (bx + bolt_size * 0.02, by - bolt_size * 0.05),  # middle right
        (bx + bolt_size * 0.25, by - bolt_size * 0.05),  # mid-right extended
        (bx - bolt_size * 0.05, by + bolt_size * 0.5),   # bottom point
        (bx + bolt_size * 0.05, by + bolt_size * 0.1),   # mid-left inner
        (bx - bolt_size * 0.18, by + bolt_size * 0.1),   # mid-left
    ]
    draw.polygon(points, fill=(79, 195, 247, 255))

    # Inner bright highlight
    highlight = [
        (bx - bolt_size * 0.08, by - bolt_size * 0.35),
        (bx + bolt_size * 0.1, by - bolt_size * 0.35),
        (bx + bolt_size * 0.0, by - bolt_size * 0.08),
        (bx + bolt_size * 0.12, by - bolt_size * 0.08),
        (bx - bolt_size * 0.02, by + bolt_size * 0.35),
        (bx + bolt_size * 0.04, by + bolt_size * 0.06),
        (bx - bolt_size * 0.08, by + bolt_size * 0.06),
    ]
    draw.polygon(highlight, fill=(200, 230, 255, 200))

    # Glow effect
    glow = img.copy()
    glow = glow.filter(ImageFilter.GaussianBlur(radius=size // 12))
    result = Image.alpha_composite(glow, img)
    result.save(path)
    print(f"Created {path} ({size}x{size})")


create_icon(48, "icons/icon48.png")
create_icon(128, "icons/icon128.png")

