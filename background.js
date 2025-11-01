// Background service worker for Mindful Web extension
// Handles AI interactions for usefulness scores and calm features

let cachedLanguageModel = null;
let cachedAvailability = null;
let modelInitPromise = null;

let cachedSummarizer = null;
let summarizerAvailability = null;
let summarizerInitPromise = null;

let cachedRewriter = null;
let rewriterAvailability = null;
let rewriterInitPromise = null;

const JOURNAL_MOOD_OPTIONS = ['Calm', 'Grateful', 'Productive', 'Stressed', 'Hopeful', 'Low', 'Reflective', 'Proud', 'Conflicted'];

function setupContextMenus() {
  if (!chrome?.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'calmSummarize',
      title: 'Calmly Summarize',
      contexts: ['page', 'selection']
    });
  });
}

async function ensureLanguageModel() {
  if (!('LanguageModel' in self)) {
    throw new Error('LanguageModel API not available. Make sure AI flags are enabled in chrome://flags');
  }
  
  if (cachedLanguageModel) {
    return cachedLanguageModel;
  }
  
  if (!modelInitPromise) {
    modelInitPromise = (async () => {
      cachedAvailability = await LanguageModel.availability();
      if (cachedAvailability !== 'available') {
        throw new Error(`LanguageModel not available. Status: ${cachedAvailability}`);
      }
      cachedLanguageModel = await LanguageModel.create({ output: { language: 'en' } });
      return cachedLanguageModel;
    })().catch(error => {
      cachedLanguageModel = null;
      cachedAvailability = null;
      modelInitPromise = null;
      throw error;
    });
  }
  
  return modelInitPromise;
}

async function ensureSummarizer() {
  const chromeAi = typeof chrome !== 'undefined' ? chrome.ai : undefined;
  const aiNamespace = self.ai || chromeAi;
  const summarizerFactory = aiNamespace?.summarizer;
  if (!summarizerFactory) {
    throw new Error('Summarizer API not available.');
  }
  if (cachedSummarizer) {
    return cachedSummarizer;
  }
  if (!summarizerInitPromise) {
    summarizerInitPromise = (async () => {
      const availabilityFn = typeof summarizerFactory.availability === 'function'
        ? summarizerFactory.availability.bind(summarizerFactory)
        : null;
      if (availabilityFn) {
        summarizerAvailability = await availabilityFn();
        if (summarizerAvailability !== 'available') {
          throw new Error(`Summarizer not available. Status: ${summarizerAvailability}`);
        }
      }
      let instance = null;
      if (typeof summarizerFactory.create === 'function') {
        instance = await summarizerFactory.create({ type: 'long_document' });
      } else if (typeof summarizerFactory.summarize === 'function') {
        instance = summarizerFactory;
      }
      if (!instance || typeof instance.summarize !== 'function') {
        throw new Error('Unable to initialize Summarizer instance.');
      }
      cachedSummarizer = instance;
      return cachedSummarizer;
    })().catch(error => {
      cachedSummarizer = null;
      summarizerAvailability = null;
      summarizerInitPromise = null;
      throw error;
    });
  }
  return summarizerInitPromise;
}

async function ensureRewriter() {
  const chromeAi = typeof chrome !== 'undefined' ? chrome.ai : undefined;
  const aiNamespace = self.ai || chromeAi;
  const rewriterFactory = aiNamespace?.rewriter;
  if (!rewriterFactory) {
    throw new Error('Rewriter API not available.');
  }
  if (cachedRewriter) {
    return cachedRewriter;
  }
  if (!rewriterInitPromise) {
    rewriterInitPromise = (async () => {
      const availabilityFn = typeof rewriterFactory.availability === 'function'
        ? rewriterFactory.availability.bind(rewriterFactory)
        : null;
      if (availabilityFn) {
        rewriterAvailability = await availabilityFn();
        if (rewriterAvailability !== 'available') {
          throw new Error(`Rewriter not available. Status: ${rewriterAvailability}`);
        }
      }
      let instance = null;
      if (typeof rewriterFactory.create === 'function') {
        instance = await rewriterFactory.create();
      } else if (typeof rewriterFactory.rewrite === 'function') {
        instance = rewriterFactory;
      }
      if (!instance || typeof instance.rewrite !== 'function') {
        throw new Error('Unable to initialize Rewriter instance.');
      }
      cachedRewriter = instance;
      return cachedRewriter;
    })().catch(error => {
      cachedRewriter = null;
      rewriterAvailability = null;
      rewriterInitPromise = null;
      throw error;
    });
  }
  return rewriterInitPromise;
}

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'assessUsefulness') {
    // AI API calls must be made from the service worker
    assessPageUsefulness(request.intent, request.pageText, request.pageTitle, request.pageUrl)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep message channel open for async response
  }
  
  if (request.action === 'summarizePage') {
    summarizePage(request.pageText)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'classifyJournalMood') {
    classifyJournalMood(request.text, request.moods)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  
});

