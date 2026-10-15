#!/usr/bin/env python3
"""Build the Matchday Fuel logo files and its sport-ball variants.

The original logo is a painted illustration: a soccer ball drawn in coffee stains inside a
splashy coffee ring, with black brush lettering across the middle. This script

1. white-balances the original so its cream paper becomes pure #FFFFFF (the browns stay brown),
2. separates it into three layers: the black lettering, the outer coffee ring with its
   droplets, and the ball interior,
3. paints a new interior for baseball, football, basketball, and hockey using texture cut from
   the original's coffee-stained pentagons and recolored along the original's own brown ramp,
4. composites white paper, new interior, original ring, original lettering.

Outputs (paths relative to matchday-fuel/):
    public/assets/logo/matchday-fuel.webp        960 px, original on white
    public/assets/logo/matchday-fuel-720.webp    720 px
    public/assets/logo/matchday-fuel-480.webp    480 px
    public/assets/logo/matchday-fuel-1200.jpg    1200 px social preview
    public/assets/logo/apple-touch-icon.png      180 px
    public/assets/logo/sport-{sport}.webp        960 px
    public/assets/logo/sport-{sport}-720.webp    720 px
    public/assets/logo/sport-{sport}-480.webp    480 px
    tools/logos/out/sport-{sport}.png            1254 px lossless masters

Usage:
    python3 tools/logos/make_sport_logos.py [--src original.png] [--only baseball,hockey]
                                            [--debug DIR]

The source defaults to tools/logos/source/matchday-fuel-original.png (the owner's 1254 px
original, kept here so the build is reproducible).

Needs Python 3.9+, Pillow (with WebP), and numpy. Output is deterministic.
"""

import argparse
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.normpath(os.path.join(HERE, "..", ".."))
DEFAULT_SRC = "/root/.claude/uploads/3460222a-b333-5208-8308-094eb58b7dae/e6ac454a-image.png"
LOCAL_SRC = os.path.join(HERE, "source", "matchday-fuel-original.png")

SPORTS = ["soccer", "baseball", "football", "basketball", "hockey"]
SIZE = 1254

# Ball geometry, measured on the original: center of the coffee ring and the radius at which
# the painted pentagons are cut off.
CX, CY, R0 = 628.0, 637.0, 470.0


# --------------------------------------------------------------------------------------------
# Small image toolkit (numpy + Pillow only)
# --------------------------------------------------------------------------------------------

def _box(a, r, axis):
    if r < 1:
        return a
    n = a.shape[axis]
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r + 1, r)
    p = np.pad(a, pad, mode="edge")
    c = np.cumsum(p, axis=axis, dtype=np.float64)
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(c, np.arange(0, n), axis=axis)
    return ((hi - lo) / (2 * r + 1)).astype(np.float32)


def blur(a, sigma):
    """Gaussian-like blur (three box passes) over the first two axes."""
    if sigma <= 0:
        return a.astype(np.float32)
    w = math.sqrt(12.0 * sigma * sigma / 3.0 + 1.0)
    r = max(1, int(round((w - 1) / 2)))
    out = a.astype(np.float32)
    for _ in range(3):
        out = _box(out, r, 0)
        out = _box(out, r, 1)
    return out


def dilate(mask, radius):
    """Grey dilation with a square of side 2*radius+1."""
    if radius <= 0:
        return mask.astype(np.float32)
    im = Image.fromarray(mask.astype(np.float32), "F")
    left = radius
    while left > 0:
        step = min(left, 3)
        im = im.filter(ImageFilter.MaxFilter(2 * step + 1))
        left -= step
    return np.asarray(im, dtype=np.float32)


def erode(mask, radius):
    return 1.0 - dilate(1.0 - mask.astype(np.float32), radius)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def label(mask):
    """8-connected component labels via row runs and union-find. Returns (labels, count)."""
    h, w = mask.shape
    d = np.diff(np.pad(mask.astype(np.int8), ((0, 0), (1, 1))), axis=1)
    runs, parent = [], []

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    prev = []
    for y in range(h):
        starts = np.nonzero(d[y] == 1)[0].tolist()
        ends = np.nonzero(d[y] == -1)[0].tolist()
        cur, j = [], 0
        for s, e in zip(starts, ends):
            idx = len(runs)
            runs.append((y, s, e))
            parent.append(idx)
            cur.append((s, e, idx))
            while j < len(prev) and prev[j][1] < s:
                j += 1
            k = j
            while k < len(prev) and prev[k][0] <= e:
                ra, rb = find(idx), find(prev[k][2])
                if ra != rb:
                    parent[max(ra, rb)] = min(ra, rb)
                k += 1
        prev = cur
    lab = np.zeros((h, w), np.int32)
    roots = {}
    for i, (y, s, e) in enumerate(runs):
        r = find(i)
        if r not in roots:
            roots[r] = len(roots) + 1
        lab[y, s:e] = roots[r]
    return lab, len(roots)


def fbm(shape, scale, octaves=4, seed=0, persistence=0.5):
    """Fractal value noise, roughly zero mean and unit deviation."""
    rng = np.random.default_rng(seed)
    h, w = shape
    out = np.zeros(shape, np.float32)
    amp, total = 1.0, 0.0
    s = float(scale)
    for _ in range(octaves):
        gh, gw = int(h / s) + 4, int(w / s) + 4
        g = rng.standard_normal((gh, gw)).astype(np.float32)
        big = Image.fromarray(g, "F").resize((int(gw * s), int(gh * s)), Image.BICUBIC)
        arr = np.asarray(big, dtype=np.float32)
        oy, ox = int(s), int(s)
        out += amp * arr[oy:oy + h, ox:ox + w]
        total += amp * amp
        amp *= persistence
        s = max(1.0, s / 2.0)
    out /= math.sqrt(total)
    return out / (out.std() + 1e-6)


def sample(img, x, y):
    """Bilinear sample of img (HxW or HxWxC) at float coordinates x, y."""
    h, w = img.shape[:2]
    x = np.clip(x, 0, w - 1.001)
    y = np.clip(y, 0, h - 1.001)
    x0 = np.floor(x).astype(np.int32)
    y0 = np.floor(y).astype(np.int32)
    fx = (x - x0).astype(np.float32)
    fy = (y - y0).astype(np.float32)
    if img.ndim == 3:
        fx = fx[..., None]
        fy = fy[..., None]
    a = img[y0, x0]
    b = img[y0, x0 + 1]
    c = img[y0 + 1, x0]
    d = img[y0 + 1, x0 + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


GRID_Y, GRID_X = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32)


