// review/review.js

const params = new URLSearchParams(location.search);
const tabId = parseInt(params.get('tabId'), 10);

const mainEl = document.getElementById('main');
const videoTitleEl = document.getElementById('videoTitle');
const includedCountEl = document.getElementById('includedCount');
const totalCountEl = document.getElementById('totalCount');

let timeline = [];           // [{timestamp, thumbnail, diffFromPrev}]
let threshold = 0.14;
let domainMax = 1;
const overrides = new Map(); // index -> boolean (explicit user choice, overrides threshold)

function isIncluded(i) {
  if (overrides.has(i)) return overrides.get(i);
  return timeline[i].diffFromPrev >= threshold;
}

function includedTimestamps() {
  const out = [];
  for (let i = 0; i < timeline.length; i++) if (isIncluded(i)) out.push(timeline[i].timestamp);
  return out;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ---------- load scan results from the background worker ----------

function loadTimeline() {
  chrome.runtime.sendMessage({ type: 'GET_TIMELINE', tabId }, (resp) => {
    if (!resp) {
      mainEl.innerHTML = `<div class="error-box">Couldn\u2019t reach the extension background. Try reopening this tab from the popup.</div>`;
      return;
    }
    if (resp.lastError) {
      mainEl.innerHTML = `<div class="error-box">Scan failed: ${resp.lastError}${resp.errorDetail ? '<br>' + resp.errorDetail : ''}</div>`;
      return;
    }
    if (resp.status === 'scanning' || resp.status === 'idle') {
      mainEl.innerHTML = `<div class="loading">Still scanning the video… this tab will update automatically.</div>`;
      setTimeout(loadTimeline, 1200);
      return;
    }
    if (!resp.timeline || resp.timeline.length === 0) {
      mainEl.innerHTML = `<div class="error-box">No samples were found. Go back and try scanning again.</div>`;
      return;
    }

    timeline = resp.timeline;
    threshold = resp.suggestedThreshold;
    videoTitleEl.textContent = resp.videoTitle || 'Untitled lecture';
    totalCountEl.textContent = timeline.length;

    const maxObserved = Math.max(...timeline.map((s) => s.diffFromPrev));
    domainMax = Math.min(1, Math.max(maxObserved * 1.2, threshold * 1.5, 0.1));

    render();
  });
}

// ---------- rendering ----------

function render() {
  mainEl.innerHTML = `
    <div class="panel">
      <div class="panel-title">Change-detection timeline</div>
      <div class="panel-hint">
        Each spike is a moment the video changed. The dashed line is the auto-suggested threshold
        (computed from this video's own signal via Otsu's method) — drag it up or down to be stricter
        or looser. Anything above the line is included as a slide.
      </div>
      <div id="chartWrap">
        <svg id="chartSvg" viewBox="0 0 1000 180" preserveAspectRatio="none"></svg>
        <div class="threshold-readout" id="thresholdReadout"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-title">Slides (${timeline.length} scanned)</div>
      <div class="panel-hint">Click any thumbnail to manually include or exclude it, regardless of the threshold line.</div>
      <div class="gallery-toolbar">
        <button id="selectAllBtn">Select all</button>
        <button id="deselectAllBtn">Deselect all</button>
        <button id="resetBtn">Reset to auto threshold</button>
      </div>
      <div id="gallery"></div>
    </div>

    <div class="bottom-bar">
      <button class="primary" id="generateBtn">⚡ Generate PDF from <span id="genCount">0</span> Selected Slides</button>
    </div>
  `;

  document.getElementById('selectAllBtn').addEventListener('click', () => {
    timeline.forEach((_, i) => overrides.set(i, true));
    updateSelectionUI();
  });
  document.getElementById('deselectAllBtn').addEventListener('click', () => {
    timeline.forEach((_, i) => overrides.set(i, false));
    updateSelectionUI();
  });
  document.getElementById('resetBtn').addEventListener('click', () => {
    overrides.clear();
    updateSelectionUI();
  });
  document.getElementById('generateBtn').addEventListener('click', onGenerate);

  drawChart();
  drawGallery();
  attachDragHandlers();
  updateSelectionUI();
}

function drawChart() {
  const svg = document.getElementById('chartSvg');
  const W = 1000, H = 180;
  const n = timeline.length;
  const points = timeline.map((s, i) => {
    const x = n <= 1 ? 0 : (i / (n - 1)) * W;
    const y = H - (Math.min(s.diffFromPrev, domainMax) / domainMax) * H;
    return `${x},${y}`;
  }).join(' ');

  const threshY = H - (threshold / domainMax) * H;

  svg.innerHTML = `
    <polyline points="${points}" fill="none" stroke="#8b85ff" stroke-width="1.5" opacity="0.9" />
    <line id="threshLine" x1="0" y1="${threshY}" x2="${W}" y2="${threshY}" stroke="#f87171" stroke-width="1.5" stroke-dasharray="6,4" />
  `;
  document.getElementById('thresholdReadout').textContent = `Threshold: ${(threshold * 100).toFixed(1)}% changed`;
}

function drawGallery() {
  const gallery = document.getElementById('gallery');
  gallery.innerHTML = timeline.map((s, i) => `
    <div class="thumb" data-index="${i}">
      <img src="${s.thumbnail}" loading="lazy" />
      <span class="badge">${formatTime(s.timestamp)}</span>
      <span class="check">✓</span>
    </div>
  `).join('');

  gallery.querySelectorAll('.thumb').forEach((el) => {
    el.addEventListener('click', () => {
      const i = parseInt(el.dataset.index, 10);
      overrides.set(i, !isIncluded(i));
      updateSelectionUI();
    });
  });
}

function updateSelectionUI() {
  const included = includedTimestamps();
  includedCountEl.textContent = included.length;
  document.getElementById('genCount').textContent = included.length;

  document.querySelectorAll('.thumb').forEach((el) => {
    const i = parseInt(el.dataset.index, 10);
    el.classList.toggle('included', isIncluded(i));
    el.classList.toggle('excluded', !isIncluded(i));
  });

  const threshY = 180 - (threshold / domainMax) * 180;
  const line = document.getElementById('threshLine');
  if (line) {
    line.setAttribute('y1', threshY);
    line.setAttribute('y2', threshY);
  }
  const readout = document.getElementById('thresholdReadout');
  if (readout) readout.textContent = `Threshold: ${(threshold * 100).toFixed(1)}% changed`;
}

// ---------- drag-to-adjust-threshold ----------

function attachDragHandlers() {
  const wrap = document.getElementById('chartWrap');
  let dragging = false;

  const onMove = (e) => {
    if (!dragging) return;
    const rect = wrap.getBoundingClientRect();
    let relY = e.clientY - rect.top;
    relY = Math.max(0, Math.min(rect.height, relY));
    threshold = domainMax * (1 - relY / rect.height);
    // threshold drag only affects samples WITHOUT an explicit manual override
    updateSelectionUI();
  };

  wrap.addEventListener('mousedown', (e) => { dragging = true; onMove(e); });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', () => { dragging = false; });
}

// ---------- final generate step ----------

function onGenerate() {
  const timestamps = includedTimestamps();
  if (timestamps.length === 0) {
    alert('Select at least one slide first.');
    return;
  }
  const btn = document.getElementById('generateBtn');
  btn.disabled = true;
  btn.textContent = 'Starting capture…';

  chrome.runtime.sendMessage({ type: 'GENERATE_FROM_SELECTION', tabId, timestamps }, (resp) => {
    if (!resp) {
      btn.disabled = false;
      btn.textContent = '⚡ Generate PDF from Selected Slides';
      alert('Couldn\u2019t reach the extension. Make sure the original video tab is still open.');
      return;
    }
    pollGenerationStatus(btn);
  });
}

function pollGenerationStatus(btn) {
  const poll = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'GET_SESSION', tabId }, (session) => {
      if (!session) return;
      switch (session.status) {
        case 'capturing_selection':
          btn.textContent = `Capturing slides… ${session.progressPercent || 0}%`;
          break;
        case 'building_pdf':
          btn.textContent = 'Building PDF…';
          break;
        case 'done':
          clearInterval(poll);
          btn.textContent = '✓ PDF downloaded';
          if (session.errorDetail) {
            const note = document.createElement('div');
            note.style.cssText = 'text-align:center;color:#9999ad;font-size:11.5px;margin-top:10px;';
            note.textContent = session.errorDetail;
            btn.parentElement.appendChild(note);
          }
          break;
        case 'error':
          clearInterval(poll);
          btn.disabled = false;
          btn.textContent = '⚡ Generate PDF from Selected Slides';
          alert('PDF generation failed: ' + (session.errorDetail || session.lastError));
          break;
      }
    });
  }, 700);
}

loadTimeline();
