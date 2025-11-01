
let currentMode = 'calm';
let browsingIntent = '';

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setupEventListeners();
  updateModeDisplay();
});

async function loadSettings() {
  try {
    const result = await chrome.storage.local.get(['mode', 'browsingIntent']);
    
    if (result.mode) {
      currentMode = result.mode;
    }
    
    if (result.browsingIntent) {
      browsingIntent = result.browsingIntent;
      document.getElementById('browsingIntent').value = browsingIntent;
    }
    
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

// Setup event listeners
function setupEventListeners() {
  document.getElementById('calmMode').addEventListener('click', () => switchMode('calm'));
  document.getElementById('focusMode').addEventListener('click', () => switchMode('focus'));

  document.getElementById('calmSummarize').addEventListener('click', () => executeFeature('calmSummarize'));
  document.getElementById('breathe').addEventListener('click', () => executeFeature('breathe'));
  document.getElementById('journal').addEventListener('click', () => executeFeature('journal'));

  document.getElementById('setIntent').addEventListener('click', setBrowsingIntent);

  const intentInput = document.getElementById('browsingIntent');
  const setIntentBtn = document.getElementById('setIntent');
  if (intentInput && setIntentBtn) {
      intentInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') 
      {
          event.preventDefault();
          setIntentBtn.click();
      }
      });
  }
}

async function switchMode(mode) {
  currentMode = mode;
  await chrome.storage.local.set({ mode: currentMode });
  updateModeDisplay();
  
  // Notify content script of mode change
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    try {
      await sendMessageWithRetry(tab.id, {
        action: 'updateIntent',
        intent: browsingIntent,
        mode: currentMode
      });
    } catch (error) {
      console.warn('Could not notify content script of mode change:', error);
    }
  }
  
  showStatus(`${mode === 'calm' ? 'Calm' : 'Focus'} mode activated`, 'success');
}

function updateModeDisplay() {
  const calmBtn = document.getElementById('calmMode');
  const focusBtn = document.getElementById('focusMode');
  const calmFeatures = document.getElementById('calmFeatures');
  const focusFeatures = document.getElementById('focusFeatures');
  
  if (currentMode === 'calm') {
    calmBtn.classList.add('active');
    focusBtn.classList.remove('active');
    calmFeatures.classList.remove('hidden');
    focusFeatures.classList.add('hidden');
  } else {
    calmBtn.classList.remove('active');
    focusBtn.classList.add('active');
    calmFeatures.classList.add('hidden');
    focusFeatures.classList.remove('hidden');
  }
}

async function setBrowsingIntent() {
  const intentInput = document.getElementById('browsingIntent');
  browsingIntent = intentInput.value.trim();
  
  if (!browsingIntent) {
    showStatus('Please enter your browsing intent', 'error');
    return;
  }
  
  await chrome.storage.local.set({ browsingIntent });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    try {
      await sendMessageWithRetry(tab.id, {
        action: 'updateIntent',
        intent: browsingIntent,
        mode: currentMode
      });
    } catch (error) {
      console.warn('Could not notify content script of intent update:', error);
    }
  }
  
  showStatus('Intent set successfully!', 'success');
}

async function executeFeature(feature) {
  try {
    showStatus('Processing...', 'info');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab) {
      showStatus('No active tab found', 'error');
      return;
    }

    const isContentScriptReady = await checkContentScriptReady(tab.id);
    if (!isContentScriptReady) {
      showStatus('Content script not ready. Please refresh the page and try again.', 'error');
      return;
    }

    const response = await sendMessageWithRetry(tab.id, {
      action: 'executeFeature',
      feature: feature,
      mode: currentMode,
      browsingIntent: browsingIntent
    });
    
    if (response?.cancelled) {
      showStatus('Request cancelled', 'info');
    } else if (response && response.success) {
      showStatus(response.message || 'Done!', 'success');
    } else {
      showStatus(response?.error || response?.message || 'Failed to execute', 'error');
    }
  } catch (error) {
    console.error('Error executing feature:', error);
    if (error.message.includes('Could not establish connection')) {
      showStatus('Extension not ready. Please refresh the page and try again.', 'error');
    } else {
      showStatus('Error: ' + error.message, 'error');
    }
  }
}

async function checkContentScriptReady(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return response && response.ready === true;
  } catch (error) {
    return false;
  }
}

async function sendMessageWithRetry(tabId, message, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      return response;
    } catch (error) {
      if (i === maxRetries - 1) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

function showStatus(message, type) {
  const statusEl = document.getElementById('status');
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.classList.remove('hidden');
  
  setTimeout(() => {
    statusEl.classList.add('hidden');
  }, 3000);
}