def warp(img, amp, scale, seed):
    """Displace img by a smooth noise field: a hand-drawn wobble for edges."""
    dx = fbm(img.shape[:2], scale, 3, seed) * amp
    dy = fbm(img.shape[:2], scale, 3, seed + 1) * amp
    return sample(img, GRID_X + dx, GRID_Y + dy)


def rough(mask, seed, wobble=3.0, wobble_scale=40, grain=0.18, soft=1.2, bite=0.0):
    """Turn a clean vector mask into a stained, slightly ragged painted edge."""
    m = warp(mask, wobble, wobble_scale, seed)
    m = blur(m, soft)
    n = fbm(m.shape, 3.0, 3, seed + 7)
    m = m + grain * n * smoothstep(0.02, 0.5, m) * smoothstep(0.98, 0.5, m) - bite
    return smoothstep(0.42, 0.58, m)


def draw_mask(draw_fn, ss=2):
    """Render vector shapes at ss times the size and return an anti-aliased float mask."""
    im = Image.new("L", (SIZE * ss, SIZE * ss), 0)
    d = ImageDraw.Draw(im)
    draw_fn(d, ss)
    im = im.resize((SIZE, SIZE), Image.LANCZOS)
    return np.asarray(im, dtype=np.float32) / 255.0


def thick_polyline(d, pts, width, ss, fill=255):
    """Polyline with round joins, in supersampled coordinates."""
    p = [(x * ss, y * ss) for x, y in pts]
    w = width * ss
    d.line(p, fill=fill, width=int(round(w)), joint="curve")
    r = w / 2.0
    for x, y in (p[0], p[-1]):
        d.ellipse((x - r, y - r, x + r, y + r), fill=fill)


def tapered_stroke(d, pts, w0, w1, ss, fill=255, taper_in=0.15, taper_out=0.2):
    """A brush stroke whose width swells from w0 to w1 and tapers at both ends."""
    n = len(pts)
    for i in range(n):
        t = i / max(1, n - 1)
        w = w0 + (w1 - w0) * math.sin(math.pi * t) if w1 != w0 else w0
        if t < taper_in:
            w *= 0.35 + 0.65 * (t / taper_in)
        if t > 1 - taper_out:
            w *= 0.35 + 0.65 * ((1 - t) / taper_out)
        x, y = pts[i]
        r = w * ss / 2.0
        d.ellipse((x * ss - r, y * ss - r, x * ss + r, y * ss + r), fill=fill)


def resample_path(pts, step):
    """Points every `step` pixels along a polyline."""
    pts = np.asarray(pts, np.float64)
    seg = np.sqrt(((pts[1:] - pts[:-1]) ** 2).sum(1))
    cum = np.r_[0, np.cumsum(seg)]
    n = max(2, int(cum[-1] / step) + 1)
    s = np.linspace(0, cum[-1], n)
    x = np.interp(s, cum, pts[:, 0])
    y = np.interp(s, cum, pts[:, 1])
    return list(zip(x.tolist(), y.tolist()))


# --------------------------------------------------------------------------------------------
# Color: white balance and the original's coffee ramp
# --------------------------------------------------------------------------------------------

def white_balance(a):
    """Scale channels so the paper maps to 255 (clamped). Browns keep their hue."""
    mx, mn = a.max(2), a.min(2)
    paper_guess = np.median(a[(a.mean(2) > 225) & (mx - mn < 40)], axis=0)
    near = np.sqrt(((a - paper_guess) ** 2).sum(2)) < 14
    paper = a[near]
    # The 0.3rd percentile so that the paper's faint grain clips to pure white as well.
    white = np.percentile(paper, 0.3, axis=0)
    out = np.clip(a * (255.0 / white), 0, 255)
    # Knee: anything within a hair of white is paper.
    lo = out.min(2)
    k = smoothstep(246.0, 252.0, lo)[..., None]
    out = out * (1 - k) + 255.0 * k
    return out.astype(np.float32), paper_guess, white


def luminance(rgb):
    return (rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722) / 255.0


def build_ramp(rgb, mask, bins=96):
    """Mean color of the original's coffee pixels for each luminance, dark to paper white."""
    px = rgb[mask > 0.5]
    lum = luminance(px)
    idx = np.clip((lum * (bins - 1)).round().astype(int), 0, bins - 1)
    cnt = np.bincount(idx, minlength=bins).astype(np.float64)
    ramp = np.zeros((bins, 3))
    for c in range(3):
        ramp[:, c] = np.bincount(idx, weights=px[:, c], minlength=bins)
    good = cnt > 30
    t = np.arange(bins) / (bins - 1.0)
    ramp[good] /= cnt[good, None]
    # Pin the ends: paper white at the top, the darkest coffee at the bottom.
    tg = np.r_[t[good], 1.0]
    out = np.zeros((bins, 3))
    for c in range(3):
        vals = np.r_[ramp[good, c], 255.0]
        out[:, c] = np.interp(t, tg, vals)
    # Light smoothing along the ramp.
    k = np.array([1, 2, 3, 2, 1], np.float64)
    k /= k.sum()
    for c in range(3):
        out[:, c] = np.convolve(np.pad(out[:, c], 2, mode="edge"), k, mode="valid")
    out[-1] = 255.0
    return out.astype(np.float32)


def shift_ramp(ramp, hue=0.0, sat=1.0, val=1.0):
    """Hue shift (fraction of a turn), saturation and value scale, in HSV."""
    r = ramp / 255.0
    mx = r.max(1)
    mn = r.min(1)
    d = mx - mn + 1e-9
    h = np.zeros(len(r))
    rr, gg, bb = r[:, 0], r[:, 1], r[:, 2]
    m = mx == rr
    h[m] = ((gg - bb)[m] / d[m]) % 6
    m2 = (mx == gg) & ~m
    h[m2] = (bb - rr)[m2] / d[m2] + 2
    m3 = ~m & ~m2
    h[m3] = (rr - gg)[m3] / d[m3] + 4
    h = (h / 6.0 + hue) % 1.0
    s = np.where(mx > 0, (mx - mn) / (mx + 1e-9), 0) * sat
    s = np.clip(s, 0, 1)
    v = np.clip(mx * val, 0, 1)
    i = np.floor(h * 6).astype(int) % 6
    f = h * 6 - np.floor(h * 6)
    p = v * (1 - s)
    q = v * (1 - f * s)
    t = v * (1 - (1 - f) * s)
    out = np.zeros_like(r)
    sel = [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)]
    for k in range(6):
        mk = i == k
        for c in range(3):
            out[mk, c] = sel[k][c][mk]
    out = out * 255.0
    out[-1] = 255.0
    return out.astype(np.float32)


