import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";
import {
  fileId,
  getLastId,
  idbDelete,
  idbGet,
  idbPut,
  setLastId,
  type StoredFile,
  type StoredPage,
} from "@/lib/idb";
import { analyzeRegion, eraseInk } from "@/lib/inpaint";
import { LANGS } from "@/lib/langs";
import { extractDocText, isArchive, isImage, isPdf, isTextDoc, pdfToImages, type DocBlocks } from "@/lib/docs";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Koe/Box — Manga Translator" },
      {
        name: "description",
        content:
          "In-place manga text replacement. Upload a CBZ and translate Japanese, Chinese, or Korean dialogue into English (and more) — artwork stays untouched.",
      },
      { property: "og:title", content: "Koe/Box — Manga Translator" },
      {
        property: "og:description",
        content: "Drop a CBZ, get translated pages with overlaid text.",
      },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
    ],
  }),
  component: Index,
});

type PageStatus = "pending" | "processing" | "translated" | "skipped";
type RegionKind = "bubble" | "narration" | "sfx" | "sign" | "freefloat";
type RegionShape = "rounded" | "ellipse" | "rect" | "irregular" | "none";
type RegionStyle = "print" | "handwritten" | "brush" | "bold" | "italic";
type Region = {
  x: number; y: number; w: number; h: number;
  translated: string; original?: string; bg: string;
  kind: RegionKind;
  hasBackdrop: boolean;
  shape?: RegionShape;
  angle?: number;
  textColor?: string;
  strokeColor?: string | null;
  style?: RegionStyle;
  align?: "left" | "center" | "right";
  vertical?: boolean;
  capHeight?: number;
  lines?: number;
};
type Page = {
  name: string;
  blob: Blob;
  url: string;
  img: HTMLImageElement;
  w: number;
  h: number;
  status: PageStatus;
  regions: Region[];
};
type LogLine = { text: string; cls?: "ok-line" | "accent-line" | "skip-line" };


function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function badgeLabel(s: PageStatus) {
  if (s === "translated") return "Done";
  if (s === "skipped") return "No text";
  if (s === "processing") return "Scanning";
  return "Pending";
}

async function downscaleToBlob(img: HTMLImageElement, maxDim: number, quality = 0.7): Promise<Blob> {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  c.getContext("2d")!.drawImage(img, 0, 0, w, h);
  return await new Promise<Blob>((res) =>
    c.toBlob((b) => res(b!), "image/jpeg", quality),
  );
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current); current = word;
    } else current = test;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function pickInk(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#111111";
  const v = parseInt(m[1], 16);
  const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.55 ? "#111111" : "#F7F4ED";
}

function fontFamilyFor(style: RegionStyle, kind: RegionKind) {
  if (style === "handwritten") return `'Caveat', 'Patrick Hand', 'Segoe Script', cursive`;
  if (style === "brush") return `'Bangers', 'Impact', 'Archivo Narrow', sans-serif`;
  if (kind === "sfx") return `'Bangers', 'Impact', 'Archivo Narrow', sans-serif`;
  return `'Inter', 'Helvetica Neue', Arial, sans-serif`;
}

type Rect = { x: number; y: number; w: number; h: number };

function intersects(a: Rect, b: Rect, gap = 0) {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
}

// Grow `base` toward `desired` but stop at the page edges and at anything
// already drawn, so two overlays can never cover each other or bleed over
// artwork they don't own.
function constrainBox(base: Rect, desired: Rect, placed: Rect[], pageW: number, pageH: number): Rect {
  let box: Rect = {
    x: Math.max(0, desired.x),
    y: Math.max(0, desired.y),
    w: Math.min(desired.w, pageW),
    h: Math.min(desired.h, pageH),
  };
  if (box.x + box.w > pageW) box.x = Math.max(0, pageW - box.w);
  if (box.y + box.h > pageH) box.y = Math.max(0, pageH - box.h);

  for (const o of placed) {
    if (!intersects(box, o, 1)) continue;
    // Cut the box back along whichever axis is cheapest, never past `base`.
    const cutLeft = box.x + box.w - o.x;          // shrink right edge
    const cutRight = o.x + o.w - box.x;           // shrink left edge
    const cutTop = box.y + box.h - o.y;           // shrink bottom edge
    const cutBottom = o.y + o.h - box.y;          // shrink top edge
    const options = [
      { cost: cutLeft, apply: () => ({ ...box, w: Math.max(base.w * 0.6, box.w - cutLeft - 2) }) },
      { cost: cutRight, apply: () => ({ ...box, x: box.x + cutRight + 2, w: Math.max(base.w * 0.6, box.w - cutRight - 2) }) },
      { cost: cutTop, apply: () => ({ ...box, h: Math.max(base.h * 0.6, box.h - cutTop - 2) }) },
      { cost: cutBottom, apply: () => ({ ...box, y: box.y + cutBottom + 2, h: Math.max(base.h * 0.6, box.h - cutBottom - 2) }) },
    ].filter((o2) => o2.cost > 0).sort((p, q) => p.cost - q.cost);
    if (options.length) box = options[0].apply();
  }
  return box;
}

