// Content script for Mindful Web extension
// Handles AI API interactions and overlays

let currentOverlay = null;
let usefulnessBar = null;
let currentIntent = null;
let currentMode = null;
let usefulnessBarAutoCollapsed = false;
let snoozedUrl = null;

// blink buddy vars
let blinkBuddyRunning = false;
let blinkBuddyInterval = null;
const BLINK_MASCOT_OPEN = 'icons/mascot_eye_open.png';  
const BLINK_MASCOT_CLOSED = 'icons/mascot_eye_relaxed.png';     


// Automatic refocus tracking
let consecutiveLowScores = 0;
let timeOnLowScorePage = 0;
let lowScoreTimer = null;
let lastScore = null;
const LOW_SCORE_THRESHOLD = 4;
const CONSECUTIVE_LOW_SCORE_LIMIT = 3;
const TIME_ON_LOW_SCORE_LIMIT = 60000;
let suppressedUrlForConsecutive = null;
const SIDEBAR_MIN_WIDTH = 260;
const SIDEBAR_MAX_WIDTH = 560;
const USEFULNESS_BAR_DEFAULT_WIDTH = 350;
const CALM_SIDEBAR_DEFAULT_WIDTH = 400;
const featureRequestTokens = {};
const CALM_SUMMARY_CACHE_KEY = 'calmSummaryCache';
const CALM_SUMMARY_CACHE_TTL = 60 * 60 * 1000;
const CALM_SUMMARY_CACHE_LIMIT = 12;
const USEFULNESS_CACHE_KEY = 'usefulnessAssessmentCache';
const USEFULNESS_CACHE_TTL = 30 * 60 * 1000;
const USEFULNESS_CACHE_LIMIT = 20;
const PAGE_BRIDGE_SOURCE = 'mindful-page-bridge';
const CONTENT_BRIDGE_SOURCE = 'mindful-content-script';
const PAGE_SUMMARY_REQUEST = 'CALM_SUMMARY_REQUEST';
const PAGE_SUMMARY_RESULT = 'CALM_SUMMARY_RESULT';
const PAGE_SUMMARY_STATUS = 'CALM_SUMMARY_STATUS';
const PAGE_USEFULNESS_REQUEST = 'USEFULNESS_ASSESS_REQUEST';
const PAGE_USEFULNESS_RESULT = 'USEFULNESS_ASSESS_RESULT';
const PAGE_USEFULNESS_STATUS = 'USEFULNESS_ASSESS_STATUS';

const pageSummaryResolvers = new Map();
const pageUsefulnessResolvers = new Map();
let bridgeInjected = false;

async function getFreshCalmSummaryEntries() {
  const stored = await chrome.storage.local.get([CALM_SUMMARY_CACHE_KEY]);
  const rawEntries = Array.isArray(stored[CALM_SUMMARY_CACHE_KEY])
    ? stored[CALM_SUMMARY_CACHE_KEY]
    : [];
  const now = Date.now();
  const freshEntries = rawEntries.filter(entry =>
    entry &&
    entry.url &&
    typeof entry.summary === 'string' &&
    typeof entry.timestamp === 'number' &&
    now - entry.timestamp <= CALM_SUMMARY_CACHE_TTL
  );
  const trimmedEntries = pruneCalmSummaryEntries(freshEntries);
  if (trimmedEntries.length !== rawEntries.length) {
    await chrome.storage.local.set({ [CALM_SUMMARY_CACHE_KEY]: trimmedEntries });
  }
  return trimmedEntries;
}

function pruneCalmSummaryEntries(entries) {
  if (!Array.isArray(entries) || entries.length <= CALM_SUMMARY_CACHE_LIMIT) {
    return Array.isArray(entries) ? entries : [];
  }
  return [...entries]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-CALM_SUMMARY_CACHE_LIMIT);
}

async function getCachedCalmSummaryForUrl(url) {
  if (!url) return null;
  const entries = await getFreshCalmSummaryEntries();
  return entries.find(entry => entry.url === url) || null;
}

async function cacheCalmSummary(url, summary) {
  if (!url || typeof summary !== 'string' || !summary.trim()) {
    return;
  }
  const entries = await getFreshCalmSummaryEntries();
  const withoutUrl = entries.filter(entry => entry.url !== url);
  const updated = pruneCalmSummaryEntries([
    ...withoutUrl,
    { url, summary, timestamp: Date.now() }
  ]);
  await chrome.storage.local.set({ [CALM_SUMMARY_CACHE_KEY]: updated });
}

function injectPageBridge() {
  if (bridgeInjected) {
    return;
  }
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('page-apis-bridge.js');
    script.dataset.mindfulBridge = 'true';
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();
    bridgeInjected = true;
  } catch (error) {
    console.warn('Unable to inject page bridge script:', error);
  }
}

function handlePageBridgeMessage(event) {
  if (event.source !== window || !event.data) {
    return;
  }
  const data = event.data;
  if (data.source !== PAGE_BRIDGE_SOURCE) {
    return;
  }
  let resolverMap = null;
  if (data.type === PAGE_SUMMARY_STATUS || data.type === PAGE_SUMMARY_RESULT) {
    resolverMap = pageSummaryResolvers;
  } else if (data.type === PAGE_USEFULNESS_STATUS || data.type === PAGE_USEFULNESS_RESULT) {
    resolverMap = pageUsefulnessResolvers;
  } else {
    return;
  }
  const resolver = resolverMap.get(data.requestId);
  if (!resolver) {
    return;
  }
  if (data.type === PAGE_SUMMARY_STATUS || data.type === PAGE_USEFULNESS_STATUS) {
    if (typeof data.message === 'string' && typeof resolver.onStatus === 'function') {
      resolver.onStatus(data.message);
    }
    return;
  }
  if (data.type === PAGE_SUMMARY_RESULT || data.type === PAGE_USEFULNESS_RESULT) {
    clearTimeout(resolver.timeoutId);
    resolverMap.delete(data.requestId);
    if (data.success) {
      resolver.resolve(data.payload);
    } else {
      resolver.reject(new Error(data.error || 'Unknown error from page bridge.'));
    }
  }
}

window.addEventListener('message', handlePageBridgeMessage, false);

function requestPageCalmSummary({ text, intent, onStatus }) {
  injectPageBridge();
  const requestId = `mindful-summary-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pageSummaryResolvers.delete(requestId);
      reject(new Error('Timed out waiting for on-page summarizer response.'));
    }, 25000);

    pageSummaryResolvers.set(requestId, { resolve, reject, timeoutId, onStatus });

    window.postMessage({
      source: CONTENT_BRIDGE_SOURCE,
      type: PAGE_SUMMARY_REQUEST,
      requestId,
      text,
      metadata: {
        intent,
        title: document.title || '',
        url: window.location.href || ''
      }
    }, '*');
  });
}

function requestPageUsefulnessAssessment({ text, intent, title, url, onStatus }) {
  injectPageBridge();
  const requestId = `mindful-usefulness-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pageUsefulnessResolvers.delete(requestId);
      reject(new Error('Timed out waiting for on-page usefulness assessment.'));
    }, 25000);

    pageUsefulnessResolvers.set(requestId, { resolve, reject, timeoutId, onStatus });

    window.postMessage({
      source: CONTENT_BRIDGE_SOURCE,
      type: PAGE_USEFULNESS_REQUEST,
      requestId,
      text,
      metadata: {
        intent,
        title: title || document.title || '',
        url: url || window.location.href || ''
      }
    }, '*');
  });
}

function setCalmSummaryLoadingMessage(text) {
  const el = document.getElementById('calm-summary-loading-message');
  if (el) {
    el.textContent = text;
  }
}

function setCalmSummarySnippet(html) {
  const el = document.getElementById('calm-summary-snippet');
  if (el) {
    const hasContent = typeof html === 'string' && html.trim().length > 0;
    if (hasContent) {
      el.innerHTML = html;
      el.style.display = '';
    } else {
      el.innerHTML = '';
      el.style.display = 'none';
    }
  }
}

function buildSnippetFromText(text, maxLength = 360) {
  if (!text) return '';
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  const snippet = trimmed.length > maxLength
    ? `${trimmed.slice(0, maxLength).trim()}…`
    : trimmed;
  return `<pre class="mindful-loading-snippet">${escapeHtml(snippet)}</pre>`;
}

function convertMarkdownBoldToStrongInline(text = '') {
  if (typeof text !== 'string' || !text.includes('**')) {
    return text;
  }
  return text.replace(/\*\*(.+?)\*\*/gs, (_match, inner) => `<strong>${inner.trim()}</strong>`);
}