def apply_ramp(ramp, tone):
    t = np.clip(tone, 0, 1) * (len(ramp) - 1)
    i0 = np.floor(t).astype(np.int32)
    i1 = np.minimum(i0 + 1, len(ramp) - 1)
    f = (t - i0)[..., None]
    return ramp[i0] * (1 - f) + ramp[i1] * f


# --------------------------------------------------------------------------------------------
# Segmentation of the original
# --------------------------------------------------------------------------------------------

class Layers:
    pass


def ink_map(w):
    """0 on paper, 1 on any paint."""
    return np.clip((255.0 - w.min(2)) / 60.0, 0, 1)


def find_cut(w):
    """Closed path through the white gap between the ball's contents and the coffee ring."""
    ink = ink_map(w)
    na = 2048
    th = np.arange(na) * 2 * np.pi / na
    rs = np.arange(R0 - 40, R0 + 30, 1.0)
    T, R = np.meshgrid(th, rs, indexing="ij")
    X = np.clip((CX + R * np.cos(T)).round().astype(int), 0, SIZE - 1)
    Y = np.clip((CY + R * np.sin(T)).round().astype(int), 0, SIZE - 1)
    P = ink[Y, X]
    Pm = P.copy()
    for s in (1, 2, 3):
        Pm[:, s:] = np.maximum(Pm[:, s:], P[:, :-s])
        Pm[:, :-s] = np.maximum(Pm[:, :-s], P[:, s:])
    cost = Pm * 10.0 + np.abs(rs - R0)[None, :] * 0.01
    cost = np.concatenate([cost, cost, cost])
    n, m = cost.shape
    acc = cost[0].copy()
    back = np.zeros((n, m), np.int32)
    idx = np.arange(m)
    lam = 0.3
    for i in range(1, n):
        c = np.stack([np.r_[np.inf, acc[:-1]] + lam, acc, np.r_[acc[1:], np.inf] + lam])
        k = c.argmin(0)
        back[i] = idx + k - 1
        acc = c.min(0) + cost[i]
    j = int(acc.argmin())
    path = np.zeros(n, np.int32)
    path[-1] = j
    for i in range(n - 1, 0, -1):
        j = back[i][j]
        path[i - 1] = j
    return rs[path[na:2 * na]].astype(np.float32)


def polar_field(cut):
    """Per-pixel radius and the cut radius at that pixel's angle."""
    dx = GRID_X - CX
    dy = GRID_Y - CY
    r = np.sqrt(dx * dx + dy * dy)
    ang = np.arctan2(dy, dx) % (2 * np.pi)
    na = len(cut)
    pos = ang / (2 * np.pi) * na
    i0 = np.floor(pos).astype(np.int32) % na
    i1 = (i0 + 1) % na
    f = pos - np.floor(pos)
    rc = cut[i0] * (1 - f) + cut[i1] * f
    return r, ang, rc


def segment(w):
    L = Layers()
    L.w = w
    mx, mn = w.max(2), w.min(2)
    chroma = mx - mn
    lum = w.mean(2)

    # Lettering: near-black, low-chroma ink inside the lettering band whose surroundings are
    # paper (dark spots in the coffee are surrounded by brown and are rejected).
    core = (chroma < 32) & (lum < 150)
    lab, n = label(core)
    brown = (chroma > 45) & (lum < 228)
    around = (dilate(core.astype(np.float32), 3) > 0.5) & ~core
    labd = np.asarray(Image.fromarray(lab.astype(np.float32), "F").filter(ImageFilter.MaxFilter(7))).astype(np.int32)
    area = np.bincount(lab.ravel(), minlength=n + 1)
    rb = np.bincount(labd[around], weights=brown[around], minlength=n + 1)
    rt = np.bincount(labd[around], minlength=n + 1)
    frac = rb / np.maximum(rt, 1)
    cy = np.bincount(lab.ravel(), weights=GRID_Y.ravel(), minlength=n + 1) / np.maximum(area, 1)
    keep = (cy > 395) & (cy < 860) & (frac < 0.35)
    keep[0] = False
    # Small specks out in the ring belong to the ring (it is reproduced as is anyway).
    cut0 = find_cut(w)
    r0, _, rc0 = polar_field(cut0)
    speck_out = np.bincount(lab.ravel(), weights=(r0 > rc0).ravel(), minlength=n + 1) > 0.5 * area
    keep &= ~((area < 400) & speck_out)
    letters_core = keep[lab]
    # Letters and rules only (not the ink specks), for the light and paper around the type.
    L.letter_big = (keep & (area >= 120))[lab].astype(np.float32)
    zone = blur(dilate(letters_core.astype(np.float32), 3), 1.0)
    L.letter_alpha, L.letter_rgb = color_to_alpha(w, zone, 40.0)
    L.letter_core = letters_core

    # Ring: everything outside the cut through the white gap.
    L.cut = cut0
    r, ang, rc = polar_field(L.cut)
    L.r, L.ang, L.rc = r, ang, rc
    L.outside = smoothstep(-1.5, 1.5, r - rc).astype(np.float32)
    ink = ink_map(w)
    L.ring_ink = (ink * L.outside * (1 - L.letter_alpha)).astype(np.float32)

    # Interior coffee: pentagons (large), seam dashes, and small splatter dots.
    inside = (1 - L.outside) > 0.5
    coffee = (ink > 0.35) & inside & (L.letter_alpha < 0.05) & ((chroma > 25) | (lum < 120))
    lab2, n2 = label(coffee)
    area2 = np.bincount(lab2.ravel(), minlength=n2 + 1)
    area2[0] = 0
    big = area2 > 8000
    L.pentagons = big[lab2]
    # Small dots: keep for the new interiors (same hand), away from the pentagons and dashes.
    medium = (area2 > 260) & ~big
    near_big = dilate((big | medium)[lab2].astype(np.float32), 10) > 0.5
    small = (area2 > 0) & (area2 <= 260)
    dots = small[lab2] & ~near_big
    L.dot_alpha, L.dot_rgb = color_to_alpha(w, blur(dilate(dots.astype(np.float32), 2), 0.8), 90.0)

    # The cut, smoothed, is the outline the new balls are painted to.
    k = 9
    cs = np.r_[L.cut[-k:], L.cut, L.cut[:k]].astype(np.float64)
    for _ in range(3):
        cs = np.convolve(cs, np.ones(2 * k + 1) / (2 * k + 1), mode="same")
    L.cut_smooth = cs[k:-k].astype(np.float32)
    _, _, L.rc_smooth = polar_field(L.cut_smooth)

    # The ring as a layer of paint over white (color-to-alpha), so a new ball may fill right up
    # to it, and the outline a full ball is painted to: a little in from the ring's inner edge.
    L.ring_alpha, L.ring_rgb = color_to_alpha(w, L.outside * (1 - L.letter_alpha), 60.0)
    L.ball_edge = ball_outline(L)
    _, _, L.ball_r = polar_field(L.ball_edge)
    return L