// Assess page usefulness using Chrome AI API
async function assessPageUsefulness(intent, pageText, pageTitle = '', pageUrl = '') {
  try {
    console.log('Ensuring LanguageModel is available...');
    const lm = await ensureLanguageModel();
    
    const prompt = `You are evaluating how useful a web page is for a user's stated goal. The user's input may contain typos; infer the intended meaning.

User goal: "${intent}"
Page title: ${pageTitle}
Page URL: ${pageUrl}

Consider the page type (overview, tutorial, documentation, news, shopping, entertainment, educational video) and whether it directly helps the user make concrete progress toward their goal.

Scoring rubric (0-10):
- 9-10: Highly on-topic and actionable for the goal (e.g., tutorials, guides, docs, educational videos, or canonical overviews that would be a sensible first stop like Wikipedia/intro docs when the goal is to learn the topic).
- 7-8: On-topic and informative but less actionable or narrowly scoped (e.g., educational videos that are relevant but may be too advanced/basic).
- 4-6: Tangential, partial relevance, or too shallow to be directly useful.
- 1-3: Mostly irrelevant, clickbait, or off-topic for the stated goal.
- 0: Completely unrelated or empty content.

Special considerations:
- Educational videos (YouTube, etc.) should be scored highly if they directly relate to the learning goal
- Video titles and descriptions are key indicators of educational value
- Look for keywords in titles that match the user's learning intent

Analyze up to the first 4000 characters of visible text:
Page content (truncated): ${pageText.substring(0, 4000)}

Provide your response in this EXACT format:
Score: X/10
Explanation: [1-2 sentences referencing the goal and page type]
Relevant Information:
- [Only list bullet points that directly help the user with their goal. If none, write "No directly relevant points found."]
- [bullet point 2]
- [bullet point 3]
`;

    console.log('Calling lm.prompt...');
    const assessment = await lm.prompt(prompt);
    
    console.log('Received assessment from AI:', assessment);
    return { success: true, assessment };
  } catch (error) {
    console.error('Error in assessPageUsefulness:', error);
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    throw error;
  }
}

// Summarize page using Chrome AI API with calming approach
const CALM_SUMMARY_MAX_INPUT = 1800;

function truncateContentForSummary(text = '', maxLength = CALM_SUMMARY_MAX_INPUT) {
  if (typeof text !== 'string') return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

function extractTextResult(result, fallbackKey) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (typeof result[fallbackKey] === 'string') return result[fallbackKey];
  if (result.output && typeof result.output === 'string') return result.output;
  if (result.result && typeof result.result === 'string') return result.result;
  if (Array.isArray(result.results) && result.results.length) {
    const candidate = result.results[0];
    return extractTextResult(candidate, fallbackKey);
  }
  return '';
}

function ensureBoldHighlights(summary = '') {
  if (typeof summary !== 'string' || !summary.trim()) return summary;
  const normalised = convertMarkdownBoldToStrong(summary);
  if (/<strong>/i.test(normalised)) {
    return normalised;
  }
  const sentences = normalised.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (!sentences.length) {
    return `<strong>${normalised}</strong>`;
  }
  const highlighted = sentences.map((sentence, index) => {
    if (index === 0 || /(\d|\bkey\b|\bimportant\b|\bfact\b)/i.test(sentence)) {
      return `<strong>${sentence.trim()}</strong>`;
    }
    return sentence;
  });
  return highlighted.join(' ');
}

function convertMarkdownBoldToStrong(text = '') {
  if (typeof text !== 'string' || !text.includes('**')) {
    return text;
  }
  return text.replace(/\*\*(.+?)\*\*/gs, (_match, inner) => `<strong>${inner.trim()}</strong>`);
}

async function rewriteSummaryCalmly(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return text;
  }
  try {
    const rewriter = await ensureRewriter();
    const instructions = 'Rewrite this summary in a gentle, compassionate tone. Keep every factual detail. Use short paragraphs. Wrap the most important factual sentences in <strong> tags.';
    let rewriteResult = null;
    try {
      rewriteResult = await rewriter.rewrite({
        input: text,
        instructions
      });
    } catch (error) {
      rewriteResult = await rewriter.rewrite({
        text,
        instruction: instructions
      });
    }
    const rewritten = extractTextResult(rewriteResult, 'rewritten');
    if (rewritten && rewritten.trim()) {
      return rewritten.trim();
    }
  } catch (error) {
    console.warn('Rewriter pipeline not available, using base summary.', error);
  }
  return text;
}