function buildSummaryHtml(summary = '', allowRichHtml = false) {
  if (!summary || typeof summary !== 'string') {
    return '<div class="mindful-content mindful-rich-text">No summary available.</div>';
  }
  const normalised = convertMarkdownBoldToStrongInline(summary.trim());
  if (allowRichHtml) {
    return `<div class="mindful-content mindful-rich-text">${normalised}</div>`;
  }
  const safe = escapeHtml(normalised);
  const paragraphs = safe.split(/\n{2,}/).map(paragraph =>
    paragraph.replace(/\n/g, '<br>')
  );
  return `<div class="mindful-content mindful-rich-text"><p>${paragraphs.join('</p><p>')}</p></div>`;
}

function ensureSummaryMarkup(summary = '') {
  if (typeof summary !== 'string' || !summary.trim()) {
    return '<div class="mindful-content mindful-rich-text">No summary available.</div>';
  }
  const trimmed = summary.trim();
  if (trimmed.startsWith('<')) {
    return trimmed;
  }
  return `<div class="mindful-content mindful-rich-text">${trimmed}</div>`;
}

function formatRelativeTimestamp(timestamp) {
  if (typeof timestamp !== 'number') {
    return '';
  }
  const delta = Date.now() - timestamp;
  if (delta < 60 * 1000) return 'just now';
  if (delta < 60 * 60 * 1000) {
    const minutes = Math.round(delta / (60 * 1000));
    return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  }
  if (delta < 24 * 60 * 60 * 1000) {
    const hours = Math.round(delta / (60 * 60 * 1000));
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString();
}

async function getFreshUsefulnessEntries() {
  const stored = await chrome.storage.local.get([USEFULNESS_CACHE_KEY]);
  const rawEntries = Array.isArray(stored[USEFULNESS_CACHE_KEY])
    ? stored[USEFULNESS_CACHE_KEY]
    : [];
  const now = Date.now();
  const freshEntries = rawEntries.filter(entry =>
    entry &&
    entry.url &&
    typeof entry.intent === 'string' &&
    typeof entry.assessment === 'string' &&
    typeof entry.timestamp === 'number' &&
    now - entry.timestamp <= USEFULNESS_CACHE_TTL
  );
  const trimmedEntries = pruneUsefulnessEntries(freshEntries);
  if (trimmedEntries.length !== rawEntries.length) {
    await chrome.storage.local.set({ [USEFULNESS_CACHE_KEY]: trimmedEntries });
  }
  return trimmedEntries;
}

function pruneUsefulnessEntries(entries) {
  if (!Array.isArray(entries) || entries.length <= USEFULNESS_CACHE_LIMIT) {
    return Array.isArray(entries) ? entries : [];
  }
  return [...entries]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-USEFULNESS_CACHE_LIMIT);
}

async function getCachedUsefulnessAssessment(url, intent) {
  if (!url) return null;
  const safeIntent = typeof intent === 'string' ? intent : '';
  const entries = await getFreshUsefulnessEntries();
  return entries.find(entry => entry.url === url && entry.intent === safeIntent) || null;
}

async function cacheUsefulnessAssessment(url, intent, assessment) {
  if (!url || typeof assessment !== 'string' || !assessment.trim()) {
    return;
  }
  const safeIntent = typeof intent === 'string' ? intent : '';
  const entries = await getFreshUsefulnessEntries();
  const withoutCurrent = entries.filter(entry => !(entry.url === url && entry.intent === safeIntent));
  const updated = pruneUsefulnessEntries([
    ...withoutCurrent,
    { url, intent: safeIntent, assessment, timestamp: Date.now() }
  ]);
  await chrome.storage.local.set({ [USEFULNESS_CACHE_KEY]: updated });
}

function beginFeatureRequest(feature) {
  featureRequestTokens[feature] = (featureRequestTokens[feature] || 0) + 1;
  return featureRequestTokens[feature];
}

function isFeatureRequestActive(feature, token) {
  return featureRequestTokens[feature] === token;
}

function cancelFeatureRequest(feature) {
  featureRequestTokens[feature] = (featureRequestTokens[feature] || 0) + 1;
}

// Initialize on page load
initializePage();

// Listen for URL changes (for SPAs like YouTube)
let currentUrl = window.location.href;
setInterval(() => {
  if (window.location.href !== currentUrl) {
    currentUrl = window.location.href;
    console.log('URL changed, updating usefulness bar...');
    snoozedUrl = null;
    if (currentMode === 'focus' && currentIntent && usefulnessBar) {
      updateUsefulnessBar();
    }
  }
}, 1000);

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    sendResponse({ ready: true });
    return true;
  }
  
  if (request.action === 'executeFeature') {
    handleFeature(request.feature, request.mode, request.browsingIntent)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }
  
  if (request.action === 'updateIntent') {
    currentIntent = request.intent;
    currentMode = request.mode;
    
    cancelFeatureRequest('calmSummarize');
    cancelFeatureRequest('journal');
    
    // Reset tracking counters when mode or intent changes
    consecutiveLowScores = 0;
    if (lowScoreTimer) {
      clearInterval(lowScoreTimer);
      lowScoreTimer = null;
    }
    timeOnLowScorePage = 0;
    snoozedUrl = null;
    
    // Show/hide bar based on mode and intent
    if (currentMode === 'focus' && currentIntent) {
      if (!usefulnessBar) {
        createUsefulnessBar();
      }
      updateUsefulnessBar();
    } else {
      removeUsefulnessBar();
    }
    
    sendResponse({ success: true });
    return true;
  }
});

// Initialize page
async function initializePage() {
  // Load current settings
  const result = await chrome.storage.local.get(['browsingIntent', 'mode']);
  currentIntent = result.browsingIntent || '';
  currentMode = result.mode || 'calm';
  
  // Show usefulness bar if in Focus mode with intent
  if (currentMode === 'focus' && currentIntent) {
    createUsefulnessBar();
    await updateUsefulnessBar();
  } else {
    // Remove bar if not in Focus mode
    removeUsefulnessBar();
  }
}

// Remove usefulness bar
function removeUsefulnessBar() {
  if (usefulnessBar) {
    usefulnessBar.remove();
    usefulnessBar = null;
  }
  usefulnessBarAutoCollapsed = false;
  // Remove body classes
  document.body.classList.remove('mindful-bar-active');
  document.body.classList.remove('mindful-bar-overlay');
}

