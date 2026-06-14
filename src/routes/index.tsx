import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import JSZip from "jszip";

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
    ],
  }),
  component: Index,
});

type PageStatus = "pending" | "processing" | "translated" | "skipped";
type Region = { x: number; y: number; w: number; h: number; translated: string; bg: string };
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
  c.width = w;
  c.height = h;
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
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function drawTextBox(ctx: CanvasRenderingContext2D, r: Region) {
  const { x, y, w, h, translated, bg } = r;
  ctx.save();
  ctx.fillStyle = bg || "#FFFFFF";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#000000";
  ctx.textBaseline = "top";
  const padding = Math.max(2, Math.min(w, h) * 0.06);
  const maxWidth = w - padding * 2;
  const maxHeight = h - padding * 2;
  let fontSize = Math.max(10, Math.floor(h * 0.22));
  let lines: string[] = [];
  const family = `'Inter', 'Helvetica Neue', Arial, sans-serif`;
  for (; fontSize >= 8; fontSize -= 1) {
    ctx.font = `600 ${fontSize}px ${family}`;
    lines = wrapText(ctx, translated, maxWidth);
    const totalHeight = lines.length * fontSize * 1.18;
    if (totalHeight <= maxHeight || fontSize === 8) break;
  }
  ctx.font = `600 ${fontSize}px ${family}`;
  ctx.textAlign = "center";
  const lineHeight = fontSize * 1.18;
  const totalTextHeight = lines.length * lineHeight;
  let ty = y + padding + Math.max(0, (maxHeight - totalTextHeight) / 2);
  const tx = x + w / 2;
  for (const line of lines) {
    ctx.fillText(line, tx, ty, maxWidth);
    ty += lineHeight;
  }
  ctx.restore();
}

