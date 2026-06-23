# Changelog

All notable changes to Lecture2PDF AI are documented here.

---

## [1.0.0] — 2025-06-23 — First Public Release

### What's new
- **Two-pass pipeline** — cheap full-video scan first (thumbnails + change signal), then full-resolution capture only for slides you confirm. No more capturing hundreds of full-res frames blindly.
- **Otsu's-method auto-calibration** — after the scan, the extension analyzes this video's own change-signal distribution and suggests the optimal duplicate-detection threshold automatically. No more guessing a sensitivity number.
- **Visual diff timeline** — interactive SVG chart showing exactly when the video content changed. Drag the threshold line up or down live.
- **Review & curate gallery** — see all detected slide thumbnails before the PDF is built. Click any thumbnail to manually include or exclude it, regardless of the auto-threshold.
- **Emoji/Unicode-safe PDF titles** — video titles with emoji (e.g. 🔥) no longer crash PDF generation. Characters outside the WinAnsi range are stripped safely.
- **Blob-URL download** — PDF download no longer converts the whole file to a base64 string in memory. Uses Blob + object URL, which is more robust for large PDFs.
- **Per-frame resilience** — a single corrupt frame no longer aborts the whole PDF build. It is skipped and counted, and the user is informed.
- **Removed unused permission** — `storage` permission dropped (not needed).
- **32px icon** — added for crisper display in Chrome's toolbar at high DPI.

### Known limitations
- DRM-protected video sources (some Coursera/Udemy) cannot be captured via canvas — surfaced as a clear error.
- Live streams have no seekable duration and are not supported.
- No OCR / searchable text layer yet.
- No table of contents yet.

---

## [0.4.0] — Internal

Two-pass scan/review/generate pipeline introduced. Replaced the old single-pass threshold-guessing flow.

## [0.3.0] — Internal

Switched from dHash perceptual hashing to 16×9 brightness-grid comparison. Added configurable duplicate sensitivity and image quality settings.

## [0.2.0] — Internal

Switched from real-time polling to seek-based extraction (no longer requires watching the video). PDF generation moved into the background service worker.

## [0.1.0] — Internal

Initial prototype. Content script polling, dHash deduplication, popup-driven PDF generation.
