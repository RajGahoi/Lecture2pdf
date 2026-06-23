<div align="center">

# 📄 Lecture2PDF AI

**Turn any lecture video into a study-ready PDF — automatically.**

Zero manual screenshots · 100% local · No APIs · No cloud · No cost

[![Version](https://img.shields.io/badge/version-1.0.0-635bff?style=flat-square)](https://github.com/raj-gahoi/lecture2pdf/releases)
[![Manifest](https://img.shields.io/badge/manifest-v3-34d399?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/)
[![License](https://img.shields.io/badge/license-MIT-f2f2f7?style=flat-square)](LICENSE)

</div>

---

## What it does

Open a lecture video, click **Scan Video**, and the extension:

1. Seeks through the entire video timeline automatically (no watching required)
2. Detects slide changes using a 16×9 perceptual brightness grid
3. Auto-calibrates its own duplicate threshold using **Otsu's method** — analysing *this video's* signal, not a global guess
4. Opens a **review tab** with an interactive timeline chart and thumbnail gallery
5. Captures full-resolution slides only for the timestamps you confirm
6. Assembles and downloads a timestamped PDF

---

## Installation

### Step 1 — Get the extension

**Clone**
```bash
git clone https://github.com/raj-gahoi/lecture2pdf.git
```

**Or download ZIP** → click **Code → Download ZIP** → extract it

---

### Step 2 — Load into Chrome

1. Open Chrome and navigate to:
```
chrome://extensions
```

2. Enable **Developer mode** (toggle in the top-right corner)

3. Click **Load unpacked**

4. Select the `lecture2pdf-extension` folder
   *(the one containing `manifest.json`)*

5. The Lecture2PDF AI icon appears in your extensions list

6. **Pin it** → click the 🧩 puzzle icon in Chrome's toolbar → pin Lecture2PDF AI

---

### Step 3 — Use it

| Step | Action |
|---|---|
| 1 | Open a lecture video in Chrome (YouTube, Khan Academy, PhysicsWallah, any HTML5 video) |
| 2 | Click the **Lecture2PDF AI** icon |
| 3 | Set scan interval (10s recommended) and image quality |
| 4 | Click **🔍 Scan Video** |
| 5 | Wait for the Review tab to open automatically |
| 6 | Drag the threshold line or click thumbnails to adjust selection |
| 7 | Click **⚡ Generate PDF from Selected Slides** |
| 8 | PDF downloads automatically ✅ |

---

## Requirements

| | |
|---|---|
| Browser | Chrome 88+ · Edge · Brave · Arc (any Chromium-based) |
| OS | Windows · macOS · Linux |
| Internet | Only to load the video — all processing is local |
| Permissions | `tabs` `scripting` `downloads` — no account, no login, no data collection |

> Firefox is not supported — it uses a different extension background model incompatible with the service worker architecture here.

---

## How it works

```
[Pass 1 — Scan]
Video tab → seek every N seconds → 16×9 brightness grid + thumbnail → background worker

[Auto-calibration]
Background worker → histogram of change scores → Otsu's method → suggested threshold

[Review tab]
SVG timeline chart with draggable threshold line + thumbnail gallery with click-to-toggle

[Pass 2 — Capture]
Re-seek only to confirmed timestamps → full-resolution JPEG capture

[PDF assembly]
pdf-lib (bundled locally) → cover page + timestamped slides → Blob download
```

### Key algorithms

**16×9 brightness-grid comparison**
Each frame is drawn onto a 16×9 canvas (144 cells). Per-cell brightness is compared between consecutive frames. A cell counts as "changed" if `|brightness_a - brightness_b| > 20`. The fraction of changed cells is the change score. Tolerates small local motion (webcam corner, cursor) without treating it as a new slide.

**Otsu's method**
A classic image-binarization algorithm applied here to the distribution of change scores from the scan. It finds the threshold that maximises between-class variance — i.e. best separates the "noise" cluster from the "real slide change" cluster — giving a per-video starting point instead of a hardcoded guess.

---

## Tech stack

| Layer | Technology |
|---|---|
| Extension | Chrome Manifest V3, Vanilla JS |
| Change detection | Custom 16×9 brightness grid (Canvas API) |
| Auto-calibration | Otsu's method (implemented from scratch) |
| Timeline chart | Raw SVG — no chart library |
| PDF generation | [pdf-lib](https://pdf-lib.js.org/) (bundled locally) |
| Build tooling | None — load unpacked directly |

No OpenAI · No Gemini · No React · No Webpack · No server · No tracking

---

## Project structure

```
lecture2pdf-extension/
├── manifest.json
├── background/serviceWorker.js   ← Otsu calibration, PDF build, session state, download
├── content/contentScript.js      ← Pass 1 (timeline scan) + Pass 2 (curated capture)
├── popup/                        ← Scan trigger UI
├── review/                       ← Timeline chart + curation gallery
├── lib/pdf-lib.min.js            ← Bundled locally, no remote fetch
├── icons/
├── CHANGELOG.md
└── LICENSE
```

---

## Known limitations

- **DRM-protected video** (some Coursera/Udemy) — canvas capture is blocked; surfaced as a clear error
- **Live streams** — no seekable duration, not supported
- **Scan speed** — depends on YouTube buffering per seek; locally saved videos scan much faster
- **No OCR / searchable text** — PDF pages are images only (planned)
- **No table of contents** — planned

---

## Roadmap

- [ ] On-device OCR via Tesseract.js → searchable PDF + auto table of contents
- [ ] Content-aware slide cropping (removes webcam PiP, letterboxing)
- [ ] Local video file support (drag-and-drop MP4/WebM)
- [ ] Batch/playlist processing

---

## Contributing

Issues and PRs welcome. If you find a video source where detection behaves unexpectedly, include:
- Video length
- Scan interval used
- Resulting slide count vs. expected

---

## License

[MIT](LICENSE) © 2025 Raj Gahoi
