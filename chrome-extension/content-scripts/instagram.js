/**
 * ElectionSentiment - Instagram Content Script
 * Scrapes posts and comments from hashtag pages, post detail pages, and feed.
 */

(() => {
  const PLATFORM = 'instagram';

  /**
   * Detect which type of Instagram page we are on.
   * @returns {'hashtag'|'post'|'feed'|'explore'|'other'}
   */
  function detectPageType() {
    const path = window.location.pathname;
    if (path.startsWith('/explore/tags/')) return 'hashtag';
    if (/^\/p\/[^/]+/.test(path) || /^\/reel\/[^/]+/.test(path)) return 'post';
    if (path === '/' || path === '/feed/') return 'feed';
    if (path.startsWith('/explore/')) return 'explore';
    return 'other';
  }

  /**
   * Extract caption text from a post detail view or modal.
   * @param {Element} container - the post detail container
   * @returns {string}
   */
  function extractCaption(container) {
    try {
      // Caption is typically in span elements near the username/poster info
      // Look for the main content area that holds the caption
      const captionCandidates = container.querySelectorAll('h1, span[dir="auto"], div[dir="auto"]');
      const texts = [];

      for (const el of captionCandidates) {
        const text = extractTextContent(el);
        // Filter out short UI strings and usernames (typically short, no spaces)
        if (text.length > 15 || (text.length > 3 && text.includes(' '))) {
          // Avoid duplicates from nested elements
          const isDuplicate = texts.some((t) => t.includes(text) || text.includes(t));
          if (!isDuplicate) {
            texts.push(text);
          }
        }
      }

      return texts.join('\n');
    } catch (e) {
      console.warn(LOG_PREFIX, 'Instagram extractCaption error:', e.message);
      return '';
    }
  }

  /**
   * Extract hashtags from caption text.
   * @param {string} text
   * @returns {string[]}
   */
  function extractHashtags(text) {
    if (!text) return [];
    const matches = text.match(/#[\w\u0D00-\u0D7F]+/g);
    return matches || [];
  }

  /**
   * Extract likes count from a post.
   * @param {Element} container
   * @returns {number}
   */
  function extractLikes(container) {
    try {
      // Look for "X likes" text or button
      const likeSections = container.querySelectorAll('section, div');
      for (const section of likeSections) {
        const text = extractTextContent(section);
        // Match patterns like "1,234 likes" or "Liked by user and 567 others"
        const directMatch = text.match(/([\d,.]+[kKmM]?)\s*like/i);
        if (directMatch) return parseCount(directMatch[1]);

        const othersMatch = text.match(/and\s+([\d,.]+[kKmM]?)\s*other/i);
        if (othersMatch) return parseCount(othersMatch[1]) + 1;
      }

      // Check aria-labels
      const likeButtons = container.querySelectorAll('[aria-label*="like" i]');
      for (const btn of likeButtons) {
        const label = btn.getAttribute('aria-label') || '';
        const match = label.match(/([\d,.]+[kKmM]?)/);
        if (match) return parseCount(match[1]);
      }
    } catch (e) {
      // silent
    }
    return 0;
  }

  /**
   * Extract comments from a post detail view.
   * @param {Element} container
   * @param {string} parentPostUrl - URL of the parent post
   * @returns {Object[]}
   */
  function extractComments(container, parentPostUrl) {
    const comments = [];
    try {
      // Comments are typically in a ul list within the post detail/modal
      const commentLists = container.querySelectorAll('ul');
      for (const ul of commentLists) {
        const items = ul.querySelectorAll('li');
        for (const li of items) {
          const text = extractTextContent(li);
          // Skip very short items (likely UI elements) and the caption item
          if (text.length < 10) continue;
          if (!isRelevantPost(text)) continue;

          const commentId = `ig-comment-${text.substring(0, 40).replace(/\s/g, '-')}-${Date.now()}`;
          if (!trackPost(commentId)) continue;

          const comment = formatPost(text, PLATFORM, {}, window.location.href, null);
          comment.type = 'comment';
          comment.parentPostUrl = parentPostUrl || window.location.href;
          comments.push(comment);

          // Limit comments per post
          if (comments.length >= 20) break;
        }
        if (comments.length > 0) break; // found the comment list
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'Instagram extractComments error:', e.message);
    }
    return comments;
  }

  /**
   * Extract timestamp from a post detail view.
   * @param {Element} container
   * @returns {string|null}
   */
  function extractTimestamp(container) {
    try {
      const timeEl = container.querySelector('time');
      if (timeEl) {
        return timeEl.getAttribute('datetime') || extractTextContent(timeEl);
      }
    } catch (e) {
      // silent
    }
    return null;
  }

  /**
   * Get the URL for a specific post.
   * @param {Element} container
   * @returns {string}
   */
  function extractPostUrl(container) {
    try {
      // On post detail pages, use current URL
      if (/\/(p|reel)\/[^/]+/.test(window.location.pathname)) {
        return window.location.href;
      }

      // In feed or grid, look for link to the post
      const postLink = container.querySelector('a[href*="/p/"], a[href*="/reel/"]');
      if (postLink) return postLink.href;
    } catch (e) {
      // silent
    }
    return window.location.href;
  }

  // --- Post detail / modal extraction ---

  function extractPostDetail() {
    const posts = [];

    try {
      // Post detail page or open modal
      const articleEls = document.querySelectorAll('article');
      // Also check for dialog/modal containing a post
      const modalEl = document.querySelector('div[role="dialog"] article');
      const containers = modalEl ? [modalEl] : articleEls;

      for (const container of containers) {
        try {
          if (!isInViewport(container)) continue;

          const url = extractPostUrl(container);
          if (!trackPost(url)) continue;

          const caption = extractCaption(container);
          if (!caption) continue;
          if (!isRelevantPost(caption)) continue;

          const likes = extractLikes(container);
          const hashtags = extractHashtags(caption);
          const timestamp = extractTimestamp(container);

          const post = formatPost(
            caption,
            PLATFORM,
            { likes },
            url,
            timestamp
          );
          post.type = 'post';
          post.hashtags = hashtags;
          posts.push(post);

          // Extract comments from this post
          const commentPosts = extractComments(container, url);
          posts.push(...commentPosts);
        } catch (e) {
          console.warn(LOG_PREFIX, 'Instagram post detail extraction error:', e.message);
        }
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'Instagram extractPostDetail error:', e.message);
    }

    return posts;
  }

  // --- Feed extraction ---

  function extractFeedPosts() {
    const posts = [];

    try {
      const feedArticles = document.querySelectorAll('article[role="presentation"], article');

      for (const article of feedArticles) {
        try {
          if (!isInViewport(article)) continue;

          const url = extractPostUrl(article);
          if (!trackPost(url)) continue;

          const caption = extractCaption(article);
          if (!caption || caption.length < 10) continue;
          if (!isRelevantPost(caption)) continue;

          const likes = extractLikes(article);
          const hashtags = extractHashtags(caption);
          const timestamp = extractTimestamp(article);

          const post = formatPost(
            caption,
            PLATFORM,
            { likes },
            url,
            timestamp
          );
          post.type = 'post';
          post.hashtags = hashtags;
          posts.push(post);
        } catch (e) {
          console.warn(LOG_PREFIX, 'Instagram feed post extraction error:', e.message);
        }
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'Instagram extractFeedPosts error:', e.message);
    }

    return posts;
  }

  // --- Grid view (hashtag/explore pages) ---

  function extractGridView() {
    // Grid view has limited data (just thumbnails). We extract post links
    // but full data requires clicking into each post (modal view).
    // We just note the grid is present and extract from any open modals.
    const posts = [];

    try {
      // Check if a modal is open (user clicked a post in the grid)
      const modal = document.querySelector('div[role="dialog"]');
      if (modal) {
        const modalArticle = modal.querySelector('article');
        if (modalArticle && isInViewport(modalArticle)) {
          const url = extractPostUrl(modalArticle);
          if (trackPost(url)) {
            const caption = extractCaption(modalArticle);
            if (caption && isRelevantPost(caption)) {
              const likes = extractLikes(modalArticle);
              const hashtags = extractHashtags(caption);
              const timestamp = extractTimestamp(modalArticle);

              const post = formatPost(caption, PLATFORM, { likes }, url, timestamp);
              post.type = 'post';
              post.hashtags = hashtags;
              posts.push(post);

              const commentPosts = extractComments(modalArticle, url);
              posts.push(...commentPosts);
            }
          }
        }
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'Instagram extractGridView error:', e.message);
    }

    return posts;
  }

  // --- Main extraction ---

  function extractAll() {
    if (!EXTRACTION_ACTIVE) return;

    const pageType = detectPageType();
    let posts = [];

    switch (pageType) {
      case 'post':
        posts = extractPostDetail();
        break;
      case 'feed':
        posts = extractFeedPosts();
        break;
      case 'hashtag':
      case 'explore':
        posts = extractGridView();
        break;
      default:
        // Try all extraction methods
        posts = [
          ...extractPostDetail(),
          ...extractFeedPosts(),
          ...extractGridView(),
        ];
        break;
    }

    if (posts.length > 0) {
      console.log(LOG_PREFIX, `Instagram (${pageType}): extracted ${posts.length} relevant item(s).`);
      sendToBackground(posts);
    }
  }

  // --- Initialize ---

  function init() {
    console.log(LOG_PREFIX, 'Instagram content script initialized.');

    // Initial extraction after page settles
    setTimeout(extractAll, 3000);

    // Observe for new content (infinite scroll and modal opens)
    const containerSelector = 'main';
    createObserver(extractAll, containerSelector);

    // Also observe for dialog/modal changes (post detail modals)
    createObserver(extractAll, 'body');

    // Listen for START_COLLECTION to trigger auto-scroll
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'START_COLLECTION') {
        console.log(LOG_PREFIX, 'Instagram: START_COLLECTION received, auto-scrolling.');
        EXTRACTION_ACTIVE = true;
        autoScroll({
          maxScrolls: message.maxScrolls || 15,
          onComplete: () => {
            extractAll();
            console.log(LOG_PREFIX, 'Instagram: auto-scroll collection finished.');
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
