import { createFileRoute } from "@tanstack/react-router";
import { LANG_NAMES } from "@/lib/langs";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function callGateway(messages: unknown[]) {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  const maxAttempts = 5;
  let lastErr = "";
  let suggestedDelayMs = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": key,
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages,
        temperature: 0,
        top_p: 0.1,
        seed: 7,
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return {
        content: data.choices?.[0]?.message?.content ?? "",
        throttleMs: suggestedDelayMs,
      };
    }
    const text = await res.text();
    lastErr = `${res.status}: ${text.slice(0, 200)}`;
    if (res.status === 402) throw new Error("AI credits exhausted for this workspace.");
    if (res.status === 429 || res.status === 503) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const capped = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter, 8) * 1000
        : 1000 * Math.pow(2, attempt);
      const base = Math.min(capped, 8000);
      const jitter = Math.floor(Math.random() * 500);
      // Tell the client to slow down its inter-page pacing on a hit.
      suggestedDelayMs = Math.max(suggestedDelayMs, base + 1000);
      await new Promise((r) => setTimeout(r, base + jitter));
      continue;
    }
    throw new Error(`AI gateway error ${lastErr}`);
  }
  throw new Error(`Rate limited after retries — try again in a minute. (${lastErr})`);
}

function clampHex(v: unknown, fallback: string) {
  return typeof v === "string" && /^#?[0-9a-f]{6}$/i.test(v)
    ? (v.startsWith("#") ? v : `#${v}`)
    : fallback;
}

function parseRegions(raw: string, maxW: number, maxH: number) {
  let cleaned = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  // try to extract a JSON array if model added prose
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
  let arr: unknown;
  try {
    arr = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  type Out = {
    x: number; y: number; w: number; h: number;
    translated: string; original: string; bg: string;
    kind: "bubble" | "narration" | "sfx" | "sign" | "freefloat";
    hasBackdrop: boolean;
    shape: "rounded" | "ellipse" | "rect" | "irregular" | "none";
    angle: number;
    textColor: string;
    strokeColor: string | null;
    style: "print" | "handwritten" | "brush" | "bold" | "italic";
    align: "left" | "center" | "right";
    vertical: boolean;
    capHeight: number;
    lines: number;
  };
  const out: Out[] = [];
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    // Coordinates arrive in a resolution-independent 0–1000 grid, so they map
    // exactly onto the page at ANY resolution (the model sees a downscaled
    // copy). Values > 1000 are treated as legacy pixel coordinates.
    const rawX = Number(o.x), rawY = Number(o.y), rawW = Number(o.w), rawH = Number(o.h);
    const normalized = [rawX, rawY, rawW, rawH].every((n) => Number.isFinite(n) && n <= 1000);
    const sx = normalized ? maxW / 1000 : 1;
    const sy = normalized ? maxH / 1000 : 1;
    const x = rawX * sx;
    const y = rawY * sy;
    const w = rawW * sx;
    const h = rawH * sy;
    const translated = typeof o.translated === "string" ? o.translated : "";
    const original = typeof o.original === "string" ? o.original : "";
    const bg = clampHex(o.bg, "#FFFFFF");
    const kindRaw = typeof o.kind === "string" ? o.kind.toLowerCase() : "bubble";
    const kind: Out["kind"] =
      kindRaw === "narration" || kindRaw === "sfx" || kindRaw === "sign" || kindRaw === "freefloat"
        ? kindRaw
        : "bubble";
    const hasBackdrop = typeof o.hasBackdrop === "boolean"
      ? o.hasBackdrop
      : (kind === "bubble" || kind === "narration");
    const shapeRaw = typeof o.shape === "string" ? o.shape.toLowerCase() : "";
    const shape: Out["shape"] =
      shapeRaw === "ellipse" || shapeRaw === "rect" || shapeRaw === "irregular" || shapeRaw === "none" || shapeRaw === "rounded"
        ? (shapeRaw as Out["shape"])
        : hasBackdrop ? (kind === "narration" ? "rect" : "ellipse") : "none";
    const angleRaw = Number(o.angle);
    const angle = Number.isFinite(angleRaw) ? Math.max(-45, Math.min(45, angleRaw)) : 0;
    const styleRaw = typeof o.style === "string" ? o.style.toLowerCase() : "";
    const style: Out["style"] =
      styleRaw === "handwritten" || styleRaw === "brush" || styleRaw === "bold" || styleRaw === "italic"
        ? (styleRaw as Out["style"])
        : "print";
    const alignRaw = typeof o.align === "string" ? o.align.toLowerCase() : "";
    const align: Out["align"] = alignRaw === "left" || alignRaw === "right" ? alignRaw : "center";
    const vertical = o.vertical === true;
    const capRaw = Number(o.capHeight);
    // capHeight is reported in the same 0–1000 grid as the box.
    const capHeight = Number.isFinite(capRaw) && capRaw > 0
      ? capRaw * (normalized ? maxH / 1000 : 1)
      : 0;
    const linesRaw = Number(o.lines);
    const lines = Number.isFinite(linesRaw) && linesRaw > 0 ? Math.min(12, Math.round(linesRaw)) : 0;
    if (![x, y, w, h].every((n) => Number.isFinite(n))) continue;
    if (w <= 0 || h <= 0) continue;
    if (!translated) continue;
    out.push({
      x: Math.max(0, Math.min(maxW, x)),
      y: Math.max(0, Math.min(maxH, y)),
      w: Math.max(1, Math.min(maxW - x, w)),
      h: Math.max(1, Math.min(maxH - y, h)),
      translated,
      original,
      bg,
      kind,
      hasBackdrop,
      shape,
      angle,
      textColor: clampHex(o.textColor, "#111111"),
      strokeColor: typeof o.strokeColor === "string" && /^#?[0-9a-f]{6}$/i.test(o.strokeColor)
        ? clampHex(o.strokeColor, "#FFFFFF")
        : null,
      style,
      align,
      vertical,
      capHeight: Math.min(h, capHeight || h * 0.8),
      lines,
    });
  }
  return out;
}

