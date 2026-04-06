/**
 * ElectionSentiment - Common Utilities
 * Shared utilities for all content scripts.
 * Kerala 2026 Election Sentiment Collection
 */

const LOG_PREFIX = '[ElectionSentiment]';

// --- State ---
let EXTRACTION_ACTIVE = true;
let extractionCount = 0;
const MAX_POSTS_PER_SESSION = 100;
const processedUrls = new Set();

// --- Kerala election keywords ---
const KERALA_KEYWORDS = [
  'election', 'vote', 'voting', 'ballot', 'poll', 'polls',
  'kerala', 'ldf', 'udf', 'nda',
  'bjp', 'cpm', 'cpi', 'congress', 'inc', 'iuml',
  'pinarayi', 'vijayan', 'sudhakaran', 'chennithala',
  'candidate', 'constituency', 'mla', 'assembly',
  'communist', 'marxist',
  'ernakulam', 'kochi', 'kalamassery', 'thrissur', 'kozhikode',
  'thiruvananthapuram', 'kollam', 'alappuzha', 'kannur',
  'left front', 'united democratic', 'national democratic',
  'manifesto', 'campaign', 'rally',
];

const MALAYALAM_RANGE = /[\u0D00-\u0D7F]/;

/**
 * Safely extract text content from a DOM element.
 * @param {Element|null} element
 * @returns {string}
 */
function extractTextContent(element) {
  try {
    if (!element) return '';
    return (element.textContent || element.innerText || '').trim();
  } catch (e) {
    console.warn(LOG_PREFIX, 'extractTextContent error:', e.message);
    return '';
  }
}

/**
 * Send extracted posts to the background service worker.
 * @param {Object|Object[]} data - post or array of posts
 */
function sendToBackground(data) {
  try {
    if (!EXTRACTION_ACTIVE) {
      console.log(LOG_PREFIX, 'Extraction paused, skipping send.');
      return;
    }
    const posts = Array.isArray(data) ? data : [data];
    if (posts.length === 0) return;

    chrome.runtime.sendMessage({ type: 'NEW_POSTS', data: posts }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn(LOG_PREFIX, 'sendToBackground error:', chrome.runtime.lastError.message);
      } else {
        console.log(LOG_PREFIX, `Sent ${posts.length} post(s) to background.`);
      }
    });
  } catch (e) {
    console.warn(LOG_PREFIX, 'sendToBackground error:', e.message);
  }
}

/**
 * Create a MutationObserver for infinite scroll pages.
 * Calls extractFn when new content appears in the container,
 * debounced to max once per 5 seconds with random jitter (3-8s).
 *
 * @param {Function} extractFn - function to call when new content detected
 * @param {string} containerSelector - CSS selector for the scroll container
 * @returns {MutationObserver|null}
 */
function createObserver(extractFn, containerSelector) {
  let debounceTimer = null;
  let lastRun = 0;

  function scheduleExtraction() {
    if (debounceTimer) return;

    const now = Date.now();
    const elapsed = now - lastRun;
    const minDelay = 5000;
    // Random jitter between 3-8 seconds
    const jitter = 3000 + Math.random() * 5000;
    const delay = Math.max(minDelay - elapsed, 0) + jitter;

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      lastRun = Date.now();
      if (EXTRACTION_ACTIVE && extractionCount < MAX_POSTS_PER_SESSION) {
        try {
          extractFn();
        } catch (e) {
          console.warn(LOG_PREFIX, 'Observer extractFn error:', e.message);
        }
      }
    }, delay);
  }

  try {
    const container = document.querySelector(containerSelector) || document.body;

    const observer = new MutationObserver((mutations) => {
      const hasAddedNodes = mutations.some(
        (m) => m.addedNodes && m.addedNodes.length > 0
      );
      if (hasAddedNodes) {
        scheduleExtraction();
      }
    });

    observer.observe(container, { childList: true, subtree: true });
    console.log(LOG_PREFIX, `Observer attached to "${containerSelector}" (or body).`);
    return observer;
  } catch (e) {
    console.warn(LOG_PREFIX, 'createObserver error:', e.message);
    return null;
  }
}

/**
 * Check if text contains Kerala election related content.
 * @param {string} text
 * @returns {boolean}
 */