def ball_outline(L, gap=9.0):
    """Per-angle radius of a ball that fills the ring, keeping a white gap to its paint."""
    na = len(L.cut)
    th = np.arange(na) * 2 * np.pi / na
    rs = np.arange(380, 560, 1.0)
    T, R = np.meshgrid(th, rs, indexing="ij")
    X = np.clip((CX + R * np.cos(T)).round().astype(int), 0, SIZE - 1)
    Y = np.clip((CY + R * np.sin(T)).round().astype(int), 0, SIZE - 1)
    P = L.ring_ink[Y, X] > 0.25
    P &= rs[None, :] >= (L.cut[:, None] - 2)
    first = np.where(P.any(1), rs[np.argmax(P, axis=1)], rs[-1])
    edge = np.minimum(first - gap, L.cut_smooth + 14.0)
    edge = np.maximum(edge, L.cut_smooth - 30.0)
    # Erode (min filter) then smooth, circularly, so the outline stays inside the gap.
    k = 6
    ext = np.r_[edge[-k:], edge, edge[:k]]
    mins = np.min(np.stack([ext[i:i + na] for i in range(2 * k + 1)]), 0)
    k2 = 10
    ext = np.r_[mins[-k2:], mins, mins[:k2]].astype(np.float64)
    for _ in range(2):
        ext = np.convolve(ext, np.ones(2 * k2 + 1) / (2 * k2 + 1), mode="same")
    return ext[k2:-k2].astype(np.float32)


def color_to_alpha(w, zone, ink_level):
    """Unmix paint from white paper: alpha from darkness, color so that over white it is exact."""
    a = np.clip((255.0 - w.min(2)) / (255.0 - ink_level), 0, 1) * zone
    col = (w - (1 - a[..., None]) * 255.0) / np.maximum(a[..., None], 1e-3)
    return a.astype(np.float32), np.clip(col, 0, 255).astype(np.float32)


# --------------------------------------------------------------------------------------------
# Texture synthesis from the pentagons
# --------------------------------------------------------------------------------------------

