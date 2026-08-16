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
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Lovable-API-Key": key },
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
      return data.choices?.[0]?.message?.content ?? "";
    }
    const text = await res.text();
    if (res.status === 402) throw new Error("AI credits exhausted for this workspace.");
    if (res.status === 429 || res.status === 503) {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      continue;
    }
    throw new Error(`AI gateway error ${res.status}: ${text.slice(0, 200)}`);
  }
  throw new Error("Rate limited — try again in a minute.");
}

export const Route = createFileRoute("/api/translate-text")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as {
            blocks?: string[];
            srcLang?: string;
            tgtLang?: string;
            glossary?: string;
            customInstructions?: string;
          };
          const blocks = (body.blocks || []).map((b) => String(b)).slice(0, 60);
          if (!blocks.length) return json({ translations: [] });
          const srcName = LANG_NAMES[body.srcLang || "auto"] || LANG_NAMES.auto;
          const tgtName = LANG_NAMES[body.tgtLang || "en"] || "English";

          const system = [
            `You are a document translator translating from ${srcName} to ${tgtName}.`,
            `You receive a JSON array of text blocks in reading order. Translate each block, keeping paragraph breaks, list markers, slide labels like "[Slide 3]", numbers and proper nouns intact. Use the surrounding blocks for context so terminology and tone stay consistent across the document.`,
            body.glossary?.trim()
              ? `GLOSSARY — apply exactly:\n${body.glossary.trim().slice(0, 2000)}`
              : "",
            body.customInstructions?.trim()
              ? `USER INSTRUCTIONS:\n${body.customInstructions.trim().slice(0, 1500)}`
              : "",
            `Respond ONLY with a JSON array of strings, the same length and order as the input. No prose, no markdown fences.`,
          ].filter(Boolean).join("\n\n");

          const raw = await callGateway([
            { role: "system", content: system },
            { role: "user", content: JSON.stringify(blocks) },
          ]);
          let cleaned = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
          const s = cleaned.indexOf("["), e = cleaned.lastIndexOf("]");
          if (s !== -1 && e !== -1) cleaned = cleaned.slice(s, e + 1);
          let arr: unknown = [];
          try { arr = JSON.parse(cleaned); } catch { arr = []; }
          const translations = Array.isArray(arr)
            ? blocks.map((_, i) => (typeof (arr as unknown[])[i] === "string" ? String((arr as unknown[])[i]) : ""))
            : [];
          return json({ translations });
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) }, 200);
        }
      },
    },
  },
});
