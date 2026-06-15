from PIL import Image, ImageDraw

SRC = "/Users/thatsucks/shift/logo-src.jpg"
OUT = "/Users/thatsucks/shift/prometheus-tracer/"

im = Image.open(SRC).convert("RGBA")
px = im.load()
w, h = im.size

# The colored circle is wrapped by a bright near-white sticker ring on a dark
# navy background. The dark navy mountain inside the circle is the same family
# of color as the background, so we can't separate by darkness. Instead we
# detect the bright white ring (the brightest thing in the image): its bounding
# box is the OUTER edge of the circle. We then inset by the ring thickness so
# the crop is the colored disc just inside the ring.
WHITE = 200  # r,g,b all above this == near-white (ring + snow peak)

minx, miny, maxx, maxy = w, h, 0, 0
for y in range(h):
    for x in range(w):
        r, g, b, a = px[x, y]
        if r > WHITE and g > WHITE and b > WHITE:
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y
outer = (minx, miny, maxx + 1, maxy + 1)
print("white-ring (outer) bbox:", outer, "w x h:",
      outer[2] - outer[0], outer[3] - outer[1])

# Measure ring thickness along the center row (left side).
cy = (miny + maxy) // 2
xs = minx
xe = xs
for x in range(minx, minx + 80):
    r, g, b, a = px[x, cy]
    if r > WHITE and g > WHITE and b > WHITE:
        xe = x
    else:
        if xe >= xs:
            break
ring = xe - xs + 1
print("ring thickness ~", ring, "px")

# Inset the outer bbox by ring thickness -> the colored disc bbox.
bbox = (minx + ring, miny + ring, maxx + 1 - ring, maxy + 1 - ring)
bw = bbox[2] - bbox[0]
bh = bbox[3] - bbox[1]
print("inner disc bbox:", bbox, "w x h:", bw, bh, "ratio:", round(bw / bh, 3))

crop = im.crop(bbox)

# Pad to square, centered on transparent canvas
side = max(bw, bh)
square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
square.paste(crop, ((side - bw) // 2, (side - bh) // 2))

# Circular alpha mask, antialiased (4x then downscale)
SS = 4
big = Image.new("L", (side * SS, side * SS), 0)
d = ImageDraw.Draw(big)
d.ellipse((0, 0, side * SS - 1, side * SS - 1), fill=255)
circle = big.resize((side, side), Image.LANCZOS)

square.putalpha(circle)


def save_small(img, path):
    # Flat-color round art -> a palettized PNG with an alpha-aware quantizer is
    # tiny and visually identical. Pillow's FASTOCTREE keeps per-pixel alpha
    # and reserves a fully-transparent palette slot for the round corners.
    q = img.quantize(colors=256, method=Image.FASTOCTREE)
    q.save(path, optimize=True)


for name, size in [
    ("logo.png", 512),
    ("favicon-32.png", 32),
    ("apple-touch-icon.png", 180),
    ("icon-192.png", 192),
    ("icon-512.png", 512),
]:
    save_small(square.resize((size, size), Image.LANCZOS), OUT + name)

# Sanity check on logo.png
chk = Image.open(OUT + "logo.png").convert("RGBA")
print("logo.png size:", chk.size)
cx, cy = chk.size[0] // 2, chk.size[1] // 2
print("corner alpha (0,0):", chk.getpixel((0, 0))[3])
print("corner alpha (max,max):", chk.getpixel((chk.size[0]-1, chk.size[1]-1))[3])
print("center alpha:", chk.getpixel((cx, cy))[3])