// Create usefulness score sidebar
function createUsefulnessBar() {
  if (usefulnessBar) {
    usefulnessBar.remove();
  }
  removeCalmSidebars();
  removeActiveOverlay();
  
  usefulnessBar = document.createElement('div');
  usefulnessBar.id = 'mindful-usefulness-bar';
  usefulnessBar.className = 'mindful-usefulness-sidebar';
  
  usefulnessBar.innerHTML = `
    <div class="mindful-sidebar-header">
      <h3>Usefulness Score</h3>
      <div class="mindful-sidebar-controls">
        <button class="mindful-sidebar-toggle" title="Collapse sidebar">−</button>
        <button class="mindful-sidebar-close" title="Turn off focus mode">×</button>
      </div>
    </div>
    <div class="mindful-sidebar-body">
      <div class="usefulness-score-display">
        <div class="score-main">
          <span class="score-label">Score:</span>
          <span class="score-value" id="usefulness-score-value">Calculating...</span>
        </div>
        <div class="intent-display">
          <strong>Your Goal:</strong> <span id="intent-text">${currentIntent}</span>
        </div>
        <div class="score-details" id="score-details">
          Analyzing page content...
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(usefulnessBar);
  initSidebarResize(usefulnessBar, USEFULNESS_BAR_DEFAULT_WIDTH);
  makeCollapsedSidebarDraggable(usefulnessBar);

  const toggleBtn = usefulnessBar.querySelector('.mindful-sidebar-toggle');
  const closeBtn = usefulnessBar.querySelector('.mindful-sidebar-close');
  
  toggleBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (usefulnessBar.classList.contains('collapsed')) {
      removeCalmSidebars();
      removeActiveOverlay();
      expandSidebarElement(usefulnessBar);
    } else {
      collapseSidebarElement(usefulnessBar);
    }
    usefulnessBarAutoCollapsed = false;
  });

  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.storage.local.set({ mode: 'calm' });
    currentMode = 'calm';
    consecutiveLowScores = 0;
    timeOnLowScorePage = 0;
    snoozedUrl = null;
    if (lowScoreTimer) {
      clearInterval(lowScoreTimer);
      lowScoreTimer = null;
    }
    removeUsefulnessBar();
  });
}

// Update usefulness bar with current page assessment
async function updateUsefulnessBar() {
  if (!usefulnessBar) return;
  
  const scoreValue = usefulnessBar.querySelector('#usefulness-score-value');
  const scoreDetails = usefulnessBar.querySelector('#score-details');
  const intentText = usefulnessBar.querySelector('#intent-text');
  const currentUrl = window.location.href || '';
  
  // Update intent display
  intentText.textContent = currentIntent;
  
  const startLoading = () => {
    scoreValue.textContent = 'Analyzing...';
    scoreValue.className = 'score-value score-medium';
    scoreDetails.textContent = 'Reading page content...';
    dots = 0;
    if (loadingInterval) {
      clearInterval(loadingInterval);
    }
    loadingInterval = setInterval(() => {
      dots = (dots + 1) % 4;
      scoreDetails.textContent = 'Analyzing page content' + '.'.repeat(dots);
    }, 500);
  };
  
  const stopLoading = () => {
    if (loadingInterval) {
      clearInterval(loadingInterval);
      loadingInterval = null;
    }
  };
  
  let dots = 0;
  let loadingInterval = null;
  
  const cachedEntry = await getCachedUsefulnessAssessment(currentUrl, currentIntent);
  if (cachedEntry) {
    const relative = formatRelativeTimestamp(cachedEntry.timestamp);
    const notePieces = ['Showing saved score'];
    if (relative) {
      notePieces.push(`from ${relative}`);
    }
    notePieces.push('while refreshing...');
    const parsed = renderUsefulnessAssessment(
      cachedEntry.assessment,
      { scoreValue, scoreDetails },
      notePieces.join(' ')
    );
    if (parsed && Number.isInteger(parsed.scoreNumber)) {
      lastScore = parsed.scoreNumber;
      checkForAutomaticRefocus(parsed.scoreNumber);
    }
  } else {
    startLoading();
  }
  
  try {
    const pageText = extractPageText();
    
    if (!pageText) {
      stopLoading();
      if (cachedEntry) {
        const parsed = renderUsefulnessAssessment(
          cachedEntry.assessment,
          { scoreValue, scoreDetails },
          'Using saved score. Unable to read this page right now.'
        );
        if (parsed && Number.isInteger(parsed.scoreNumber)) {
          lastScore = parsed.scoreNumber;
          checkForAutomaticRefocus(parsed.scoreNumber);
        }
      } else {
        scoreValue.textContent = 'N/A';
        scoreValue.className = 'score-value score-medium';
        scoreDetails.textContent = 'No content found on this page';
      }
      return;
    }
    
    if (!cachedEntry && !loadingInterval) {
      startLoading();
    }
    
    let pageAssessment = null;
    try {
      pageAssessment = await requestPageUsefulnessAssessment({
        text: pageText,
        intent: currentIntent,
        title: document.title || '',
        url: currentUrl || '',
        onStatus: (status) => {
          if (status) {
            scoreDetails.textContent = status;
          }
        }
      });
    } catch (pageError) {
      console.warn('On-page prompt unavailable for usefulness assessment, using fallback.', pageError);
    }

    if (pageAssessment) {
      stopLoading();
      const parsed = renderUsefulnessAssessment(
        pageAssessment.assessmentText,
        { scoreValue, scoreDetails }
      );
      await cacheUsefulnessAssessment(currentUrl, currentIntent, pageAssessment.assessmentText);
      if (parsed && Number.isInteger(parsed.scoreNumber)) {
        lastScore = parsed.scoreNumber;
        checkForAutomaticRefocus(parsed.scoreNumber);
      }
      return;
    }
    
    // Send message to background script to use AI API
    console.log('Sending request to background script for AI assessment...');
    const result = await chrome.runtime.sendMessage({
      action: 'assessUsefulness',
      intent: currentIntent,
      pageText: pageText,
      pageTitle: document.title || '',
      pageUrl: currentUrl || ''
    });
    
    stopLoading();
    
    if (!result.success) {
      throw new Error(result.error || 'AI assessment failed');
    }
    
    const parsed = renderUsefulnessAssessment(
      result.assessment,
      { scoreValue, scoreDetails }
    );
    await cacheUsefulnessAssessment(currentUrl, currentIntent, result.assessment);
    
    if (parsed && Number.isInteger(parsed.scoreNumber)) {
      lastScore = parsed.scoreNumber;
      checkForAutomaticRefocus(parsed.scoreNumber);
    }
    
  } catch (error) {
    stopLoading();
    console.error('Error updating usefulness bar:', error);
    console.error('Error details:', {
      message: error.message,
      name: error.name,
      stack: error.stack
    });
    
    if (cachedEntry) {
      const parsed = renderUsefulnessAssessment(
        cachedEntry.assessment,
        { scoreValue, scoreDetails },
        'Showing saved insights. Latest analysis unavailable.'
      );
      if (parsed && Number.isInteger(parsed.scoreNumber)) {
        lastScore = parsed.scoreNumber;
        checkForAutomaticRefocus(parsed.scoreNumber);
      }
      return;
    }
    // Fallback assessment
    const fallbackScore = 7;
    scoreValue.textContent = `${fallbackScore}/10`;
    scoreValue.className = `score-value score-${getScoreClass(fallbackScore)}`;
    scoreDetails.innerHTML = `
      <div class="explanation"><strong>Assessment:</strong> This page appears to contain relevant information. Consider if it directly supports your goal: "${currentIntent}"</div>
      <div class="relevant-info"><strong>Note:</strong> AI assessment unavailable. Error: ${error.message}. Please review the page content manually.</div>
    `;
  }
}

// Check if automatic refocus reminder should be shown
function checkForAutomaticRefocus(score) {
  // Only check in focus mode
  if (currentMode !== 'focus' || !currentIntent) {
    return;
  }
  if (snoozedUrl && snoozedUrl === window.location.href) {
    return;
  }
  // Clear suppression if URL changed
  if (suppressedUrlForConsecutive && suppressedUrlForConsecutive !== window.location.href) {
    suppressedUrlForConsecutive = null;
  }
  
  // Check if score is low
  if (score < LOW_SCORE_THRESHOLD) {
    // Increment consecutive low scores
    if (window.location.href !== suppressedUrlForConsecutive) {
      consecutiveLowScores++;
    }
    
    // Start timer for time on low-score page
    if (!lowScoreTimer) {
      timeOnLowScorePage = 0;
      lowScoreTimer = setInterval(() => {
        timeOnLowScorePage += 1000;
        
        // Check if we've been on low-score page for too long
        if (timeOnLowScorePage >= TIME_ON_LOW_SCORE_LIMIT) {
          clearInterval(lowScoreTimer);
          lowScoreTimer = null;
          showAutomaticRefocusReminder('time');
        }
      }, 1000);
    }
    
    // Check if we've hit consecutive low score limit
    if (consecutiveLowScores >= CONSECUTIVE_LOW_SCORE_LIMIT) {
      clearInterval(lowScoreTimer);
      lowScoreTimer = null;
      showAutomaticRefocusReminder('consecutive');
      consecutiveLowScores = 0; // Reset after showing reminder
    }
  } else {
    // Reset counters if score is good
    consecutiveLowScores = 0;
    if (lowScoreTimer) {
      clearInterval(lowScoreTimer);
      lowScoreTimer = null;
    }
    timeOnLowScorePage = 0;
  }
}

// Show automatic refocus reminder
function showAutomaticRefocusReminder(reason) {
  // Don't show if there's already an overlay
  if (currentOverlay) {
    return;
  }
  
  let message = '';
  if (reason === 'consecutive') {
    message = `You've visited ${CONSECUTIVE_LOW_SCORE_LIMIT} pages with low usefulness scores.\n\nRemember your goal: ${currentIntent}\n\nYou seem to be drifting away. Want to refocus?`;
  } else if (reason === 'time') {
    message = `You've been on this page for a while, but it's not very useful for your goal.\n\nRemember your goal: ${currentIntent}\n\nYou seem to be drifting away. Want to refocus?`;
  }
  
    showOverlay({
      title: 'Drifting Away?',
    content: message,
    theme: 'focus',
    actions: [
      { label: 'Yes, Refocus', action: 'refocus' },
      { label: 'I\'m Good', action: 'snooze' }
    ]
  });

  // If time-based reminder fired, suppress consecutive trigger on this URL
  if (reason === 'time') {
    suppressedUrlForConsecutive = window.location.href;
    consecutiveLowScores = 0;
  }
}

// Get CSS class based on score
function getScoreClass(score) {
  const num = parseInt(score);
  if (num >= 8) return 'high';
  if (num >= 5) return 'medium';
  return 'low';
}

