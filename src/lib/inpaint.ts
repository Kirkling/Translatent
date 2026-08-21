// Pixel-level analysis of a source text region.
//
// Instead of stamping a generic rectangle over the original lettering, we look
// at the actual pixels on a fine grid: we learn the surface colour behind the
// glyphs, build a per-pixel ink mask (letter by letter, including anti-aliased
// edges), erase ONLY those pixels, and measure the true ink bounding box +
// line rhythm so the replacement text can be scaled to match the original.

export type RegionAnalysis = {
  plate: string;        // colour of the surface directly behind the glyphs
  ink: string;          // dominant glyph colour
  hasBackdrop: boolean; // true when the text sits on its own plate/bubble
  x: number; y: number; w: number; h: number; // tight ink bbox (px)
  lines: number;        // measured number of text lines
  capHeight: number;    // measured height of one line (px)
  density: number;      // ink coverage 0..1 inside the tight bbox
  reliable: boolean;    // false when the pixel read looks untrustworthy
};

type RGB = { r: number; g: number; b: number };

function dist(a: RGB, b: RGB) {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}
function hex({ r, g, b }: RGB) {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
export function parseHex(v: string): RGB | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v || "");
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

// Finer colour buckets (5 bits/channel instead of 4) so near-identical tones
// are not merged and the plate colour comes back exact.
function dominant(samples: RGB[]): { color: RGB; fraction: number; spread: number } | null {
  if (!samples.length) return null;
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (const s of samples) {
    const key = ((s.r >> 3) << 10) | ((s.g >> 3) << 5) | (s.b >> 3);
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

// Otsu threshold over a 0..765 distance histogram — adapts to faint grey text
// as well as hard black-on-white lettering instead of a single magic number.
function otsu(hist: Uint32Array, total: number) {
  let sum = 0;
  for (let i = 0; i < hist.length; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thresh = 60;
  for (let i = 0; i < hist.length; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thresh = i; }
  }
  return thresh;
}

export function analyzeRegion(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
): RegionAnalysis | null {
  try {
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    const t = ctx.getTransform();
    const sxScale = t.a || 1, syScale = t.d || 1;
    const px = Math.max(0, Math.floor(x * sxScale));
    const py = Math.max(0, Math.floor(y * syScale));
    const pw = Math.min(cw - px, Math.ceil(w * sxScale));
    const ph = Math.min(ch - py, Math.ceil(h * syScale));
    if (pw < 4 || ph < 4) return null;

    // Wider sampling skirt: three concentric bands so we can tell a bubble
    // (calm ring, different surroundings) from flat artwork.
    const near = Math.max(3, Math.round(Math.min(pw, ph) * 0.22));
    const mid = near + Math.max(3, Math.round(Math.min(pw, ph) * 0.25));
    const far = Math.max(mid + 4, Math.round(Math.min(pw, ph) * 0.95));
    const ox = Math.max(0, px - far), oy = Math.max(0, py - far);
    const ow = Math.min(cw - ox, pw + far * 2), oh = Math.min(ch - oy, ph + far * 2);
    const img = ctx.getImageData(ox, oy, ow, oh);
    const d = img.data;
    const at = (ix: number, iy: number): RGB => {
      const o = (iy * ow + ix) * 4;
      return { r: d[o], g: d[o + 1], b: d[o + 2] };
    };
    const bx = px - ox, by = py - oy;

    const nearRing: RGB[] = [];
    const midRing: RGB[] = [];
    const farRing: RGB[] = [];
    for (let iy = 0; iy < oh; iy++) {
      for (let ix = 0; ix < ow; ix++) {
        const insideBox = ix >= bx && ix < bx + pw && iy >= by && iy < by + ph;
        if (insideBox) continue;
        const dx = ix < bx ? bx - ix : ix - (bx + pw) + 1;
        const dy = iy < by ? by - iy : iy - (by + ph) + 1;
        const ring = Math.max(dx > 0 ? dx : 0, dy > 0 ? dy : 0);
        if (ring <= near) nearRing.push(at(ix, iy));
        else if (ring <= mid) midRing.push(at(ix, iy));
        else farRing.push(at(ix, iy));
      }
    }

    const interior: RGB[] = [];
    for (let iy = by; iy < by + ph; iy++)
      for (let ix = bx; ix < bx + pw; ix++) interior.push(at(ix, iy));

    const nearDom = dominant(nearRing) || dominant(interior);
    const intDom = dominant(interior);
    if (!nearDom || !intDom) return null;
    // The surface behind the glyphs: prefer the ring hugging the ink, but if
    // the interior is overwhelmingly one tone (large bubble) trust that.
    const plate = intDom.fraction > 0.55 && nearDom.fraction < 0.35
      ? intDom.color
      : nearDom.fraction >= 0.22 ? nearDom.color : intDom.color;

    // Two-stage container test on a finer grid: the band hugging the text must
    // be calm, and the wider surroundings must break away from it.
    const midDom = dominant(midRing);
    const farDom = dominant(farRing);
    const nearUniform = nearDom.spread < 34 && nearDom.fraction > 0.38;
    const midCalm = !!midDom && dist(midDom.color, plate) < 40 && midDom.spread < 46;
    const farDiffers = !!farDom && (dist(farDom.color, plate) > 38 || farDom.spread > nearDom.spread + 18);
    const hasBackdrop = nearUniform && (farDiffers || (midCalm && !!farDom && farDom.spread > 55));

    // Per-pixel ink mask with an adaptive (Otsu) cut, so faint or coloured
    // lettering is separated as cleanly as solid black print.
    const hist = new Uint32Array(766);
    const dd = new Uint16Array(pw * ph);
    for (let iy = 0; iy < ph; iy++) {
      for (let ix = 0; ix < pw; ix++) {
        const v = dist(at(bx + ix, by + iy), plate);
        dd[iy * pw + ix] = v;
        hist[Math.min(765, v)]++;
      }
    }
    const auto = otsu(hist, pw * ph);
    const thresh = Math.max(38, Math.min(190, auto));

    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    const rowInk = new Array<number>(ph).fill(0);
    const inkSamples: RGB[] = [];
    let inkCount = 0;
    for (let iy = 0; iy < ph; iy++) {
      for (let ix = 0; ix < pw; ix++) {
        if (dd[iy * pw + ix] > thresh) {
          rowInk[iy]++;
          inkCount++;
          if (inkSamples.length < 6000) inkSamples.push(at(bx + ix, by + iy));
          if (ix < minX) minX = ix;
          if (ix > maxX) maxX = ix;
          if (iy < minY) minY = iy;
          if (iy > maxY) maxY = iy;
        }
      }
    }
    const inkDom = dominant(inkSamples);
    const ink = inkDom ? inkDom.color : { r: 17, g: 17, b: 17 };
    const density = inkCount / (pw * ph);

    // Count line bands from the row profile.
    const rowThresh = Math.max(1, Math.round(pw * 0.015));
    let run = 0;
    const runs: number[] = [];
    for (let iy = 0; iy < ph; iy++) {
      if (rowInk[iy] >= rowThresh) run++;
      else if (run) { runs.push(run); run = 0; }
    }
    if (run) runs.push(run);
    const solid = runs.filter((r) => r >= Math.max(2, ph * 0.035));
    const lines = Math.max(1, solid.length);
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
      density,
      // If more than ~62% of the box reads as "ink" the plate guess is almost
      // certainly wrong (we latched onto the glyph colour), so callers should
      // fall back to a solid cover rather than a pixel erase.
      reliable: density > 0.008 && density < 0.62,
    };
  } catch {
    return null;
  }
}

// Erase the original glyphs by repainting ONLY the ink pixels with the
// surrounding surface colour — strictly inside the measured ink box, so
// neighbouring artwork is never flattened.
export function eraseInk(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  plateHex: string,
): boolean {
  try {
    const plate = parseHex(plateHex);
    if (!plate) return false;
    const t = ctx.getTransform();
    const sx = t.a || 1, sy = t.d || 1;
    // Only a hairline of padding: enough for anti-aliased fringes, not enough
    // to bulldoze surrounding illustration detail.
    const pad = Math.max(1, Math.round(Math.min(w * sx, h * sy) * 0.04));
    const ox = Math.max(0, Math.floor(x * sx) - pad);
    const oy = Math.max(0, Math.floor(y * sy) - pad);
    const ow = Math.min(ctx.canvas.width - ox, Math.ceil(w * sx) + pad * 2);
    const oh = Math.min(ctx.canvas.height - oy, Math.ceil(h * sy) + pad * 2);
    if (ow <= 2 || oh <= 2) return false;
    const img = ctx.getImageData(ox, oy, ow, oh);
    const d = img.data;

    const hist = new Uint32Array(766);
    const dd = new Uint16Array(ow * oh);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const v = Math.abs(d[i] - plate.r) + Math.abs(d[i + 1] - plate.g) + Math.abs(d[i + 2] - plate.b);
      dd[p] = v;
      hist[Math.min(765, v)]++;
    }
    const thresh = Math.max(34, Math.min(190, otsu(hist, ow * oh)));

    const mask = new Uint8Array(ow * oh);
    let count = 0;
    for (let p = 0; p < mask.length; p++) if (dd[p] > thresh) { mask[p] = 1; count++; }
    // Nothing sensible to erase, or the "ink" is the whole box.
    if (!count || count / mask.length > 0.72) return false;

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
