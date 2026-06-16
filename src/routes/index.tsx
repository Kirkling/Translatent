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
type Region = {
  x: number; y: number; w: number; h: number;
  translated: string; bg: string;
  kind: RegionKind;
  hasBackdrop: boolean;
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

const LANG_NAMES: Record<string, string> = {
  auto: "the source language",
  ja: "Japanese",
  zh: "Chinese",
  ko: "Korean",
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
};

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

function drawTextBox(ctx: CanvasRenderingContext2D, r: Region) {
  const { x, y, w, h, translated, bg, kind, hasBackdrop } = r;
  ctx.save();
  const family = `'Inter', 'Helvetica Neue', Arial, sans-serif`;
  const fill = bg || "#FFFFFF";
  const ink = pickInk(fill);

  if (hasBackdrop) {
    // Redraw bubble at the SAME dimensions as the original so it overlays cleanly.
    // Only a tiny pad so anti-aliased edges of the original glyphs are covered.
    const pad = Math.max(1, Math.min(w, h) * 0.02);
    const bx = x - pad, by = y - pad, bw = w + pad * 2, bh = h + pad * 2;
    const radius = kind === "narration" ? 2 : Math.max(4, Math.min(bw, bh) * 0.22);
    ctx.fillStyle = fill;
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, radius);
      ctx.fill();
    } else ctx.fillRect(bx, by, bw, bh);
  } else {
    // No backdrop: sample a ring around the bbox to get the underlying art
    // color, then erase the original text with that color so the translated
    // text sits directly on the artwork — no rectangle, no shadow, no plate.
    try {
      const ring = Math.max(2, Math.min(w, h) * 0.06);
      const sx = Math.max(0, Math.floor(x - ring));
      const sy = Math.max(0, Math.floor(y - ring));
      const sw = Math.min(ctx.canvas.width - sx, Math.ceil(w + ring * 2));
      const sh = Math.min(ctx.canvas.height - sy, Math.ceil(h + ring * 2));
      const sample = ctx.getImageData(sx, sy, sw, sh).data;
      // Average pixels on the outer ring only (skip interior, which holds text)
      let rs = 0, gs = 0, bs = 0, n = 0;
      for (let py = 0; py < sh; py++) {
        for (let px = 0; px < sw; px++) {
          const inInterior = px >= ring && px < sw - ring && py >= ring && py < sh - ring;
          if (inInterior) continue;
          const o = (py * sw + px) * 4;
          rs += sample[o]; gs += sample[o + 1]; bs += sample[o + 2]; n++;
        }
      }
      if (n > 0) {
        const ar = Math.round(rs / n), ag = Math.round(gs / n), ab = Math.round(bs / n);
        const grad = ctx.createRadialGradient(
          x + w / 2, y + h / 2, Math.min(w, h) * 0.15,
          x + w / 2, y + h / 2, Math.max(w, h) * 0.7,
        );
        grad.addColorStop(0, `rgba(${ar},${ag},${ab},1)`);
        grad.addColorStop(1, `rgba(${ar},${ag},${ab},0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(x - w * 0.2, y - h * 0.2, w * 1.4, h * 1.4);
      }
    } catch {/* ignore CORS or empty canvas */}
  }

  ctx.fillStyle = ink;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const padX = Math.max(2, w * 0.04);
  const padY = Math.max(1, h * 0.04);
  const maxWidth = w - padX * 2;
  const maxHeight = h - padY * 2;
  // Match the original text's pixel height. The bbox should hug the glyphs,
  // so use the box height itself as the starting font size and only shrink
  // if the translation overflows.
  let fontSize = Math.min(
    Math.floor(h * (kind === "sfx" ? 0.95 : 0.78)),
    Math.max(12, Math.floor(Math.sqrt((w * h) / Math.max(6, translated.length)) * 1.4)),
  );
  let lines: string[] = [];
  const lineGap = 1.18;
  const weight = kind === "sfx" ? 800 : kind === "narration" ? 500 : 600;
  const display = kind === "sfx" ? translated.toUpperCase() : translated;
  for (; fontSize >= 9; fontSize -= 1) {
    ctx.font = `${weight} ${fontSize}px ${family}`;
    lines = wrapText(ctx, display, maxWidth);
    const totalHeight = lines.length * fontSize * lineGap;
    const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
    if (totalHeight <= maxHeight && widest <= maxWidth) break;
    if (fontSize === 9) break;
  }
  ctx.font = `${weight} ${fontSize}px ${family}`;
  const lineHeight = fontSize * lineGap;
  const totalTextHeight = (lines.length - 1) * lineHeight + fontSize;
  const cy = y + h / 2 - totalTextHeight / 2 + fontSize / 2;
  const cx = x + w / 2;

  // No stroke / shadow — user wants overlay to match original style exactly.
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], cx, cy + i * lineHeight, maxWidth);
  }
  ctx.restore();
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
    canvas.style.width = "100%"; canvas.style.height = "auto";
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
              aria-label="Choose a CBZ file"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) void handleFile(f); }}
            >
              <span className="icon">⌸</span>
              <span className="label">
                {fileLabel ? "Drop another .cbz, or click to browse" : "Drop a .cbz file, or click to browse"}
              </span>
              <span className="hint">CBZ archives of image pages only</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".cbz,.zip"
              style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
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
                <option value="ja">Japanese</option>
                <option value="zh">Chinese (Simplified/Traditional)</option>
                <option value="ko">Korean</option>
              </select>
            </div>
            <div className="lang-row">
              <span className="lang-arrow">→</span>
              <select value={tgtLang} onChange={(e) => setTgtLang(e.target.value)}>
                <option value="en">English</option>
                <option value="es">Spanish</option>
                <option value="fr">French</option>
                <option value="de">German</option>
                <option value="pt">Portuguese</option>
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
              <button className="btn-secondary" disabled={!translatedCount || running || building} onClick={downloadCBZ}>
                {building ? "Building…" : downloadUrl ? "Rebuild CBZ" : "Build Translated CBZ"}
              </button>
              {downloadUrl && (
                <a className="download-link" href={downloadUrl} download={downloadName}>
                  ↓ Download {downloadName}
                </a>
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
            {!pages.length && (
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
                wheel={{ step: 0.15 }}
                pinch={{ step: 5 }}
                limitToBounds={true}
                centerOnInit={true}
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
  // 0 = peek (sheet only shows ~28% of height), 1 = mid (~62%), 2 = full (~94%)
  if (s === 0) return Math.round(h * 0.62);
  if (s === 1) return Math.round(h * 0.18);
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
.canvas-wrap canvas { max-width: 100%; max-height: 78vh; display: block; }
.compare-label { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--muted); letter-spacing: 0.5px; text-transform: uppercase; }

/* Lightbox */
.lightbox { position: fixed; inset: 0; background: rgba(15,15,18,0.96); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 64px 16px 80px; padding-top: max(64px, env(safe-area-inset-top)); padding-bottom: max(80px, env(safe-area-inset-bottom)); }
.lightbox-bar { position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; padding-top: max(10px, env(safe-area-inset-top)); background: linear-gradient(rgba(0,0,0,0.55), rgba(0,0,0,0)); color: var(--paper); z-index: 2; gap: 10px; }
.lb-count { font-family: 'JetBrains Mono', monospace; font-size: 13px; letter-spacing: 0.5px; }
.lb-btn { background: rgba(0,0,0,0.5); border: 1px solid rgba(247,244,237,0.35); color: var(--paper); font-family: 'Archivo Narrow', sans-serif; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; padding: 10px 16px; border-radius: 4px; cursor: pointer; min-height: 44px; min-width: 44px; }
.lb-btn:hover:not(:disabled) { background: rgba(247,244,237,0.18); border-color: var(--paper); }
.lb-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.lb-back { font-size: 14px; }
.lb-stage { width: 100% !important; height: 100% !important; }
.lb-stage canvas { max-width: 100%; max-height: calc(100dvh - 160px); display: block; box-shadow: 0 8px 40px rgba(0,0,0,0.6); }
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
  .topbar { padding: 10px 14px; }
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
  .viewer.sheet-snap-0 { transform: translateY(62dvh); }
  .viewer.sheet-snap-1 { transform: translateY(18dvh); }
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
  .main::before {
    content: "";
    position: absolute; inset: 0;
    background: var(--paper);
    z-index: 0;
  }
  .canvas-wrap canvas { max-height: 60vh; }
  .lightbox { padding: 56px 4px 72px; }
  .lb-nav { width: 40px; height: 56px; font-size: 22px; }
}
`;