function parseUsefulnessAssessment(assessmentText) {
  if (typeof assessmentText !== 'string') {
    return null;
  }
  const trimmed = assessmentText.trim();
  if (!trimmed) {
    return null;
  }
  const scoreMatch = trimmed.match(/Score:\s*(\d+)\/10/i);
  const explanationMatch = trimmed.match(/Explanation:\s*(.+?)(?:\nRelevant|$)/is);
  const relevantInfoMatch = trimmed.match(/Relevant Information:\s*(.+?)(?:\n\n|\n*$)/is);
  const scoreNumber = scoreMatch ? parseInt(scoreMatch[1], 10) : NaN;
  const scoreDisplay = scoreMatch ? `${scoreMatch[1]}/10` : 'N/A';
  const scoreClass = Number.isNaN(scoreNumber) ? 'medium' : getScoreClass(scoreNumber);
  const explanation = explanationMatch ? explanationMatch[1].trim() : 'Unable to assess this page right now.';
  let relevantHtml = '';
  if (relevantInfoMatch) {
    const bulletLines = relevantInfoMatch[1]
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('-'))
      .map(line => `<li>${escapeHtml(line.substring(1).trim())}</li>`);
    if (bulletLines.length) {
      relevantHtml = `<ul style="margin: 5px 0; padding-left: 20px;">${bulletLines.join('')}</ul>`;
    }
  }
  if (!relevantHtml) {
    relevantHtml = '<p>No directly relevant points found.</p>';
  }
  return {
    scoreNumber,
    scoreDisplay,
    scoreClass,
    explanation,
    relevantHtml
  };
}

function renderUsefulnessAssessment(assessmentText, elements, note = '') {
  const parsed = parseUsefulnessAssessment(assessmentText);
  if (!parsed) {
    return null;
  }
  const { scoreNumber, scoreDisplay, scoreClass, explanation, relevantHtml } = parsed;
  if (elements.scoreValue) {
    elements.scoreValue.textContent = scoreDisplay;
    elements.scoreValue.className = `score-value score-${scoreClass}`;
  }
  if (elements.scoreDetails) {
    let detailsHtml = `
      <div class="explanation"><strong>Assessment:</strong> ${escapeHtml(explanation)}</div>
      <div class="relevant-info"><strong>Relevant Information:</strong>${relevantHtml}</div>
    `;
    if (note) {
      detailsHtml += `<p class="cached-note">${escapeHtml(note)}</p>`;
    }
    elements.scoreDetails.innerHTML = detailsHtml;
  }
  return parsed;
}

// Handle feature execution
async function handleFeature(feature, mode, browsingIntent) {
  try {
    switch (feature) {
      case 'calmSummarize':
        return await calmSummarize();
      
      case 'breathe':
        return await showBreathingExercise();
      
      case 'journal':
        return await showJournal();
      
      case 'blinkBuddy':
        return await showBlinkBuddy();
      
      default:
        return { success: false, error: 'Unknown feature' };
    }
  } catch (error) {
    console.error('Error handling feature:', error);
    return { success: false, error: error.message };
  }
}

// Calm Mode Features

async function calmSummarize() {
  const requestToken = beginFeatureRequest('calmSummarize');
  const currentUrl = window.location.href;
  let cachedEntry = null;
  let pageSummaryResult = null;
  try {
    showLoadingSidebar('Calm Summary', 'Creating a gentle summary of this page...');
    setCalmSummaryLoadingMessage('Gathering the most soothing details...');
    cachedEntry = await getCachedCalmSummaryForUrl(currentUrl);
    if (cachedEntry) {
      const when = formatRelativeTimestamp(cachedEntry.timestamp);
      const cachedMarkup = ensureSummaryMarkup(cachedEntry.summary);
      setCalmSummarySnippet(`
        <div class="loading-snippet-title">Last calm summary ${when ? `• ${when}` : ''}</div>
        ${cachedMarkup}
      `);
      setCalmSummaryLoadingMessage('Refreshing your calm summary...');
    } else {
      setCalmSummarySnippet('');
    }
    
    const pageText = extractPageText();
    if (!pageText) {
      if (isFeatureRequestActive('calmSummarize', requestToken) && currentMode === 'calm') {
        hideLoadingSidebar();
      }
      return { success: false, error: 'No content found on this page' };
    }
    
    try {
      pageSummaryResult = await requestPageCalmSummary({
        text: pageText,
        intent: currentIntent,
        onStatus: (status) => {
          if (status && isFeatureRequestActive('calmSummarize', requestToken) && currentMode === 'calm') {
            setCalmSummaryLoadingMessage(status);
          }
        }
      });
    } catch (pageError) {
      console.warn('On-page summarizer unavailable, falling back to background worker.', pageError);
    }

    if (pageSummaryResult && isFeatureRequestActive('calmSummarize', requestToken) && currentMode === 'calm') {
      hideLoadingSidebar();
      const allowRichHtml = pageSummaryResult.mode === 'summarizer+rewriter';
      const summaryContent = buildSummaryHtml(pageSummaryResult.summary, allowRichHtml);
      showSidebar('Calm Summary', summaryContent, 'calm');
      await cacheCalmSummary(currentUrl, summaryContent);
      return { success: true, message: 'Summary generated' };
    }

    setCalmSummaryLoadingMessage('Letting the calm settle into a summary...');
    const result = await chrome.runtime.sendMessage({
      action: 'summarizePage',
      pageText: pageText
    });
    setCalmSummaryLoadingMessage('Weaving together a peaceful overview...');
    
    if (!isFeatureRequestActive('calmSummarize', requestToken) || currentMode !== 'calm') {
      return { success: false, cancelled: true };
    }
    
    hideLoadingSidebar();
    
    if (!result.success) {
      throw new Error(result.error || 'Summary failed');
    }
    
    const summaryContent = buildSummaryHtml(result.summary, true);
    showSidebar('Calm Summary', summaryContent, 'calm');
    await cacheCalmSummary(currentUrl, summaryContent);
    
    return { success: true, message: 'Summary generated' };
  } catch (error) {
    console.error('Error in calmSummarize:', error);
    
    if (!isFeatureRequestActive('calmSummarize', requestToken) || currentMode !== 'calm') {
      return { success: false, cancelled: true };
    }
    
    hideLoadingSidebar();
    if (cachedEntry && typeof cachedEntry.summary === 'string') {
      const cachedContent = ensureSummaryMarkup(cachedEntry.summary);
      showSidebar('Calm Summary', cachedContent, 'calm');
      return { success: true, message: 'Summary loaded from cache' };
    }
    
    const pageText = extractPageText();
    const simpleSummary = pageText ? pageText.substring(0, 500) + '...' : 'No content available.';
    
    const fallbackContent = buildSummaryHtml(simpleSummary, false);
    showSidebar('Calm Summary', fallbackContent, 'calm');
    
    return { success: true, message: 'Summary generated (fallback mode)' };
  }
}

async function showBreathingExercise() {
  // Create breathing exercise content for sidebar
  const breathingMascotUrl = chrome.runtime.getURL('icons/mascot_breathe.png');
  const breathingContent = `
    <div class="breathing-container">
      <div class="breathing-circle start-state" id="breathing-circle">
        <div class="breathing-inner"></div>
      </div>
      <div class="breathing-text">
        <h4 id="breathing-instruction">Ready</h4>
        <p id="breathing-countdown">0</p>
      </div>
      <div class="breathing-guidance">
        <p>Follow the circle as it expands and contracts</p>
        <p>Take your time, there's no rush</p>
        <div class="breathing-controls">
          <button class="breathing-control-btn" id="breathing-start">Start</button>
          <button class="breathing-control-btn" id="breathing-stop" disabled>Stop</button>
        </div>
        <div class="breathing-mascot">
          <img src="${breathingMascotUrl}" alt="Breathing mascot">
        </div>
      </div>
    </div>
  `;
  
  showSidebar('Breathing Exercise', breathingContent, 'calm');
  
  // Start breathing animation on the sidebar
  const sidebar = currentOverlay;
  if (sidebar) {
    initBreathingControls(sidebar);
  }
  
  return { success: true, message: 'Breathing exercise started' };
}

function buildBlinkBuddySidebar() {
  const openUrl = chrome.runtime.getURL(BLINK_MASCOT_OPEN);
  const closedUrl = chrome.runtime.getURL(BLINK_MASCOT_CLOSED);

  return `
    <div class="blinkbuddy-container">
      <div class="blinkbuddy-mascot-wrap">
        <img id="blinkbuddy-mascot" src="${closedUrl}" alt="Blink buddy mascot" />
      </div>

      <p class="blinkbuddy-text">
        A gentle buddy that blinks softly in the corner — a subtle reminder for your eyes.
      </p>

      <div class="blinkbuddy-controls">
        <button class="blinkbuddy-btn" id="blinkbuddy-toggle">
          ${blinkBuddyRunning ? 'Stop' : 'Start'}
        </button>
      </div>
    </div>
  `;
}

