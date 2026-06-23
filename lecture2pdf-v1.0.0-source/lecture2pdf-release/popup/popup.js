// popup/popup.js
//
// The popup now only triggers Pass 1 (the cheap timeline scan). When the
// scan finishes, the background worker opens a dedicated review tab — the
// popup just shows progress and a reopen link in case that tab gets lost.

const scanBtn = document.getElementById('scanBtn');
const reopenBtn = document.getElementById('reopenBtn');
const resetBtn = document.getElementById('resetBtn');
const intervalRange = document.getElementById('intervalRange');
const intervalNumber = document.getElementById('intervalNumber');
const intervalValue = document.getElementById('intervalValue');
const qualitySelect = document.getElementById('qualitySelect');
const statusValue = document.getElementById('statusValue');
const progressFill = document.getElementById('progressFill');
const errorBox = document.getElementById('errorBox');

let activeTabId = null;
let pollTimer = null;

const QUALITY_PRESETS = {
  small:    { maxWidth: 1200, jpegQuality: 0.62 },
  balanced: { maxWidth: 1600, jpegQuality: 0.78 },
  high:     { maxWidth: 1920, jpegQuality: 0.90 },
};

intervalRange.addEventListener('input', () => {
  intervalNumber.value = intervalRange.value;
  intervalValue.textContent = intervalRange.value;
});
intervalNumber.addEventListener('input', () => {
  let v = parseFloat(intervalNumber.value);
  if (isNaN(v)) return;
  v = Math.min(60, Math.max(0.5, v));
  intervalValue.textContent = v;
  if (v <= parseFloat(intervalRange.max)) intervalRange.value = v;
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showError(text) { errorBox.innerHTML = `<div class="error-box">${text}</div>`; }
function clearError() { errorBox.innerHTML = ''; }

function describeError(reason) {
  switch (reason) {
    case 'no_video_found': return 'No video found on this page. Open a lecture video and try again.';
    case 'no_duration': return 'Couldn\u2019t read this video\u2019s length (might be a live stream).';
    case 'tainted_canvas': return 'This video is DRM-protected and can\u2019t be captured directly from the page.';
    case 'no_frames_captured': return 'No slides were selected. Go back to the review tab and pick some.';
    case 'no_content_script': return 'Couldn\u2019t reach this page \u2014 try reloading the tab.';
    case 'pdf_build_failed': return 'PDF generation failed.';
    case 'download_failed': return 'Chrome blocked the download.';
    default: return 'Something went wrong. Try reloading the page and scanning again.';
  }
}

async function refreshState() {
  if (!activeTabId) return;
  chrome.runtime.sendMessage({ type: 'GET_SESSION', tabId: activeTabId }, (session) => {
    if (!session) return;
    progressFill.style.width = (session.progressPercent || 0) + '%';

    if (session.lastError) {
      const detail = session.errorDetail ? `<br><span style="opacity:0.75">${session.errorDetail}</span>` : '';
      showError(describeError(session.lastError) + detail);
    } else clearError();

    switch (session.status) {
      case 'scanning':
        statusValue.innerHTML = '<span class="pulse"></span>Scanning…';
        scanBtn.disabled = true;
        scanBtn.textContent = `Scanning… ${session.progressPercent || 0}%`;
        reopenBtn.style.display = 'none';
        break;
      case 'review_ready':
        statusValue.textContent = 'Ready for review ✓';
        scanBtn.disabled = false;
        scanBtn.textContent = '🔍 Scan Again';
        reopenBtn.style.display = 'block';
        break;
      case 'capturing_selection':
        statusValue.innerHTML = '<span class="pulse"></span>Capturing selected slides…';
        scanBtn.disabled = true;
        reopenBtn.style.display = 'block';
        break;
      case 'building_pdf':
        statusValue.textContent = 'Building PDF…';
        scanBtn.disabled = true;
        reopenBtn.style.display = 'block';
        break;
      case 'done':
        statusValue.textContent = 'PDF downloaded ✓';
        scanBtn.disabled = false;
        scanBtn.textContent = '🔍 Scan Video';
        reopenBtn.style.display = 'none';
        break;
      case 'error':
        statusValue.textContent = 'Error';
        scanBtn.disabled = false;
        scanBtn.textContent = '🔍 Scan Video';
        break;
      default:
        statusValue.textContent = 'Idle';
        scanBtn.disabled = false;
        scanBtn.textContent = '🔍 Scan Video';
        reopenBtn.style.display = 'none';
    }
  });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshState, 700);
}

scanBtn.addEventListener('click', async () => {
  clearError();
  const tab = await getActiveTab();
  activeTabId = tab.id;

  const intervalSeconds = Math.min(60, Math.max(0.5, parseFloat(intervalNumber.value) || 4));
  const preset = QUALITY_PRESETS[qualitySelect.value] || QUALITY_PRESETS.balanced;

  chrome.runtime.sendMessage(
    {
      type: 'START_TIMELINE_SCAN_FOR_TAB',
      tabId: tab.id,
      intervalSeconds,
      maxWidth: preset.maxWidth,
      jpegQuality: preset.jpegQuality,
    },
    (resp) => {
      if (chrome.runtime.lastError || !resp) {
        showError('Couldn\u2019t reach this page. Reload the tab and try again.');
        return;
      }
      refreshState();
    }
  );
});

reopenBtn.addEventListener('click', () => {
  if (!activeTabId) return;
  chrome.tabs.create({ url: chrome.runtime.getURL(`review/review.html?tabId=${activeTabId}`) });
});

resetBtn.addEventListener('click', async () => {
  const tab = await getActiveTab();
  activeTabId = tab.id;
  chrome.runtime.sendMessage({ type: 'CLEAR_SESSION', tabId: tab.id }, () => {
    clearError();
    progressFill.style.width = '0%';
    statusValue.textContent = 'Idle';
    scanBtn.disabled = false;
    scanBtn.textContent = '🔍 Scan Video';
    reopenBtn.style.display = 'none';
  });
});

(async function init() {
  const tab = await getActiveTab();
  activeTabId = tab.id;
  await refreshState();
  startPolling();
})();
