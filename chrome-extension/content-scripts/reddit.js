/**
 * ElectionSentiment - Reddit Content Script
 * Scrapes posts and comments from r/Kerala, r/Kochi, r/india
 * Supports Old Reddit, New Reddit (Shreddit), and intermediate redesign.
 */

(() => {
  const PLATFORM = 'reddit';
  const TRACKED_SUBREDDITS = ['kerala', 'kochi', 'india', 'indianpolitics', 'keralapolity'];

  /**
   * Check if current page is a tracked subreddit.
   */
  function isTrackedSubreddit() {
    const url = window.location.href.toLowerCase();
    return TRACKED_SUBREDDITS.some(
      (sub) => url.includes(`/r/${sub}/`) || url.includes(`/r/${sub}?`) || url.endsWith(`/r/${sub}`)
    );
  }

  /**
   * Detect which Reddit UI variant is active.
   * @returns {'old'|'shreddit'|'redesign'|'unknown'}
   */
  function detectRedditVariant() {
    if (document.querySelector('.thing[data-type="link"]')) return 'old';
    if (document.querySelector('shreddit-post')) return 'shreddit';
    if (document.querySelector('div[data-testid="post-container"]')) return 'redesign';
    return 'unknown';
  }

  // --- Old Reddit extraction ---

  function extractOldRedditPosts() {
    const posts = [];
    const postElements = document.querySelectorAll('.thing[data-type="link"]');

    for (const el of postElements) {
      try {
        if (!isInViewport(el)) continue;

        const permalink = el.getAttribute('data-permalink') || '';
        const fullUrl = permalink ? `https://www.reddit.com${permalink}` : '';
        if (!trackPost(fullUrl || el.getAttribute('data-fullname'))) continue;

        const titleEl = el.querySelector('a.title');
        const title = extractTextContent(titleEl);
        const bodyEl = el.querySelector('.entry .md');
        const body = extractTextContent(bodyEl);
        const text = [title, body].filter(Boolean).join('\n\n');

        if (!isRelevantPost(text)) continue;

        const subreddit = el.getAttribute('data-subreddit') || '';
        const scoreEl = el.querySelector('.score.unvoted');
        const engagement = {
          upvotes: parseCount(extractTextContent(scoreEl)),
        };

        const timeEl = el.querySelector('time');
        const timestamp = timeEl ? timeEl.getAttribute('datetime') : null;

        const post = formatPost(text, PLATFORM, engagement, fullUrl, timestamp);
        post.type = 'post';
        posts.push(post);

        // Extract comments within this post's thread (if on a comment page)
        const postCommentEls = el.querySelectorAll('.thing[data-type="comment"] .entry .md');
        for (const commentBody of postCommentEls) {
          const commentText = extractTextContent(commentBody);
          if (!commentText || commentText.length < 5 || !isRelevantPost(commentText)) continue;
          const commentEl = commentBody.closest('.thing[data-type="comment"]');
          const commentId = commentEl ? (commentEl.getAttribute('data-fullname') || '') : '';
          if (commentId && !trackPost(commentId)) continue;
          const commentScoreEl = commentEl ? commentEl.querySelector('.score.unvoted') : null;
          const commentEngagement = { upvotes: parseCount(extractTextContent(commentScoreEl)) };
          const commentPermalink = commentEl ? commentEl.querySelector('a.bylink') : null;
          const commentUrl = commentPermalink ? commentPermalink.href : window.location.href;
          const commentTimeEl = commentEl ? commentEl.querySelector('time') : null;
          const commentTimestamp = commentTimeEl ? commentTimeEl.getAttribute('datetime') : null;
          const comment = formatPost(commentText, PLATFORM, commentEngagement, commentUrl, commentTimestamp);
          comment.type = 'comment';
          comment.parentPostUrl = fullUrl;
          posts.push(comment);
        }
      } catch (e) {
        console.warn(LOG_PREFIX, 'Old Reddit post extraction error:', e.message);
      }
    }

    // Extract standalone comments on comment pages (not already captured above)
    const commentElements = document.querySelectorAll('.thing[data-type="comment"]');
    for (const el of commentElements) {
      try {
        if (!isInViewport(el)) continue;

        const id = el.getAttribute('data-fullname') || '';
        if (!trackPost(id)) continue;

        const bodyEl = el.querySelector('.entry .md');
        const text = extractTextContent(bodyEl);
        if (!isRelevantPost(text)) continue;

        const scoreEl = el.querySelector('.score.unvoted');
        const engagement = {
          upvotes: parseCount(extractTextContent(scoreEl)),
        };

        const permalink = el.querySelector('a.bylink');
        const url = permalink ? permalink.href : window.location.href;
        const timeEl = el.querySelector('time');
        const timestamp = timeEl ? timeEl.getAttribute('datetime') : null;

        const comment = formatPost(text, PLATFORM, engagement, url, timestamp);
        comment.type = 'comment';
        comment.parentPostUrl = window.location.href;
        posts.push(comment);
      } catch (e) {
        console.warn(LOG_PREFIX, 'Old Reddit comment extraction error:', e.message);
      }
    }

    return posts;
  }

  // --- New Reddit (Shreddit) extraction ---

  function extractShredditPosts() {
    const posts = [];
    const postElements = document.querySelectorAll('shreddit-post');

    for (const el of postElements) {
      try {
        if (!isInViewport(el)) continue;

        const permalink = el.getAttribute('permalink') || el.getAttribute('content-href') || '';
        const fullUrl = permalink.startsWith('http') ? permalink : `https://www.reddit.com${permalink}`;
        if (!trackPost(fullUrl || el.getAttribute('id'))) continue;

        const title = el.getAttribute('post-title') || '';
        const textBodyEl = el.querySelector('[slot="text-body"]')
          || el.querySelector('div[id$="-post-rtjson-content"]');
        const body = extractTextContent(textBodyEl);
        const text = [title, body].filter(Boolean).join('\n\n');

        if (!isRelevantPost(text)) continue;

        const score = el.getAttribute('score') || '0';
        const engagement = {
          upvotes: parseCount(score),
        };

        const subreddit = el.getAttribute('subreddit-prefixed-name') || '';
        const timestamp = el.getAttribute('created-timestamp') || null;

        const post = formatPost(text, PLATFORM, engagement, fullUrl, timestamp);
        post.type = 'post';
        posts.push(post);
      } catch (e) {
        console.warn(LOG_PREFIX, 'Shreddit post extraction error:', e.message);
      }
    }

    // Shreddit comments - extracted separately with type and parentPostUrl
    const commentElements = document.querySelectorAll('shreddit-comment');
    for (const el of commentElements) {
      try {
        if (!isInViewport(el)) continue;

        const thingId = el.getAttribute('thingid') || el.getAttribute('id') || '';
        if (!trackPost(thingId)) continue;

        const bodyEl = el.querySelector('[slot="comment"]')
          || el.querySelector('div[id$="-comment-rtjson-content"]');
        const text = extractTextContent(bodyEl);
        if (!isRelevantPost(text)) continue;

        const score = el.getAttribute('score') || '0';
        const engagement = {
          upvotes: parseCount(score),
        };
        const timestamp = el.getAttribute('created-timestamp') || null;

        // Find parent post URL from the nearest shreddit-post or page URL
        const parentPost = document.querySelector('shreddit-post');
        const parentPermalink = parentPost
          ? (parentPost.getAttribute('permalink') || parentPost.getAttribute('content-href') || '')
          : '';
        const parentPostUrl = parentPermalink.startsWith('http')
          ? parentPermalink
          : parentPermalink ? `https://www.reddit.com${parentPermalink}` : window.location.href;

        const comment = formatPost(text, PLATFORM, engagement, window.location.href, timestamp);
        comment.type = 'comment';
        comment.parentPostUrl = parentPostUrl;
        posts.push(comment);
      } catch (e) {
        console.warn(LOG_PREFIX, 'Shreddit comment extraction error:', e.message);
      }
    }

    return posts;
  }

  // --- Intermediate redesign extraction ---

  function extractRedesignPosts() {
    const posts = [];
    const postElements = document.querySelectorAll('div[data-testid="post-container"]');

    for (const el of postElements) {
      try {
        if (!isInViewport(el)) continue;

        // Get permalink from the post link
        const linkEl = el.querySelector('a[data-click-id="body"]')
          || el.querySelector('a[href*="/comments/"]');
        const url = linkEl ? linkEl.href : '';
        if (!trackPost(url || el.getAttribute('id') || Math.random().toString())) continue;

        // Title
        const titleEl = el.querySelector('h3') || el.querySelector('h1');
        const title = extractTextContent(titleEl);

        // Body text
        const bodyEl = el.querySelector('div[data-click-id="text"]')
          || el.querySelector('[data-testid="post-content"]');
        const body = extractTextContent(bodyEl);
        const text = [title, body].filter(Boolean).join('\n\n');

        if (!isRelevantPost(text)) continue;

        // Score
        const scoreEl = el.querySelector('div[data-testid="post-score"]')
          || el.querySelector('button[id*="upvote"] + div');
        const engagement = {
          upvotes: parseCount(extractTextContent(scoreEl)),
        };

        // Timestamp
        const timeEl = el.querySelector('a[data-click-id="timestamp"]')
          || el.querySelector('time');
        const timestamp = timeEl
          ? (timeEl.getAttribute('datetime') || timeEl.title || null)
          : null;

        const post = formatPost(text, PLATFORM, engagement, url, timestamp);
        post.type = 'post';
        posts.push(post);
      } catch (e) {
        console.warn(LOG_PREFIX, 'Redesign post extraction error:', e.message);
      }
    }

    return posts;
  }

  // --- Main extraction dispatcher ---

  function extractAll() {
    if (!EXTRACTION_ACTIVE) return;

    const variant = detectRedditVariant();
    let posts = [];

    switch (variant) {
      case 'old':
        posts = extractOldRedditPosts();
        break;
      case 'shreddit':
        posts = extractShredditPosts();
        break;
      case 'redesign':
        posts = extractRedesignPosts();
        break;
      default:
        // Try all variants as fallback
        posts = [
          ...extractShredditPosts(),
          ...extractRedesignPosts(),
          ...extractOldRedditPosts(),
        ];
        break;
    }

    if (posts.length > 0) {
      console.log(LOG_PREFIX, `Reddit (${variant}): extracted ${posts.length} relevant post(s).`);
      sendToBackground(posts);
    }
  }

  // --- Initialize ---

  function init() {
    if (!isTrackedSubreddit()) {
      // Also allow comment pages or search results mentioning Kerala
      const pageText = document.title || '';
      if (!isRelevantPost(pageText) && !window.location.href.includes('search')) {
        console.log(LOG_PREFIX, 'Reddit: not a tracked subreddit, skipping.');
        return;
      }
    }

    console.log(LOG_PREFIX, 'Reddit content script initialized.');

    // Initial extraction after short delay to let page render
    setTimeout(extractAll, 2000);

    // Set up MutationObserver for infinite scroll
    const containerSelector =
      document.querySelector('.siteTable') ? '.siteTable'           // Old Reddit
      : document.querySelector('shreddit-feed') ? 'shreddit-feed'   // Shreddit
      : document.querySelector('div[data-testid="posts-list"]') ? 'div[data-testid="posts-list"]' // Redesign
      : 'main';

    createObserver(extractAll, containerSelector);

    // Listen for START_COLLECTION to trigger auto-scroll
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'START_COLLECTION') {
        console.log(LOG_PREFIX, 'Reddit: START_COLLECTION received, auto-scrolling.');
        EXTRACTION_ACTIVE = true;
        autoScroll({
          maxScrolls: message.maxScrolls || 15,
          onComplete: () => {
            extractAll();
            console.log(LOG_PREFIX, 'Reddit: auto-scroll collection finished.');
          }
        });
        sendResponse({ success: true });
      }
      return true;
    });
  }

  // Wait for common.js utilities to be available
  if (typeof extractTextContent === 'function') {
    init();
  } else {
    window.addEventListener('load', () => setTimeout(init, 1000));
  }
})();