// function startBlinkBuddy(sidebar){
//   const mascotImg = sidebar?.querySelector('#blinkbuddy-mascot');
//   if (!mascotImg) return;
//   const openUrl = chrome.runtime.getURL(BLINK_MASCOT_OPEN);
//   const closedUrl = chrome.runtime.getURL(BLINK_MASCOT_CLOSED);
//   blinkBuddyRunning = true;
//   const scheduleNext = () => {
//     if(!blinkBuddyRunning) return;
//     const delay = 8000 + Math.floor(Math.random()*7000);
//     blinkBuddyInterval = setTimeout(() => {
//       if (!blinkBuddyRunning) return ;
//       mascotImg.src = openUrl;
//       setTimeout(()=>{
//         mascotImg.src = closedUrl;
//         scheduleNext();
//       }, 350);
//     },delay);
//   };
//   scheduleNext();
// }

function startBlinkBuddy(sidebar) {
  const mascotImg = sidebar?.querySelector('#blinkbuddy-mascot');
  if (!mascotImg) return;

  const openUrl = chrome.runtime.getURL(BLINK_MASCOT_OPEN);
  const closedUrl = chrome.runtime.getURL(BLINK_MASCOT_CLOSED);

  stopBlinkBuddy(); // clear any previous timer
  blinkBuddyRunning = true;

  const doBlink = () => {
    if (!blinkBuddyRunning) return;

    // start “soft” transition
    mascotImg.style.opacity = '0.85';
    mascotImg.style.transform = 'scaleY(0.95)';

    // close eyes quickly
    setTimeout(() => {
      if (!blinkBuddyRunning) return;
      mascotImg.src = closedUrl;
    }, 60);

    // reopen + restore
    setTimeout(() => {
      if (!blinkBuddyRunning) return;
      mascotImg.src = openUrl;
      mascotImg.style.opacity = '1';
      mascotImg.style.transform = 'scaleY(1)';
    }, 180);
  };

  const scheduleNext = () => {
    if (!blinkBuddyRunning) return;

    const delay = 5000 + Math.floor(Math.random() * 5000); // 5–10s (less dead time)
    blinkBuddyInterval = setTimeout(() => {
      doBlink();
      scheduleNext();
    }, delay);
  };

  // optional: immediate blink so user feels it started
  doBlink();
  scheduleNext();
}


function stopBlinkBuddy() {
  blinkBuddyRunning = false;
  if (blinkBuddyInterval) {
    clearTimeout(blinkBuddyInterval);
    blinkBuddyInterval = null;
  }
}

// async function showBlinkBuddy(){
//   const content = buildBlinkBuddySidebar();
//   showSidebar('Blink Buddy', content, 'calm');
//   const sidebar = currentOverlay;
//   if (!sidebar) {
//     return { success: false, error: 'Sidebar not available' };
//   }
//   const toggleBtn = sidebar.querySelector('#blinkbuddy-toggle');
//   const syncButton = () => {
//     if (toggleBtn) toggleBtn.textContent = blinkBuddyRunning ? 'Stop' : 'Start';
//   };
//   toggleBtn?.addEventListener('click', () => {
//     if (blinkBuddyRunning) {
//       stopBlinkBuddy();
//     } else {
//       startBlinkBuddy(sidebar);
//     }
//     syncButton();
//   });
//   const closeBtn = sidebar.querySelector('.mindful-sidebar-close');
//   closeBtn?.addEventListener('click', () => {
//     stopBlinkBuddy();
//   });
//   syncButton();
//   return { success: true, message: 'Blink Buddy opened' };
// }
async function showBlinkBuddy() {
  const content = buildBlinkBuddySidebar();
  showSidebar('Blink Buddy', content, 'calm');

  const sidebar = currentOverlay;
  if (!sidebar) return { success: false, error: 'Sidebar not available' };

  const syncButton = () => {
    const btn = sidebar.querySelector('#blinkbuddy-toggle');
    if (btn) btn.textContent = blinkBuddyRunning ? 'Stop' : 'Start';
  };

  // Event delegation: handle clicks inside sidebar reliably
  sidebar.addEventListener('click', (e) => {
    const target = e.target;

    if (target && target.id === 'blinkbuddy-toggle') {
      e.preventDefault();
      e.stopPropagation();

      if (blinkBuddyRunning) {
        stopBlinkBuddy(sidebar);
      } else {
        startBlinkBuddy(sidebar);
      }
      syncButton();
    }
  });

  // cleanup when sidebar is closed
  const closeBtn = sidebar.querySelector('.mindful-sidebar-close');
  closeBtn?.addEventListener('click', () => stopBlinkBuddy(sidebar));

  syncButton();
  return { success: true, message: 'Blink Buddy opened' };
}


const JOURNAL_STORAGE_KEY = 'calmJournalEntries';
const JOURNAL_MOODS = ['Calm', 'Grateful', 'Productive', 'Stressed', 'Hopeful', 'Low', 'Reflective', 'Proud', 'Conflicted'];

async function showJournal() {
  const entries = await getJournalEntries();
  const journalContent = buildJournalSidebar(entries);
  showSidebar('Journal', journalContent, 'calm');
  const sidebar = currentOverlay;
  if (sidebar) {
    attachJournalHandlers(sidebar, entries);
  }
  return { success: true, message: 'Journal opened' };
}

// Helper Functions

async function getJournalEntries() {
  const stored = await chrome.storage.local.get([JOURNAL_STORAGE_KEY]);
  const entries = stored[JOURNAL_STORAGE_KEY];
  return Array.isArray(entries) ? entries : [];
}

async function saveJournalEntries(entries) {
  await chrome.storage.local.set({ [JOURNAL_STORAGE_KEY]: entries });
}

function buildJournalSidebar(entries) {
  const entryList = entries.length
    ? entries.slice().reverse().map(entry => {
        const timestamp = formatJournalTimestamp(entry.createdAt);
        const safeText = escapeHtml(entry.text).replace(/\n/g, '<br>');
        return `
          <article class="journal-entry" data-id="${entry.id}">
            <header class="journal-entry-header">
              <div>
                <p class="journal-entry-time">${timestamp}</p>
                <p class="journal-entry-mood">${escapeHtml(entry.mood)}</p>
              </div>
              <button class="journal-delete-btn" data-id="${entry.id}" title="Delete entry">🗑</button>
            </header>
            <div class="journal-entry-body">${safeText}</div>
          </article>
        `;
      }).join('')
    : '<p class="journal-empty">No journal entries yet. Start with a few lines above.</p>';
  return `
    <div class="journal-container">
    <div class="journal-new-entry">
      <textarea id="journal-entry-input" class="journal-textarea" placeholder="How are you feeling today?"></textarea>
      <div class="journal-controls">
        <div class="journal-auto-mood" id="journal-auto-mood">Mood: Calm</div>
        <button class="journal-save-btn">Save Entry</button>
      </div>
      <p class="journal-feedback" id="journal-feedback"></p>
    </div>
      <div class="journal-actions">
        <button class="journal-download-btn">Download PDF</button>
      </div>
      <div class="journal-entries">
        ${entryList}
      </div>
    </div>
  `;
}