function isRelevantPost(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  // Check for Malayalam unicode characters
  if (MALAYALAM_RANGE.test(text)) return true;

  // Check for Kerala election keywords
  return KERALA_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Extract engagement metrics from an element using provided selectors.
 * @param {Element} element - parent element to search within
 * @param {Object} selectors - { likes: 'selector', retweets: 'selector', ... }
 * @returns {Object} engagement counts
 */
function getEngagement(element, selectors) {
  const engagement = {};
  if (!element || !selectors) return engagement;

  try {
    for (const [metric, selector] of Object.entries(selectors)) {
      const el = element.querySelector(selector);
      if (el) {
        const rawText = extractTextContent(el);
        // Also check aria-label for hidden text counts
        const ariaLabel = el.getAttribute('aria-label') || '';
        const text = rawText || ariaLabel;
        const match = text.match(/([\d,.]+[kKmM]?)/);
        if (match) {
          engagement[metric] = parseCount(match[1]);
        } else {
          engagement[metric] = 0;
        }
      }
    }
  } catch (e) {
    console.warn(LOG_PREFIX, 'getEngagement error:', e.message);
  }

  return engagement;
}

/**
 * Parse abbreviated counts like "1.2k", "3M" into numbers.
 * @param {string} str
 * @returns {number}
 */
function parseCount(str) {
  if (!str) return 0;
  str = str.replace(/,/g, '').trim();
  const lower = str.toLowerCase();
  if (lower.endsWith('k')) {
    return Math.round(parseFloat(lower) * 1000);
  }
  if (lower.endsWith('m')) {
    return Math.round(parseFloat(lower) * 1000000);
  }
  return parseInt(lower, 10) || 0;
}

/**
 * Create a standardized post object.
 * @param {string} text
 * @param {string} platform
 * @param {Object} engagement
 * @param {string} url
 * @param {string|number|null} timestamp
 * @returns {Object}
 */
function formatPost(text, platform, engagement, url, timestamp) {
  return {
    text: (text || '').substring(0, 5000), // cap text length
    platform,
    engagement: engagement || {},
    url: url || '',
    timestamp: timestamp || null,
    extractedAt: Date.now(),
  };
}

/**
 * Register a post URL as processed and increment count.
 * Returns false if already processed or limit reached.
 * @param {string} url
 * @returns {boolean} true if post can be processed
 */
function trackPost(url) {
  if (extractionCount >= MAX_POSTS_PER_SESSION) {
    console.log(LOG_PREFIX, 'Session extraction limit reached.');
    return false;
  }
  if (processedUrls.has(url)) return false;
  processedUrls.add(url);
  extractionCount++;
  return true;
}

/**
 * Check if an element is within the current viewport.
 * @param {Element} element
 * @returns {boolean}
 */
function isInViewport(element) {
  try {
    const rect = element.getBoundingClientRect();
    return (
      rect.top < window.innerHeight &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0
    );
  } catch (e) {
    return false;
  }
}

// Auto-scroll for search results pages
// Scrolls at human-like pace, extracts as it goes
function autoScroll(options = {}) {
  const { maxScrolls = 15, intervalMs = 3000, jitterMs = 2000, onComplete } = options;
  let scrollCount = 0;

  const timer = setInterval(() => {
    if (!EXTRACTION_ACTIVE || scrollCount >= maxScrolls) {
      clearInterval(timer);
      if (onComplete) onComplete();
      console.log(`${LOG_PREFIX} Auto-scroll complete after ${scrollCount} scrolls`);
      return;
    }

    // Scroll by a random amount (300-800px) to look human
    const scrollAmount = 300 + Math.random() * 500;
    window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
    scrollCount++;
  }, intervalMs + Math.random() * jitterMs);

  return timer; // return so it can be cancelled
}

// Extract and format individual comments from a post
function extractCommentElements(commentElements, platform) {
  const comments = [];
  commentElements.forEach(el => {
    const text = extractTextContent(el);
    if (text && text.length > 5 && isRelevantPost(text)) {
      comments.push({
        text: text.substring(0, 500),
        platform,
        type: 'comment',
        engagement: 0,
        extractedAt: Date.now()
      });
    }
  });
  return comments;
}

// --- Background message listener ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (message.type === 'TOGGLE_EXTRACTION') {
      EXTRACTION_ACTIVE = !!message.active;
      console.log(LOG_PREFIX, `Extraction ${EXTRACTION_ACTIVE ? 'activated' : 'paused'}.`);
      sendResponse({ success: true, active: EXTRACTION_ACTIVE });
    } else if (message.type === 'START_COLLECTION') {
      EXTRACTION_ACTIVE = true;
      console.log(LOG_PREFIX, 'Collection started, beginning auto-scroll.');
      autoScroll({
        maxScrolls: message.maxScrolls || 15,
        intervalMs: message.intervalMs || 3000,
        onComplete: () => {
          console.log(LOG_PREFIX, 'Auto-scroll collection finished.');
        }
      });
      sendResponse({ success: true, active: EXTRACTION_ACTIVE });
    } else if (message.type === 'GET_STATUS') {
      sendResponse({
        active: EXTRACTION_ACTIVE,
        extractionCount,
        maxPosts: MAX_POSTS_PER_SESSION,
        processedUrls: processedUrls.size,
      });
    }
  } catch (e) {
    console.warn(LOG_PREFIX, 'Message handler error:', e.message);
    sendResponse({ error: e.message });
  }
  return true; // keep channel open for async response
});

console.log(LOG_PREFIX, 'Common utilities loaded.');