function drawTextBox(
  ctx: CanvasRenderingContext2D,
  r: Region,
  placed: Rect[] = [],
  pageW = ctx.canvas.width,
  pageH = ctx.canvas.height,
) {
  // ---- 1. Look at the actual pixels of the source region -------------------
  const a = analyzeRegion(ctx, r.x, r.y, r.w, r.h);
  // Only trust the pixel-measured box when the read looked sane; otherwise the
  // model's box is safer than a bbox derived from a bad plate guess.
  const usePixels = !!a && a.reliable;
  const bx = usePixels ? a!.x : r.x;
  const by = usePixels ? a!.y : r.y;
  const bw = usePixels ? a!.w : r.w;
  const bh = usePixels ? a!.h : r.h;
  const plate = (usePixels ? a!.plate : null) || r.bg || "#FFFFFF";
  const kind = r.kind;
  const style: RegionStyle = r.style ?? "print";
  const align = r.align ?? "center";
  const angle = ((r.angle ?? 0) * Math.PI) / 180;

  // The pixel evidence decides whether a container really exists; the model's
  // flag only acts as a veto. Text drawn straight on artwork never gains a box.
  const modelBackdrop = r.hasBackdrop !== false;
  const hasBackdrop = usePixels ? a!.hasBackdrop && modelBackdrop : modelBackdrop;
  const shape: RegionShape = hasBackdrop
    ? (r.shape && r.shape !== "none" ? r.shape : kind === "narration" ? "rect" : "ellipse")
    : "none";

  // ---- 2. Erase the original lettering, pixel by pixel ---------------------
  const erased = eraseInk(ctx, bx, by, bw, bh, plate);

  // ---- 3. Fit the replacement text to the measured ink box ----------------
  ctx.save();
  const family = fontFamilyFor(style, kind);
  const ink = r.textColor || (usePixels ? a!.ink : undefined) || pickInk(plate);
  const weight = style === "bold" || style === "brush" || kind === "sfx" ? 800
    : kind === "narration" ? 500
    : 600;
  const slant = style === "italic" ? "italic " : "";
  const display = kind === "sfx" || style === "brush" ? r.translated.toUpperCase() : r.translated;
  const lineGap = 1.16;
  const measuredCap = (usePixels ? a!.capHeight : 0) || r.capHeight || bh / Math.max(1, r.lines ?? 1);

  // Growing the container is only allowed when the original HAD one — text on
  // bare artwork must stay inside its own footprint. Either way the result is
  // clipped to the page and to boxes already drawn.
  const base: Rect = { x: bx, y: by, w: bw, h: bh };
  const growFactor = hasBackdrop ? 1.4 : 1.04;
  const wanted: Rect = {
    x: bx - (bw * (growFactor - 1)) / 2,
    y: by - (bh * (growFactor - 1)) / 2,
    w: bw * growFactor,
    h: bh * growFactor,
  };
  const room = constrainBox(base, wanted, placed, pageW, pageH);
  const growW = Math.max(10, room.w);
  const growH = Math.max(8, room.h);

  // Start from the measured original cap height so scale matches the source,
  // then only shrink if the translated string genuinely needs more room.
  let fontSize = Math.max(7, Math.round(measuredCap * (style === "handwritten" ? 1.08 : 1)));
  let lines: string[] = [];
  let textW = 0;
  let textH = 0;
  for (;;) {
    ctx.font = `${slant}${weight} ${fontSize}px ${family}`;
    lines = wrapText(ctx, display, Math.max(12, growW));
    textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
    textH = lines.length * fontSize * lineGap;
    if ((textW <= growW && textH <= growH) || fontSize <= 7) break;
    fontSize -= 1;
  }

  // ---- 4. Redraw a container ONLY when the original had one ---------------
  const cx0 = room.x + room.w / 2;
  const cy0 = room.y + room.h / 2;
  if (angle) {
    ctx.translate(cx0, cy0);
    ctx.rotate(angle);
    ctx.translate(-cx0, -cy0);
  }
  const padX = Math.max(3, fontSize * 0.5);
  const padY = Math.max(2, fontSize * 0.38);
  let coverW = Math.min(room.w, Math.max(bw, textW + padX * 2));
  let coverH = Math.min(room.h, Math.max(bh, textH + padY * 2));
  const coverX = cx0 - coverW / 2;
  const coverY = cy0 - coverH / 2;

  if (hasBackdrop) {
    // Scale the plate to the words it holds (never a fixed default size), but
    // never smaller than the original silhouette so the source stays covered.
    ctx.fillStyle = plate;
    ctx.beginPath();
    if (shape === "ellipse" || shape === "irregular") {
      ctx.ellipse(cx0, cy0, (coverW / 2) * 1.06, (coverH / 2) * 1.1, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (shape === "rect") {
      ctx.fillRect(coverX, coverY, coverW, coverH);
    } else {
      const radius = Math.max(2, Math.min(coverW, coverH) * 0.24);
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(coverX, coverY, coverW, coverH, radius);
        ctx.fill();
      } else ctx.fillRect(coverX, coverY, coverW, coverH);
    }
  } else if (!erased) {
    // No container in the original and the pixel eraser could not do its job
    // (busy artwork behind the glyphs): lay down the tightest possible opaque
    // patch in the sampled surface colour so the source text still disappears.
    coverW = bw;
    coverH = bh;
    ctx.fillStyle = plate;
    ctx.fillRect(bx, by, bw, bh);
  }

  // ---- 5. Paint the translated lettering ----------------------------------
  ctx.font = `${slant}${weight} ${fontSize}px ${family}`;
  ctx.fillStyle = ink;
  ctx.textBaseline = "middle";
  ctx.textAlign = align;
  const lineHeight = fontSize * lineGap;
  const totalTextHeight = (lines.length - 1) * lineHeight + fontSize;
  const startY = cy0 - totalTextHeight / 2 + fontSize / 2;
  const drawX = align === "left" ? cx0 - textW / 2 : align === "right" ? cx0 + textW / 2 : cx0;
  if (r.strokeColor) {
    ctx.strokeStyle = r.strokeColor;
    ctx.lineWidth = Math.max(1, fontSize * 0.08);
    ctx.lineJoin = "round";
  }
  for (let i = 0; i < lines.length; i++) {
    const ly = startY + i * lineHeight;
    if (r.strokeColor) ctx.strokeText(lines[i], drawX, ly);
    ctx.fillText(lines[i], drawX, ly);
  }
  ctx.restore();

  // Reserve the footprint so later regions route around it.
  placed.push({
    x: Math.min(bx, coverX),
    y: Math.min(by, coverY),
    w: Math.max(bw, coverW),
    h: Math.max(bh, coverH),
  });
}

// Paint a page + all its overlays, biggest boxes first so small SFX never get
// swallowed by a larger bubble growing over them.
function paintPage(ctx: CanvasRenderingContext2D, p: Page, translated: boolean) {
  ctx.drawImage(p.img, 0, 0, p.w, p.h);
  if (!translated || p.status !== "translated" || !p.regions.length) return;
  const placed: Rect[] = [];
  const order = p.regions
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.w * b.r.h - a.r.w * a.r.h);
  for (const { r } of order) drawTextBox(ctx, r, placed, p.w, p.h);
}