function attachJournalHandlers(sidebar, initialEntries) {
  const textarea = sidebar.querySelector('#journal-entry-input');
  const saveBtn = sidebar.querySelector('.journal-save-btn');
  const downloadBtn = sidebar.querySelector('.journal-download-btn');
  const feedbackEl = sidebar.querySelector('#journal-feedback');
  const autoMoodEl = sidebar.querySelector('#journal-auto-mood');
  let detectedMood = JOURNAL_MOODS[0];
  let detectTimer = null;
  let lastAnalyzedText = '';

  const setFeedback = (message, tone = 'info') => {
    if (!feedbackEl) return;
    feedbackEl.textContent = message || '';
    feedbackEl.dataset.tone = tone;
  };

  const updateAutoMoodDisplay = (mood, pending = false) => {
    if (!autoMoodEl) return;
    autoMoodEl.textContent = pending ? 'Mood: Detecting…' : `Mood: ${mood}`;
  };

  const detectMood = async () => {
    const text = (textarea?.value || '').trim();
    if (!text) {
      detectedMood = JOURNAL_MOODS[0];
      lastAnalyzedText = '';
      updateAutoMoodDisplay(detectedMood);
      return;
    }
    if (text === lastAnalyzedText) return;
    updateAutoMoodDisplay('', true);
    try {
      const result = await chrome.runtime.sendMessage({
        action: 'classifyJournalMood',
        text,
        moods: JOURNAL_MOODS
      });
      if (result && result.success && result.mood) {
        detectedMood = result.mood;
        lastAnalyzedText = text;
      } else {
        detectedMood = JOURNAL_MOODS[0];
      }
    } catch (error) {
      console.warn('Mood detection failed:', error);
      detectedMood = JOURNAL_MOODS[0];
    }
    updateAutoMoodDisplay(detectedMood);
  };

  textarea?.addEventListener('input', () => {
    if (detectTimer) {
      clearTimeout(detectTimer);
    }
    detectTimer = setTimeout(detectMood, 600);
  });

  saveBtn?.addEventListener('click', async () => {
    const text = (textarea?.value || '').trim();
    if (!text) {
      setFeedback('Write a few words before saving.', 'error');
      return;
    }
    await detectMood();
    const mood = detectedMood || JOURNAL_MOODS[0];
    const newEntry = {
      id: (crypto?.randomUUID && crypto.randomUUID()) || `entry-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text,
      mood,
      createdAt: new Date().toISOString()
    };
    const entries = [...initialEntries, newEntry];
    await saveJournalEntries(entries);
    setFeedback('Entry saved.', 'success');
    if (textarea) textarea.value = '';
    detectedMood = JOURNAL_MOODS[0];
    lastAnalyzedText = '';
    updateAutoMoodDisplay(detectedMood);
    showJournal();
  });

  downloadBtn?.addEventListener('click', async () => {
    const entries = await getJournalEntries();
    if (!entries.length) {
      setFeedback('No entries to download yet.', 'error');
      return;
    }
    try {
      const blob = createJournalPdfBlob(entries);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'mindful-journal.pdf';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setFeedback('PDF downloaded.', 'success');
    } catch (error) {
      console.error('Failed to generate PDF:', error);
      setFeedback('Could not generate PDF right now.', 'error');
    }
  });

  sidebar.querySelectorAll('.journal-delete-btn').forEach(button => {
    button.addEventListener('click', async () => {
      const id = button.dataset.id;
      const entries = await getJournalEntries();
      const updated = entries.filter(entry => entry.id !== id);
      await saveJournalEntries(updated);
      showJournal();
    });
  });

  updateAutoMoodDisplay(detectedMood);
}

function formatJournalTimestamp(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function escapeHtml(value) {
  return (value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function createJournalPdfBlob(entries) {
  const lines = [];
  const sourceEntries = Array.isArray(entries) ? entries : [];
  if (!sourceEntries.length) {
    lines.push('No journal entries recorded.');
  } else {
    sourceEntries.forEach(entry => {
      const timestamp = formatJournalTimestamp(entry.createdAt);
      lines.push(`${timestamp} [${entry.mood}]`);
      const cleanedText = (entry.text || '').replace(/\r/g, '');
      if (cleanedText.includes('\n')) {
        cleanedText.split('\n').forEach(segment => lines.push(segment));
      } else {
        lines.push(cleanedText);
      }
      lines.push('');
    });
  }
  const sanitizeForPdf = (value = '') => value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
  const leading = 16;
  let contentStream = `BT\n/F1 12 Tf\n${leading} TL\n72 720 Td\n`;
  lines.forEach((rawLine, index) => {
    const sanitizedLine = sanitizeForPdf(rawLine);
    if (index === 0) {
      contentStream += `(${sanitizedLine}) Tj\n`;
      return;
    }
    if (!sanitizedLine) {
      contentStream += 'T*\n';
    } else {
      contentStream += `T* (${sanitizedLine}) Tj\n`;
    }
  });
  contentStream += 'ET';
  const encoder = new TextEncoder();
  const contentBytes = encoder.encode(contentStream);
  const header = '%PDF-1.4\n';
  const obj1 = '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n';
  const obj2 = '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n';
  const obj3 = '3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >> endobj\n';
  const obj4 = '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n';
  const obj5 = `5 0 obj << /Length ${contentBytes.length} >>\nstream\n${contentStream}\nendstream\nendobj\n`;
  const objects = [obj1, obj2, obj3, obj4, obj5];
  let pdf = header;
  let offsets = [];
  let position = encoder.encode(header).length;
  objects.forEach(obj => {
    offsets.push(position);
    pdf += obj;
    position += encoder.encode(obj).length;
  });
  const xrefStart = position;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  offsets.forEach(offset => {
    xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  });
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  pdf += xref + trailer;
  return new Blob([pdf], { type: 'application/pdf' });
}

function extractPageText() {
  const hostname = (window.location.hostname || '').toLowerCase();
  let fallbackCandidate = '';
  
const strategies = [
    { test: /(?:^|\.)youtube\.com$/, extractor: extractYouTubeContent },
    { test: /(?:^|\.)quora\.com$/, extractor: extractQuoraContent },
    { test: /(?:^|\.)reddit\.com$/, extractor: extractRedditContent },
    { test: /(?:^|\.)google\./, extractor: extractGoogleSearchContent },
    { test: /(?:^|\.)medium\.com$/, extractor: () => extractArticleSection('article') },
    { test: /(?:^|\.)wikipedia\.org$/, extractor: () => extractArticleSection('#content') }
  ];
  
  for (const { test, extractor } of strategies) {
    if (test.test(hostname)) {
      const specialized = sanitizeExtractedText(extractor());
      if (specialized && specialized.length >= 80) {
        return specialized;
      }
      if (specialized && !fallbackCandidate) {
        fallbackCandidate = specialized;
      }
    }
  }
  
  const genericText = sanitizeExtractedText(extractGenericPageText());
  if (genericText && genericText.length >= 80) {
    return genericText;
  }
  
  return fallbackCandidate || genericText || '';
}

function extractGenericPageText() {
  const bodyClone = document.body.cloneNode(true);
  const scripts = bodyClone.querySelectorAll('script, style, nav, header, footer, aside');
  scripts.forEach(el => el.remove());
  
  const mainContent = bodyClone.querySelector('main, article, [role="main"], #main-content') || bodyClone;
  return mainContent.innerText || mainContent.textContent || '';
}

function extractArticleSection(selector) {
  const node = document.querySelector(selector);
  if (!node) return '';
  return node.innerText || '';
}

function extractYouTubeContent() {
  if (!window.location.pathname.startsWith('/watch')) {
    return '';
  }
  
  const parts = [];
  const metadata = document.querySelector('ytd-watch-metadata');
  if (metadata) {
    const title = metadata.querySelector('h1') || metadata.querySelector('#title');
    if (title) {
      parts.push(title.innerText.trim());
    }
    
    const subtitle = metadata.querySelector('#subtitle');
    if (subtitle) {
      parts.push(subtitle.innerText.trim());
    }
  }
  
  const description = document.querySelector('ytd-watch-metadata #description') ||
    document.querySelector('#description-inline-expander');
  if (description) {
    parts.push(description.innerText.trim());
  }
  
  const chapterList = Array.from(document.querySelectorAll('ytd-engagement-panel-section-list-renderer ytd-macro-markers-list-item-renderer'));
  if (chapterList.length) {
    const chapters = chapterList.slice(0, 5).map(item => item.innerText.trim()).filter(Boolean);
    if (chapters.length) {
      parts.push(`Key Chapters:\n${chapters.join('\n')}`);
    }
  }
  
  const topComment = document.querySelector('ytd-comment-thread-renderer #content-text');
  if (topComment) {
    parts.push(`Top comment: ${topComment.innerText.trim()}`);
  }
  
  return parts.filter(Boolean).join('\n\n');
}

function extractQuoraContent() {
  const parts = [];
  const question = document.querySelector('div[data-testid="question_text"]') ||
    document.querySelector('div[data-testid="question_title"]') ||
    document.querySelector('h1');
  if (question) {
    parts.push(question.innerText.trim());
  }
  
  const detail = document.querySelector('div[data-testid="question_detail"]');
  if (detail) {
    parts.push(detail.innerText.trim());
  }
  
  const answerSelectors = [
    'div[data-testid="answer_content"]',
    'div.q-relative.spacing_log_answer_content',
    'div[data-testid="answer-content"]'
  ];
  const answers = [];
  for (const selector of answerSelectors) {
    if (answers.length >= 2) break;
    document.querySelectorAll(selector).forEach(node => {
      if (answers.length < 2) {
        const text = node.innerText.trim();
        if (text) {
          answers.push(text);
        }
      }
    });
  }
  answers.forEach((answer, index) => {
    parts.push(`Answer ${index + 1}:\n${answer}`);
  });
  
  return parts.filter(Boolean).join('\n\n');
}

function extractRedditContent() {
  const parts = [];
  const title = document.querySelector('h1');
  if (title) {
    parts.push(title.innerText.trim());
  }
  
  const post = document.querySelector('[data-test-id="post-content"]');
  if (post) {
    const body = post.querySelector('[data-click-id="text"]') || post;
    if (body) {
      parts.push(body.innerText.trim());
    }
  }
  
  const comments = Array.from(document.querySelectorAll('div[data-test-id="comment"] [data-click-id="text"]'))
    .map(node => node.innerText.trim())
    .filter(Boolean)
    .slice(0, 2);
  comments.forEach((comment, index) => {
    parts.push(`Comment ${index + 1}: ${comment}`);
  });
  
  return parts.filter(Boolean).join('\n\n');
}

function extractGoogleSearchContent() {
  if (!/google\./.test(window.location.hostname)) {
    return '';
  }
  const params = new URLSearchParams(window.location.search || '');
  const query = params.get('q') || '';
  const parts = [];
  if (query) {
    parts.push(`Search query: ${query}`);
  }
  const organicResults = document.querySelectorAll('div.g');
  organicResults.forEach(result => {
    const titleEl = result.querySelector('h3');
    const snippetEl = result.querySelector('.VwiC3b, .IsZvec');
    if (titleEl) {
      parts.push(titleEl.innerText.trim());
    }
    if (snippetEl) {
      parts.push(snippetEl.innerText.trim());
    }
  });
  const shoppingResults = document.querySelectorAll('[data-hveid] g-card, [data-hveid] .sh-dgr__content');
  shoppingResults.forEach(item => {
    const productTitle = item.querySelector('.sh-np__product-title, .tAxDx');
    const price = item.querySelector('.a8Pemb, .XrAfOe');
    if (productTitle) {
      parts.push(`Product: ${productTitle.innerText.trim()}${price ? ` - ${price.innerText.trim()}` : ''}`);
    }
  });
  const packed = parts.filter(Boolean).join('\n');
  if (packed.length < 80 && query) {
    return `Search query: ${query}`;
  }
  return packed;
}

function sanitizeExtractedText(text, maxLength = 8000) {
  if (!text) return '';
  const normalized = text
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (normalized.length > maxLength) {
    return normalized.slice(0, maxLength);
  }
  return normalized;
}

// Sidebar functions
function initSidebarResize(element, defaultWidth) {
  if (!element) return;
  
  if (!element.dataset.defaultWidth) {
    element.dataset.defaultWidth = defaultWidth;
  }
  if (!element.dataset.expandedWidth) {
    element.dataset.expandedWidth = defaultWidth;
  }
  
  const storedWidth = parseInt(element.dataset.expandedWidth, 10);
  if (!Number.isNaN(storedWidth)) {
    element.style.width = `${storedWidth}px`;
  }
  
  if (element.querySelector('.mindful-sidebar-resize-handle')) {
    return;
  }
  
  const handle = document.createElement('div');
  handle.className = 'mindful-sidebar-resize-handle';
  element.appendChild(handle);
  
  let isResizing = false;
  let startX = 0;
  let startWidth = 0;
  const body = document.body;
  
  const onMouseMove = (moveEvent) => {
    if (!isResizing) return;
    const delta = startX - moveEvent.clientX;
    let newWidth = startWidth + delta;
    newWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, newWidth));
    element.style.width = `${newWidth}px`;
    element.dataset.expandedWidth = newWidth;
  };
  
  const onMouseUp = () => {
    if (!isResizing) return;
    isResizing = false;
    element.dataset.expandedWidth = element.offsetWidth;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    if (body) {
      body.classList.remove('mindful-sidebar-resizing');
    }
  };
  
  handle.addEventListener('mousedown', (downEvent) => {
    if (element.classList.contains('collapsed')) {
      return;
    }
    
    isResizing = true;
    startX = downEvent.clientX;
    startWidth = element.offsetWidth;
    element.dataset.expandedWidth = startWidth;
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    if (body) {
      body.classList.add('mindful-sidebar-resizing');
    }
    downEvent.preventDefault();
    downEvent.stopPropagation();
  });
}

function collapseSidebarElement(element) {
    if (!element) return;
    const body = element.querySelector('.mindful-sidebar-body');
    const actions = element.querySelector('.mindful-sidebar-actions');
    const toggleBtn = element.querySelector('.mindful-sidebar-toggle');

    if (element.offsetWidth && !element.dataset.expandedWidth) {
        element.dataset.expandedWidth = element.offsetWidth;
    }

    if (body) body.style.display = 'none';
    if (actions) actions.style.display = 'none';
    if (toggleBtn) {
        toggleBtn.innerHTML = '<img src="icons/icon48.png" alt="Expand" class="sidebar-toggle-img" />';
        toggleBtn.title = 'Expand sidebar';
        toggleBtn.style.cursor = 'grab';
    }
    element.style.width = '60px'; 
    element.classList.add('collapsed');
    element.style.position = 'fixed';
    element.style.top = element.style.top || '0px';
    element.style.right = '0px';
    element.style.zIndex = 2147483647;
    element.classList.add('mindful-sidebar-collapsed');
}

function expandSidebarElement(element) {
    if (!element) return;
    const body = element.querySelector('.mindful-sidebar-body');
    const actions = element.querySelector('.mindful-sidebar-actions');
    const toggleBtn = element.querySelector('.mindful-sidebar-toggle');

    if (body) body.style.display = 'block';
    if (actions) actions.style.display = 'flex';
    if (toggleBtn) {
        toggleBtn.textContent = '−';
        toggleBtn.title = 'Collapse sidebar';
        toggleBtn.style.cursor = '';
    }
    element.classList.remove('collapsed');
    element.classList.remove('mindful-sidebar-collapsed');
    element.style.top = '0px';
    element.style.right = '0px';
    element.style.position = '';
    element.style.zIndex = '';
    const storedWidth = parseInt(element.dataset.expandedWidth || element.dataset.defaultWidth || '', 10);
    if (!Number.isNaN(storedWidth)) {
        element.style.width = `${storedWidth}px`;
    } else {
        element.style.width = '';
    }
}
function removeActiveOverlay() {
  if (currentOverlay && currentOverlay.classList && currentOverlay.classList.contains('mindful-overlay')) {
    currentOverlay.remove();
    currentOverlay = null;
  }
}

function removeCalmSidebars() {
  const sidebars = document.querySelectorAll('.mindful-sidebar');
  if (sidebars.length > 0) {
    sidebars.forEach(sidebar => {
      if (currentOverlay === sidebar) {
        currentOverlay = null;
      }
      sidebar.remove();
    });
  }
}

function closeExistingSidebars() {
  removeActiveOverlay();
  removeCalmSidebars();
  
  if (usefulnessBar) {
    const alreadyCollapsed = usefulnessBar.classList.contains('collapsed');
    collapseSidebarElement(usefulnessBar);
    if (!alreadyCollapsed) {
      usefulnessBarAutoCollapsed = true;
    }
  }
}

function restoreUsefulnessBar() {
  if (usefulnessBarAutoCollapsed && usefulnessBar) {
    expandSidebarElement(usefulnessBar);
  }
  usefulnessBarAutoCollapsed = false;
}

function showSidebar(title, content, theme = 'calm', actions = []) {
  closeExistingSidebars();
  
  const sidebar = document.createElement('div');
  sidebar.className = `mindful-sidebar mindful-${theme}`;
  
  const sidebarContent = `
    <div class="mindful-sidebar-header">
      <h3>${title}</h3>
      <div class="mindful-sidebar-controls">
        <button class="mindful-sidebar-toggle" title="Collapse sidebar">−</button>
        <button class="mindful-sidebar-close" title="Close">×</button>
      </div>
    </div>
    <div class="mindful-sidebar-body">
      ${content}
    </div>
    ${actions.length > 0 ? `
      <div class="mindful-sidebar-actions">
        ${actions.map(action => 
          `<button class="mindful-sidebar-btn" data-action="${action.action}">${action.label}</button>`
        ).join('')}
      </div>
    ` : ''}
  `;
  
  sidebar.innerHTML = sidebarContent;
  document.body.appendChild(sidebar);
  currentOverlay = sidebar;
  initSidebarResize(sidebar, CALM_SIDEBAR_DEFAULT_WIDTH);
  makeCollapsedSidebarDraggable(sidebar);
  
  // Add event listeners
  const toggleBtn = sidebar.querySelector('.mindful-sidebar-toggle');
  const closeBtn = sidebar.querySelector('.mindful-sidebar-close');
  toggleBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (sidebar.classList.contains('collapsed')) {
      expandSidebarElement(sidebar);
    } else {
      collapseSidebarElement(sidebar);
    }
  });
  
  closeBtn.addEventListener('click', () => {
    sidebar.remove();
    currentOverlay = null;
    restoreUsefulnessBar();
  });
  
  // Add action button listeners
  if (actions.length > 0) {
    sidebar.querySelectorAll('.mindful-sidebar-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        if (action === 'close') {
          sidebar.remove();
          currentOverlay = null;
          restoreUsefulnessBar();
          cancelFeatureRequest('calmSummarize');
          cancelFeatureRequest('journal');
        }
      });
    });
  }
}

function showLoadingSidebar(title, message) {
  const loadingContent = `
    <div class="loading-container">
      <div class="loading-spinner"></div>
      <p class="loading-message" id="calm-summary-loading-message">${message}</p>
    </div>
    <div class="loading-snippet" id="calm-summary-snippet" style="display:none;"></div>
  `;
  
  showSidebar(title, loadingContent, 'calm');
}

function hideLoadingSidebar() {
  if (currentOverlay) {
    currentOverlay.remove();
    currentOverlay = null;
    restoreUsefulnessBar();
  }
}

function showOverlay(options) {
  removeCalmSidebars();
  removeActiveOverlay();
  
  const overlay = document.createElement('div');
  overlay.className = `mindful-overlay mindful-${options.theme}`;
  
  const content = `
    <div class="mindful-overlay-content">
      <div class="mindful-overlay-header">
        <h2>${options.title}</h2>
        <div class="overlay-controls">
          <button class="mindful-toggle-btn" title="Collapse overlay">−</button>
          <button class="mindful-close-btn">×</button>
        </div>
      </div>
      <div class="mindful-overlay-body">
        <pre>${options.content}</pre>
      </div>
      <div class="mindful-overlay-actions">
        ${options.actions.map(action => 
          `<button class="mindful-action-btn" data-action="${action.action}">${action.label}</button>`
        ).join('')}
      </div>
    </div>
  `;
  
  overlay.innerHTML = content;
  
  // Add event listeners
  const closeBtn = overlay.querySelector('.mindful-close-btn');
  const toggleBtn = overlay.querySelector('.mindful-toggle-btn');
  const overlayBody = overlay.querySelector('.mindful-overlay-body');
  const overlayActions = overlay.querySelector('.mindful-overlay-actions');
  
  let isCollapsed = false;
  
  closeBtn.addEventListener('click', () => {
    overlay.remove();
    currentOverlay = null;
  });
  
  toggleBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    isCollapsed = !isCollapsed;
    if (isCollapsed) {
      overlayBody.style.display = 'none';
      overlayActions.style.display = 'none';
      toggleBtn.textContent = '+';
      toggleBtn.title = 'Expand overlay';
      overlay.classList.add('collapsed');
    } else {
      overlayBody.style.display = 'block';
      overlayActions.style.display = 'flex';
      toggleBtn.textContent = '−';
      toggleBtn.title = 'Collapse overlay';
      overlay.classList.remove('collapsed');
    }
  });
  
  overlay.querySelectorAll('.mindful-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      if (action === 'close') {
        overlay.remove();
        currentOverlay = null;
      } else if (action === 'snooze') {
        overlay.remove();
        currentOverlay = null;
        snoozedUrl = window.location.href;
        if (lowScoreTimer) {
          clearInterval(lowScoreTimer);
          lowScoreTimer = null;
        }
        consecutiveLowScores = 0;
        timeOnLowScorePage = 0;
        suppressedUrlForConsecutive = window.location.href;
      } else if (action === 'refocus') {
        // Show refocus message
        overlay.remove();
        currentOverlay = null;
        
        const refocusMessage = currentIntent 
          ? `Remember your goal: ${currentIntent}\n\nTake a deep breath and refocus. You've got this!\n\nConsider:\n- Going back to a useful page\n- Adjusting your search terms\n- Taking a short break`
          : 'Take a deep breath and refocus. You can do this!';
        
        showOverlay({
          title: 'Refocus',
          content: refocusMessage,
          theme: 'focus',
          actions: [
            { label: 'Got it!', action: 'close' }
          ]
        });
      }
    });
  });
  
  document.body.appendChild(overlay);
  currentOverlay = overlay;
}

function createBreathingOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'mindful-overlay mindful-calm mindful-breathing';
  
  overlay.innerHTML = `
    <div class="mindful-overlay-content">
      <div class="mindful-overlay-header">
        <h2>Breathing Exercise</h2>
        <button class="mindful-close-btn">×</button>
      </div>
      <div class="mindful-overlay-body">
        <div class="breathing-circle">
          <div class="breathing-inner"></div>
        </div>
        <div class="breathing-text">
          <h3 id="breathing-instruction">Breathe In</h3>
          <p id="breathing-countdown">4</p>
        </div>
        <div class="breathing-guidance">
          <p>Follow the circle as it expands and contracts</p>
          <p>Take your time, there's no rush</p>
        </div>
      </div>
      <div class="mindful-overlay-actions">
        <button class="mindful-action-btn" data-action="close">Finish</button>
      </div>
    </div>
  `;
  
  // Add close button listener
  overlay.querySelector('.mindful-close-btn').addEventListener('click', () => {
    overlay.remove();
    currentOverlay = null;
  });
  
  overlay.querySelector('.mindful-action-btn').addEventListener('click', () => {
    overlay.remove();
    currentOverlay = null;
  });
  
  return overlay;
}

function startBreathingAnimation(container) {
  const circle = container.querySelector('.breathing-circle');
  const instruction = container.querySelector('#breathing-instruction');
  const countdown = container.querySelector('#breathing-countdown');
  
  let phase = 'inhale'; // inhale, hold, exhale
  let count = 1;
  let isActive = true;
  
  const durationMap = {
    inhale: 4,
    hold: 3,
    exhale: 4
  };
  
  function nextPhase() {
    if (!isActive) return;
    
    if (phase === 'inhale') {
      circle.classList.remove('breathing-hold', 'breathing-out');
      circle.classList.add('breathing-in');
      instruction.textContent = 'Breathe In';
    } else if (phase === 'hold') {
      circle.classList.remove('breathing-in', 'breathing-out');
      circle.classList.add('breathing-hold');
      instruction.textContent = 'Hold';
    } else if (phase === 'exhale') {
      circle.classList.remove('breathing-in', 'breathing-hold');
      circle.classList.add('breathing-out');
      instruction.textContent = 'Breathe Out';
    }
    
    count = 1;
    countdown.textContent = count;
    
    const phaseDuration = durationMap[phase];
    const interval = setInterval(() => {
      if (!isActive) {
        clearInterval(interval);
        return;
      }
      
      count++;
      if (count > phaseDuration) {
        clearInterval(interval);
        if (phase === 'inhale') {
          phase = 'hold';
        } else if (phase === 'hold') {
          phase = 'exhale';
        } else if (phase === 'exhale') {
          phase = 'inhale';
        }
        nextPhase();
      } else {
        countdown.textContent = count;
      }
    }, 1000);
  }
  
  function stop() {
    isActive = false;
    circle.classList.remove('breathing-in', 'breathing-out', 'breathing-hold');
    circle.classList.add('start-state');
    instruction.textContent = 'Ready';
    countdown.textContent = '0';
  }
  
  nextPhase();
  
  return stop;
}

