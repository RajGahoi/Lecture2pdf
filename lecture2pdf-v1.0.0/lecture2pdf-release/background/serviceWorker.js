// background/serviceWorker.js
//
// Classic (non-module) service worker so importScripts() works — this is
// what lets us load the locally-bundled pdf-lib here and build the PDF
// directly in the background, independent of whether the popup is open.
// (No remote code is fetched — pdf-lib.min.js ships inside the extension.)

importScripts('../lib/pdf-lib.min.js');

const sessions = new Map(); // tabId -> session state
const CELL_DELTA = 20; // must match content script's grid-cell brightness threshold

function changedFraction(a, b) {
  if (!a || !b) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > CELL_DELTA) changed++;
  }
  return changed / a.length;
}

// Otsu's method: given a set of values in [0,1], find the threshold that
// best separates them into two clusters (here: "noise/no real change" vs.
// "genuine slide change") by maximizing between-class variance. This is
// what replaces "the user guesses a sensitivity number" with "the tool
// looks at THIS video's actual signal and picks a sensible starting point."
function otsuThreshold(values, bins = 100) {
  if (values.length === 0) return 0.14;
  const hist = new Array(bins).fill(0);
  for (const v of values) {
    let idx = Math.floor(v * bins);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    hist[idx]++;
  }
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * hist[i];

  let sumB = 0, weightB = 0, varMax = -1, bestBin = 0;
  for (let i = 0; i < bins; i++) {
    weightB += hist[i];
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += i * hist[i];
    const meanB = sumB / weightB;
    const meanF = (sumAll - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (between > varMax) { varMax = between; bestBin = i; }
  }
  return (bestBin + 0.5) / bins;
}

function getOrCreateSession(tabId) {
  if (!sessions.has(tabId)) {
    sessions.set(tabId, {
      // status: idle | scanning | review_ready | capturing_selection | building_pdf | done | error
      status: 'idle',
      progressPercent: 0,
      lastError: null,
      errorDetail: null,

      videoUrl: '',
      videoTitle: '',
      maxWidth: 1600,
      jpegQuality: 0.78,

      rawTimeline: [],   // working buffer during the scan: {timestamp, grid, thumbnail}
      timeline: [],      // what the review page sees: {timestamp, thumbnail, diffFromPrev}
      suggestedThreshold: 0.14,

      frames: [],        // final full-res frames: {timestamp, dataUrl}
    });
  }
  return sessions.get(tabId);
}

// ---------- PDF generation (unchanged from before — proven working) ----------

function dataUrlToUint8Array(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function uint8ArrayToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function sanitizeFilename(name) {
  return (name || 'lecture').replace(/[\\/:*?"<>|]/g, '').slice(0, 80);
}

function sanitizeForPdfText(str) {
  if (!str) return '';
  return Array.from(str)
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 255);
    })
    .join('')
    .trim();
}

async function buildPdf(frames, videoTitle, videoUrl, onSkip) {
  const { PDFDocument, rgb, StandardFonts } = PDFLib;
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const cover = pdfDoc.addPage([612, 792]);
  cover.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: rgb(0.06, 0.06, 0.09) });
  cover.drawText('Lecture2PDF AI', { x: 50, y: 700, size: 26, font: boldFont, color: rgb(0.49, 0.45, 1) });
  const safeTitle = sanitizeForPdfText(videoTitle) || 'Untitled Lecture';
  const safeUrl = sanitizeForPdfText(videoUrl);

  cover.drawText(safeTitle, { x: 50, y: 660, size: 16, font, color: rgb(1, 1, 1), maxWidth: 512 });
  cover.drawText(`Captured: ${new Date().toLocaleString()}`, { x: 50, y: 630, size: 10, font, color: rgb(0.7, 0.7, 0.75) });
  if (safeUrl) {
    cover.drawText(safeUrl.slice(0, 90), { x: 50, y: 612, size: 9, font, color: rgb(0.55, 0.55, 0.65) });
  }
  cover.drawText(`${frames.length} slides captured`, { x: 50, y: 580, size: 12, font: boldFont, color: rgb(0.21, 0.83, 0.6) });

  let pageNumber = 0;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    try {
      const jpgBytes = dataUrlToUint8Array(frame.dataUrl);
      const jpgImage = await pdfDoc.embedJpg(jpgBytes);

      const pageWidth = 612, pageHeight = 792;
      const page = pdfDoc.addPage([pageWidth, pageHeight]);

      const marginTop = 70, marginBottom = 40, marginX = 30;
      const maxW = pageWidth - marginX * 2;
      const maxH = pageHeight - marginTop - marginBottom;
      const scale = Math.min(maxW / jpgImage.width, maxH / jpgImage.height);
      const drawW = jpgImage.width * scale;
      const drawH = jpgImage.height * scale;
      const x = (pageWidth - drawW) / 2;
      const y = marginBottom + (maxH - drawH) / 2;

      pageNumber++;
      page.drawText(`Slide ${pageNumber} of ${frames.length}`, { x: marginX, y: pageHeight - 35, size: 11, font: boldFont, color: rgb(0.3, 0.3, 0.3) });
      page.drawText(`@ ${formatTimestamp(frame.timestamp)}`, { x: pageWidth - marginX - 70, y: pageHeight - 35, size: 11, font, color: rgb(0.45, 0.45, 0.45) });
      page.drawImage(jpgImage, { x, y, width: drawW, height: drawH });
      page.drawText('Lecture2PDF AI', { x: marginX, y: 20, size: 8, font, color: rgb(0.6, 0.6, 0.6) });
    } catch (err) {
      console.error('Lecture2PDF AI: skipped frame', i, 'at', frame.timestamp, err);
      if (onSkip) onSkip(i, err);
    }
    frames[i].dataUrl = null;
    if (i % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (pageNumber === 0) {
    throw new Error('Every captured frame failed to embed — nothing to build a PDF from.');
  }
  return pdfDoc.save();
}

