/**
 * ElectionSentiment - Twitter/X Content Script
 * Scrapes tweets from timelines, search results, and individual tweet pages.
 */

(() => {
  const PLATFORM = 'twitter';

  /**
   * Extract text content from a tweet element.
   * @param {Element} tweetArticle
   * @returns {string}
   */
  function extractTweetText(tweetArticle) {
    try {
      const textEl = tweetArticle.querySelector('div[data-testid="tweetText"]');
      if (textEl) return extractTextContent(textEl);
      return '';
    } catch (e) {
      console.warn(LOG_PREFIX, 'Twitter extractTweetText error:', e.message);
      return '';
    }
  }

  /**
   * Extract engagement metrics from a tweet.
   * Twitter puts counts in aria-labels on metric buttons.
   * @param {Element} tweetArticle
   * @returns {Object}
   */
  function extractTweetMetrics(tweetArticle) {
    const engagement = {};

    try {
      const metricMap = {
        likes: 'button[data-testid="like"]',
        retweets: 'button[data-testid="retweet"]',
        replies: 'button[data-testid="reply"]',
      };

      for (const [key, selector] of Object.entries(metricMap)) {
        const btn = tweetArticle.querySelector(selector);
        if (btn) {
          const ariaLabel = btn.getAttribute('aria-label') || '';
          // Aria labels like "523 Likes" or "1,204 replies"
          const match = ariaLabel.match(/([\d,.]+[kKmM]?)/);
          if (match) {
            engagement[key] = parseCount(match[1]);
          }
        }
      }

      // Also check for the "unlike" button (already liked tweets)
      if (!engagement.likes) {
        const unlikeBtn = tweetArticle.querySelector('button[data-testid="unlike"]');
        if (unlikeBtn) {
          const ariaLabel = unlikeBtn.getAttribute('aria-label') || '';
          const match = ariaLabel.match(/([\d,.]+[kKmM]?)/);
          if (match) {
            engagement.likes = parseCount(match[1]);
          }
        }
      }

      // Views/impressions if available
      const viewsEl = tweetArticle.querySelector('a[href$="/analytics"]');
      if (viewsEl) {
        const ariaLabel = viewsEl.getAttribute('aria-label') || '';
        const match = ariaLabel.match(/([\d,.]+[kKmM]?)\s*view/i);
        if (match) {
          engagement.views = parseCount(match[1]);
        }
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'Twitter extractTweetMetrics error:', e.message);
    }

    return engagement;
  }

  /**
   * Extract hashtags from a tweet.
   * @param {Element} tweetArticle
   * @returns {string[]}
   */
  function extractHashtags(tweetArticle) {
    const hashtags = [];
    try {
      const hashtagLinks = tweetArticle.querySelectorAll('a[href^="/hashtag/"]');
      for (const link of hashtagLinks) {
        const tag = extractTextContent(link);
        if (tag) hashtags.push(tag);
      }
    } catch (e) {
      // silent
    }
    return hashtags;
  }

  /**
   * Extract the user handle from a tweet.
   * @param {Element} tweetArticle
   * @returns {string}
   */
  function extractUserHandle(tweetArticle) {
    try {
      const userNameEl = tweetArticle.querySelector('div[data-testid="User-Name"]');
      if (userNameEl) {
        // The handle is typically in a span starting with @
        const spans = userNameEl.querySelectorAll('span');
        for (const span of spans) {
          const text = extractTextContent(span);
          if (text.startsWith('@')) return text;
        }
        // Fallback: look for a link to the profile
        const profileLink = userNameEl.querySelector('a[href^="/"]');
        if (profileLink) {
          const href = profileLink.getAttribute('href');
          if (href && !href.includes('/status/')) {
            return `@${href.replace(/^\//, '')}`;
          }
        }
      }
    } catch (e) {
      // silent
    }
    return '';
  }

  /**
   * Extract tweet URL (permalink).
   * @param {Element} tweetArticle
   * @returns {string}
   */
  function extractTweetUrl(tweetArticle) {
    try {
      // Look for the timestamp link which is the permalink
      const timeLink = tweetArticle.querySelector('a[href*="/status/"] time');
      if (timeLink) {
        const anchor = timeLink.closest('a');
        if (anchor) return anchor.href;
      }

      // Fallback: any link with /status/ pattern
      const statusLinks = tweetArticle.querySelectorAll('a[href*="/status/"]');
      for (const link of statusLinks) {
        const href = link.href;
        if (href && /\/status\/\d+$/.test(href)) {
          return href;
        }
      }
    } catch (e) {
      // silent
    }
    return window.location.href;
  }

  /**
   * Extract timestamp from a tweet.
   * @param {Element} tweetArticle
   * @returns {string|null}
   */
  function extractTimestamp(tweetArticle) {
    try {
      const timeEl = tweetArticle.querySelector('time');
      if (timeEl) {
        return timeEl.getAttribute('datetime') || extractTextContent(timeEl);
      }
    } catch (e) {
      // silent
    }
    return null;
  }

  /**
   * Extract quote tweet text if present.
   * @param {Element} tweetArticle
   * @returns {string}
   */
  function extractQuoteTweet(tweetArticle) {
    try {
      const quotedTweet = tweetArticle.querySelector('div[role="link"]');
      if (quotedTweet) {
        const quoteTextEl = quotedTweet.querySelector('div[data-testid="tweetText"]');
        if (quoteTextEl) {
          return extractTextContent(quoteTextEl);
        }
        // Fallback: get all text from the quoted block
        return extractTextContent(quotedTweet);
      }
    } catch (e) {
      // silent
    }
    return '';
  }

  /**
   * Determine if a tweet article is a reply (comment) in a thread.
   * On a tweet detail page, the first tweet is the main tweet; subsequent ones are replies.
   * In timelines, tweets in a thread conversation are nested after the parent.
   * @param {Element} article
   * @returns {boolean}
   */
  function isReplyTweet(article) {
    try {
      // On a tweet detail page (/status/), the main tweet is typically
      // the one whose URL matches the page URL
      const pageUrl = window.location.href;
      if (/\/status\/\d+/.test(pageUrl)) {
        const tweetUrl = extractTweetUrl(article);
        // If this tweet's URL differs from the page URL, it's a reply
        if (tweetUrl !== pageUrl && !pageUrl.includes(tweetUrl.split('/status/')[1] || '__none__')) {
          return true;
        }
      }

      // Check for reply indicator: "Replying to" text above the tweet
      const replyIndicator = article.querySelector('div[id*="id__"] a[href^="/"]');
      const prevSibling = article.closest('[data-testid="cellInnerDiv"]');
      if (prevSibling) {
        const prevEl = prevSibling.previousElementSibling;
        if (prevEl) {
          const prevText = extractTextContent(prevEl);
          if (/replying to/i.test(prevText)) return true;
        }
      }
    } catch (e) {
      // silent
    }
    return false;
  }

  // --- Main extraction ---

  function extractAll() {
    if (!EXTRACTION_ACTIVE) return;

    const items = [];
    const tweetArticles = document.querySelectorAll('article[data-testid="tweet"]');

    // Determine the parent tweet URL for reply context
    const pageUrl = window.location.href;
    let mainTweetUrl = /\/status\/\d+/.test(pageUrl) ? pageUrl : '';

    for (const article of tweetArticles) {
      try {
        if (!isInViewport(article)) continue;

        const url = extractTweetUrl(article);
        if (!trackPost(url)) continue;

        const tweetText = extractTweetText(article);
        const quoteText = extractQuoteTweet(article);
        const fullText = [tweetText, quoteText].filter(Boolean).join('\n[Quote] ');

        if (!fullText || fullText.length < 5) continue;
        if (!isRelevantPost(fullText)) continue;

        const engagement = extractTweetMetrics(article);
        const hashtags = extractHashtags(article);
        const handle = extractUserHandle(article);
        const timestamp = extractTimestamp(article);

        const isReply = isReplyTweet(article);

        const post = formatPost(fullText, PLATFORM, engagement, url, timestamp);
        post.hashtags = hashtags;
        post.userHandle = handle;
        post.type = isReply ? 'comment' : 'post';
        if (isReply && mainTweetUrl) {
          post.parentPostUrl = mainTweetUrl;
        }

        // Track the first main tweet URL for linking replies
        if (!isReply && !mainTweetUrl) {
          mainTweetUrl = url;
        }

        items.push(post);
      } catch (e) {
        console.warn(LOG_PREFIX, 'Twitter tweet extraction error:', e.message);
      }
    }

    if (items.length > 0) {
      console.log(LOG_PREFIX, `Twitter: extracted ${items.length} relevant item(s) (posts + replies).`);
      sendToBackground(items);
    }
  }

  // --- Initialize ---

  function init() {
    console.log(LOG_PREFIX, 'Twitter/X content script initialized.');

    // Initial extraction after page settles
    setTimeout(extractAll, 2500);

    // Observe timeline for new tweets loaded via infinite scroll
    // Twitter's main timeline container
    const containerSelector = 'main section[role="region"]';
    createObserver(extractAll, containerSelector);

    // Listen for START_COLLECTION to trigger auto-scroll
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'START_COLLECTION') {
        console.log(LOG_PREFIX, 'Twitter: START_COLLECTION received, auto-scrolling.');
        EXTRACTION_ACTIVE = true;
        autoScroll({
          maxScrolls: message.maxScrolls || 15,
          onComplete: () => {
            extractAll();
            console.log(LOG_PREFIX, 'Twitter: auto-scroll collection finished.');
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
