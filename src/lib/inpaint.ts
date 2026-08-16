// Pixel-level analysis of a source text region.
//
// Instead of stamping a generic rectangle over the original lettering, we look
// at the actual pixels: we learn the surface colour behind the glyphs, build a
// per-pixel ink mask (letter by letter, including anti-aliased edges), erase
// ONLY those pixels, and measure the true ink bounding box + line rhythm so the
// replacement text can be scaled to match the original exactly.

export type RegionAnalysis = {
  plate: string;        // colour of the surface directly behind the glyphs
  ink: string;          // dominant glyph colour
  hasBackdrop: boolean; // true when the text sits on its own plate/bubble
  x: number; y: number; w: number; h: number; // tight ink bbox (px)
  lines: number;        // measured number of text lines
  capHeight: number;    // measured height of one line (px)
};

type RGB = { r: number; g: number; b: number };

function dist(a: RGB, b: RGB) {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}
function hex({ r, g, b }: RGB) {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function dominant(samples: RGB[]): { color: RGB; fraction: number; spread: number } | null {
  if (!samples.length) return null;
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (const s of samples) {
    const key = ((s.r >> 4) << 8) | ((s.g >> 4) << 4) | (s.b >> 4);
    const cur = buckets.get(key);
    if (cur) { cur.r += s.r; cur.g += s.g; cur.b += s.b; cur.n++; }
    else buckets.set(key, { r: s.r, g: s.g, b: s.b, n: 1 });
  }
  let best: { r: number; g: number; b: number; n: number } | null = null;
  buckets.forEach((v) => { if (!best || v.n > best.n) best = v; });
  if (!best) return null;
  const b = best as { r: number; g: number; b: number; n: number };
  const color = { r: b.r / b.n, g: b.g / b.n, b: b.b / b.n };
  let spread = 0;
  for (const s of samples) spread += dist(s, color);
  return { color, fraction: b.n / samples.length, spread: spread / samples.length };
}

export function analyzeRegion(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): RegionAnalysis | null {
  try {
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    // The canvas may be scaled (DPR); getImageData works in device pixels.
    const t = ctx.getTransform();
    const sxScale = t.a || 1, syScale = t.d || 1;
    const px = Math.max(0, Math.floor(x * sxScale));
    const py = Math.max(0, Math.floor(y * syScale));
    const pw = Math.min(cw - px, Math.ceil(w * sxScale));
    const ph = Math.min(ch - py, Math.ceil(h * syScale));
    if (pw < 4 || ph < 4) return null;

    const near = Math.max(2, Math.round(Math.min(pw, ph) * 0.18));
    const far = Math.max(near + 3, Math.round(Math.min(pw, ph) * 0.7));
    const ox = Math.max(0, px - far), oy = Math.max(0, py - far);
    const ow = Math.min(cw - ox, pw + far * 2), oh = Math.min(ch - oy, ph + far * 2);
    const img = ctx.getImageData(ox, oy, ow, oh);
    const d = img.data;
    const at = (ix: number, iy: number): RGB => {
      const o = (iy * ow + ix) * 4;
      return { r: d[o], g: d[o + 1], b: d[o + 2] };
    };
    // Box coordinates inside the sampled patch
    const bx = px - ox, by = py - oy;

    const nearRing: RGB[] = [];
    const farRing: RGB[] = [];
    for (let iy = 0; iy < oh; iy++) {
      for (let ix = 0; ix < ow; ix++) {
        const insideBox = ix >= bx && ix < bx + pw && iy >= by && iy < by + ph;
        if (insideBox) continue;
        const dx = ix < bx ? bx - ix : ix - (bx + pw) + 1;
        const dy = iy < by ? by - iy : iy - (by + ph) + 1;
        const ring = Math.max(dx > 0 ? dx : 0, dy > 0 ? dy : 0);
        if (ring <= near) nearRing.push(at(ix, iy));
        else farRing.push(at(ix, iy));
      }
    }

    const interior: RGB[] = [];
    for (let iy = by; iy < by + ph; iy++)
      for (let ix = bx; ix < bx + pw; ix++) interior.push(at(ix, iy));

    const nearDom = dominant(nearRing) || dominant(interior);
    const intDom = dominant(interior);
    if (!nearDom || !intDom) return null;
    // The surface behind the glyphs: prefer the near ring (just outside the ink)
    // since it is guaranteed to be surface, not glyph.
    const plate = nearDom.fraction >= 0.25 ? nearDom.color : intDom.color;

    // Does the text sit on its own plate (bubble / banner)? Compare the calm
    // surface hugging the text against the wider surroundings: a bubble means
    // the near ring is uniform AND the far ring looks different or busier.
    const farDom = dominant(farRing);
    const nearUniform = nearDom.spread < 26 && nearDom.fraction > 0.45;
    const farDiffers = !!farDom && (dist(farDom.color, plate) > 44 || farDom.spread > nearDom.spread + 22);
    const hasBackdrop = nearUniform && farDiffers;

    // Per-pixel ink mask + tight bbox + row profile (letter-by-letter extents).
    const thresh = 60;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    const rowInk = new Array<number>(ph).fill(0);
    const inkSamples: RGB[] = [];
    for (let iy = 0; iy < ph; iy++) {
      for (let ix = 0; ix < pw; ix++) {
        const c = at(bx + ix, by + iy);
        if (dist(c, plate) > thresh) {
          rowInk[iy]++;
          inkSamples.push(c);
          if (ix < minX) minX = ix;
          if (ix > maxX) maxX = ix;
          if (iy < minY) minY = iy;
          if (iy > maxY) maxY = iy;
        }
      }
    }
    const inkDom = dominant(inkSamples);
    const ink = inkDom ? inkDom.color : { r: 17, g: 17, b: 17 };

    // Count line bands from the row profile.
    const rowThresh = Math.max(1, Math.round(pw * 0.02));
    let lines = 0, run = 0;
    const runs: number[] = [];
    for (let iy = 0; iy < ph; iy++) {
      if (rowInk[iy] >= rowThresh) run++;
      else if (run) { runs.push(run); run = 0; }
    }
    if (run) runs.push(run);
    const solid = runs.filter((r) => r >= Math.max(2, ph * 0.04));
    lines = Math.max(1, solid.length);
    const capHeight = solid.length
      ? solid.reduce((a, b) => a + b, 0) / solid.length / syScale
      : h / lines;

    const box = maxX >= 0
      ? {
          x: x + minX / sxScale,
          y: y + minY / syScale,
          w: Math.max(1, (maxX - minX + 1) / sxScale),
          h: Math.max(1, (maxY - minY + 1) / syScale),
        }
      : { x, y, w, h };

    return {
      plate: hex(plate),
      ink: hex(ink),
      hasBackdrop,
      ...box,
      lines,
      capHeight,
    };
  } catch {
    return null;
  }
}

// Erase the original glyphs by repainting ONLY the ink pixels with the
// surrounding surface colour — no rectangle, so surrounding artwork survives.
export function eraseInk(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  plateHex: string,
): boolean {
  try {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(plateHex);
    if (!m) return false;
    const plate = { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
    const t = ctx.getTransform();
    const sx = t.a || 1, sy = t.d || 1;
    const pad = Math.max(2, Math.round(Math.min(w * sx, h * sy) * 0.12));
    const ox = Math.max(0, Math.floor(x * sx) - pad);
    const oy = Math.max(0, Math.floor(y * sy) - pad);
    const ow = Math.min(ctx.canvas.width - ox, Math.ceil(w * sx) + pad * 2);
    const oh = Math.min(ctx.canvas.height - oy, Math.ceil(h * sy) + pad * 2);
    if (ow <= 0 || oh <= 0) return false;
    const img = ctx.getImageData(ox, oy, ow, oh);
    const d = img.data;
    const mask = new Uint8Array(ow * oh);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const dd = Math.abs(d[i] - plate.r) + Math.abs(d[i + 1] - plate.g) + Math.abs(d[i + 2] - plate.b);
      if (dd > 55) mask[p] = 1;
    }
    // Dilate by 1px so anti-aliased glyph fringes go too.
    const grown = new Uint8Array(mask);
    for (let iy = 1; iy < oh - 1; iy++) {
      for (let ix = 1; ix < ow - 1; ix++) {
        const p = iy * ow + ix;
        if (mask[p]) continue;
        if (mask[p - 1] || mask[p + 1] || mask[p - ow] || mask[p + ow]) grown[p] = 1;
      }
    }
    for (let p = 0; p < grown.length; p++) {
      if (!grown[p]) continue;
      const i = p * 4;
      d[i] = plate.r; d[i + 1] = plate.g; d[i + 2] = plate.b; d[i + 3] = 255;
    }
    ctx.putImageData(img, ox, oy);
    return true;
  } catch {
    return false;
  }
}