def synth_texture(L, seed=11, patch=88, step=34):
    """Dead-leaves synthesis: soft, blobby patches of the original's coffee texture."""
    rng = np.random.default_rng(seed)
    lum = luminance(L.w)
    src_mask = erode(L.pentagons.astype(np.float32), 4)
    # Detail (fine swirls) and mottling, as separate channels so tone can be controlled.
    low = blur(lum, 22)
    detail = lum - blur(lum, 4)
    mottle = blur(lum, 4) - low
    src = np.stack([detail, mottle], -1)
    # Candidate patch corners fully inside a pentagon (integral image test).
    ii = np.pad(np.cumsum(np.cumsum(src_mask > 0.5, 0), 1), ((1, 0), (1, 0)))
    h = SIZE - patch
    ys, xs = np.mgrid[0:h, 0:h]
    full = ii[ys + patch, xs + patch] - ii[ys, xs + patch] - ii[ys + patch, xs] + ii[ys, xs]
    cand = np.argwhere(full >= patch * patch)
    if len(cand) == 0:
        raise SystemExit("no texture patches found in the original")
    out = np.zeros((SIZE + patch, SIZE + patch, 2), np.float32)
    # Blob-shaped soft masks for patches.
    yy, xx = np.mgrid[0:patch, 0:patch].astype(np.float32)
    rr = np.sqrt((xx - patch / 2 + 0.5) ** 2 + (yy - patch / 2 + 0.5) ** 2) / (patch / 2)
    blobs = []
    for k in range(8):
        n = fbm((patch, patch), patch / 3.0, 2, seed + 100 + k) * 0.18
        blobs.append(smoothstep(1.0, 0.62, rr + n))
    positions = []
    for gy in range(-patch // 2, SIZE + patch // 2, step):
        for gx in range(-patch // 2, SIZE + patch // 2, step):
            positions.append((gy + rng.integers(-step // 2, step // 2 + 1),
                              gx + rng.integers(-step // 2, step // 2 + 1)))
    order = rng.permutation(len(positions))
    for oi in order:
        py, px = positions[oi]
        cy, cx = cand[rng.integers(len(cand))]
        p = src[cy:cy + patch, cx:cx + patch]
        rot = rng.integers(4)
        p = np.rot90(p, rot)
        if rng.random() < 0.5:
            p = p[:, ::-1]
        bm = blobs[rng.integers(len(blobs))]
        y0, x0 = py + patch // 2, px + patch // 2
        y0 = int(np.clip(y0, 0, SIZE)); x0 = int(np.clip(x0, 0, SIZE))
        sl = (slice(y0, y0 + patch), slice(x0, x0 + patch))
        region = out[sl]
        hh, ww = region.shape[:2]
        if hh < 1 or ww < 1:
            continue
        m = bm[:hh, :ww, None]
        out[sl] = region * (1 - m) + p[:hh, :ww] * m
    o = patch // 2
    tex = out[o:o + SIZE, o:o + SIZE]
    return tex[..., 0], tex[..., 1]


# --------------------------------------------------------------------------------------------
# Painting helpers
# --------------------------------------------------------------------------------------------

class Painter:
    def __init__(self, L, detail, mottle, ramp):
        self.L = L
        self.detail = detail
        self.mottle = mottle
        self.ramp = ramp
        self.rgb = np.full((SIZE, SIZE, 3), 255.0, np.float32)
        core = L.letter_big
        # A broad, soft lightening over the whole text block. On a ball it reads as light
        # falling on the paint, and it keeps the black lettering legible on dark coffee.
        self.block = np.clip(blur(dilate(core, 12), 26) * 1.8, 0, 1)
        # A tight lift around each letter so brush edges stay crisp on texture (round growth:
        # threshold a blur rather than a square max filter).
        self.halo = smoothstep(0.03, 0.25, blur(core, 2.0))
        # Paper knockout for marks on white ground: in the original the letters sit on paper.
        self.knock = smoothstep(0.02, 0.16, blur(core, 3.0))
        # The small COLD BREW + ENERGY line gets a little more room.
        small = core * (GRID_Y > 795)
        self.knock = np.maximum(self.knock, smoothstep(0.02, 0.16, blur(small, 5.0)))
        # And on dark paint, a soft band of extra light behind it.
        self.small_lift = smoothstep(0.01, 0.12, blur(small, 7.0))

    def tone_texture(self, base, detail_gain=1.0, mottle_gain=1.0, shift=(0, 0)):
        d, m = self.detail, self.mottle
        if shift != (0, 0):
            d = np.roll(d, shift, (0, 1))
            m = np.roll(m, shift, (0, 1))
        return base + d * detail_gain + m * mottle_gain

    def paint(self, alpha, tone, ramp=None, lift=0.0, lift_tone=0.7, halo=0.0, knock=0.0,
              edge_dark=0.10, edge_sigma=3.0, bleed=0.0, opacity=1.0):
        """Composite coffee paint of the given tone through alpha onto the canvas."""
        ramp = self.ramp if ramp is None else ramp
        if knock:
            alpha = alpha * (1 - self.knock * knock)
        if edge_dark:
            # Coffee pools at the edge of a stain as it dries: a darker rim.
            inner = blur(alpha, edge_sigma)
            rim = np.clip(1.0 - inner, 0, 1) * alpha
            tone = tone - edge_dark * rim * 2.0
        if lift:
            w = self.block * lift
            tone = tone * (1 - w) + np.maximum(tone, lift_tone + (tone - tone.mean()) * 0.5) * w
            w = self.small_lift * lift
            tone = tone * (1 - w) + np.maximum(tone, lift_tone + 0.10) * w
        if halo:
            tone = tone + halo * self.halo
        col = apply_ramp(ramp, tone)
        if bleed:
            b = np.clip(blur(alpha, 2.5) - alpha, 0, 1) * bleed * opacity
            bcol = apply_ramp(ramp, np.clip(tone + 0.25, 0, 1))
            self.rgb = self.rgb * (1 - b[..., None]) + bcol * b[..., None]
        a = (alpha * opacity)[..., None]
        self.rgb = self.rgb * (1 - a) + col * a

    def white(self, alpha, strength=0.95):
        a = (alpha * strength)[..., None]
        self.rgb = self.rgb * (1 - a) + 255.0 * a

    def droplets(self, drops, seed, tone=0.32, ramp=None, knock=1.0, avoid=None):
        """Small coffee droplets: round, a darker rim, a little raggedness. Droplets that
        would land on paint (avoid mask), on the lettering, or in the ring are dropped."""
        rng = np.random.default_rng(seed)
        keep = []
        block = np.maximum(self.knock, self.L.outside)
        if avoid is not None:
            block = np.maximum(block, avoid)
        for (x, y, r) in drops:
            ok = True
            for ox, oy in ((0, 0), (r + 6, 0), (-r - 6, 0), (0, r + 6), (0, -r - 6)):
                xi, yi = int(round(x + ox)), int(round(y + oy))
                if not (0 <= xi < SIZE and 0 <= yi < SIZE) or block[yi, xi] > 0.05:
                    ok = False
                    break
            if ok:
                keep.append((x, y, r))
        drops = keep
        if not drops:
            return

        def fn(d, ss):
            for (x, y, r) in drops:
                rx = r * (1 + rng.uniform(-0.15, 0.15))
                ry = r * (1 + rng.uniform(-0.15, 0.15))
                d.ellipse(((x - rx) * ss, (y - ry) * ss, (x + rx) * ss, (y + ry) * ss), fill=255)
        m = draw_mask(fn) * (1 - self.L.outside)
        m = rough(m, seed, wobble=0.7, wobble_scale=8, grain=0.08, soft=0.6)
        t = self.tone_texture(np.full(m.shape, tone, np.float32), 0.5, 0.3)
        self.paint(m, t, ramp, knock=knock, edge_dark=0.10, edge_sigma=1.5)


def spray(rng, around, n, rmin, rmax, size_range):
    """Random droplet positions scattered around a list of points."""
    out = []
    for _ in range(n):
        cx, cy = around[rng.integers(len(around))]
        ang = rng.uniform(0, 2 * math.pi)
        dist = rng.uniform(rmin, rmax)
        r = rng.uniform(*size_range) * (1.0 if rng.random() < 0.7 else 0.5)
        out.append((cx + dist * math.cos(ang), cy + dist * math.sin(ang), r))
    return out


def ball_mask(L, inset=0.0, seed=1):
    """The ball's painted area: inside the ring's gap, following its hand-drawn wobble."""
    edge = L.ball_r - inset
    m = smoothstep(1.0, -1.0, L.r - edge)
    return rough(m, seed, wobble=1.6, wobble_scale=30, grain=0.10, soft=1.0)


def sphere_light(radius, lx=-0.40, ly=-0.50, lz=0.77):
    nx = (GRID_X - CX) / radius
    ny = (GRID_Y - CY) / radius
    rr = np.clip(nx * nx + ny * ny, 0, 1)
    nz = np.sqrt(1 - rr)
    return np.clip(lx * nx + ly * ny + lz * nz, 0, 1)


def inside_arc(center, radius, limit, n=900):
    """Points of a circle that fall inside the ball circle, in order along the arc."""
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    x = center[0] + radius * np.cos(t)
    y = center[1] + radius * np.sin(t)
    ok = (x - CX) ** 2 + (y - CY) ** 2 < limit * limit
    if ok.all() or not ok.any():
        return list(zip(x, y))
    start = int(np.argmax(~ok[:-1] & ok[1:])) + 1 if not ok[0] else int(np.argmax(ok & ~np.roll(ok, 1)))
    idx = [(start + i) % n for i in range(n)]
    pts = []
    for i in idx:
        if not ok[i]:
            break
        pts.append((x[i], y[i]))
    return pts


# --------------------------------------------------------------------------------------------
# Sports
# --------------------------------------------------------------------------------------------

def paint_baseball(P, L):
    rng = np.random.default_rng(301)
    red = shift_ramp(P.ramp, hue=-0.03, sat=1.25, val=1.0)
    R = 458.0
    rot = math.radians(-12.0)
    inside = ball_mask(L, inset=2, seed=5)

    # A faint coffee shadow along the lower right rim gives the white ball some roundness,
    # the way the darker sides of the original's pentagons do.
    rim = smoothstep(95.0, 0.0, L.ball_r - 2.0 - L.r)
    side = np.clip(0.5 + 0.5 * ((GRID_X - CX) * 0.55 + (GRID_Y - CY) * 0.83) / 300.0, 0, 1)
    shade = inside * rim * side ** 1.5
    t = P.tone_texture(np.full(shade.shape, 0.80, np.float32), 0.45, 0.7, shift=(25, -35))
    P.paint(shade * 0.50, t, P.ramp, knock=1.0, edge_dark=0.0)

    # Seams: arcs of circles as large as the ball, set off above and below its center, so they
    # curve toward the middle like the stitching on a ball turned on its side.
    seams = []
    for k in (-1, 1):
        dx, dy = math.sin(rot) * k, math.cos(rot) * k   # k=-1: top seam
        off = 1.52 * R
        sc = (CX + dx * off, CY + dy * off)
        seams.append(inside_arc(sc, R, R + 40))

    def seam_fn(d, ss):
        for pts in seams:
            tapered_stroke(d, resample_path(pts, 1.5), 6.5, 7.5, ss, taper_in=0.0, taper_out=0.0)
    seam = draw_mask(seam_fn) * inside
    seam = rough(seam, 31, wobble=1.4, wobble_scale=26, grain=0.25, soft=0.9)
    t = P.tone_texture(np.full(seam.shape, 0.40, np.float32), 0.8, 0.6, shift=(40, 90))
    P.paint(seam, t, red, knock=1.0, edge_dark=0.05, bleed=0.30)

    # V stitches: short strokes on both sides of each seam, angled back along it.
    def stitch_fn(d, ss):
        for pts in seams:
            arr = np.array(resample_path(pts, 1.0))
            total = len(arr)
            spacing = 33.0
            pos = rng.uniform(0, spacing)
            while pos < total:
                i = int(pos)
                p = arr[i]
                tv = arr[min(i + 3, total - 1)] - arr[max(i - 3, 0)]
                tv = tv / (np.linalg.norm(tv) + 1e-9)
                nv = np.array([-tv[1], tv[0]])
                for s in (-1, 1):
                    arm = 23.0 + rng.uniform(-3.0, 3.0)
                    back = 11.0 + rng.uniform(-2.0, 2.0)
                    tip = p + nv * s * arm - tv * back + rng.uniform(-1.2, 1.2, 2)
                    base = p + nv * s * 2.0 + tv * 3.0
                    w = 8.5 + rng.uniform(-1.0, 1.0)
                    tapered_stroke(d, resample_path([tuple(base), tuple(tip)], 1.0),
                                   w, w, ss, taper_in=0.05, taper_out=0.5)
                pos += spacing + rng.uniform(-1.5, 1.5)
    st = draw_mask(stitch_fn) * inside
    st = rough(st, 41, wobble=1.0, wobble_scale=14, grain=0.28, soft=0.8)
    t = P.tone_texture(np.full(st.shape, 0.26, np.float32), 0.8, 0.5, shift=(-60, 20))
    P.paint(st, t, red, knock=1.0, edge_dark=0.06, bleed=0.35)

    drops = []
    for pts in seams:
        drops += spray(rng, pts[60:-60:8], 22, 30, 90, (1.8, 4.6))
    P.droplets(drops, 55, tone=0.34, ramp=red, avoid=dilate(np.maximum(st, seam), 4))


def paint_basketball(P, L):
    rng = np.random.default_rng(401)
    orange = shift_ramp(P.ramp, hue=0.006, sat=1.12, val=1.0)
    m = ball_mask(L, inset=0, seed=9)
    light = sphere_light(455.0)
    base = 0.24 + 0.30 * light + fbm(m.shape, 140, 3, 77) * 0.03
    t = P.tone_texture(base, 1.0, 1.0)
    P.paint(m, t, orange, lift=0.9, lift_tone=0.55, halo=0.08, edge_dark=0.12, edge_sigma=6.0)

    # Channels: one vertical, one horizontal, and the two side curves bowing inward.
    R = 470.0
    lines = [
        [(CX + 10 * math.sin(i / 200.0 * math.pi), CY - R + 2 * R * i / 200.0) for i in range(201)],
        [(CX - R + 2 * R * i / 200.0, CY - 8 * math.sin(i / 200.0 * math.pi)) for i in range(201)],
    ]
    for side in (-1, 1):
        sc = CX + side * 1.27 * 455.0
        rad = 0.80 * 455.0
        pts = []
        for i in range(201):
            tt = -1.45 + 2.9 * i / 200.0
            ang = (math.pi + tt) if side > 0 else tt
            pts.append((sc + rad * math.cos(ang), CY + rad * math.sin(ang)))
        lines.append(pts)

    def fn(d, ss):
        for pts in lines:
            tapered_stroke(d, resample_path(pts, 1.5), 19.0, 23.0, ss, taper_in=0.0, taper_out=0.0)
    lm = draw_mask(fn) * m
    lm = rough(lm, 47, wobble=1.8, wobble_scale=30, grain=0.25, soft=1.0)
    t = P.tone_texture(np.full(lm.shape, 0.035, np.float32), 0.5, 0.4, shift=(70, -30))
    P.paint(lm, t, P.ramp, lift=0.7, lift_tone=0.34, halo=0.1, edge_dark=0.0, bleed=0.25)


def paint_football(P, L):
    rng = np.random.default_rng(501)
    leather = shift_ramp(P.ramp, hue=-0.004, sat=1.02, val=0.98)
    ang = math.radians(-38.0)       # long axis; negative tilts it up to the right
    ux, uy = math.cos(ang), math.sin(ang)
    vx, vy = -uy, ux
    a, b = 440.0, 268.0
    lx = (GRID_X - CX) * ux + (GRID_Y - CY) * uy     # along the long axis
    ly = (GRID_X - CX) * vx + (GRID_Y - CY) * vy     # across it
    # Silhouette: a full, rounded belly that narrows to the points, with the points slightly
    # rounded (blur and re-threshold rounds convex corners only), like a real ball. The fuller
    # curve keeps it from reading as a diamond at label size.
    u = np.clip(np.abs(lx) / a, 0, 1)
    q = 1 - u * u
    half = b * q ** 0.62 * (np.abs(lx) < a)
    sd = half - np.abs(ly)
    body = smoothstep(-1.0, 1.0, sd)
    body = smoothstep(0.45, 0.55, blur(body, 4.0)) * (1 - L.outside)
    body = rough(body, 13, wobble=1.6, wobble_scale=34, grain=0.12, soft=1.2)
    hp = np.maximum(half, 1)
    across = np.clip(ly / hp, -1, 1)
    along = np.clip(np.abs(lx) / a, 0, 1)
    light = np.clip(1 - (across + 0.25) ** 2, 0, 1) ** 0.6 * (1 - along ** 2.2)
    base = 0.11 + 0.27 * light + fbm(body.shape, 120, 3, 88) * 0.03
    t = P.tone_texture(base, 1.0, 1.1)
    P.paint(body, t, leather, lift=0.8, lift_tone=0.47, halo=0.08, edge_dark=0.12, edge_sigma=5.0)

    # White end stripes near each tip, bent with the ball's curvature.
    stripes = np.zeros_like(body)
    for s in (-1, 1):
        c0 = s * 0.58 * a
        bend = 30.0 * (ly / b) ** 2 * s
        dist = np.abs(lx - c0 + bend)
        stripes = np.maximum(stripes, smoothstep(19.0, 16.0, dist))
    stripes = rough(stripes * erode(body, 7), 17, wobble=1.5, wobble_scale=22, grain=0.22, soft=0.8)
    P.white(stripes, 0.95)

    # Laces along the middle: a seam with crossbars. They sit behind the lettering, so only
    # the pieces between the letters show, as on a ball held behind a sign.
    def lace_fn(d, ss):
        L0 = 0.30 * a
        pts = [(CX + ux * s, CY + uy * s) for s in np.linspace(-L0, L0, 60)]
        thick_polyline(d, pts, 8.0, ss)
        n = 8
        for i in range(n):
            s = -L0 * 0.86 + 2 * L0 * 0.86 * i / (n - 1)
            px, py = CX + ux * s, CY + uy * s
            w = 42.0 * (1 - 0.2 * abs(s) / L0)
            tapered_stroke(d, resample_path([(px - vx * w, py - vy * w), (px + vx * w, py + vy * w)], 1.0),
                           14.0, 14.0, ss, taper_in=0.12, taper_out=0.12)
    lace = rough(draw_mask(lace_fn), 19, wobble=1.0, wobble_scale=16, grain=0.2, soft=0.7)
    P.white(lace, 0.96)

    tips = [(CX + ux * s * a * 0.95, CY + uy * s * a * 0.95) for s in (-1, 1)]
    P.droplets(spray(rng, tips, 30, 30, 90, (2.0, 5.0)), 77, tone=0.2, ramp=leather,
               avoid=dilate(body, 3))


def paint_hockey(P, L):
    rng = np.random.default_rng(601)
    wood = shift_ramp(P.ramp, hue=0.0, sat=1.05, val=1.0)

    # Two crossed sticks: shafts from the upper sides, crossing behind FUEL, blades at the
    # bottom turned outward. The puck sits below the lettering.
    sticks = []
    for side in (-1, 1):
        top = (CX + side * 292.0, CY - 322.0)
        heel = (CX - side * 128.0, CY + 262.0)
        sticks.append((top, heel, -side))

    def shaft_fn(d, ss):
        for top, heel, out in sticks:
            tapered_stroke(d, resample_path([top, heel], 1.5), 44.0, 44.0, ss, taper_in=0.0, taper_out=0.0)

    def blade_fn(d, ss):
        for top, (hx, hy), out in sticks:
            poly = [(-18, -34), (-22, 4), (-12, 28), (30, 36), (110, 37), (180, 32), (210, 20),
                    (220, 0), (212, -16), (165, -17), (95, -19), (32, -23), (8, -34)]
            d.polygon([((hx + out * px) * ss, (hy + py) * ss) for px, py in poly], fill=255)
    stick = np.maximum(draw_mask(shaft_fn), draw_mask(blade_fn)) * (1 - L.outside)
    stick = rough(stick, 61, wobble=1.6, wobble_scale=30, grain=0.16, soft=1.0)
    # Wood: a touch lighter down the middle of each shaft, darker at the edges.
    t = P.tone_texture(np.full(stick.shape, 0.31, np.float32) + 0.06 * erode(stick, 8), 1.05, 1.1, shift=(30, 30))
    P.paint(stick, t, wood, knock=1.0, edge_dark=0.13, edge_sigma=3.0, bleed=0.2)

    # Tape: a dark knob at the butt and a wrapped band on each blade.
    def tape_fn(d, ss):
        for (tx, ty), (hx, hy), out in sticks:
            ln = math.hypot(hx - tx, hy - ty)
            ux, uy = (hx - tx) / ln, (hy - ty) / ln
            thick_polyline(d, [(tx - ux * 6, ty - uy * 6), (tx + ux * 70, ty + uy * 70)], 48.0, ss)

    def blade_tape_fn(d, ss):
        for top, (hx, hy), out in sticks:
            x0, x1 = hx + out * 64, hx + out * 176
            d.polygon([(min(x0, x1) * ss, (hy - 44) * ss), (max(x0, x1) * ss, (hy - 44) * ss),
                       (max(x0, x1) * ss + out * 6 * ss, (hy + 44) * ss),
                       (min(x0, x1) * ss + out * 6 * ss, (hy + 44) * ss)], fill=255)
    tape = draw_mask(tape_fn) * stick
    t = P.tone_texture(np.full(tape.shape, 0.10, np.float32), 0.6, 0.5)
    P.paint(tape, t, wood, knock=1.0, edge_dark=0.0)
    btape = draw_mask(blade_tape_fn) * stick
    wraps = 0.5 + 0.5 * np.sin((GRID_X + GRID_Y * 0.35) / 5.0)
    t = P.tone_texture(0.10 + 0.08 * wraps, 0.5, 0.4)
    P.paint(btape, t, wood, knock=1.0, edge_dark=0.0)

    # The puck, at an angle: a top face over a band of side, coffee-black, with a lighter
    # worn edge where the face meets the side.
    px, py = CX, CY + 338.0
    rx, ry, hgt = 120.0, 40.0, 44.0

    def puck_fn(d, ss):
        d.ellipse(((px - rx) * ss, (py + hgt - ry) * ss, (px + rx) * ss, (py + hgt + ry) * ss), fill=255)
        d.rectangle(((px - rx) * ss, py * ss, (px + rx) * ss, (py + hgt) * ss), fill=255)
        d.ellipse(((px - rx) * ss, (py - ry) * ss, (px + rx) * ss, (py + ry) * ss), fill=255)

    def top_fn(d, ss):
        d.ellipse(((px - rx + 2) * ss, (py - ry + 1) * ss, (px + rx - 2) * ss, (py + ry - 1) * ss), fill=255)
    pm = rough(draw_mask(puck_fn), 71, wobble=1.3, wobble_scale=26, grain=0.14, soft=0.9)
    side_light = np.clip(1 - np.abs((GRID_X - px + 40) / rx), 0, 1)
    t = P.tone_texture(0.02 + 0.05 * side_light, 0.35, 0.35, shift=(-40, 70))
    P.paint(pm, t, P.ramp, edge_dark=0.0)
    top = rough(draw_mask(top_fn), 72, wobble=1.0, wobble_scale=26, grain=0.12, soft=0.9)
    # The worn edge: a thin lighter ring just inside the top face's outline.
    ring = np.clip(top - erode(top, 5), 0, 1)
    ring = blur(ring, 1.2) * top
    lit = np.clip(1 - ((GRID_X - px + 35) / rx) ** 2 - ((GRID_Y - py + 10) / ry) ** 2, 0, 1)
    t = P.tone_texture(0.07 + 0.08 * lit + 0.22 * ring, 0.6, 0.6, shift=(50, -40))
    P.paint(top, t, P.ramp, edge_dark=0.0)

    drops = spray(rng, [(px - 95, py + 55), (px + 95, py + 55)], 16, 24, 80, (1.6, 3.6))
    drops += spray(rng, [(s[1][0] + s[2] * 200, s[1][1]) for s in sticks], 16, 26, 80, (1.6, 4.0))
    drops += spray(rng, [s[0] for s in sticks], 10, 30, 70, (1.6, 3.6))
    P.droplets(drops, 88, tone=0.26, ramp=wood, avoid=dilate(np.maximum(stick, pm), 3))


# --------------------------------------------------------------------------------------------
# Composite and output
# --------------------------------------------------------------------------------------------

def composite(P, L):
    rgb = P.rgb
    # The original's loose splatter dots inside the ball, for continuity of hand.
    a = L.dot_alpha[..., None]
    rgb = rgb * (1 - a) + L.dot_rgb * a
    # White gap around the ring's paint, as in the original.
    gap = np.clip(blur(dilate(L.ring_ink, 5), 2.0) * 1.3, 0, 1)
    rgb = rgb * (1 - gap[..., None]) + 255.0 * gap[..., None]
    # The original ring, as paint over the (now white) ground.
    a = L.ring_alpha[..., None]
    rgb = rgb * (1 - a) + L.ring_rgb * a
    # The lettering on top.
    a = L.letter_alpha[..., None]
    rgb = rgb * (1 - a) + L.letter_rgb * a
    return np.clip(rgb, 0, 255)


def to_image(rgb):
    return Image.fromarray(np.clip(rgb + 0.5, 0, 255).astype(np.uint8), "RGB")


def _white_errors(decoded, master):
    """Corner pixels that are not pure white, and paper pixels far from paint that drifted."""
    size = decoded.shape[0]
    k = max(4, size // 40)
    c = np.concatenate([decoded[:k, :k], decoded[:k, -k:], decoded[-k:, :k], decoded[-k:, -k:]])
    corners = int((c.reshape(-1, 3) < 255).any(1).sum())
    paper = Image.fromarray(((master.min(2) == 255) * 255).astype(np.uint8))
    for _ in range(8):
        paper = paper.filter(ImageFilter.MinFilter(3))
    far = np.asarray(paper) > 0
    return corners, int((decoded[far].min(1) < 255).sum())


def save_webp(img, path):
    """Lossy WebP whose white paper decodes as exact #FFFFFF: of a few nearby qualities, keep
    the one with pure-white corners and the fewest drifted paper pixels."""
    import io
    master = np.asarray(img)
    best = None
    for q in (90, 89, 88, 87, 86, 92, 94, 96):
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=q, method=6)
        dec = np.asarray(Image.open(io.BytesIO(buf.getvalue())).convert("RGB"))
        corners, drift = _white_errors(dec, master)
        if corners == 0 and (best is None or drift < best[0]):
            best = (drift, q, buf.getvalue())
        if best is not None and best[0] <= 400:
            break
    if best is None:
        img.save(path, "WEBP", lossless=True, method=6)
        return
    with open(path, "wb") as f:
        f.write(best[2])


def save_variant(img, base, sizes):
    for size, path in sizes:
        out = img if size == img.width else img.resize((size, size), Image.LANCZOS)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if path.endswith(".webp"):
            save_webp(out, path)
        elif path.endswith(".jpg"):
            out.save(path, "JPEG", quality=90, optimize=True, progressive=True)
        else:
            out.save(path, "PNG", optimize=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--src", default=None, help="original logo PNG")
    ap.add_argument("--debug", default=None, help="directory for intermediate images")
    ap.add_argument("--only", default=None, help="comma-separated sports to build")
    args = ap.parse_args()
    src = args.src or (LOCAL_SRC if os.path.exists(LOCAL_SRC) else DEFAULT_SRC)
    img = Image.open(src).convert("RGB")
    if img.size != (SIZE, SIZE):
        img = img.resize((SIZE, SIZE), Image.LANCZOS)
    a = np.asarray(img, dtype=np.float32)
    w, paper, white = white_balance(a)
    print("paper", paper.round(1).tolist(), "white point", white.round(1).tolist())

    logo_dir = os.path.join(PROJECT, "public", "assets", "logo")
    out_dir = os.path.join(HERE, "out")
    os.makedirs(logo_dir, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)

    original = to_image(w)
    save_variant(original, "matchday-fuel", [
        (960, os.path.join(logo_dir, "matchday-fuel.webp")),
        (720, os.path.join(logo_dir, "matchday-fuel-720.webp")),
        (480, os.path.join(logo_dir, "matchday-fuel-480.webp")),
        (1200, os.path.join(logo_dir, "matchday-fuel-1200.jpg")),
        (180, os.path.join(logo_dir, "apple-touch-icon.png")),
    ])

    L = segment(w)
    if args.debug:
        os.makedirs(args.debug, exist_ok=True)

        def layer(alpha, rgb, name):
            a_ = alpha[..., None]
            to_image(255.0 * (1 - a_) + rgb * a_).save(os.path.join(args.debug, name))
        layer(L.letter_alpha, L.letter_rgb, "letters.png")
        layer(L.ring_alpha, L.ring_rgb, "ring.png")
        layer(L.dot_alpha, L.dot_rgb, "dots.png")
        layer(L.pentagons.astype(np.float32), w, "pentagons.png")
        layer(1 - L.outside, w, "interior.png")

    ramp = build_ramp(w, erode(L.pentagons.astype(np.float32), 2))
    detail, mottle = synth_texture(L)
    if args.debug:
        strip = np.repeat(ramp[None, :, :], 40, 0)
        to_image(np.asarray(Image.fromarray(strip.astype(np.uint8)).resize((960, 40)))).save(
            os.path.join(args.debug, "ramp.png"))
        to_image(apply_ramp(ramp, 0.45 + detail + mottle)).save(os.path.join(args.debug, "texture.png"))

    painters = {
        "baseball": paint_baseball,
        "football": paint_football,
        "basketball": paint_basketball,
        "hockey": paint_hockey,
    }
    only = set(args.only.split(",")) if args.only else set(SPORTS)
    for sport in SPORTS:
        if sport not in only:
            continue
        if sport == "soccer":
            im = original
        else:
            P = Painter(L, detail, mottle, ramp)
            painters[sport](P, L)
            im = to_image(composite(P, L))
        im.save(os.path.join(out_dir, "sport-%s.png" % sport), "PNG", optimize=True)
        save_variant(im, sport, [
            (960, os.path.join(logo_dir, "sport-%s.webp" % sport)),
            (720, os.path.join(logo_dir, "sport-%s-720.webp" % sport)),
            (480, os.path.join(logo_dir, "sport-%s-480.webp" % sport)),
        ])
        print("built", sport)


if __name__ == "__main__":
    main()
