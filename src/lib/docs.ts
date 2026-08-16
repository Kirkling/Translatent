// Document ingestion helpers (client-side, browser only).
//  • PDF  → rendered page images, so it flows through the normal page pipeline.
//  • DOCX / PPTX / TXT / MD / CSV → plain text blocks for text translation.
import JSZip from "jszip";

export type DocBlocks = { name: string; blocks: string[] };

export const isPdf = (f: File) => /\.pdf$/i.test(f.name) || f.type === "application/pdf";
export const isTextDoc = (f: File) =>
  /\.(docx|pptx|txt|md|markdown|csv|rtf)$/i.test(f.name);
export const isArchive = (f: File) => /\.(cbz|zip)$/i.test(f.name);
export const isImage = (f: File) =>
  /^image\//i.test(f.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);

// ---- PDF → page images -----------------------------------------------------
export async function pdfToImages(
  file: File,
  onPage?: (done: number, total: number) => void,
): Promise<File[]> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const out: File[] = [];
  const pad = String(doc.numPages).length;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    // Target ~1600px on the long edge for good OCR without huge memory use.
    const scale = Math.min(3, Math.max(1, 1600 / Math.max(base.width, base.height)));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), "image/jpeg", 0.92));
    out.push(new File([blob], `${String(i).padStart(pad, "0")}.jpg`, { type: "image/jpeg" }));
    onPage?.(i, doc.numPages);
  }
  return out;
}

// ---- Word / PowerPoint / plain text → text blocks ---------------------------
export async function extractDocText(file: File): Promise<DocBlocks> {
  const name = file.name;
  if (/\.docx$/i.test(name)) {
    const mammoth = await import("mammoth/mammoth.browser.js");
    const res = await (mammoth as unknown as {
      extractRawText: (o: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
    }).extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { name, blocks: splitBlocks(res.value) };
  }
  if (/\.pptx$/i.test(name)) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const slideNames = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const blocks: string[] = [];
    for (const sn of slideNames) {
      const xml = await zip.file(sn)!.async("string");
      const texts = Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)).map((m) =>
        decodeXml(m[1]).trim(),
      ).filter(Boolean);
      if (texts.length) blocks.push(`[Slide ${slideNames.indexOf(sn) + 1}]\n${texts.join("\n")}`);
    }
    return { name, blocks };
  }
  // txt / md / csv / rtf → read as text
  const raw = await file.text();
  const clean = /\.rtf$/i.test(name) ? raw.replace(/\\[a-z]+-?\d*\s?|[{}]/gi, "") : raw;
  return { name, blocks: splitBlocks(clean) };
}

function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function splitBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((s) => s.replace(/[ \t]+\n/g, "\n").trim())
    .filter(Boolean);
}
