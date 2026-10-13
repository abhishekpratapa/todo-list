#!/usr/bin/env python3
"""Renders the app's icons. Pure stdlib: shapes are drawn with signed distance
functions for smooth anti-aliasing.

  build/icon.png                       1024x1024 app icon: indigo rounded square, white check
  electron/assets/trayTemplate.png     18x18 menu bar icon (black + alpha "template" image,
  electron/assets/trayTemplate@2x.png  36x36  which macOS tints for light and dark menu bars)
  public/icons/icon-{180,192,512}.png  full-bleed icons for phone home screens
"""

import math
import os
import struct
import sys
import zlib

SIZE = 1024
# macOS Big Sur+ icon grid: 824px body centered on a 1024px canvas.
BODY = 824
RADIUS = 186
CX = CY = SIZE / 2
TOP = (0x76, 0x76, 0xF2)
BOTTOM = (0x4A, 0x47, 0xC8)
CHECK = [(338, 528), (452, 640), (690, 396)]
STROKE = 50  # half-width of the checkmark stroke


def rounded_rect_sdf(x, y, cy=CY):
    half = BODY / 2 - RADIUS
    qx = abs(x - CX) - half
    qy = abs(y - cy) - half
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - RADIUS


def segment_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def coverage(d):
    return max(0.0, min(1.0, 0.5 - d))


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def over(dst, src_rgb, src_a):
    """Composite a straight-alpha color over a straight-alpha pixel."""
    r, g, b, a = dst
    out_a = src_a + a * (1 - src_a)
    if out_a == 0:
        return (0.0, 0.0, 0.0, 0.0)
    mix = lambda s, d: (s * src_a + d * a * (1 - src_a)) / out_a
    return (mix(src_rgb[0], r), mix(src_rgb[1], g), mix(src_rgb[2], b), out_a)


def render():
    rows = bytearray()
    (ax, ay), (bx, by), (cx, cy) = CHECK
    for y in range(SIZE):
        rows.append(0)  # PNG filter: none
        py = y + 0.5
        t = max(0.0, min(1.0, (py - (CY - BODY / 2)) / BODY))
        fill = tuple(TOP[i] + (BOTTOM[i] - TOP[i]) * t for i in range(3))
        for x in range(SIZE):
            px = x + 0.5
            pixel = (0.0, 0.0, 0.0, 0.0)

            # Soft drop shadow below the body.
            shadow = 0.30 * (1 - smoothstep(-24, 36, rounded_rect_sdf(px, py, CY + 14)))
            if shadow > 0:
                pixel = over(pixel, (0, 0, 0), shadow)

            body = coverage(rounded_rect_sdf(px, py))
            if body > 0:
                pixel = over(pixel, fill, body)
                d = min(segment_dist(px, py, ax, ay, bx, by), segment_dist(px, py, bx, by, cx, cy)) - STROKE
                check = coverage(d) * body
                if check > 0:
                    pixel = over(pixel, (255, 255, 255), check)

            r, g, b, a = pixel
            rows += bytes((round(r), round(g), round(b), round(a * 255)))
    return bytes(rows)


def render_tray(size):
    """Outlined rounded square with a check, drawn on an 18-unit grid."""
    k = size / 18.0
    half, radius, outline = 6.4 * k, 3.4 * k, 0.75 * k  # outline = half the stroke width
    (ax, ay), (bx, by), (cx, cy) = [(x * k, y * k) for x, y in [(5.7, 9.3), (8.0, 11.5), (12.4, 6.7)]]
    stroke = 0.85 * k
    mid = size / 2.0
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        py = y + 0.5
        for x in range(size):
            px = x + 0.5
            qx, qy = abs(px - mid) - (half - radius), abs(py - mid) - (half - radius)
            box = math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - radius
            ring = abs(box) - outline
            check = min(segment_dist(px, py, ax, ay, bx, by), segment_dist(px, py, bx, by, cx, cy)) - stroke
            rows += bytes((0, 0, 0, round(coverage(min(ring, check)) * 255)))
    return bytes(rows)


def render_touch(size):
    """The app icon's artwork filling the whole square, with no rounded corners or
    shadow: phones apply their own mask to home-screen icons."""
    k = size / float(BODY)
    inset = (SIZE - BODY) / 2.0
    (ax, ay), (bx, by), (cx, cy) = [((x - inset) * k, (y - inset) * k) for x, y in CHECK]
    stroke = STROKE * k
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        py = y + 0.5
        fill = [TOP[i] + (BOTTOM[i] - TOP[i]) * (py / size) for i in range(3)]
        for x in range(size):
            px = x + 0.5
            c = coverage(min(segment_dist(px, py, ax, ay, bx, by), segment_dist(px, py, bx, by, cx, cy)) - stroke)
            rows += bytes([round(fill[i] + (255 - fill[i]) * c) for i in range(3)] + [255])
    return bytes(rows)


def write_png(path, raw, size=SIZE):
    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    root = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
    os.makedirs(os.path.join(root, 'build'), exist_ok=True)
    os.makedirs(os.path.join(root, 'electron', 'assets'), exist_ok=True)
    targets = [(os.path.join(root, 'electron', 'assets', 'trayTemplate.png'), 18), (os.path.join(root, 'electron', 'assets', 'trayTemplate@2x.png'), 36)]
    for path, size in targets:
        write_png(path, render_tray(size), size)
        print('wrote', path)
    os.makedirs(os.path.join(root, 'public', 'icons'), exist_ok=True)
    for size in (180, 192, 512):
        path = os.path.join(root, 'public', 'icons', 'icon-%d.png' % size)
        write_png(path, render_touch(size), size)
        print('wrote', path)
    if '--tray-only' not in sys.argv:
        out = os.path.join(root, 'build', 'icon.png')
        write_png(out, render())
        print('wrote', out)