function triggerDownload(pdfBytes, filename) {
  return new Promise((resolve, reject) => {
    let url;
    let usedBlob = false;
    try {
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      url = URL.createObjectURL(blob);
      usedBlob = true;
    } catch (blobErr) {
      console.warn('Lecture2PDF AI: Blob URL unavailable, falling back to data URL', blobErr);
      const base64 = uint8ArrayToBase64(pdfBytes);
      url = 'data:application/pdf;base64,' + base64;
    }
    chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
      if (usedBlob) setTimeout(() => URL.revokeObjectURL(url), 60000);
      if (chrome.runtime.lastError || downloadId === undefined) {
        reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Download did not start.'));
      } else {
        resolve();
      }
    });
  });
}

async function finishSession(tabId) {
  const session = getOrCreateSession(tabId);
  if (session.frames.length === 0) {
    session.status = 'error';
    session.lastError = 'no_frames_captured';
    return;
  }
  session.status = 'building_pdf';
  const skipped = [];
  let pdfBytes;
  try {
    pdfBytes = await buildPdf(session.frames, session.videoTitle, session.videoUrl, (i, err) => {
      skipped.push({ index: i, message: String(err && err.message || err) });
    });
  } catch (err) {
    console.error('Lecture2PDF AI: PDF build failed', err);
    session.status = 'error';
    session.lastError = 'pdf_build_failed';
    session.errorDetail = String(err && err.message || err);
    return;
  }

  try {
    const filename = `${sanitizeFilename(session.videoTitle)}.pdf`;
    await triggerDownload(pdfBytes, filename);
    session.status = 'done';
    if (skipped.length > 0) {
      session.errorDetail = `${skipped.length} of ${session.frames.length} slides couldn't be embedded and were skipped.`;
    }
  } catch (err) {
    console.error('Lecture2PDF AI: download failed', err);
    session.status = 'error';
    session.lastError = 'download_failed';
    session.errorDetail = String(err && err.message || err);
  }
}

function openReviewTab(tabId) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`review/review.html?tabId=${tabId}`) });
}

