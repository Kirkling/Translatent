A focused pass on the Koe/Box translator to fix the mobile UX rough edges, prevent work loss on tab/view changes, and make the overlay actually look like part of the page.

## 1. Don't lose work on reload / tab switch / desktop-site toggle

Today the file's pixels live only in memory; switching to desktop site reloads the page and they vanish.

- Add an IndexedDB store (single small wrapper, no new dep — native `indexedDB`) keyed by `name+size+lastModified`.
- On file load, save the raw CBZ bytes plus per-page metadata; on app boot, look up the last-used key and offer "Resume <filename>" without re-uploading.
- Move the existing translated-regions snapshot from `localStorage` into the same IndexedDB record (avoids the 5MB quota that silently drops long sessions).
- Auto-save on every page status change + on `visibilitychange` so backgrounding the tab flushes immediately.
- If translation is `running` when the tab is hidden, mark `pauseRef=true` and persist `remaining` so resume after reload works.

## 2. Translation pacing + adaptive throttle

- Track a rolling window of the last N request timestamps and the last 429/5xx event in the client.
- Base delay stays ~2.5s, but after any rate-related failure double the delay (cap 15s) and decay back over the next 10 successful pages.
- Server `callGateway` already does retry-after backoff; expose that signal in the response (`{ regions, throttle: { retryAfterMs } }`) so the client can apply the suggested cooldown instead of guessing.
- Show a small "Pacing: 4.0s/page" line in the log when throttle is active so it's visible, not silent.

## 3. Contextual, grouped translations

- Switch the translate prompt from "per region" to "whole page, then return regions". Ask the model to first read every text box in reading order (right-to-left top-to-bottom for ja/zh, left-to-right for ko/en), translate as a cohesive scene, then emit the JSON array with each region's translated line.
- Pass the previous page's translated lines (last ~10) as `priorContext` in the request so dialogue carries between pages.
- Add a new region field `kind: "bubble" | "narration" | "sfx" | "sign" | "freefloat"` and `hasBackdrop: boolean` so the renderer knows whether to draw a bubble fill.

## 4. Overlay that actually fits

Rewrite `drawTextBox`:

- If `hasBackdrop` is false (sfx, free-floating text on art): erase via a soft-edged mask sampled from a 2–4px ring around the bbox (median color, feathered), then draw text with a 1px contrasting stroke for legibility — no rectangle.
- If `hasBackdrop` is true: redraw the bubble as today, but inflate adaptively (sample the bg color band; expand until the sampled ring is uniform, max 25%).
- Auto-fit font weight + size: target the original text's pixel height (we now get it from the model's `h`), then binary-search font size to fill ~85% of the box, clamp 9–48px, choose vertical writing fallback if `w < h*0.5` and language is `ja`.
- Use `Inter Tight` 600 for bubbles, italic 500 for narration, bold uppercase for sfx — picked from `kind`.

## 5. Lightbox: gentler zoom, real back, smooth pan

- Replace ad-hoc pinch/pan with `react-zoom-pan-pinch` (small, well-tested) configured: `minScale 1`, `maxScale 4`, `doubleClick: reset`, `wheel.step: 0.15`, `pinch.step: 5`.
- Double-tap anywhere on the image → reset to fit. Single-tap on bottom 1/3 → toggle Original/Translated. Tap top-left "Back" button enlarged to 44×44 with safe-area padding so it's reachable on iOS.
- Intercept the mobile back gesture: push a history state when the lightbox opens; `popstate` closes the lightbox instead of leaving the tab. Same trick for `expanded` viewer.

## 6. Mobile: merge logs / grid / page into one draggable sheet

- Replace the small drag-handle bar with a bottom-sheet container that holds: status, grid/page tabs, the canvas/grid, and the log — stacked vertically inside one scrollable surface.
- Sheet has three snap points: 35% (peek, shows status + first row), 65% (default), 95% (full). Implement with CSS transforms + a single `pointer` handler with velocity-aware snap (no library). Animation uses `transform` + `will-change` so it stays at 60fps.
- Below the sheet sits the currently-displayed page, so the user can drag the sheet up over it instead of the sheet hiding the page. Removes the "buried vs covering" glitch.

## 7. Desktop: move actions + log into the sidebar

- Keep the current sidebar width and overall page dimensions.
- Add a new sidebar section "Activity" below Glossary that contains the Translate/Pause/Resume buttons, Build/Download buttons, the progress bar, and the log feed (scrollable, max-height 40vh).
- Remove the topbar progress bar on desktop ≥1024px; mobile keeps it inside the sheet.
- No layout change to the canvas/viewer column.

## 8. Misc polish

- Cleaner status: small pill instead of dot+text wall.
- Back button (desktop hardware/browser back) only closes lightbox/expanded first; second press leaves the app.
- A11y: focus trap inside lightbox, return focus to the originating thumbnail on close.

## Technical notes

- New files: `src/lib/idb.ts` (tiny IndexedDB wrapper), `src/components/BottomSheet.tsx`, `src/components/Overlay.ts` (drawing helpers split out of index.tsx so the route file shrinks).
- API change: `src/routes/api/translate.ts` accepts `priorContext` (string), returns `{ regions: Region[], throttle?: { retryAfterMs } }`. Region schema gains `kind`, `hasBackdrop`. Backward-compatible defaults (`kind:"bubble"`, `hasBackdrop:true`).
- New dep: `react-zoom-pan-pinch` (~6KB gz). No other deps.
- No backend/RLS/schema changes; all data lives client-side in IndexedDB.

```text
Mobile layout after change
┌─────────────────────────┐
│   page canvas (fixed)   │
│                         │
├─────── drag bar ────────┤  ← snap 95%
│ status · Grid/Page tabs │
│ [grid or page viewer]   │  ← snap 65%
│ ─────── log ─────────── │  ← snap 35%
└─────────────────────────┘
```
