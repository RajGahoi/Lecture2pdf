// content/contentScript.js
//
// TWO-PASS PIPELINE (v0.4):
//   Pass 1 — scanTimeline(): seeks through the WHOLE video once, cheaply.
//   For every sample point it computes a small change-detection grid and a
//   tiny thumbnail (not a full-resolution capture). This builds the signal
//   the review screen visualizes as a graph, and lets Otsu's-method
//   auto-calibration (computed in the background worker) pick a sensible
//   starting threshold instead of the user guessing one blind.
//
//   Pass 2 — captureSelected(): once the person has reviewed the timeline
//   and confirmed which timestamps to keep, THIS pass re-seeks to just
//   those timestamps and captures full-resolution JPEGs — so the expensive
//   work only happens for slides that are actually going in the PDF.
//
// This replaces the old single-pass "guess a threshold, hope it's right"
// flow entirely.

(() => {
  const GRID_W = 16;
  const GRID_H = 9;
  const THUMB_WIDTH = 160;
  const CELL_DELTA = 20; // brightness diff (0-255) to count a grid cell as "changed"
  const SEEK_TIMEOUT_MS = 6000;

  const DEFAULT_MAX_CAPTURE_WIDTH = 1600;
  const DEFAULT_JPEG_QUALITY = 0.78;

  let gridCanvas, gridCtx, thumbCanvas, thumbCtx, captureCanvas, captureCtx;
  let cancelled = false;

  function findVideoElement() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;
    let best = null, bestArea = 0;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && r.width > 100 && r.height > 100) { bestArea = area; best = v; }
    }
    return best || videos[0];
  }

  function ensureScanCanvases() {
    if (!gridCanvas) {
      gridCanvas = document.createElement('canvas');
      gridCanvas.width = GRID_W;
      gridCanvas.height = GRID_H;
      gridCtx = gridCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!thumbCanvas) {
      thumbCanvas = document.createElement('canvas');
      thumbCtx = thumbCanvas.getContext('2d');
    }
  }

  function ensureCaptureCanvas(video, maxWidth) {
    if (!captureCanvas) {
      captureCanvas = document.createElement('canvas');
      captureCtx = captureCanvas.getContext('2d');
    }
    const nativeW = video.videoWidth || 1280;
    const nativeH = video.videoHeight || 720;
    let targetW = nativeW, targetH = nativeH;
    if (nativeW > maxWidth) {
      targetW = maxWidth;
      targetH = Math.round(nativeH * (maxWidth / nativeW));
    }
    if (captureCanvas.width !== targetW || captureCanvas.height !== targetH) {
      captureCanvas.width = targetW;
      captureCanvas.height = targetH;
    }
  }

  function computeGrid(video) {
    try {
      gridCtx.drawImage(video, 0, 0, GRID_W, GRID_H);
      const { data } = gridCtx.getImageData(0, 0, GRID_W, GRID_H);
      const grid = new Array(GRID_W * GRID_H);
      for (let i = 0; i < grid.length; i++) {
        const o = i * 4;
        grid[i] = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
      }
      return grid;
    } catch (err) {
      reportError(err);
      return null;
    }
  }

  function captureThumbnail(video) {
    const nativeW = video.videoWidth || 1280;
    const nativeH = video.videoHeight || 720;
    const h = Math.round(nativeH * (THUMB_WIDTH / nativeW));
    if (thumbCanvas.width !== THUMB_WIDTH || thumbCanvas.height !== h) {
      thumbCanvas.width = THUMB_WIDTH;
      thumbCanvas.height = h;
    }
    thumbCtx.drawImage(video, 0, 0, THUMB_WIDTH, h);
    return thumbCanvas.toDataURL('image/jpeg', 0.5);
  }

  function captureFullFrame(video, jpegQuality) {
    captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
    return captureCanvas.toDataURL('image/jpeg', jpegQuality);
  }

  function reportError(err) {
    chrome.runtime.sendMessage({
      type: 'EXTRACTION_ERROR',
      reason: err && err.name === 'SecurityError' ? 'tainted_canvas' : 'unknown',
      message: String(err),
    });
  }

  function waitForSeek(video, time) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        video.removeEventListener('seeked', onSeeked);
        clearTimeout(timer);
        resolve();
      };
      const onSeeked = () => finish();
      video.addEventListener('seeked', onSeeked);
      const timer = setTimeout(finish, SEEK_TIMEOUT_MS);
      video.currentTime = time;
    });
  }

  function waitFrames(n) {
    return new Promise((resolve) => {
      let count = 0;
      const step = () => { count++; if (count >= n) resolve(); else requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  }

  // ---------- PASS 1: cheap full-video scan for the review timeline ----------

  async function scanTimeline(intervalSeconds) {
    const video = findVideoElement();
    if (!video) { chrome.runtime.sendMessage({ type: 'EXTRACTION_ERROR', reason: 'no_video_found' }); return; }
    if (!isFinite(video.duration) || video.duration <= 0) {
      chrome.runtime.sendMessage({ type: 'EXTRACTION_ERROR', reason: 'no_duration' });
      return;
    }

    cancelled = false;
    ensureScanCanvases();

    const wasPlaying = !video.paused;
    const originalTime = video.currentTime;
    video.pause();

    chrome.runtime.sendMessage({
      type: 'TIMELINE_SCAN_STARTED',
      videoDuration: video.duration,
      videoTitle: document.title,
      videoUrl: location.href,
    });

    let t = 0;
    while (t <= video.duration && !cancelled) {
      await waitForSeek(video, t);
      await waitFrames(3);

      const grid = computeGrid(video);
      if (grid === null) { video.currentTime = originalTime; return; } // tainted canvas

      const thumbnail = captureThumbnail(video);
      chrome.runtime.sendMessage({ type: 'TIMELINE_SAMPLE', timestamp: t, grid, thumbnail });
      chrome.runtime.sendMessage({ type: 'EXTRACTION_PROGRESS', processed: Math.min(t, video.duration), duration: video.duration });

      t += intervalSeconds;
    }

    video.currentTime = originalTime;
    if (wasPlaying) video.play().catch(() => {});

    if (!cancelled) chrome.runtime.sendMessage({ type: 'TIMELINE_SCAN_COMPLETE' });
  }

  // ---------- PASS 2: full-resolution capture of only the curated timestamps ----------

  async function captureSelected(timestamps, maxWidth, jpegQuality) {
    const video = findVideoElement();
    if (!video) { chrome.runtime.sendMessage({ type: 'EXTRACTION_ERROR', reason: 'no_video_found' }); return; }

    cancelled = false;
    ensureCaptureCanvas(video, maxWidth);

    const wasPlaying = !video.paused;
    const originalTime = video.currentTime;
    video.pause();

    for (let i = 0; i < timestamps.length && !cancelled; i++) {
      const t = timestamps[i];
      await waitForSeek(video, t);
      await waitFrames(3);

      const dataUrl = captureFullFrame(video, jpegQuality);
      chrome.runtime.sendMessage({ type: 'SELECTED_FRAME', timestamp: t, dataUrl });
      chrome.runtime.sendMessage({ type: 'CAPTURE_PROGRESS', processed: i + 1, total: timestamps.length });
    }

    video.currentTime = originalTime;
    if (wasPlaying) video.play().catch(() => {});

    if (!cancelled) chrome.runtime.sendMessage({ type: 'SELECTION_CAPTURE_COMPLETE' });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'START_TIMELINE_SCAN') {
      scanTimeline(msg.intervalSeconds || 4).catch((err) => {
        chrome.runtime.sendMessage({ type: 'EXTRACTION_ERROR', reason: 'unknown', message: String(err) });
      });
      sendResponse({ ok: true });
    } else if (msg.type === 'CAPTURE_SELECTED') {
      captureSelected(
        msg.timestamps || [],
        msg.maxWidth || DEFAULT_MAX_CAPTURE_WIDTH,
        msg.jpegQuality ?? DEFAULT_JPEG_QUALITY
      ).catch((err) => {
        chrome.runtime.sendMessage({ type: 'EXTRACTION_ERROR', reason: 'unknown', message: String(err) });
      });
      sendResponse({ ok: true });
    } else if (msg.type === 'CANCEL_EXTRACTION') {
      cancelled = true;
      sendResponse({ ok: true });
    } else if (msg.type === 'PING') {
      sendResponse({ ok: true, hasVideo: !!findVideoElement() });
    }
    return true;
  });
})();
