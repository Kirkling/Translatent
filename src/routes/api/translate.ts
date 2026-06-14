import { createFileRoute } from "@tanstack/react-router";

const LANG_NAMES: Record<string, string> = {
  auto: "the source language (auto-detect Japanese, Chinese, or Korean)",
  ja: "Japanese",
  zh: "Chinese",
  ko: "Korean",
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
};

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
  const maxAttempts = 3;
  let lastErr = "";
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
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? "";
    }
    const text = await res.text();
    lastErr = `${res.status}: ${text.slice(0, 200)}`;
    if (res.status === 402) throw new Error("AI credits exhausted for this workspace.");
    if (res.status === 429 || res.status === 503) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const capped = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 800 * Math.pow(2, attempt);
      const base = Math.min(capped, 4000);
      const jitter = Math.floor(Math.random() * 300);
      await new Promise((r) => setTimeout(r, base + jitter));
      continue;
    }
    throw new Error(`AI gateway error ${lastErr}`);
  }
  throw new Error(`Rate limited after retries — try again in a minute. (${lastErr})`);
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
  const out: Array<{ x: number; y: number; w: number; h: number; translated: string; bg: string }> = [];
  for (const r of arr) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const x = Number(o.x);
    const y = Number(o.y);
    const w = Number(o.w);
    const h = Number(o.h);
    const translated = typeof o.translated === "string" ? o.translated : "";
    const bg = typeof o.bg === "string" && /^#?[0-9a-f]{6}$/i.test(o.bg) ? (o.bg.startsWith("#") ? o.bg : `#${o.bg}`) : "#FFFFFF";
    if (![x, y, w, h].every((n) => Number.isFinite(n))) continue;
    if (w <= 0 || h <= 0) continue;
    if (!translated) continue;
    out.push({
      x: Math.max(0, Math.min(maxW, x)),
      y: Math.max(0, Math.min(maxH, y)),
      w: Math.max(1, Math.min(maxW - x, w)),
      h: Math.max(1, Math.min(maxH - y, h)),
      translated,
      bg,
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
            const content = await callGateway([
              { role: "system", content: system },
              {
                role: "user",
                content: [
                  { type: "image_url", image_url: { url: dataUrl } },
                  { type: "text", text: "Does this image contain any text? Answer YES or NO only." },
                ],
              },
            ]);
            const ans = content.trim().toUpperCase();
            return json({ hasText: ans.startsWith("Y") });
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
            `For each text region you find, report its pixel bounding box (x, y, width, height — origin at top-left of the image) and provide a ${tgtName} translation of the source text inside it.`,
            `Also report a single representative background color for each box as a hex code, sampled from just outside the text glyphs (e.g. the speech-bubble fill or panel background), so the translated text can be overlaid cleanly.`,
            langRules,
            glossaryRules,
            `Respond ONLY with a JSON array, no prose, no markdown fences. Each element: {"x":number,"y":number,"w":number,"h":number,"translated":"...","bg":"#RRGGBB"}. If there is no text at all, respond with [].`,
          ]
            .filter(Boolean)
            .join("\n\n");

          const content = await callGateway([
            { role: "system", content: system },
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: dataUrl } },
                {
                  type: "text",
                  text: `Image size: ${width}x${height} pixels. Find all text regions and translate to ${tgtName}. Respond with ONLY the JSON array.`,
                },
              ],
            },
          ]);

          const regions = parseRegions(content, width || 1, height || 1);
          return json({ regions });
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