async function generateHybridCalmSummary(pageText) {
  const summarizer = await ensureSummarizer();
  const trimmed = truncateContentForSummary(pageText);
  if (!trimmed) {
    throw new Error('No content available for summary.');
  }
  let summaryResult = null;
  const summarizerContext = 'Summarize this webpage for someone feeling overwhelmed. Include key points, data, and cautions.';
  try {
    summaryResult = await summarizer.summarize({
      input: trimmed,
      context: summarizerContext
    });
  } catch (error) {
    try {
      summaryResult = await summarizer.summarize({
        text: trimmed,
        context: summarizerContext
      });
    } catch (secondaryError) {
      summaryResult = await summarizer.summarize(trimmed);
    }
  }
  const rawSummary = extractTextResult(summaryResult, 'summary');
  if (!rawSummary || !rawSummary.trim()) {
    throw new Error('Summarizer returned empty result.');
  }
  const calmSummary = await rewriteSummaryCalmly(rawSummary);
  return ensureBoldHighlights(calmSummary.trim());
}

async function summarizePage(pageText) {
  try {
    try {
      const hybridSummary = await generateHybridCalmSummary(pageText);
      if (hybridSummary && hybridSummary.trim()) {
        return { success: true, summary: hybridSummary };
      }
    } catch (hybridError) {
      console.warn('Hybrid summarizer pipeline unavailable, falling back to LanguageModel.', hybridError);
    }
    const lm = await ensureLanguageModel();
    
    const prompt = `You are a gentle, calming assistant helping someone who feels overwhelmed by news or information. Your role is to provide a soothing, peaceful summary that helps them feel centered and calm.

Please create a gentle summary of the following content. Use a warm, compassionate tone that:
- Softens harsh or distressing information
- Focuses on hope, resilience, and positive aspects where possible
- Uses gentle, calming language
- Acknowledges the complexity of situations with empathy
- Provides a sense of perspective and peace
- Does not miss any important information from the page
- Wrap the most important factual sentences from the content in <strong> tags so they stand out and are bolded. 

Content to summarize (first 3000 characters):
${pageText.substring(0, 3000)}

Create a calming summary that helps the reader feel more peaceful and centered. Use gentle language and focus on understanding, compassion, and hope.`;

    const summary = await lm.prompt(prompt);
    
    const formatted = ensureBoldHighlights(summary);
    return { success: true, summary: formatted };
  } catch (error) {
    console.error('Error in summarizePage:', error);
    throw error;
  }
}

async function classifyJournalMood(text = '', moods = []) {
  try {
    const lm = await ensureLanguageModel();
    const availableMoods = Array.isArray(moods) && moods.length ? moods : JOURNAL_MOOD_OPTIONS;
    const prompt = `Pick the single most appropriate mood from this list: ${availableMoods.join(', ')}.
Only return the mood word with no punctuation.

Entry:
"""
${text}
"""`;
    const response = await lm.prompt(prompt);
    const mood = extractMoodFromResponse(response, availableMoods);
    return { success: true, mood };
  } catch (error) {
    console.error('Error classifying journal mood:', error);
    return { success: false, error: error.message };
  }
}

function extractMoodFromResponse(response, moods) {
  const cleaned = (response || '').trim().toLowerCase();
  if (!cleaned) return moods[0] || JOURNAL_MOOD_OPTIONS[0];
  const match = moods.find(mood => cleaned === mood.toLowerCase())
    || moods.find(mood => cleaned.includes(mood.toLowerCase()));
  return match || moods[0] || JOURNAL_MOOD_OPTIONS[0];
}

// Initialize extension
chrome.runtime.onInstalled.addListener(() => {
  console.log('Mindful Web extension installed');
  chrome.action.setBadgeText({ text: '' });
  setupContextMenus();
});

chrome.runtime.onStartup?.addListener(() => {
  setupContextMenus();
});

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'calmSummarize' || !tab?.id) {
    return;
  }
  try {
    const stored = await chrome.storage.local.get(['browsingIntent']);
    await chrome.tabs.sendMessage(tab.id, {
      action: 'executeFeature',
      feature: 'calmSummarize',
      mode: 'calm',
      browsingIntent: stored.browsingIntent || ''
    });
  } catch (error) {
    console.warn('Unable to trigger calm summarize from context menu:', error);
  }
});
