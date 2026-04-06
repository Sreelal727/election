/**
 * ElectionSentiment - Facebook Content Script
 * Scrapes posts and comments from Facebook feed and pages.
 * Uses structural/role-based selectors to handle Facebook's obfuscated class names.
 */

(() => {
  const PLATFORM = 'facebook';

  /**
   * Extract text from a Facebook post element.
   * Facebook uses obfuscated class names, so we rely on role and data attributes.
   * @param {Element} article
   * @returns {string}
   */
  function extractPostText(article) {
    try {
      // Primary: data-ad-comet-preview="message" container
      const messageEl = article.querySelector('div[data-ad-comet-preview="message"]');
      if (messageEl) {
        return extractTextContent(messageEl);
      }

      // Fallback: dir="auto" spans/divs within the article (post text blocks)
      const autoTextEls = article.querySelectorAll('div[dir="auto"]');
      const texts = [];
      for (const el of autoTextEls) {
        // Skip very short text (likely UI labels) and elements inside comment sections
        const text = extractTextContent(el);
        if (text.length > 10 && !el.closest('ul')) {
          texts.push(text);
        }
      }
      if (texts.length > 0) {
        return texts.join('\n');
      }

      // Last resort: any substantial text in the article
      const allText = extractTextContent(article);
      return allText.length > 20 ? allText.substring(0, 2000) : '';
    } catch (e) {
      console.warn(LOG_PREFIX, 'Facebook extractPostText error:', e.message);
      return '';
    }
  }

  /**
   * Extract reaction count from a post article.
   * Facebook puts reaction counts in aria-label attributes.
   * @param {Element} article
   * @returns {Object}
   */
  function extractReactions(article) {
    const engagement = {};

    try {
      // Reaction summary - often in an aria-label like "52 reactions"
      const reactionEls = article.querySelectorAll('[aria-label*="reaction"], [aria-label*="like"]');
      for (const el of reactionEls) {
        const label = el.getAttribute('aria-label') || '';
        const match = label.match(/([\d,.]+[kKmM]?)\s*(reaction|like)/i);
        if (match) {
          engagement.reactions = parseCount(match[1]);
          break;
        }
      }

      // Comment count
      const commentCountEls = article.querySelectorAll('[aria-label*="comment"]');
      for (const el of commentCountEls) {
        const label = el.getAttribute('aria-label') || '';
        const match = label.match(/([\d,.]+[kKmM]?)\s*comment/i);
        if (match) {
          engagement.comments = parseCount(match[1]);
          break;
        }
      }

      // Share count
      const shareEls = article.querySelectorAll('[aria-label*="share"]');
      for (const el of shareEls) {
        const label = el.getAttribute('aria-label') || '';
        const match = label.match(/([\d,.]+[kKmM]?)\s*share/i);
        if (match) {
          engagement.shares = parseCount(match[1]);
          break;
        }
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'Facebook extractReactions error:', e.message);
    }

    return engagement;
  }

  /**
   * Extract group or page name from the post header or URL.
   * @param {Element} article
   * @returns {string}
   */
  function extractSourceName(article) {
    try {
      // Look for strong tag or heading in the post header (author/page name)
      const headerLink = article.querySelector('h2 a, h3 a, h4 a, strong a');
      if (headerLink) {
        return extractTextContent(headerLink);
      }

      // Check URL for group/page
      const url = window.location.href;
      const groupMatch = url.match(/groups\/([^/?]+)/);
      if (groupMatch) return `group:${groupMatch[1]}`;
      const pageMatch = url.match(/facebook\.com\/([^/?]+)/);
      if (pageMatch && !['watch', 'marketplace', 'gaming', 'events'].includes(pageMatch[1])) {
        return `page:${pageMatch[1]}`;
      }
    } catch (e) {
      // silent
    }
    return '';
  }

  /**
   * Extract timestamp from a post.
   * @param {Element} article
   * @returns {string|null}
   */
  function extractTimestamp(article) {
    try {
      // Timestamps are often in abbr or span with aria-label containing date info
      const abbrEl = article.querySelector('abbr[data-utime]');
      if (abbrEl) return abbrEl.getAttribute('data-utime');

      // New Facebook: look for links with timestamps in aria-label or text
      const timeLinks = article.querySelectorAll('a[role="link"]');
      for (const link of timeLinks) {
        const label = link.getAttribute('aria-label') || '';
        // Match patterns like "March 15, 2026" or "2 hours ago"
        if (/\d{4}|ago|yesterday|hours?|minutes?|days?/i.test(label)) {
          return label;
        }
      }

      // Check for use of <time> element
      const timeEl = article.querySelector('time');
      if (timeEl) return timeEl.getAttribute('datetime') || extractTextContent(timeEl);
    } catch (e) {
      // silent
    }
    return null;
  }

  /**
   * Extract a URL for the individual post.
   * @param {Element} article
   * @returns {string}
   */
  function extractPostUrl(article) {
    try {
      // Permalink is usually on the timestamp link
      const permalinkEl = article.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]');
      if (permalinkEl) return permalinkEl.href;

      // Fallback: any link with /posts/ pattern
      const links = article.querySelectorAll('a[href]');
      for (const link of links) {
        if (/\/(posts|permalink|story_fbid|photo)/.test(link.href)) {
          return link.href;
        }
      }
    } catch (e) {
      // silent
    }
    return window.location.href;
  }

  /**
   * Extract comments from within a post article.
   * @param {Element} article
   * @param {string} parentPostUrl - URL of the parent post
   * @returns {Object[]}
   */
  function extractComments(article, parentPostUrl) {
    const comments = [];
    try {
      // Comments are nested article elements with role="article"
      const commentEls = article.querySelectorAll('div[role="article"]');
      for (const commentEl of commentEls) {
        // Skip the parent article itself
        if (commentEl === article) continue;

        const text = extractTextContent(commentEl);
        if (text.length < 5) continue;
        if (!isRelevantPost(text)) continue;

        const id = `fb-comment-${text.substring(0, 50).replace(/\s/g, '-')}-${Date.now()}`;
        if (!trackPost(id)) continue;

        const comment = formatPost(text, PLATFORM, {}, window.location.href, null);
        comment.type = 'comment';
        comment.parentPostUrl = parentPostUrl || window.location.href;
        comments.push(comment);
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'Facebook extractComments error:', e.message);
    }
    return comments;
  }

  // --- Main extraction ---

  function extractAll() {
    if (!EXTRACTION_ACTIVE) return;

    const posts = [];
    const articles = document.querySelectorAll('div[role="article"]');

    for (const article of articles) {
      try {
        // Skip nested articles (comments) - only process top-level posts
        if (article.closest('div[role="article"]') !== article &&
            article.parentElement.closest('div[role="article"]')) {
          continue;
        }

        if (!isInViewport(article)) continue;

        const url = extractPostUrl(article);
        const postId = url || `fb-${extractTextContent(article).substring(0, 80)}`;
        if (!trackPost(postId)) continue;

        const text = extractPostText(article);
        if (!text || text.length < 10) continue;
        if (!isRelevantPost(text)) continue;

        const engagement = extractReactions(article);
        const timestamp = extractTimestamp(article);
        const source = extractSourceName(article);

        const post = formatPost(text, PLATFORM, engagement, url, timestamp);
        post.type = 'post';
        post.source = source;
        posts.push(post);

        // Also extract comments within this post
        const commentPosts = extractComments(article, url);
        posts.push(...commentPosts);
      } catch (e) {
        console.warn(LOG_PREFIX, 'Facebook post extraction error:', e.message);
      }
    }

    if (posts.length > 0) {
      console.log(LOG_PREFIX, `Facebook: extracted ${posts.length} relevant item(s).`);
      sendToBackground(posts);
    }
  }

  // --- Initialize ---

  function init() {
    console.log(LOG_PREFIX, 'Facebook content script initialized.');

    // Initial extraction after page settles
    setTimeout(extractAll, 3000);

    // Observe the main feed container for new posts (infinite scroll)
    const containerSelector = 'div[role="main"]';
    createObserver(extractAll, containerSelector);

    // Listen for START_COLLECTION to trigger auto-scroll
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'START_COLLECTION') {
        console.log(LOG_PREFIX, 'Facebook: START_COLLECTION received, auto-scrolling.');
        EXTRACTION_ACTIVE = true;
        autoScroll({
          maxScrolls: message.maxScrolls || 15,
          onComplete: () => {
            extractAll();
            console.log(LOG_PREFIX, 'Facebook: auto-scroll collection finished.');
          }
        });
        sendResponse({ success: true });
      }
      return true;
    });
  }

  if (typeof extractTextContent === 'function') {
    init();
  } else {
    window.addEventListener('load', () => setTimeout(init, 1000));
  }
})();
