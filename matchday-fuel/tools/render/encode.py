#!/usr/bin/env python3
"""Downsample the supersampled PNG renders and write the WebP assets.

Called by render.mjs with a JSON manifest:
  [{"src": "...png", "outputs": [{"path", "width", "height", "quality", "maxBytes"?}]}]

Each output is resized with Lanczos, encoded as lossy WebP, decoded again and checked: the four
corners must be exactly #FFFFFF (lossy WebP can drift a white pixel to 254), and sequence frames
must stay under maxBytes. If a setting fails, nearby qualities are tried.
"""

import io
import json
import sys

from PIL import Image

CORNER = 6  # px square checked at each corner


def corners_white(img):
    w, h = img.size
    boxes = [(0, 0), (w - CORNER, 0), (0, h - CORNER), (w - CORNER, h - CORNER)]
    for x0, y0 in boxes:
        region = img.crop((x0, y0, x0 + CORNER, y0 + CORNER))
        lo = [band[0] for band in region.getextrema()]
        if min(lo) < 255:
            return False
    return True


def encode(img, quality):
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=quality, method=6)
    data = buf.getvalue()
    decoded = Image.open(io.BytesIO(data)).convert("RGB")
    return data, decoded


def write_output(src_img, out):
    size = (out["width"], out["height"])
    img = src_img.resize(size, Image.LANCZOS, reducing_gap=3.0)
    if not corners_white(img):
        raise SystemExit(f"{out['path']}: corners are not white before encoding; check the render")
    q0 = out["quality"]
    max_bytes = out.get("maxBytes")
    tried = []
    candidates = [q0, q0 - 1, q0 + 1, q0 - 2, q0 + 2, q0 - 3, q0 - 4]
    if max_bytes:
        candidates += list(range(q0 - 5, 49, -3))
    for q in candidates:
        data, decoded = encode(img, q)
        ok_white = corners_white(decoded)
        ok_size = max_bytes is None or len(data) <= max_bytes
        tried.append((q, len(data), ok_white, ok_size))
        if ok_white and ok_size:
            with open(out["path"], "wb") as f:
                f.write(data)
            return q, len(data)
    raise SystemExit(f"{out['path']}: no quality setting met the checks: {tried}")


def main():
    import os

    jobs = json.load(open(sys.argv[1]))
    for job in jobs:
        src = Image.open(job["src"]).convert("RGB")
        for out in job["outputs"]:
            os.makedirs(os.path.dirname(out["path"]), exist_ok=True)
            q, n = write_output(src, out)
            rel = os.path.relpath(out["path"])
            print(f"  wrote {rel} {out['width']}x{out['height']} q{q} {n / 1024:.0f} KB")


if __name__ == "__main__":
    main()