function initBreathingControls(container) {
  const startBtn = container.querySelector('#breathing-start');
  const stopBtn = container.querySelector('#breathing-stop');
  const circle = container.querySelector('.breathing-circle');
  const instruction = container.querySelector('#breathing-instruction');
  const countdown = container.querySelector('#breathing-countdown');
  
  let stopFn = null;
  let running = false;
  
  function setRunningState(state) {
    running = state;
    startBtn.disabled = state;
    stopBtn.disabled = !state;
  }
  
  startBtn.addEventListener('click', () => {
    if (running) return;
    circle.classList.remove('start-state');
    stopFn = startBreathingAnimation(container);
    setRunningState(true);
  });
  
  stopBtn.addEventListener('click', () => {
    if (!running) return;
    if (stopFn) {
      stopFn();
      stopFn = null;
    }
    setRunningState(false);
  });
  
  // Ensure default state
  circle.classList.add('start-state');
  instruction.textContent = 'Ready';
  countdown.textContent = '0';
  setRunningState(false);
}

function makeCollapsedSidebarDraggable(sidebar) {
    let isDragging = false;
    let startY = 0;
    let startTop = 0;

    const dragTarget = sidebar.querySelector('.mindful-sidebar-toggle') || sidebar;

    dragTarget.addEventListener('mousedown', function (e) {
        if (!sidebar.classList.contains('collapsed')) return;
        isDragging = true;
        startY = e.clientY;
        startTop = parseInt(sidebar.style.top || 0, 10);
        document.body.style.userSelect = 'none';
        dragTarget.style.cursor = 'grabbing';
        e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
        if (!isDragging) return;
        let newTop = startTop + (e.clientY - startY);
        newTop = Math.max(0, Math.min(window.innerHeight - sidebar.offsetHeight, newTop));
        sidebar.style.top = newTop + 'px';
    });

    document.addEventListener('mouseup', function () {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.userSelect = '';
        dragTarget.style.cursor = 'grab';
    });

    const observer = new MutationObserver(() => {
        if (!sidebar.classList.contains('collapsed')) {
            sidebar.style.top = '0px';
        }
    });
    observer.observe(sidebar, { attributes: true, attributeFilter: ['class'] });
}