// ---------- message routing ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : msg.tabId;

  switch (msg.type) {
    // --- Pass 1: kick off the cheap full-video scan ---
    case 'START_TIMELINE_SCAN_FOR_TAB': {
      const session = getOrCreateSession(msg.tabId);
      session.status = 'scanning';
      session.progressPercent = 0;
      session.lastError = null;
      session.errorDetail = null;
      session.rawTimeline = [];
      session.timeline = [];
      session.frames = [];
      session.maxWidth = msg.maxWidth || 1600;
      session.jpegQuality = msg.jpegQuality ?? 0.78;

      chrome.tabs.sendMessage(
        msg.tabId,
        { type: 'START_TIMELINE_SCAN', intervalSeconds: msg.intervalSeconds },
        () => {
          if (chrome.runtime.lastError) {
            session.status = 'error';
            session.lastError = 'no_content_script';
          }
        }
      );
      sendResponse({ ok: true });
      return true;
    }

    case 'TIMELINE_SCAN_STARTED': {
      const session = getOrCreateSession(tabId);
      session.videoTitle = msg.videoTitle;
      session.videoUrl = msg.videoUrl;
      break;
    }

    case 'TIMELINE_SAMPLE': {
      const session = getOrCreateSession(tabId);
      session.rawTimeline.push({ timestamp: msg.timestamp, grid: msg.grid, thumbnail: msg.thumbnail });
      break;
    }

    case 'EXTRACTION_PROGRESS': {
      const session = getOrCreateSession(tabId);
      session.progressPercent = Math.round((msg.processed / msg.duration) * 100);
      break;
    }

    case 'TIMELINE_SCAN_COMPLETE': {
      const session = getOrCreateSession(tabId);
      const raw = session.rawTimeline;

      // Compute the change-fraction signal between consecutive samples —
      // this IS the graph the review page draws.
      const diffs = [];
      session.timeline = raw.map((sample, i) => {
        const diffFromPrev = i === 0 ? 1 : changedFraction(sample.grid, raw[i - 1].grid);
        if (i > 0) diffs.push(diffFromPrev);
        return { timestamp: sample.timestamp, thumbnail: sample.thumbnail, diffFromPrev };
      });

      session.suggestedThreshold = otsuThreshold(diffs);
      session.rawTimeline = []; // free the grids, no longer needed
      session.status = 'review_ready';
      openReviewTab(tabId);
      break;
    }

    // --- Review page reads the scan results ---
    case 'GET_TIMELINE': {
      const session = getOrCreateSession(msg.tabId);
      sendResponse({
        status: session.status,
        timeline: session.timeline,
        suggestedThreshold: session.suggestedThreshold,
        videoTitle: session.videoTitle,
        videoUrl: session.videoUrl,
        lastError: session.lastError,
      });
      return true;
    }

    // --- Pass 2: curated selection -> full-res capture -> PDF ---
    case 'GENERATE_FROM_SELECTION': {
      const session = getOrCreateSession(msg.tabId);
      session.frames = [];
      session.status = 'capturing_selection';
      session.progressPercent = 0;
      session.lastError = null;
      session.errorDetail = null;
      chrome.tabs.sendMessage(
        msg.tabId,
        {
          type: 'CAPTURE_SELECTED',
          timestamps: msg.timestamps || [],
          maxWidth: session.maxWidth,
          jpegQuality: session.jpegQuality,
        },
        () => {
          if (chrome.runtime.lastError) {
            session.status = 'error';
            session.lastError = 'no_content_script';
          }
        }
      );
      sendResponse({ ok: true });
      return true;
    }

    case 'SELECTED_FRAME': {
      const session = getOrCreateSession(tabId);
      session.frames.push({ timestamp: msg.timestamp, dataUrl: msg.dataUrl });
      break;
    }

    case 'CAPTURE_PROGRESS': {
      const session = getOrCreateSession(tabId);
      session.progressPercent = Math.round((msg.processed / msg.total) * 100);
      break;
    }

    case 'SELECTION_CAPTURE_COMPLETE': {
      finishSession(tabId);
      break;
    }

    case 'EXTRACTION_ERROR': {
      const session = getOrCreateSession(tabId);
      session.status = 'error';
      session.lastError = msg.reason;
      session.errorDetail = msg.message || null;
      break;
    }

    case 'GET_SESSION': {
      const session = getOrCreateSession(msg.tabId);
      sendResponse({
        status: session.status,
        frameCount: session.frames.length,
        progressPercent: session.progressPercent,
        videoTitle: session.videoTitle,
        lastError: session.lastError,
        errorDetail: session.errorDetail || null,
      });
      return true;
    }

    case 'CLEAR_SESSION': {
      sessions.delete(msg.tabId);
      sendResponse({ ok: true });
      return true;
    }

    default:
      break;
  }
});