function Index() {
  const [pages, setPages] = useState<Page[]>([]);
  const [fileLabel, setFileLabel] = useState<{ name: string; count: number } | null>(null);
  const [view, setView] = useState<"grid" | "single">("grid");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showTranslated, setShowTranslated] = useState(false);
  const [statusText, setStatusText] = useState("No file loaded");
  const [statusMode, setStatusMode] = useState<"" | "busy" | "done">("");
  const [progress, setProgress] = useState(0);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [drag, setDrag] = useState(false);

  const [srcLang, setSrcLang] = useState("auto");
  const [tgtLang, setTgtLang] = useState("en");
  const [textOnly, setTextOnly] = useState(true);
  const [skipBlank, setSkipBlank] = useState(true);
  const [noFlag, setNoFlag] = useState(true);
  const [glossary, setGlossary] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const appendLog = useCallback((text: string, cls?: LogLine["cls"]) => {
    setLog((prev) => [...prev, { text, cls }]);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      pages.forEach((p) => URL.revokeObjectURL(p.url));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      setStatusText("Reading archive…");
      setStatusMode("busy");
      appendLog(`Opening ${file.name}…`);
      try {
        const buf = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(buf);
        const entries = Object.values(zip.files)
          .filter((f) => !f.dir && /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name))
          .sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
          );
        if (entries.length === 0) {
          appendLog("No image files found in archive.", "accent-line");
          setStatusText("No images found");
          setStatusMode("");
          return;
        }
        const loaded: Page[] = [];
        for (const entry of entries) {
          const blob = await entry.async("blob");
          const url = URL.createObjectURL(blob);
          const img = await loadImage(url);
          loaded.push({
            name: entry.name,
            blob,
            url,
            img,
            w: img.naturalWidth,
            h: img.naturalHeight,
            status: "pending",
            regions: [],
          });
        }
        // revoke old
        pages.forEach((p) => URL.revokeObjectURL(p.url));
        setPages(loaded);
        setCurrentIndex(0);
        setFileLabel({ name: file.name, count: loaded.length });
        setStatusText(`${loaded.length} pages loaded`);
        setStatusMode("done");
        appendLog(`Loaded ${loaded.length} pages.`, "ok-line");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(`Failed to read archive: ${msg}`, "accent-line");
        setStatusText("Failed to read file");
        setStatusMode("");
      }
    },
    [appendLog, pages],
  );

  // Draw canvas whenever current page / overlay changes
  useEffect(() => {
    if (view !== "single") return;
    const p = pages[currentIndex];
    const canvas = canvasRef.current;
    if (!p || !canvas) return;
    canvas.width = p.w;
    canvas.height = p.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(p.img, 0, 0, p.w, p.h);
    const hasTranslation = p.status === "translated" && p.regions.length > 0;
    if (hasTranslation && showTranslated) {
      for (const r of p.regions) drawTextBox(ctx, r);
    }
  }, [view, currentIndex, pages, showTranslated]);

  const callServer = useCallback(
    async (page: Page, kind: "presence" | "detect") => {
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
      const res = await fetch("/api/translate", { method: "POST", body: fd });
      const data = (await res.json()) as { error?: string; hasText?: boolean; regions?: Region[] };
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
    [srcLang, tgtLang, glossary, noFlag, textOnly],
  );

  const downloadCBZ = useCallback(async () => {
    if (!pages.length) return;
    appendLog("Building translated CBZ…");
    const zip = new JSZip();
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      let blob: Blob = p.blob;
      if (p.status === "translated" && p.regions.length) {
        const c = document.createElement("canvas");
        c.width = p.w;
        c.height = p.h;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(p.img, 0, 0, p.w, p.h);
        for (const r of p.regions) drawTextBox(ctx, r);
        blob = await new Promise<Blob>((res) =>
          c.toBlob((b) => res(b!), "image/jpeg", 0.9),
        );
      }
      const ext = blob.type === "image/png" ? "png" : "jpg";
      const num = String(i + 1).padStart(4, "0");
      zip.file(`${num}.${ext}`, blob);
    }
    const out = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(out);
    const a = document.createElement("a");
    const baseName = (fileLabel?.name || "translated.cbz").replace(/\.[^.]+$/, "");
    a.href = url;
    a.download = `${baseName}.translated.cbz`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    appendLog("Download ready.", "ok-line");
  }, [pages, fileLabel, appendLog]);

  const runTranslation = useCallback(async () => {
    if (running || !pages.length) return;
    setRunning(true);
    setStatusText("Translating pages…");
    setStatusMode("busy");
    setProgress(0);

    const updatePage = (i: number, patch: Partial<Page>) => {
      setPages((prev) => {
        const next = prev.slice();
        next[i] = { ...next[i], ...patch };
        return next;
      });
    };

    let done = 0;
    const total = pages.length;
    for (let i = 0; i < total; i++) {
      const page = pages[i];
      updatePage(i, { status: "processing" });
      try {
        const { regions } = await callServer(page, "detect");
        const safe = regions || [];
        if (skipBlank && safe.length === 0) {
          updatePage(i, { status: "skipped" });
          appendLog(`Page ${i + 1}: no text detected — copied through untouched.`, "skip-line");
        } else {
          updatePage(i, { status: "translated", regions: safe });
          appendLog(
            `Page ${i + 1}: ${safe.length} text region${safe.length === 1 ? "" : "s"} translated.`,
            "ok-line",
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        updatePage(i, { status: "skipped" });
        appendLog(`Page ${i + 1}: ${msg}`, "accent-line");
      }
      done++;
      setProgress((done / total) * 100);
      // small pacing delay to avoid bursting the AI gateway
      await new Promise((r) => setTimeout(r, 400));
    }

    setRunning(false);
    setStatusText("Translation complete");
    setStatusMode("done");
    setProgress(100);
    appendLog("Done.", "ok-line");
  }, [pages, running, skipBlank, callServer, appendLog]);

  const current = pages[currentIndex];
  const hasTranslation = !!current && current.status === "translated" && current.regions.length > 0;
  const translatedCount = pages.filter((p) => p.status === "translated").length;

  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <div className="mark">
              Koe<span className="accent">/</span>Box
            </div>
            <div className="sub">
              In‑place manga text replacement. Reads only text regions — artwork stays untouched.
            </div>
          </div>

          <div className="section">
            <h3>Source File</h3>
            <div
              className={`dropzone${drag ? " drag" : ""}`}
              tabIndex={0}
              role="button"
              aria-label="Choose a CBZ file"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                const f = e.dataTransfer.files[0];
                if (f) void handleFile(f);
              }}
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
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
            {fileLabel && (
              <div className="file-chip">
                <span className="name">{fileLabel.name}</span>
                <span className="pages">
                  {fileLabel.count} page{fileLabel.count === 1 ? "" : "s"}
                </span>
              </div>
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

            <ToggleRow
              title="Text regions only"
              desc="The model is instructed to locate and describe only bounding boxes that contain typeset or hand‑lettered text. It does not describe character art, backgrounds, or panel composition."
              checked={textOnly}
              onChange={setTextOnly}
            />
            <ToggleRow
              title="Skip text‑free pages"
              desc="A fast low‑resolution pre‑check flags pages with no visible text so they're copied through untouched — no full‑resolution analysis needed."
              checked={skipBlank}
              onChange={setSkipBlank}
            />
            <ToggleRow
              title="Don't flag strong language"
              desc="Translate slang, insults, and crude dialogue plainly and in‑register. The tool won't soften lines or mark a page as mature just because characters curse."
              checked={noFlag}
              onChange={setNoFlag}
            />
          </div>

          <div className="section">
            <h3>
              Glossary{" "}
              <span
                style={{
                  fontWeight: 400,
                  textTransform: "none",
                  letterSpacing: 0,
                  fontSize: 10,
                }}
              >
                (optional)
              </span>
            </h3>
            <textarea
              className="field-text"
              value={glossary}
              onChange={(e) => setGlossary(e.target.value)}
              placeholder={"One per line, e.g.\nSakura → Sakura\nsenpai → senpai\n-chan → keep honorific"}
            />
          </div>

          <div className="actions">
            <button
              className="btn-primary"
              disabled={!pages.length || running}
              onClick={runTranslation}
            >
              {running ? "Translating…" : "Translate Pages"}
            </button>
            <button
              className="btn-secondary"
              disabled={!translatedCount}
              onClick={downloadCBZ}
            >
              Download Translated CBZ
            </button>
          </div>
        </aside>

        <main className="main">
          <div className="topbar">
            <div className={`status${statusMode ? ` ${statusMode}` : ""}`}>
              <span className="dot" />
              <span>{statusText}</span>
            </div>
            <div className="view-toggle">
              <button
                className={view === "grid" ? "active" : ""}
                onClick={() => setView("grid")}
              >
                Grid
              </button>
              <button
                className={view === "single" ? "active" : ""}
                onClick={() => setView("single")}
              >
                Page
              </button>
            </div>
          </div>

          <div className="progress-wrap">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>

          <div className="viewer">
            {!pages.length && (
              <div className="empty-state">
                <div className="glyph">字</div>
                <div className="msg">
                  Load a CBZ to begin. Pages appear here as a grid; switch to Page view to inspect
                  each translation against the original, with detected text regions outlined.
                </div>
              </div>
            )}

            {pages.length > 0 && view === "grid" && (
              <div className="page-grid">
                {pages.map((p, i) => (
                  <div
                    key={p.name + i}
                    className="page-card"
                    tabIndex={0}
                    role="button"
                    aria-label={`Open page ${i + 1}`}
                    onClick={() => {
                      setCurrentIndex(i);
                      setView("single");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        setCurrentIndex(i);
                        setView("single");
                      }
                    }}
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
                  <button
                    aria-label="Previous page"
                    disabled={currentIndex === 0}
                    onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
                  >
                    ‹
                  </button>
                  <span>
                    {currentIndex + 1} / {pages.length}
                  </span>
                  <button
                    aria-label="Next page"
                    disabled={currentIndex === pages.length - 1}
                    onClick={() => setCurrentIndex((i) => Math.min(pages.length - 1, i + 1))}
                  >
                    ›
                  </button>
                </div>
                <div className="compare-label">
                  {hasTranslation && showTranslated ? "Translated" : "Original"}
                </div>
                <div className="canvas-wrap">
                  <canvas ref={canvasRef} />
                </div>
                <button
                  className="btn-secondary"
                  disabled={!hasTranslation}
                  onClick={() => setShowTranslated((v) => !v)}
                >
                  {showTranslated ? "Show Original" : "Show Translated"}
                </button>
              </div>
            )}
          </div>

          {log.length > 0 && (
            <div className="log" ref={logRef}>
              {log.map((l, i) => (
                <div key={i} className={l.cls}>
                  {l.text}
                </div>
              ))}
            </div>
          )}
        </main>
      </div>
    </>
  );
}

function ToggleRow({
  title,
  desc,
  checked,
  onChange,
}: {
  title: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="toggle-row">
      <div className="copy">
        <div className="t">{title}</div>
        <div className="d">{desc}</div>
      </div>
      <label className="switch">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
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
html, body { margin: 0; height: 100%; background: var(--paper); color: var(--ink); font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; }
* { box-sizing: border-box; }
.app { display: flex; height: 100vh; overflow: hidden; }
.sidebar { width: 320px; flex-shrink: 0; background: var(--panel); border-right: 1px solid var(--line); display: flex; flex-direction: column; overflow-y: auto; }
.brand { padding: 22px 20px 16px; border-bottom: 1px solid var(--line); }
.brand .mark { font-family: 'Archivo Narrow', 'Inter', sans-serif; font-weight: 800; font-size: 22px; letter-spacing: 0.5px; text-transform: uppercase; display: flex; align-items: baseline; gap: 8px; }
.brand .mark .accent { color: var(--accent); }
.brand .sub { margin-top: 4px; font-size: 12px; color: var(--muted); line-height: 1.5; }
.section { padding: 16px 20px; border-bottom: 1px solid var(--line); }
.section h3 { font-family: 'Archivo Narrow', sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: var(--muted); margin: 0 0 10px; }
.dropzone { border: 1.5px dashed var(--ink); border-radius: 4px; padding: 20px 14px; text-align: center; cursor: pointer; transition: background .15s, border-color .15s; background: var(--paper); }
.dropzone:hover, .dropzone.drag { background: #fff; border-color: var(--accent); }
.dropzone .icon { font-size: 22px; display: block; margin-bottom: 6px; }
.dropzone .label { font-weight: 600; font-size: 13px; }
.dropzone .hint { font-size: 11px; color: var(--muted); margin-top: 4px; display:block; }
.file-chip { margin-top: 10px; background: var(--paper); border: 1px solid var(--line); border-radius: 4px; padding: 8px 10px; font-size: 12px; font-family: 'JetBrains Mono', monospace; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.file-chip .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-chip .pages { color: var(--muted); flex-shrink: 0; }
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
.actions { padding: 16px 20px; margin-top: auto; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
button { font-family: inherit; cursor: pointer; border: none; border-radius: 4px; }
.btn-primary { background: var(--ink); color: var(--paper); font-weight: 700; font-size: 13px; letter-spacing: 0.4px; text-transform: uppercase; padding: 12px; transition: background .15s; }
.btn-primary:hover:not(:disabled) { background: var(--accent); }
.btn-primary:disabled { background: var(--line); color: var(--muted); cursor: not-allowed; }
.btn-secondary { background: transparent; border: 1px solid var(--ink); color: var(--ink); font-weight: 600; font-size: 12px; padding: 10px; text-transform: uppercase; letter-spacing: 0.4px; }
.btn-secondary:hover:not(:disabled) { background: var(--ink); color: var(--paper); }
.btn-secondary:disabled { opacity: 0.4; cursor: not-allowed; }
.main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.topbar { display: flex; align-items: center; justify-content: space-between; padding: 14px 24px; border-bottom: 1px solid var(--line); background: var(--paper); flex-shrink: 0; }
.topbar .status { font-family: 'Archivo Narrow', sans-serif; font-weight: 700; font-size: 13px; letter-spacing: 0.5px; text-transform: uppercase; color: var(--muted); display: flex; align-items: center; gap: 8px; }
.status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--line); }
.status.busy .dot { background: var(--accent); animation: pulse 1s infinite; }
.status.done .dot { background: var(--ok); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.view-toggle { display: flex; border: 1px solid var(--ink); border-radius: 4px; overflow: hidden; }
.view-toggle button { background: var(--paper); color: var(--ink); font-size: 12px; font-weight: 600; padding: 7px 14px; text-transform: uppercase; letter-spacing: 0.4px; }
.view-toggle button.active { background: var(--ink); color: var(--paper); }
.progress-wrap { padding: 0 24px; flex-shrink: 0; }
.progress-bar { height: 3px; background: var(--line); overflow: hidden; margin: 0 0 10px; }
.progress-fill { height: 100%; background: var(--accent); width: 0%; transition: width .3s ease; }
.viewer { flex: 1; overflow-y: auto; padding: 24px; }
.empty-state { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: var(--muted); gap: 8px; }
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
.canvas-wrap { position: relative; max-width: 100%; box-shadow: 0 4px 24px rgba(26,26,31,0.15); line-height: 0; }
.canvas-wrap canvas { max-width: 100%; max-height: 78vh; display: block; }
.compare-label { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--muted); letter-spacing: 0.5px; text-transform: uppercase; }
.log { margin: 12px 24px 18px; background: var(--ink); color: #C9C5BA; font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.7; border-radius: 4px; padding: 10px 14px; max-height: 110px; overflow-y: auto; flex-shrink: 0; }
.log .accent-line { color: #E8825E; }
.log .ok-line { color: #7FBB8A; }
.log .skip-line { color: #8A8A92; }
@media (max-width: 760px) {
  .app { flex-direction: column; }
  .sidebar { width: 100%; height: auto; max-height: 50vh; border-right: none; border-bottom: 1px solid var(--line); }
  .main { height: 50vh; }
}
`;
