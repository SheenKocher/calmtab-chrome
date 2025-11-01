// Mindful Web extension page-bridge script
// Runs in the page context to access built-in Chrome AI APIs (Summarizer/Rewriter)
// Use of these APIs must comply with Google's Generative AI Prohibited Uses Policy.

(function () {
  const REQUEST_SOURCE = 'mindful-content-script';
  const RESPONSE_SOURCE = 'mindful-page-bridge';
  const SUMMARY_REQUEST = 'CALM_SUMMARY_REQUEST';
  const SUMMARY_RESULT = 'CALM_SUMMARY_RESULT';
  const SUMMARY_STATUS = 'CALM_SUMMARY_STATUS';
  const USEFULNESS_REQUEST = 'USEFULNESS_ASSESS_REQUEST';
  const USEFULNESS_RESULT = 'USEFULNESS_ASSESS_RESULT';
  const USEFULNESS_STATUS = 'USEFULNESS_ASSESS_STATUS';

  async function ensureSummarizer(options) {
    if (!('Summarizer' in globalThis)) {
      throw new Error('Summarizer API not available in page context');
    }

    const availability = typeof Summarizer.availability === 'function'
      ? await Summarizer.availability()
      : 'available';

    if (availability === 'unavailable') {
      throw new Error('Summarizer unavailable');
    }

    const createOptions = {
      type: options?.type || 'tldr',
      format: options?.format || 'plain-text',
      length: options?.length || 'long',
      sharedContext: options?.sharedContext || 'Provide mindful, calm summaries.',
      expectedInputLanguages: options?.expectedInputLanguages,
      outputLanguage: options?.outputLanguage,
      expectedContextLanguages: options?.expectedContextLanguages
    };

    if (typeof options?.monitor === 'function') {
      createOptions.monitor = options.monitor;
    }

    return await Summarizer.create(createOptions);
  }

  async function ensureRewriter(options) {
    if (!('Rewriter' in globalThis)) {
      throw new Error('Rewriter API not available in page context');
    }

    const availability = typeof Rewriter.availability === 'function'
      ? await Rewriter.availability()
      : 'available';

    if (availability === 'unavailable') {
      throw new Error('Rewriter unavailable');
    }

    const createOptions = options || {};

    if (typeof Rewriter.create === 'function') {
      return await Rewriter.create(createOptions);
    }

    // Some implementations expose rewrite directly on the constructor.
    if (typeof Rewriter.rewrite === 'function') {
      return {
        rewrite: (input, rewriteOptions) => Rewriter.rewrite(input, rewriteOptions)
      };
    }

    throw new Error('Unable to create rewriter instance');
  }

  function extractTextResult(result, fallbackKey) {
    if (!result) return '';
    if (typeof result === 'string') return result;
    if (typeof result[fallbackKey] === 'string') return result[fallbackKey];
    if (typeof result.output === 'string') return result.output;
    if (typeof result.result === 'string') return result.result;
    if (Array.isArray(result.results) && result.results.length) {
      return extractTextResult(result.results[0], fallbackKey);
    }
    if (typeof result.text === 'string') return result.text;
    return '';
  }

  function postStatus(requestId, message, type = SUMMARY_STATUS) {
    window.postMessage({
      source: RESPONSE_SOURCE,
      type,
      requestId,
      message
    }, '*');
  }

  function postResult(requestId, { success, payload, error }, type = SUMMARY_RESULT) {
    window.postMessage({
      source: RESPONSE_SOURCE,
      type,
      requestId,
      success: Boolean(success),
      payload: payload ?? null,
      error: error || null
    }, '*');
  }

  async function handleSummaryRequest(event) {
    const data = event.data;
    if (!data || data.source !== REQUEST_SOURCE || data.type !== SUMMARY_REQUEST) {
      return;
    }

    const { requestId, text, metadata } = data;

    if (typeof text !== 'string' || !text.trim()) {
      postResult(requestId, { success: false, error: 'No text provided for summarization.' });
      return;
    }

    try {
      postStatus(requestId, 'Checking built-in AI availability…');

      const monitor = (monitorTarget) => {
        if (!monitorTarget) return;
        monitorTarget.addEventListener('downloadprogress', (evt) => {
          const percentage = typeof evt.loaded === 'number'
            ? Math.round(evt.loaded * 100)
            : null;
          const progressMessage = percentage != null
            ? `Downloading on-device model… ${percentage}%`
            : 'Downloading on-device model…';
          postStatus(requestId, progressMessage);
        });
      };

      const summarizerOptions = {
        type: 'tldr',
        format: 'plain-text',
        length: 'long',
        sharedContext: 'Summarize articles for a mindful reader. Keep key facts, present calm, compassionate tone.',
        monitor
      };

      const summarizer = await ensureSummarizer(summarizerOptions);

      postStatus(requestId, 'Generating quick overview…');
      const summarizerContext = metadata?.intent
        ? `User goal: ${metadata.intent}. Use gentle, reassuring language.`
        : 'Use a gentle, reassuring tone and include key facts.';

      const baseSummary = await summarizer.summarize(text, {
        context: summarizerContext
      });

      let finalSummary = baseSummary;
      let mode = 'summarizer';

      if (typeof finalSummary === 'object' && finalSummary?.summary) {
        finalSummary = finalSummary.summary;
      }

      if (typeof finalSummary === 'string' && finalSummary.trim() && ('Rewriter' in globalThis)) {
        try {
          postStatus(requestId, 'Softening tone for calm delivery…');
          const rewriter = await ensureRewriter();
          const rewriteResponse = await rewriter.rewrite(finalSummary, {
            context: 'Rewrite this summary in a gentle, compassionate tone. Keep every factual detail. Use short paragraphs. Wrap the most important factual sentences in <strong> tags.'
          });
          if (typeof rewriteResponse === 'string') {
            finalSummary = rewriteResponse;
            mode = 'summarizer+rewriter';
          } else if (rewriteResponse?.rewritten) {
            finalSummary = rewriteResponse.rewritten;
            mode = 'summarizer+rewriter';
          }
        } catch (rewriteError) {
          postStatus(requestId, `Rewriter unavailable (${rewriteError.message}). Using summarizer result.`);
        }
      }

      postResult(requestId, {
        success: true,
        payload: {
          summary: typeof finalSummary === 'string' ? finalSummary : String(finalSummary || ''),
          mode,
          metadata: {
            availabilityChecked: true,
            title: metadata?.title || document.title || '',
            url: metadata?.url || location.href
          }
        }
      }, SUMMARY_RESULT);
    } catch (error) {
      postResult(requestId, {
        success: false,
        error: error?.message || 'Unknown error during summarization.'
      }, SUMMARY_RESULT);
    }
  }

  async function ensurePromptSession(options) {
    if (!('Prompt' in globalThis)) {
      throw new Error('Prompt API not available in page context');
    }
    const availability = typeof Prompt.availability === 'function'
      ? await Prompt.availability()
      : 'available';
    if (availability === 'unavailable') {
      throw new Error('Prompt API unavailable');
    }
    if (typeof Prompt.create === 'function') {
      return await Prompt.create(options || {});
    }
    if (typeof Prompt.prompt === 'function') {
      return {
        prompt: (input) => Prompt.prompt(input)
      };
    }
    throw new Error('Unable to initialize Prompt session.');
  }

  function sanitizeJsonString(value) {
    if (typeof value !== 'string') return '';
    return value
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
  }

  function formatUsefulnessAssessment(parsed) {
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid assessment payload');
    }
    const scoreNumeric = Math.max(0, Math.min(10, Number(parsed.score)));
    const score = Number.isFinite(scoreNumeric) ? Math.round(scoreNumeric) : 'N/A';
    const explanation = (parsed.explanation || '').toString().trim() || 'No explanation provided.';
    const pointsArray = Array.isArray(parsed.relevant)
      ? parsed.relevant.map(item => item.toString().trim()).filter(Boolean)
      : [];
    const bulletSection = pointsArray.length
      ? pointsArray.map(point => `- ${point}`).join('\n')
      : '- No directly relevant points found.';
    return {
      assessmentText: `Score: ${score}/10\nExplanation: ${explanation}\nRelevant Information:\n${bulletSection}`,
      numericScore: scoreNumeric
    };
  }

  async function handleUsefulnessRequest(event) {
    const data = event.data;
    if (!data || data.source !== REQUEST_SOURCE || data.type !== USEFULNESS_REQUEST) {
      return;
    }
    const { requestId, text, metadata } = data;
    if (typeof text !== 'string' || !text.trim()) {
      postResult(requestId, { success: false, error: 'No content provided for assessment.' }, USEFULNESS_RESULT);
      return;
    }
    try {
      postStatus(requestId, 'Preparing quick assessment…', USEFULNESS_STATUS);
      const session = await ensurePromptSession();
      postStatus(requestId, 'Reviewing page content…', USEFULNESS_STATUS);
      const intent = metadata?.intent || '';
      const scoringPrompt = `You are evaluating how useful a web page is for a user's goal.

User goal: "${intent}"
Page title: ${metadata?.title || document.title || ''}
Page URL: ${metadata?.url || location.href}

Assess the usefulness scored from 0-10 where 10 is highly useful. Focus on helping the user accomplish their goal. Consider if the content is educational, actionable, or closely aligned with the goal. If not, explain why.

Return ONLY valid JSON with this schema:
{
  "score": <number 0-10>,
  "explanation": "<short explanation>",
  "relevant": ["<bullet point>", "..."]
}

Page content (truncated):
${text.substring(0, 3500)}
`;
      let promptResult;
      try {
        promptResult = await session.prompt({ input: scoringPrompt });
      } catch (promptError) {
        promptResult = await session.prompt(scoringPrompt);
      }
      const rawOutput = extractTextResult(promptResult, 'output');
      const cleaned = sanitizeJsonString(rawOutput);
      let parsed = null;
      try {
        parsed = JSON.parse(cleaned);
      } catch (jsonError) {
        throw new Error('Unable to parse Prompt API response as JSON.');
      }
      const formatted = formatUsefulnessAssessment(parsed);
      postResult(requestId, {
        success: true,
        payload: {
          assessmentText: formatted.assessmentText,
          numericScore: formatted.numericScore || null,
          mode: 'prompt'
        }
      }, USEFULNESS_RESULT);
    } catch (error) {
      postResult(requestId, {
        success: false,
        error: error?.message || 'Unknown error during usefulness assessment.'
      }, USEFULNESS_RESULT);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    handleSummaryRequest(event);
    handleUsefulnessRequest(event);
  }, false);
})();