export const Route = createFileRoute("/api/translate")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        try {
          const form = await request.formData();
          const image = form.get("image");
          const kind = String(form.get("kind") || "detect");
          const width = Number(form.get("width") || 0);
          const height = Number(form.get("height") || 0);
          const srcLang = String(form.get("srcLang") || "auto");
          const tgtLang = String(form.get("tgtLang") || "en");
          const glossary = String(form.get("glossary") || "");
          const noFlag = String(form.get("noFlag") || "true") === "true";
          const textOnly = String(form.get("textOnly") || "true") === "true";
          const priorContext = String(form.get("priorContext") || "").slice(0, 2000);
          const customInstructions = String(form.get("customInstructions") || "").slice(0, 1500);

          if (!(image instanceof Blob)) return json({ error: "image field required" }, 400);

          const buf = new Uint8Array(await image.arrayBuffer());
          // base64 encode
          let bin = "";
          for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
          const b64 = btoa(bin);
          const mime = image.type || "image/jpeg";
          const dataUrl = `data:${mime};base64,${b64}`;

          if (kind === "presence") {
            const system =
              "You answer with a single word: YES or NO. You check ONLY whether an image contains any readable text characters (dialogue, narration, sound effects, signs, captions) of any language. Do not describe artwork. Respond with exactly one word.";
            const r = await callGateway([
              { role: "system", content: system },
              {
                role: "user",
                content: [
                  { type: "image_url", image_url: { url: dataUrl } },
                  { type: "text", text: "Does this image contain any text? Answer YES or NO only." },
                ],
              },
            ]);
            const ans = r.content.trim().toUpperCase();
            return json({ hasText: ans.startsWith("Y"), throttle: r.throttleMs ? { retryAfterMs: r.throttleMs } : undefined });
          }

          const srcName = LANG_NAMES[srcLang] || LANG_NAMES.auto;
          const tgtName = LANG_NAMES[tgtLang] || "English";

          const scopeRules = textOnly
            ? "SCOPE: Your task is strictly limited to locating and reading TEXT. Do not analyze artwork, characters, poses, expressions, backgrounds, or panel layout. If a region contains no text, do not include it."
            : "Locate all text regions on the page and read their contents.";
          const langRules = noFlag
            ? "LANGUAGE HANDLING: Some dialogue may include crude, vulgar, or aggressive language (insults, profanity, slang). Translate it plainly in the same register as the source — do not censor, soften, or asterisk it out. It is ordinary dialogue translation."
            : "Translate naturally, preserving tone.";
          const glossaryRules = glossary.trim()
            ? `GLOSSARY — apply these term mappings exactly where they occur (one rule per line, "source → target"):\n${glossary}`
            : "";

          const system = [
            `You are a manga text-replacement assistant translating from ${srcName} to ${tgtName}. ${scopeRules}`,
            `WORKFLOW — perform TWO passes deterministically:\n  PASS 1: Scan the page in correct reading order (right-to-left top-to-bottom for Japanese/Chinese, left-to-right top-to-bottom for Korean/English). Enumerate EVERY text region of any kind: dialogue bubbles, narration boxes, sound effects (large and small), signs, labels, handwritten/floating text, off-panel whispers, asterisked notes, even single-character interjections.\n  PASS 2: Re-scan the page from the opposite corner to catch any region missed in pass 1 (especially small SFX and edge text). Merge the two lists; do NOT duplicate regions whose boxes overlap by more than 50%.\n  Then translate the whole page together as a single cohesive scene — pronouns, names, honorifics, and tone must stay consistent across bubbles. Emit one JSON entry per unique region. Be exhaustive: missing a bubble is worse than including a borderline one.`,
            `COORDINATE SYSTEM — MANDATORY: report every geometry value in a resolution-independent grid where the FULL image width is exactly 10000 units and the FULL image height is exactly 10000 units, origin at the TOP-LEFT corner. x = left edge, y = top edge, w = width, h = height, all in that 0–10000 grid (integers or one decimal). This grid is deliberately fine — resolve each box to the nearest few source pixels, not to a coarse guess. Never emit raw pixel values. Bounding boxes must TIGHTLY hug the actual glyph block — no whitespace padding, no bubble margin: the box is the ink extent of the source text only.`,
            `SEPARATION — MANDATORY: every reported box must be disjoint. Boxes may NOT overlap each other and may NOT extend over neighbouring artwork, faces, or a different bubble. If two text blocks sit close together, tighten both boxes until there is a clear gap; if one bubble contains two visually separated line groups spoken by the same character, keep them as ONE region.`,
            `SPEAKER ATTRIBUTION: for each region decide who is speaking by following the bubble's tail/pointer to its owner, or by proximity and panel composition when there is no tail. Report "speaker" as a short stable label you reuse across the whole page for the same character (e.g. "boy-in-cap", "narrator", "offscreen", "sign"). Use it to keep pronouns, register and honorifics consistent, and to make sure each bubble's translation belongs to the right voice — never swap lines between speakers.`,
            `Precision matters more than speed: measure each box against the image edges before reporting it, and double-check that x+w ≤ 10000 and y+h ≤ 10000.`,

            priorContext
              ? `PRIOR CONTEXT — these were the last lines translated on the previous page, use them for continuity (do not re-translate them):\n${priorContext}`
              : "",
            langRules,
            glossaryRules,
            customInstructions.trim()
              ? `USER INSTRUCTIONS — follow these in addition to the rules above:\n${customInstructions.trim()}`
              : "",
            `Respond ONLY with a JSON array, no prose, no markdown fences. Each element: {"x":number,"y":number,"w":number,"h":number,"translated":"...","original":"...","bg":"#RRGGBB","textColor":"#RRGGBB","strokeColor":"#RRGGBB"|null,"kind":"bubble|narration|sfx|sign|freefloat","shape":"ellipse|rounded|rect|irregular|none","hasBackdrop":true|false,"angle":number,"style":"print|handwritten|brush|bold|italic","align":"left|center|right","vertical":true|false,"capHeight":number,"lines":number}. If there is no text at all, respond with [].`,
          ]
            .filter(Boolean)
            .join("\n\n");

          const r = await callGateway([
            { role: "system", content: system },
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: dataUrl } },
                {
                  type: "text",
                  text: `Source page resolution: ${width}x${height} pixels (aspect ratio ${(width / Math.max(1, height)).toFixed(4)}). Read the lettering glyph by glyph and report all geometry in the 0–1000 normalized grid described above, not in pixels. Find every text region, capture its exact box, shape, rotation, colors and lettering style, and translate to ${tgtName}. Respond with ONLY the JSON array.`,
                },
              ],
            },
          ]);

          const regions = parseRegions(r.content, width || 1, height || 1);
          return json({
            regions,
            throttle: r.throttleMs ? { retryAfterMs: r.throttleMs } : undefined,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Return 200 with an error field so the client can show the message
          // without tripping the global runtime-error boundary.
          return json({ error: msg }, 200);
        }
      },
    },
  },
});