function Index() {
  const [pages, setPages] = useState<Page[]>([]);
  const [fileLabel, setFileLabel] = useState<{ name: string; count: number; id: string } | null>(null);
  const [view, setView] = useState<"grid" | "single">("grid");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showTranslated, setShowTranslated] = useState(true);
  const [statusText, setStatusText] = useState("No file loaded");
  const [statusMode, setStatusMode] = useState<"" | "busy" | "done">("");
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [drag, setDrag] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState<string>("");
  const [building, setBuilding] = useState(false);
  const [remaining, setRemaining] = useState<number[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [lightboxTranslated, setLightboxTranslated] = useState(true);
  const [pacingMs, setPacingMs] = useState(2500);

  // Mobile bottom-sheet: 0 = peek, 1 = mid, 2 = full
  const [sheetSnap, setSheetSnap] = useState<0 | 1 | 2>(1);
  const sheetRef = useRef<HTMLDivElement>(null);
  const sheetDrag = useRef<{ startY: number; startSnap: 0 | 1 | 2; moved: boolean } | null>(null);

  const [doc, setDoc] = useState<(DocBlocks & { translations: string[] }) | null>(null);
  const [docBusy, setDocBusy] = useState(false);

  const [srcLang, setSrcLang] = useState("auto");
  const [tgtLang, setTgtLang] = useState("en");
  const [textOnly, setTextOnly] = useState(true);
  const [skipBlank, setSkipBlank] = useState(true);
  const [noFlag, setNoFlag] = useState(true);
  const [glossary, setGlossary] = useState("");
  const [customInstructions, setCustomInstructions] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lightboxCanvasRef = useRef<HTMLCanvasElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const pauseRef = useRef(false);
  const pacingRef = useRef(2500);
  const successSinceHitRef = useRef(0);

  const appendLog = useCallback((text: string, cls?: LogLine["cls"]) => {
    setLog((prev) => [...prev.slice(-200), { text, cls }]);
  }, []);

  useEffect(() => { pacingRef.current = pacingMs; }, [pacingMs]);

  // Make sure the hand-lettered / brush faces are rasterizable on canvas
  // before any overlay is drawn, otherwise they silently fall back.
  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    void Promise.all([
      fonts.load("600 24px 'Caveat'"),
      fonts.load("400 24px 'Patrick Hand'"),
      fonts.load("400 24px 'Bangers'"),
    ]).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // ---- IDB persistence helpers
  const saveSnapshot = useCallback(async (id: string, fileBlob: Blob, fileName: string, fileSize: number, fileLastMod: number, pagesNow: Page[]) => {
    const storedPages: StoredPage[] = pagesNow.map((p) => ({
      name: p.name,
      status: p.status,
      regions: p.regions,
    }));
    const rec: StoredFile = {
      id,
      name: fileName,
      size: fileSize,
      lastModified: fileLastMod,
      pageCount: pagesNow.length,
      blob: fileBlob,
      pages: storedPages,
      updatedAt: Date.now(),
    };
    await idbPut(rec);
  }, []);

  // ---- Load a file (from upload OR from IDB restore)
  const ingestArchive = useCallback(async (cbzBlob: Blob, name: string, size: number, lastMod: number, restoredPages?: StoredPage[]) => {
    setStatusText("Reading archive…");
    setStatusMode("busy");
    appendLog(`Opening ${name}…`);
    try {
      const buf = await cbzBlob.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);
      const entries = Object.values(zip.files)
        .filter((f) => !f.dir && /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name))
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
        );
      if (entries.length === 0) {
        appendLog("No image files found in archive.", "accent-line");
        setStatusText("No images found"); setStatusMode(""); return;
      }
      const loaded: Page[] = [];
      for (const entry of entries) {
        const blob = await entry.async("blob");
        const url = URL.createObjectURL(blob);
        const img = await loadImage(url);
        loaded.push({
          name: entry.name, blob, url, img,
          w: img.naturalWidth, h: img.naturalHeight,
          status: "pending", regions: [],
        });
      }
      // revoke old
      setPages((prev) => { prev.forEach((p) => URL.revokeObjectURL(p.url)); return prev; });

      let restoredCount = 0;
      const snap: Record<string, StoredPage> = {};
      if (restoredPages) for (const p of restoredPages) snap[p.name] = p;
      else {
        // back-compat: legacy localStorage snapshot
        try {
          const raw = localStorage.getItem(`koebox:${name}:${loaded.length}`);
          if (raw) {
            const old = JSON.parse(raw) as Record<string, { status: PageStatus; regions: Region[] }>;
            for (const k in old) snap[k] = { name: k, status: old[k].status, regions: old[k].regions as Region[] };
          }
        } catch {/* ignore */}
      }
      for (const p of loaded) {
        const s = snap[p.name];
        if (s && (s.status === "translated" || s.status === "skipped")) {
          p.status = s.status;
          p.regions = (s.regions || []).map((r) => ({
            ...r,
            x: r.x, y: r.y, w: r.w, h: r.h,
            translated: r.translated, bg: r.bg,
            kind: ((r as { kind?: string }).kind as RegionKind) || "bubble",
            hasBackdrop: typeof (r as { hasBackdrop?: boolean }).hasBackdrop === "boolean"
              ? (r as { hasBackdrop: boolean }).hasBackdrop : true,
          }));
          if (s.status === "translated") restoredCount++;
        }
      }
      const id = fileId({ name, size, lastModified: lastMod });
      setPages(loaded);
      setCurrentIndex(0);
      setRemaining([]);
      setFileLabel({ name, count: loaded.length, id });
      setLastId(id);
      setStatusText(`${loaded.length} pages loaded`);
      setStatusMode("done");
      appendLog(`Loaded ${loaded.length} pages.`, "ok-line");
      if (restoredCount)
        appendLog(`Restored ${restoredCount} previously translated page${restoredCount === 1 ? "" : "s"}.`, "ok-line");
      // Persist (even if it's already in IDB — bumps updatedAt)
      void saveSnapshot(id, cbzBlob, name, size, lastMod, loaded);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog(`Failed to read archive: ${msg}`, "accent-line");
      setStatusText("Failed to read file"); setStatusMode("");
    }
  }, [appendLog, saveSnapshot]);

  const handleFile = useCallback(async (file: File) => {
    await ingestArchive(file, file.name, file.size, file.lastModified);
  }, [ingestArchive]);

  // ---- Document ingestion: Word / PowerPoint / plain text -----------------
  const handleTextDoc = useCallback(async (file: File) => {
    setStatusText("Reading document…"); setStatusMode("busy");
    appendLog(`Opening ${file.name}…`);
    try {
      const parsed = await extractDocText(file);
      setDoc({ ...parsed, translations: [] });
      setStatusText(`${parsed.blocks.length} text blocks loaded`); setStatusMode("done");
      appendLog(`Loaded ${parsed.blocks.length} text blocks from ${file.name}.`, "ok-line");
    } catch (err) {
      appendLog(`Failed to read document: ${err instanceof Error ? err.message : String(err)}`, "accent-line");
      setStatusText("Failed to read document"); setStatusMode("");
    }
  }, [appendLog]);

  // ---- Accept archives, loose images, and PDFs (rendered to page images)
  const handleFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (!files.length) return;

    const textDoc = files.find(isTextDoc);
    if (textDoc) { await handleTextDoc(textDoc); return; }

    const pdf = files.find(isPdf);
    let images = files.filter(isImage);
    if (pdf) {
      setStatusText("Rendering PDF…"); setStatusMode("busy");
      appendLog(`Rendering ${pdf.name} to page images…`);
      try {
        const rendered = await pdfToImages(pdf, (d, t) => setStatusText(`Rendering PDF page ${d}/${t}`));
        images = images.concat(rendered);
        appendLog(`Rendered ${rendered.length} PDF page${rendered.length === 1 ? "" : "s"}.`, "ok-line");
      } catch (err) {
        appendLog(`Could not render PDF: ${err instanceof Error ? err.message : String(err)}`, "accent-line");
        setStatusText("Failed to read PDF"); setStatusMode(""); return;
      }
    }

    const archive = files.find(isArchive);
    if (images.length === 0) {
      if (archive) { await handleFile(archive); return; }
      appendLog("Unsupported file. Use CBZ, PDF, JPG/PNG, DOCX, PPTX or TXT.", "accent-line");
      return;
    }

    images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    const zip = new JSZip();
    const pad = String(images.length).length;
    images.forEach((f, i) => {
      const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] || "jpg").toLowerCase();
      zip.file(`${String(i + 1).padStart(pad, "0")}-${f.name.replace(/\.[^.]+$/, "")}.${ext}`, f);
    });
    const blob = await zip.generateAsync({ type: "blob" });
    const name = pdf ? pdf.name : images.length === 1 ? images[0].name : `${images.length} images`;
    const size = pdf ? pdf.size : images.reduce((s, f) => s + f.size, 0);
    const lastMod = pdf ? pdf.lastModified : images.reduce((m, f) => Math.max(m, f.lastModified), 0);
    await ingestArchive(blob, name, size, lastMod);
  }, [appendLog, handleFile, handleTextDoc, ingestArchive]);

  // ---- On boot: try to restore the last opened file from IDB
  const triedRestoreRef = useRef(false);
  useEffect(() => {
    if (triedRestoreRef.current) return;
    triedRestoreRef.current = true;
    (async () => {
      const id = getLastId();
      if (!id) return;
      const rec = await idbGet(id);
      if (!rec) return;
      appendLog(`Resuming "${rec.name}" from saved session.`, "ok-line");
      await ingestArchive(rec.blob, rec.name, rec.size, rec.lastModified, rec.pages);
    })();
  }, [appendLog, ingestArchive]);

  // ---- Save snapshot whenever pages change
  useEffect(() => {
    if (!fileLabel || !pages.length) return;
    // Debounce so rapid status flips don't hammer IDB.
    const t = setTimeout(async () => {
      const prev = await idbGet(fileLabel.id);
      if (!prev) return;
      await saveSnapshot(fileLabel.id, prev.blob, prev.name, prev.size, prev.lastModified, pages);
    }, 500);
    return () => clearTimeout(t);
  }, [pages, fileLabel, saveSnapshot]);

  // ---- Flush on backgrounding the tab
  useEffect(() => {
    const onHide = () => {
      if (running) pauseRef.current = true;
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [running]);

  // ---- History API: intercept back gesture to close overlays
  useEffect(() => {
    const onPop = () => {
      if (lightboxIndex !== null) { setLightboxIndex(null); return; }
      if (view === "single") { setView("grid"); return; }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [lightboxIndex, view]);

  const openLightbox = useCallback((i: number) => {
    setCurrentIndex(i);
    setLightboxTranslated(true);
    setLightboxIndex(i);
    try { history.pushState({ koebox: "lightbox" }, ""); } catch {/* noop */}
  }, []);
  const closeLightbox = useCallback(() => {
    if (lightboxIndex !== null) {
      setLightboxIndex(null);
      try { if (history.state?.koebox === "lightbox") history.back(); } catch {/* noop */}
    }
  }, [lightboxIndex]);

  // ---- Keyboard nav
  useEffect(() => {
    if (view !== "single" && lightboxIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
      if (lightboxIndex !== null) {
        if (e.key === "ArrowLeft")
          setLightboxIndex((i) => (i === null ? null : Math.max(0, i - 1)));
        else if (e.key === "ArrowRight")
          setLightboxIndex((i) => (i === null ? null : Math.min(pages.length - 1, i + 1)));
        else if (e.key === "Escape") closeLightbox();
        return;
      }
      if (e.key === "ArrowLeft") setCurrentIndex((i) => Math.max(0, i - 1));
      else if (e.key === "ArrowRight") setCurrentIndex((i) => Math.min(pages.length - 1, i + 1));
      else if (e.key.toLowerCase() === "t") setShowTranslated((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, pages.length, lightboxIndex, closeLightbox]);

  // cleanup
  useEffect(() => () => {
    pages.forEach((p) => URL.revokeObjectURL(p.url));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Draw single-page canvas
  useEffect(() => {
    if (view !== "single") return;
    const p = pages[currentIndex];
    const canvas = canvasRef.current;
    if (!p || !canvas) return;
    const dpr = 2;
    canvas.width = p.w * dpr; canvas.height = p.h * dpr;
    // Let CSS handle sizing; aspect-ratio on the wrapper preserves shape.
    canvas.style.width = "100%";
    canvas.style.height = "auto";
    canvas.style.aspectRatio = `${p.w} / ${p.h}`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(p.img, 0, 0, p.w, p.h);
    if (p.status === "translated" && p.regions.length > 0 && showTranslated) {
      for (const r of p.regions) drawTextBox(ctx, r);
    }
  }, [view, currentIndex, pages, showTranslated]);

  // Draw lightbox canvas
  useEffect(() => {
    if (lightboxIndex === null) return;
    const p = pages[lightboxIndex];
    const canvas = lightboxCanvasRef.current;
    if (!p || !canvas) return;
    // Render at 2x so text stays crisp when the user zooms in.
    const dpr = 2;
    canvas.width = p.w * dpr; canvas.height = p.h * dpr;
    // Don't pin pixel dims — let CSS scale the canvas while preserving the
    // intrinsic aspect ratio. Fixing both width & height in px in combination
    // with max-width/max-height in CSS was warping the displayed image.
    canvas.style.width = "";
    canvas.style.height = "";
    canvas.style.aspectRatio = `${p.w} / ${p.h}`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(p.img, 0, 0, p.w, p.h);
    if (p.status === "translated" && p.regions.length > 0 && lightboxTranslated) {
      for (const r of p.regions) drawTextBox(ctx, r);
    }
  }, [lightboxIndex, pages, lightboxTranslated]);

  const callServer = useCallback(
    async (page: Page, kind: "presence" | "detect", priorContext: string) => {
      const blob = await downscaleToBlob(page.img, kind === "presence" ? 512 : 1600, 0.75);
      const fd = new FormData();
      fd.append("image", blob, "page.jpg");
      fd.append("kind", kind);
      fd.append("width", String(page.w));
      fd.append("height", String(page.h));
      fd.append("srcLang", srcLang);
      fd.append("tgtLang", tgtLang);
      fd.append("glossary", glossary);
      fd.append("noFlag", String(noFlag));
      fd.append("textOnly", String(textOnly));
      if (priorContext) fd.append("priorContext", priorContext);
      if (customInstructions.trim()) fd.append("customInstructions", customInstructions);
      const res = await fetch("/api/translate", { method: "POST", body: fd });
      const text = await res.text();
      let data: { error?: string; hasText?: boolean; regions?: Region[]; throttle?: { retryAfterMs?: number } } = {};
      try { data = JSON.parse(text) as typeof data; }
      catch {
        throw new Error(`Server returned a non-JSON response (HTTP ${res.status}). The request likely timed out — try again.`);
      }
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
    [srcLang, tgtLang, glossary, noFlag, textOnly, customInstructions],
  );

  const downloadCBZ = useCallback(async () => {
    if (!pages.length || building) return;
    setBuilding(true);
    if (downloadUrl) { URL.revokeObjectURL(downloadUrl); setDownloadUrl(null); }
    appendLog("Building translated CBZ…");
    const zip = new JSZip();
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      let blob: Blob = p.blob;
      if (p.status === "translated" && p.regions.length) {
        const c = document.createElement("canvas");
        c.width = p.w; c.height = p.h;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(p.img, 0, 0, p.w, p.h);
        for (const r of p.regions) drawTextBox(ctx, r);
        blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), "image/jpeg", 0.9));
      }
      const ext = blob.type === "image/png" ? "png" : "jpg";
      const num = String(i + 1).padStart(4, "0");
      zip.file(`${num}.${ext}`, blob);
    }
    const out = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(out);
    const baseName = (fileLabel?.name || "translated.cbz").replace(/\.[^.]+$/, "");
    const name = `${baseName}.translated.cbz`;
    setDownloadUrl(url); setDownloadName(name); setBuilding(false);
    appendLog("Download ready — starting download…", "ok-line");
    try {
      const file = new File([out], name, { type: "application/vnd.comicbook+zip" });
      const nav = navigator as Navigator & {
        canShare?: (d: { files?: File[] }) => boolean;
        share?: (d: { files?: File[]; title?: string }) => Promise<void>;
      };
      if (nav.canShare && nav.share && nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: name });
        appendLog("Shared via system sheet.", "ok-line");
      } else {
        const a = document.createElement("a");
        a.href = url; a.download = name; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
      }
    } catch (err) {
      appendLog(
        `Auto-download blocked — tap the green link below. (${err instanceof Error ? err.message : String(err)})`,
        "accent-line",
      );
    }
  }, [pages, fileLabel, appendLog, building, downloadUrl]);

  useEffect(() => () => { if (downloadUrl) URL.revokeObjectURL(downloadUrl); }, [downloadUrl]);
  useEffect(() => {
    if (downloadUrl) { URL.revokeObjectURL(downloadUrl); setDownloadUrl(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  const translateRange = useCallback(async (indices: number[]) => {
    if (running || !pages.length || !indices.length) return;
    setRunning(true);
    pauseRef.current = false;
    setRemaining(indices.slice());
    setStatusText("Translating pages…");
    setStatusMode("busy");
    setProgress(0);

    const updatePage = (i: number, patch: Partial<Page>) => {
      setPages((prev) => { const next = prev.slice(); next[i] = { ...next[i], ...patch }; return next; });
    };

    let done = 0;
    const total = indices.length;
    let leftover = indices.slice();
    // Snapshot of current pages so we can build priorContext from earlier results
    // without going stale during the loop.
    let snapshot = pages.slice();
    const buildPrior = (pageIdx: number) => {
      const lines: string[] = [];
      for (let k = Math.max(0, pageIdx - 1); k < pageIdx; k++) {
        const p = snapshot[k];
        if (!p || p.status !== "translated") continue;
        for (const r of p.regions) {
          if (lines.length >= 12) break;
          lines.push(r.translated.slice(0, 120));
        }
      }
      return lines.join("\n");
    };

    for (let idx = 0; idx < indices.length; idx++) {
      const i = indices[idx];
      if (pauseRef.current) {
        leftover = indices.slice(idx);
        appendLog(`Paused — ${leftover.length} page${leftover.length === 1 ? "" : "s"} remaining.`, "accent-line");
        break;
      }
      const page = pages[i];
      updatePage(i, { status: "processing" });
      try {
        const resp = await callServer(page, "detect", buildPrior(i));
        const safe = resp.regions || [];
        if (skipBlank && safe.length === 0) {
          updatePage(i, { status: "skipped" });
          appendLog(`Page ${i + 1}: no text detected — copied through untouched.`, "skip-line");
          snapshot = snapshot.map((p, k) => k === i ? { ...p, status: "skipped" as PageStatus } : p);
        } else {
          updatePage(i, { status: "translated", regions: safe });
          appendLog(
            `Page ${i + 1}: ${safe.length} text region${safe.length === 1 ? "" : "s"} translated.`,
            "ok-line",
          );
          snapshot = snapshot.map((p, k) => k === i ? { ...p, status: "translated" as PageStatus, regions: safe } : p);
        }
        // Adaptive throttle: if the server signaled a throttle, raise our pacing
        if (resp.throttle?.retryAfterMs) {
          const next = Math.min(15000, Math.max(pacingRef.current * 1.6, resp.throttle.retryAfterMs));
          if (next > pacingRef.current) {
            setPacingMs(next);
            appendLog(`Throttling: pacing raised to ${(next / 1000).toFixed(1)}s/page.`, "accent-line");
          }
          successSinceHitRef.current = 0;
        } else {
          successSinceHitRef.current++;
          // Decay pacing back toward baseline every 8 clean pages
          if (successSinceHitRef.current >= 8 && pacingRef.current > 2500) {
            const next = Math.max(2500, pacingRef.current * 0.75);
            setPacingMs(next);
            successSinceHitRef.current = 0;
            appendLog(`Pacing relaxed to ${(next / 1000).toFixed(1)}s/page.`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        updatePage(i, { status: "pending" });
        appendLog(`Page ${i + 1}: ${msg}`, "accent-line");
        if (/rate|429|timed out|timeout|non-JSON/i.test(msg)) {
          // Bump pacing AND auto-pause
          const next = Math.min(15000, pacingRef.current * 2);
          setPacingMs(next);
          appendLog(`Rate-limited — pacing raised to ${(next / 1000).toFixed(1)}s/page. Auto-paused.`, "accent-line");
          leftover = indices.slice(idx);
          pauseRef.current = true;
          break;
        }
      }
      done++;
      setProgress((done / total) * 100);
      if (!pauseRef.current && done < total) {
        await new Promise((r) => setTimeout(r, pacingRef.current));
      }
    }

    const wasPaused = pauseRef.current;
    setRunning(false);
    if (wasPaused) {
      setRemaining(leftover);
      setStatusText(`Paused — ${leftover.length} left`);
      setStatusMode("");
    } else {
      setRemaining([]);
      setStatusText("Translation complete");
      setStatusMode("done");
      setProgress(100);
      appendLog("Done.", "ok-line");
    }
    pauseRef.current = false;
  }, [pages, running, skipBlank, callServer, appendLog]);

  const runTranslation = useCallback(
    () => translateRange(pages.map((_, i) => i).filter((i) => pages[i].status !== "translated")),
    [translateRange, pages],
  );
  const rerunAll = useCallback(() => {
    if (running || !pages.length) return;
    if (!confirm("Re-translate every page from scratch? This replaces existing translations.")) return;
    setPages((prev) => prev.map((p) => ({ ...p, status: "pending" as PageStatus, regions: [] })));
    // Slight delay so the state flush lands before translateRange snapshots pages.
    setTimeout(() => translateRange(pages.map((_, i) => i)), 50);
  }, [running, pages, translateRange]);
  const resumeTranslation = useCallback(
    () => translateRange(remaining),
    [translateRange, remaining],
  );
  const translateCurrent = useCallback(
    () => translateRange([currentIndex]),
    [translateRange, currentIndex],
  );
  const pauseTranslation = useCallback(() => { pauseRef.current = true; }, []);

  const clearSaved = useCallback(async () => {
    if (!fileLabel) return;
    if (!confirm("Discard the saved file and all its translations from this browser?")) return;
    await idbDelete(fileLabel.id);
    setLastId(null);
    pages.forEach((p) => URL.revokeObjectURL(p.url));
    setPages([]); setFileLabel(null); setRemaining([]);
    setStatusText("No file loaded"); setStatusMode("");
    appendLog("Cleared saved session.", "accent-line");
  }, [fileLabel, pages, appendLog]);

  // ---- Document translation ------------------------------------------------
  const translateDoc = useCallback(async () => {
    if (!doc || docBusy) return;
    setDocBusy(true);
    setStatusText("Translating document…"); setStatusMode("busy");
    const out: string[] = [];
    const CHUNK = 12;
    try {
      for (let i = 0; i < doc.blocks.length; i += CHUNK) {
        const slice = doc.blocks.slice(i, i + CHUNK);
        const res = await fetch("/api/translate-text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blocks: slice, srcLang, tgtLang, glossary, customInstructions }),
        });
        const text = await res.text();
        let data: { translations?: string[]; error?: string } = {};
        try { data = JSON.parse(text) as typeof data; }
        catch { throw new Error("Server returned a non-JSON response — try again."); }
        if (data.error) throw new Error(data.error);
        out.push(...(data.translations || slice.map(() => "")));
        setDoc((d) => (d ? { ...d, translations: out.slice() } : d));
        appendLog(`Translated blocks ${i + 1}–${Math.min(doc.blocks.length, i + CHUNK)}.`, "ok-line");
        if (i + CHUNK < doc.blocks.length) await new Promise((r) => setTimeout(r, 900));
      }
      setStatusText("Document translated"); setStatusMode("done");
    } catch (err) {
      appendLog(`Document: ${err instanceof Error ? err.message : String(err)}`, "accent-line");
      setStatusText("Document translation failed"); setStatusMode("");
    }
    setDocBusy(false);
  }, [doc, docBusy, srcLang, tgtLang, glossary, customInstructions, appendLog]);

  // ---- Bilingual transcript (original + translation) ------------------------
  const downloadTranscript = useCallback(() => {
    const lines: string[] = [];
    const title = doc?.name || fileLabel?.name || "transcript";
    lines.push(`Koe/Box transcript — ${title}`, `Generated ${new Date().toLocaleString()}`, "");
    if (doc) {
      doc.blocks.forEach((b, i) => {
        lines.push(`--- Block ${i + 1} ---`, "ORIGINAL:", b, "", "TRANSLATION:", doc.translations[i] || "(not translated)", "");
      });
    } else {
      pages.forEach((p, i) => {
        if (p.status !== "translated" || !p.regions.length) return;
        lines.push(`--- Page ${i + 1} (${p.name}) ---`);
        p.regions.forEach((r, k) => {
          lines.push(`[${k + 1}] ${r.kind}`);
          if (r.original) lines.push(`  ORIGINAL:    ${r.original}`);
          lines.push(`  TRANSLATION: ${r.translated}`);
        });
        lines.push("");
      });
    }
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/\.[^.]+$/, "")}.transcript.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    appendLog("Transcript downloaded.", "ok-line");
  }, [doc, pages, fileLabel, appendLog]);

  const current = pages[currentIndex];
  const hasTranslation = !!current && current.status === "translated" && current.regions.length > 0;
  const translatedCount = pages.filter((p) => p.status === "translated").length;

  // ---- Bottom sheet drag handlers (mobile only)
  const onSheetPointerDown = (e: React.PointerEvent) => {
    sheetDrag.current = { startY: e.clientY, startSnap: sheetSnap, moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onSheetPointerMove = (e: React.PointerEvent) => {
    const s = sheetDrag.current; if (!s) return;
    const dy = e.clientY - s.startY;
    if (Math.abs(dy) > 4) s.moved = true;
    if (sheetRef.current) {
      const base = snapTop(s.startSnap);
      const next = Math.max(snapTop(2), Math.min(snapTop(0), base + dy));
      sheetRef.current.style.transform = `translateY(${next}px)`;
      sheetRef.current.style.transition = "none";
    }
  };
  const onSheetPointerUp = (e: React.PointerEvent) => {
    const s = sheetDrag.current; sheetDrag.current = null;
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch {/* noop */}
    if (!s) return;
    const dy = e.clientY - s.startY;
    if (!s.moved) { setSheetSnap(s.startSnap === 2 ? 1 : (s.startSnap === 1 ? 2 : 1)); cleanupSheetTransform(); return; }
    // Velocity-free snap: pick closest snap based on resulting top
    const base = snapTop(s.startSnap);
    const resultTop = Math.max(snapTop(2), Math.min(snapTop(0), base + dy));
    const candidates: Array<0 | 1 | 2> = [0, 1, 2];
    let best: 0 | 1 | 2 = s.startSnap;
    let bestDist = Infinity;
    for (const c of candidates) {
      const d = Math.abs(snapTop(c) - resultTop);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    setSheetSnap(best); cleanupSheetTransform();
  };
  const cleanupSheetTransform = () => {
    if (!sheetRef.current) return;
    sheetRef.current.style.transform = "";
    sheetRef.current.style.transition = "";
  };

  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <div className="mark">Koe<span className="accent">/</span>Box</div>
            <div className="sub">In‑place manga text replacement. Reads only text regions — artwork stays untouched.</div>
          </div>

          <div className="section">
            <h3>Source File</h3>
            <div
              className={`dropzone${drag ? " drag" : ""}`}
              tabIndex={0}
              role="button"
              aria-label="Choose a CBZ archive or image files"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); void handleFiles(e.dataTransfer.files); }}
            >
              <span className="icon">⌸</span>
              <span className="label">
                {fileLabel || doc ? "Drop another file, or click to browse" : "Drop a CBZ, PDF, image or document"}
              </span>
              <span className="hint">CBZ/ZIP · PDF · JPG/PNG/WebP · DOCX · PPTX · TXT/MD/CSV</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".cbz,.zip,.pdf,.docx,.pptx,.txt,.md,.csv,.rtf,image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
              multiple
              style={{ display: "none" }}
              onChange={(e) => { if (e.target.files?.length) void handleFiles(e.target.files); e.target.value = ""; }}
            />
            {fileLabel && (
              <>
                <div className="file-chip">
                  <span className="name">{fileLabel.name}</span>
                  <span className="pages">{fileLabel.count} page{fileLabel.count === 1 ? "" : "s"}</span>
                </div>
                <button className="link-btn" onClick={clearSaved}>Clear saved session</button>
              </>
            )}
          </div>

          <div className="section">
            <h3>Translation</h3>
            <div className="lang-row">
              <select value={srcLang} onChange={(e) => setSrcLang(e.target.value)}>
                <option value="auto">Auto‑detect source</option>
                {LANGS.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>
            <div className="lang-row">
              <span className="lang-arrow">→</span>
              <select value={tgtLang} onChange={(e) => setTgtLang(e.target.value)}>
                {LANGS.map((l) => (
                  <option key={l.code} value={l.code}>{l.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="section">
            <h3>Scan Restriction</h3>
            <ToggleRow title="Text regions only"
              desc="The model is instructed to locate and describe only bounding boxes that contain typeset or hand‑lettered text. It does not describe character art, backgrounds, or panel composition."
              checked={textOnly} onChange={setTextOnly} />
            <ToggleRow title="Skip text‑free pages"
              desc="A fast low‑resolution pre‑check flags pages with no visible text so they're copied through untouched — no full‑resolution analysis needed."
              checked={skipBlank} onChange={setSkipBlank} />
            <ToggleRow title="Don't flag strong language"
              desc="Translate slang, insults, and crude dialogue plainly and in‑register. The tool won't soften lines or mark a page as mature just because characters curse."
              checked={noFlag} onChange={setNoFlag} />
          </div>

          <div className="section">
            <h3>Glossary <span className="opt">(optional)</span></h3>
            <textarea
              className="field-text"
              value={glossary}
              onChange={(e) => setGlossary(e.target.value)}
              placeholder={"One per line, e.g.\nSakura → Sakura\nsenpai → senpai\n-chan → keep honorific"}
            />
          </div>

          <div className="section">
            <h3>Custom Instructions <span className="opt">(optional)</span></h3>
            <textarea
              className="field-text"
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
              placeholder={"e.g. Never use bubbles or backdrops on SFX.\nAll narration is past-tense.\nKeep -san / -kun honorifics."}
            />
          </div>

          <div className="section activity">
            <h3>Activity <span className="pacing-tag">{(pacingMs / 1000).toFixed(1)}s/page</span></h3>
            <div className="actions">
              {running ? (
                <button className="btn-primary stop" onClick={pauseTranslation}>Pause Translating</button>
              ) : remaining.length > 0 ? (
                <>
                  <button className="btn-primary" onClick={resumeTranslation}>Resume ({remaining.length} left)</button>
                  <button className="btn-secondary" onClick={() => { setRemaining([]); appendLog("Cleared pending queue."); }}>
                    Cancel Queue
                  </button>
                </>
              ) : (
                <button className="btn-primary" disabled={!pages.length} onClick={runTranslation}>
                  {pages.some((p) => p.status === "translated") ? "Translate Remaining" : "Translate All Pages"}
                </button>
              )}
              {!running && pages.some((p) => p.status === "translated") && (
                <button className="btn-secondary" disabled={running} onClick={rerunAll}>
                  Re-translate Everything
                </button>
              )}
              <button className="btn-secondary" disabled={!translatedCount || running || building} onClick={downloadCBZ}>
                {building ? "Building…" : downloadUrl ? "Rebuild CBZ" : "Build Translated CBZ"}
              </button>
              {downloadUrl && (
                <a className="download-link" href={downloadUrl} download={downloadName}>
                  ↓ Download {downloadName}
                </a>
              )}
              {doc && (
                <button className="btn-primary" disabled={docBusy} onClick={translateDoc}>
                  {docBusy ? "Translating document…" : `Translate Document (${doc.blocks.length} blocks)`}
                </button>
              )}
              {(doc || translatedCount > 0) && (
                <button className="btn-secondary" onClick={downloadTranscript}>
                  ↓ Download Transcript (original + translation)
                </button>
              )}
            </div>
            <div className="progress-mini">
              <div className="progress-bar"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
            </div>
            <div className="log" ref={logRef}>
              {log.length === 0 ? (
                <div className="skip-line">Activity will appear here.</div>
              ) : (
                log.map((l, i) => <div key={i} className={l.cls}>{l.text}</div>)
              )}
            </div>
          </div>
        </aside>

        <main className="main">
          <div className="topbar">
            <div className={`status${statusMode ? ` ${statusMode}` : ""}`}>
              <span className="dot" />
              <span>{statusText}</span>
            </div>
            <div className="view-toggle">
              <button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}>Grid</button>
              <button className={view === "single" ? "active" : ""} onClick={() => setView("single")}>Page</button>
            </div>
          </div>

          {/* Visible behind the mobile bottom-sheet when it's dragged down.
              Shows live translation status and quick toggles. */}
          <div className="sheet-backdrop" aria-hidden={sheetSnap !== 0}>
            <div className={`sb-status${statusMode ? ` ${statusMode}` : ""}`}>
              <span className="dot" />
              <span className="sb-text">{statusText}</span>
            </div>
            {pages.length > 0 && (
              <div className="sb-progress">
                <div className="sb-fill" style={{ width: `${progress}%` }} />
              </div>
            )}
            <div className="sb-toggles">
              <div className="sb-seg">
                <button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}>Grid</button>
                <button className={view === "single" ? "active" : ""} onClick={() => setView("single")}>Page</button>
              </div>
              <div className="sb-seg">
                <button className={!showTranslated ? "active" : ""} onClick={() => setShowTranslated(false)}>Original</button>
                <button className={showTranslated ? "active" : ""} onClick={() => setShowTranslated(true)}>Translated</button>
              </div>
            </div>
          </div>

          <div
            ref={sheetRef}
            className={`viewer sheet-snap-${sheetSnap}`}
          >
            <div
              className="drag-handle"
              onPointerDown={onSheetPointerDown}
              onPointerMove={onSheetPointerMove}
              onPointerUp={onSheetPointerUp}
              aria-label="Drag to resize panel"
            >
              <span className="grip" />
            </div>
            {doc && !pages.length && (
              <div className="doc-view">
                <div className="doc-title">{doc.name}</div>
                {doc.blocks.map((b, i) => (
                  <div className="doc-block" key={i}>
                    <div className="doc-src">{b}</div>
                    {doc.translations[i] && <div className="doc-tgt">{doc.translations[i]}</div>}
                  </div>
                ))}
              </div>
            )}
            {!pages.length && !doc && (
              <div className="empty-state">
                <div className="glyph">字</div>
                <div className="msg">
                  Load a CBZ to begin. Your file and any translations stay saved in this browser, so reloading or switching to desktop view won't lose progress.
                </div>
              </div>
            )}

            {pages.length > 0 && view === "grid" && (
              <div className="page-grid">
                {pages.map((p, i) => (
                  <div key={p.name + i}
                    className="page-card"
                    tabIndex={0}
                    role="button"
                    aria-label={`Open page ${i + 1}`}
                    onClick={() => openLightbox(i)}
                    onKeyDown={(e) => { if (e.key === "Enter") openLightbox(i); }}
                  >
                    <img src={p.url} loading="lazy" alt={`Page ${i + 1}`} />
                    <span className="num">#{String(i + 1).padStart(3, "0")}</span>
                    <span className={`badge ${p.status}`}>{badgeLabel(p.status)}</span>
                  </div>
                ))}
              </div>
            )}

            {pages.length > 0 && view === "single" && current && (
              <div className="single-page">
                <div className="single-page-nav">
                  <button aria-label="Previous page" disabled={currentIndex === 0}
                    onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}>‹</button>
                  <span>{currentIndex + 1} / {pages.length}</span>
                  <button aria-label="Next page" disabled={currentIndex === pages.length - 1}
                    onClick={() => setCurrentIndex((i) => Math.min(pages.length - 1, i + 1))}>›</button>
                </div>
                <div className="compare-label">{hasTranslation && showTranslated ? "Translated" : "Original"}</div>
                <div className="canvas-wrap" onClick={() => openLightbox(currentIndex)} role="button" aria-label="Open zoom view">
                  <canvas ref={canvasRef} />
                </div>
                <div className="single-actions">
                  <button className="btn-secondary" disabled={!hasTranslation}
                    onClick={() => setShowTranslated((v) => !v)}>
                    {showTranslated ? "Show Original" : "Show Translated"}
                  </button>
                  <button className="btn-secondary" disabled={running} onClick={translateCurrent}>
                    Translate This Page
                  </button>
                </div>
              </div>
            )}
          </div>
        </main>

        {lightboxIndex !== null && pages[lightboxIndex] && (() => {
          const lp = pages[lightboxIndex];
          const lpHasT = lp.status === "translated" && lp.regions.length > 0;
          return (
            <div className="lightbox" role="dialog" aria-modal="true">
              <div className="lightbox-bar">
                <button className="lb-btn lb-back" onClick={closeLightbox} aria-label="Close">← Back</button>
                <span className="lb-count">{lightboxIndex + 1} / {pages.length}</span>
                {lpHasT ? (
                  <div className="lb-seg" role="tablist" aria-label="View">
                    <button role="tab" aria-selected={!lightboxTranslated}
                      className={!lightboxTranslated ? "active" : ""}
                      onClick={() => setLightboxTranslated(false)}>Original</button>
                    <button role="tab" aria-selected={lightboxTranslated}
                      className={lightboxTranslated ? "active" : ""}
                      onClick={() => setLightboxTranslated(true)}>Translated</button>
                  </div>
                ) : (
                  <span className="lb-btn" aria-disabled="true" style={{ opacity: 0.5 }}>No translation</span>
                )}
              </div>

              <TransformWrapper
                minScale={1}
                maxScale={5}
                doubleClick={{ mode: "reset", animationTime: 180 }}
                wheel={{ step: 0.2 }}
                pinch={{ step: 5 }}
                panning={{ velocityDisabled: false }}
                limitToBounds={false}
                centerOnInit={true}
                centerZoomedOut={false}
              >
                {({ zoomIn, zoomOut, resetTransform }) => (
                  <>
                    <button className="lb-nav prev" aria-label="Previous"
                      disabled={lightboxIndex === 0}
                      onClick={() => { resetTransform(); setLightboxIndex((i) => i === null ? null : Math.max(0, i - 1)); }}>
                      ‹
                    </button>
                    <TransformComponent
                      wrapperClass="lb-stage"
                      contentClass="lb-stage-content"
                    >
                      <canvas ref={lightboxCanvasRef} />
                    </TransformComponent>
                    <button className="lb-nav next" aria-label="Next"
                      disabled={lightboxIndex === pages.length - 1}
                      onClick={() => { resetTransform(); setLightboxIndex((i) => i === null ? null : Math.min(pages.length - 1, i + 1)); }}>
                      ›
                    </button>
                    <div className="lb-zoom">
                      <button className="lb-btn" onClick={() => zoomOut()} aria-label="Zoom out">−</button>
                      <button className="lb-btn" onClick={() => zoomIn()} aria-label="Zoom in">+</button>
                      <button className="lb-btn" onClick={() => resetTransform()}>Reset</button>
                    </div>
                  </>
                )}
              </TransformWrapper>
            </div>
          );
        })()}
      </div>
    </>
  );
}

// Snap-point math: viewer's translateY in px. Sheet snap is only used on mobile.
function snapTop(s: 0 | 1 | 2): number {
  if (typeof window === "undefined") return 0;
  const h = window.innerHeight;
  // 0 = peek (sheet pulled down — backdrop fully visible), 1 = mid, 2 = full
  if (s === 0) return Math.round(h * 0.78);
  if (s === 1) return Math.round(h * 0.35);
  return 0;
}

function ToggleRow({ title, desc, checked, onChange }: {
  title: string; desc: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="toggle-row">
      <div className="copy">
        <div className="t">{title}</div>
        <div className="d">{desc}</div>
      </div>
      <label className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="track" role="switch" aria-checked={checked} aria-label={title} />
      </label>
    </div>
  );
}

const CSS = `
:root {
  --ink: #1A1A1F;
  --paper: #F7F4ED;
  --panel: #E8E2D4;
  --accent: #C9402A;
  --muted: #4A4A52;
  --line: #D6CFBE;
  --ok: #3F7A4E;
}
html, body { margin: 0; height: 100%; background: var(--paper); color: var(--ink); font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; overscroll-behavior-y: contain; }
* { box-sizing: border-box; }
.app { display: flex; height: 100vh; height: 100dvh; overflow: hidden; }
.sidebar { width: 320px; flex-shrink: 0; background: var(--panel); border-right: 1px solid var(--line); display: flex; flex-direction: column; overflow-y: auto; }
.brand { padding: 22px 20px 16px; border-bottom: 1px solid var(--line); }
.brand .mark { font-family: 'Archivo Narrow', 'Inter', sans-serif; font-weight: 800; font-size: 22px; letter-spacing: 0.5px; text-transform: uppercase; display: flex; align-items: baseline; gap: 8px; }
.brand .mark .accent { color: var(--accent); }
.brand .sub { margin-top: 4px; font-size: 12px; color: var(--muted); line-height: 1.5; }
.section { padding: 16px 20px; border-bottom: 1px solid var(--line); }
.section h3 { font-family: 'Archivo Narrow', sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: var(--muted); margin: 0 0 10px; display: flex; align-items: center; justify-content: space-between; }
.section h3 .opt { font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 10px; }
.section h3 .pacing-tag { font-family: 'JetBrains Mono', monospace; font-weight: 600; font-size: 10px; letter-spacing: 0; color: var(--accent); text-transform: none; }
.dropzone { border: 1.5px dashed var(--ink); border-radius: 4px; padding: 20px 14px; text-align: center; cursor: pointer; transition: background .15s, border-color .15s; background: var(--paper); }
.dropzone:hover, .dropzone.drag { background: #fff; border-color: var(--accent); }
.dropzone .icon { font-size: 22px; display: block; margin-bottom: 6px; }
.dropzone .label { font-weight: 600; font-size: 13px; }
.dropzone .hint { font-size: 11px; color: var(--muted); margin-top: 4px; display:block; }
.file-chip { margin-top: 10px; background: var(--paper); border: 1px solid var(--line); border-radius: 4px; padding: 8px 10px; font-size: 12px; font-family: 'JetBrains Mono', monospace; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.file-chip .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-chip .pages { color: var(--muted); flex-shrink: 0; }
.link-btn { background: none; border: none; color: var(--muted); font-size: 11px; padding: 8px 0 0; cursor: pointer; text-decoration: underline; font-family: inherit; }
.link-btn:hover { color: var(--accent); }
.lang-row { display: flex; align-items: center; gap: 8px; }
select, .field-text { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 4px; background: var(--paper); color: var(--ink); font-family: inherit; font-size: 13px; appearance: none; }
.lang-row select { flex: 1; }
.lang-arrow { color: var(--muted); font-size: 14px; flex-shrink: 0; }
.lang-row + .lang-row { margin-top: 8px; }
textarea.field-text { resize: vertical; min-height: 64px; line-height: 1.5; font-size: 12px; }
.toggle-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 4px 0; }
.toggle-row + .toggle-row { margin-top: 12px; }
.toggle-row .copy { flex: 1; }
.toggle-row .copy .t { font-weight: 600; font-size: 13px; }
.toggle-row .copy .d { font-size: 11px; color: var(--muted); margin-top: 2px; line-height: 1.4; }
.switch { position: relative; width: 38px; height: 22px; flex-shrink: 0; margin-top: 1px; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch .track { position: absolute; inset: 0; background: var(--line); border-radius: 22px; cursor: pointer; transition: background .15s; }
.switch .track::before { content: ''; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: var(--paper); border-radius: 50%; transition: transform .15s; }
.switch input:checked + .track { background: var(--ok); }
.switch input:checked + .track::before { transform: translateX(16px); }
.section.activity { background: rgba(0,0,0,0.02); }
.actions { display: flex; flex-direction: column; gap: 8px; }
button { font-family: inherit; cursor: pointer; border: none; border-radius: 4px; }
.btn-primary { background: var(--ink); color: var(--paper); font-weight: 700; font-size: 13px; letter-spacing: 0.4px; text-transform: uppercase; padding: 12px; transition: background .15s; }
.btn-primary:hover:not(:disabled) { background: var(--accent); }
.btn-primary:disabled { background: var(--line); color: var(--muted); cursor: not-allowed; }
.btn-primary.stop { background: var(--accent); }
.btn-primary.stop:hover { background: #a3321e; }
.download-link { display: block; text-align: center; padding: 11px 12px; background: var(--ok); color: var(--paper); text-decoration: none; font-weight: 700; font-size: 13px; letter-spacing: 0.4px; text-transform: uppercase; border-radius: 4px; font-family: 'JetBrains Mono', monospace; word-break: break-all; }
.download-link:hover { background: #2f5d3b; }
.single-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
.btn-secondary { background: transparent; border: 1px solid var(--ink); color: var(--ink); font-weight: 600; font-size: 12px; padding: 10px; text-transform: uppercase; letter-spacing: 0.4px; }
.btn-secondary:hover:not(:disabled) { background: var(--ink); color: var(--paper); }
.btn-secondary:disabled { opacity: 0.4; cursor: not-allowed; }
.progress-mini { margin-top: 10px; }
.progress-bar { height: 3px; background: var(--line); overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent); width: 0%; transition: width .3s ease; }
.log { margin-top: 10px; background: var(--ink); color: #C9C5BA; font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.65; border-radius: 4px; padding: 10px 12px; max-height: 30vh; min-height: 80px; overflow-y: auto; }
.log .accent-line { color: #E8825E; }
.log .ok-line { color: #7FBB8A; }
.log .skip-line { color: #8A8A92; }
.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
.topbar { display: flex; align-items: center; justify-content: space-between; padding: 14px 24px; border-bottom: 1px solid var(--line); background: var(--paper); flex-shrink: 0; }
.topbar .status { font-family: 'Archivo Narrow', sans-serif; font-weight: 700; font-size: 13px; letter-spacing: 0.5px; text-transform: uppercase; color: var(--muted); display: flex; align-items: center; gap: 8px; }
.status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); }
.status.busy .dot { background: var(--accent); animation: pulse 1s infinite; }
.status.done .dot { background: var(--ok); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.view-toggle { display: flex; border: 1px solid var(--ink); border-radius: 4px; overflow: hidden; }
.view-toggle button { background: var(--paper); color: var(--ink); font-size: 12px; font-weight: 600; padding: 7px 14px; text-transform: uppercase; letter-spacing: 0.4px; }
.view-toggle button.active { background: var(--ink); color: var(--paper); }
.viewer { flex: 1; overflow-y: auto; padding: 24px; position: relative; }
.drag-handle { display: none; }
.doc-view { padding: 16px; display: flex; flex-direction: column; gap: 14px; overflow: auto; }
.doc-view .doc-title { font-weight: 700; font-size: 15px; opacity: .8; }
.doc-block { border: 1px solid rgba(0,0,0,.08); border-radius: 10px; padding: 10px 12px; background: rgba(255,255,255,.5); }
.doc-src { white-space: pre-wrap; font-size: 13px; opacity: .62; }
.doc-tgt { white-space: pre-wrap; font-size: 14px; margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(0,0,0,.12); }
.empty-state { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: var(--muted); gap: 8px; padding: 20px; }
.empty-state .glyph { font-family: 'Archivo Narrow', sans-serif; font-size: 64px; font-weight: 800; color: var(--panel); line-height: 1; }
.empty-state .msg { font-size: 14px; max-width: 320px; line-height: 1.6; }
.page-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 14px; }
.page-card { background: var(--panel); border-radius: 4px; overflow: hidden; cursor: pointer; border: 2px solid transparent; transition: border-color .15s, transform .1s; position: relative; }
.page-card:hover { border-color: var(--accent); transform: translateY(-2px); }
.page-card img { width: 100%; display: block; aspect-ratio: 2/3; object-fit: cover; background: var(--paper); }
.page-card .num { position: absolute; top: 6px; left: 6px; background: var(--ink); color: var(--paper); font-family: 'JetBrains Mono', monospace; font-size: 10px; padding: 2px 6px; border-radius: 3px; }
.page-card .badge { position: absolute; top: 6px; right: 6px; font-family: 'JetBrains Mono', monospace; font-size: 10px; padding: 2px 6px; border-radius: 3px; color: var(--paper); }
.badge.translated { background: var(--ok); }
.badge.skipped { background: var(--muted); }
.badge.pending { background: var(--line); color: var(--muted); }
.badge.processing { background: var(--accent); }
.single-page { display: flex; flex-direction: column; align-items: center; gap: 14px; }
.single-page-nav { display: flex; align-items: center; gap: 14px; font-family: 'JetBrains Mono', monospace; font-size: 13px; }
.single-page-nav button { background: var(--ink); color: var(--paper); width: 34px; height: 34px; font-size: 16px; border-radius: 4px; }
.single-page-nav button:disabled { background: var(--line); color: var(--muted); cursor: not-allowed; }
.canvas-wrap { position: relative; max-width: 100%; box-shadow: 0 4px 24px rgba(26,26,31,0.15); line-height: 0; cursor: zoom-in; }
.canvas-wrap canvas { width: 100%; height: auto; max-height: 78vh; display: block; object-fit: contain; }
.compare-label { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--muted); letter-spacing: 0.5px; text-transform: uppercase; }

/* Sheet backdrop — hidden on desktop, visible on mobile under the sheet */
.sheet-backdrop { display: none; }

/* Lightbox */
.lightbox { position: fixed; inset: 0; background: rgba(15,15,18,0.96); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 64px 16px 80px; padding-top: max(64px, env(safe-area-inset-top)); padding-bottom: max(80px, env(safe-area-inset-bottom)); }
.lightbox-bar { position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; padding-top: max(10px, env(safe-area-inset-top)); background: linear-gradient(rgba(0,0,0,0.55), rgba(0,0,0,0)); color: var(--paper); z-index: 2; gap: 10px; }
.lb-count { font-family: 'JetBrains Mono', monospace; font-size: 13px; letter-spacing: 0.5px; }
.lb-btn { background: rgba(0,0,0,0.5); border: 1px solid rgba(247,244,237,0.35); color: var(--paper); font-family: 'Archivo Narrow', sans-serif; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; padding: 10px 16px; border-radius: 4px; cursor: pointer; min-height: 44px; min-width: 44px; }
.lb-btn:hover:not(:disabled) { background: rgba(247,244,237,0.18); border-color: var(--paper); }
.lb-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.lb-back { font-size: 14px; }
.lb-stage { width: 100% !important; height: 100% !important; }
.lb-stage canvas { max-width: 100%; max-height: calc(100dvh - 160px); height: auto; width: auto; display: block; object-fit: contain; box-shadow: 0 8px 40px rgba(0,0,0,0.6); }
.lb-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 48px; height: 64px; background: rgba(0,0,0,0.45); color: var(--paper); border: 1px solid rgba(247,244,237,0.2); font-size: 26px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; z-index: 2; }
.lb-nav:hover:not(:disabled) { background: rgba(0,0,0,0.7); }
.lb-nav:disabled { opacity: 0.25; cursor: not-allowed; }
.lb-nav.prev { left: 8px; }
.lb-nav.next { right: 8px; }
.lb-seg { display: flex; border: 1px solid rgba(247,244,237,0.4); border-radius: 4px; overflow: hidden; }
.lb-seg button { background: transparent; color: var(--paper); font-family: 'Archivo Narrow', sans-serif; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; padding: 10px 14px; border: none; cursor: pointer; min-height: 44px; }
.lb-seg button.active { background: var(--paper); color: var(--ink); }
.lb-zoom { position: absolute; bottom: 14px; bottom: max(14px, env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; background: rgba(0,0,0,0.55); padding: 6px 10px; border-radius: 999px; z-index: 2; }
.lb-zoom .lb-btn { padding: 6px 14px; font-size: 14px; min-width: 44px; min-height: 40px; }

/* ---- Mobile: bottom-sheet for the viewer ---- */
@media (max-width: 760px) {
  .app { flex-direction: column; }
  .sidebar { width: 100%; max-height: 50vh; border-right: none; border-bottom: 1px solid var(--line); }
  /* On mobile, hide the sidebar entirely — its contents are inside the sheet via the page itself */
  .main { flex: 1; min-height: 0; position: relative; }
  /* The topbar's status + view toggle are duplicated inside the sheet-backdrop,
     which sits behind the draggable sheet. Hide the topbar on mobile so the
     controls live in exactly one place and the backdrop has the full width. */
  .topbar { display: none; }
  .viewer {
    position: fixed;
    left: 0; right: 0; bottom: 0;
    top: 0;
    background: var(--paper);
    z-index: 50;
    border-top: 1px solid var(--line);
    border-radius: 16px 16px 0 0;
    box-shadow: 0 -8px 24px rgba(0,0,0,0.12);
    padding: 0 14px 14px;
    overflow-y: auto;
    transition: transform .25s cubic-bezier(.22,.61,.36,1);
    will-change: transform;
    touch-action: pan-y;
  }
  /* Snap points — translateY values mirror snapTop() in JS */
  .viewer.sheet-snap-0 { transform: translateY(78dvh); }
  .viewer.sheet-snap-1 { transform: translateY(35dvh); }
  .viewer.sheet-snap-2 { transform: translateY(0); }
  .viewer .drag-handle {
    display: flex; justify-content: center; align-items: center;
    height: 24px; margin: 0 -14px 8px;
    cursor: ns-resize; touch-action: none; user-select: none;
    position: sticky; top: 0; background: var(--paper); z-index: 4;
    border-radius: 16px 16px 0 0;
  }
  .viewer .drag-handle .grip { display: block; width: 44px; height: 5px; border-radius: 3px; background: var(--line); }
  .viewer .drag-handle:active .grip { background: var(--accent); }
  /* While the sheet is collapsed, the canvas below it (the currently-displayed page) shows */
  .sheet-backdrop {
    display: flex; flex-direction: column; gap: 10px;
    position: absolute; inset: 0; z-index: 1;
    background: var(--paper); color: var(--ink);
    padding: 16px 18px;
    border-top: 1px solid var(--line);
  }
  .sb-status { font-family: 'Archivo Narrow', sans-serif; font-weight: 700; font-size: 13px; letter-spacing: 0.5px; text-transform: uppercase; color: var(--muted); display: flex; align-items: center; gap: 8px; }
  .sb-status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); }
  .sb-status.busy .dot { background: var(--accent); animation: pulse 1s infinite; }
  .sb-status.done .dot { background: var(--ok); }
  .sb-progress { height: 3px; background: var(--line); overflow: hidden; border-radius: 2px; }
  .sb-fill { height: 100%; background: var(--accent); transition: width .3s ease; }
  .sb-toggles { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
  .sb-seg { display: flex; border: 1px solid var(--ink); border-radius: 4px; overflow: hidden; }
  .sb-seg button { flex: 1; background: var(--paper); color: var(--ink); font-family: 'Archivo Narrow', sans-serif; font-weight: 700; font-size: 12px; padding: 10px; text-transform: uppercase; letter-spacing: 0.5px; border: none; cursor: pointer; min-height: 44px; }
  .sb-seg button.active { background: var(--ink); color: var(--paper); }
  .canvas-wrap canvas { max-height: 60vh; }
  .lightbox { padding: 56px 4px 72px; }
  .lb-nav { width: 40px; height: 56px; font-size: 22px; }
}
`;