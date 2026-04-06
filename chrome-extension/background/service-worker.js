/**
 * Service Worker — Main Orchestrator
 *
 * Entry point registered in manifest.json for the
 * Kerala 2026 Election Sentiment Chrome Extension.
 *
 * Handles message routing, periodic cleanup, badge management,
 * and coordinates between content scripts, popup, and options page.
 */

'use strict';

importScripts('../lib/idb.js', 'storage-manager.js', 'sentiment-engine.js', 'data-aggregator.js');

const LOG_PREFIX = '[SentimentBG]';
const ALARM_DAILY_CLEANUP = 'daily-cleanup';
const ALARM_DAILY_SNAPSHOT = 'daily-snapshot';
const ALARM_COLLECTION_TIMEOUT = 'collection-timeout';
const DEFAULT_DAYS_TO_KEEP = 90;
const COLLECTION_TIMEOUT_MINUTES = 5;

let _keywordsCache = null;
let _candidatesCache = null;
let _isCollecting = false;
let _collectionTabIds = [];

// ─── Installation / Startup ────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log(`${LOG_PREFIX} Extension installed (reason: ${details.reason})`);

  try {
    await initDB();
    console.log(`${LOG_PREFIX} Database initialized`);

    // Set default config
    const existingConstituency = await getConfig('activeConstituency');
    if (!existingConstituency) {
      await setConfig('activeConstituency', 'kochi');
    }
    const existingPlatforms = await getConfig('enabledPlatforms');
    if (!existingPlatforms) {
      await setConfig('enabledPlatforms', {
        reddit: true,
        facebook: true,
        twitter: true,
        instagram: true,
      });
    }
    await setConfig('extractionActive', false);

    console.log(`${LOG_PREFIX} Default config set`);
  } catch (err) {
    console.error(`${LOG_PREFIX} Init error:`, err);
  }

  // Badge
  chrome.action.setBadgeText({ text: '0' });
  chrome.action.setBadgeBackgroundColor({ color: '#9E9E9E' }); // gray = idle

  // Schedule daily cleanup alarm
  chrome.alarms.create(ALARM_DAILY_CLEANUP, {
    periodInMinutes: 1440, // 24 hours
  });

  // Schedule daily snapshot alarm
  chrome.alarms.create(ALARM_DAILY_SNAPSHOT, {
    periodInMinutes: 1440, // 24 hours
  });

  console.log(`${LOG_PREFIX} Daily cleanup and snapshot alarms scheduled`);
});

// Also init DB on service worker startup (in case it was suspended)
initDB().catch((err) => console.error(`${LOG_PREFIX} Startup DB init error:`, err));

// ─── Alarm Handler ─────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_DAILY_CLEANUP) {
    console.log(`${LOG_PREFIX} Running daily cleanup...`);
    try {
      const deleted = await clearOldPosts(DEFAULT_DAYS_TO_KEEP);
      console.log(`${LOG_PREFIX} Cleanup complete: ${deleted} old posts removed`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Cleanup error:`, err);
    }
  }

  if (alarm.name === ALARM_DAILY_SNAPSHOT) {
    console.log(`${LOG_PREFIX} Running daily snapshot...`);
    try {
      const constituency = (await getConfig('activeConstituency')) || 'kochi';
      const today = new Date().toISOString().split('T')[0];
      const allPosts = await getAllPosts();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayPosts = allPosts.filter(
        (p) => new Date(p.extractedAt).getTime() >= todayStart.getTime()
      );

      const dailyData = aggregateDaily(todayPosts, today);
      await saveDailySnapshot(constituency, today, dailyData);

      // Save trend data points for each front
      for (const front of ['LDF', 'UDF', 'NDA']) {
        await saveTrend(constituency, front, today, dailyData.scores[front] || 0);
      }

      console.log(`${LOG_PREFIX} Daily snapshot saved for ${constituency} on ${today}`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Daily snapshot error:`, err);
    }
  }

  if (alarm.name === ALARM_COLLECTION_TIMEOUT) {
    console.log(`${LOG_PREFIX} Collection timeout reached, stopping collection...`);
    try {
      await handleStopCollection();
    } catch (err) {
      console.error(`${LOG_PREFIX} Stop collection error:`, err);
    }
  }
});

// ─── Message Handler ───────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // All handlers are async, so we return true to keep the message channel open
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((err) => {
      console.error(`${LOG_PREFIX} Handler error for ${message.type}:`, err);
      sendResponse({ error: err.message });
    });
  return true; // Keep channel open for async response
});

/**
 * Route messages to appropriate handlers.
 * @param {Object} message - { type: string, ...payload }
 * @param {Object} sender - Chrome message sender info
 * @returns {Promise<Object>}
 */
async function handleMessage(message, sender) {
  const { type } = message;
  console.log(`${LOG_PREFIX} Received message: ${type}`);

  switch (type) {
    case 'NEW_POSTS':
      return handleNewPosts(message.posts || []);

    case 'GET_DASHBOARD':
      return handleGetDashboard(message.constituency);

    case 'EXPORT_JSON':
      return handleExportJSON(message.constituency);

    case 'TAKE_SNAPSHOT':
      return handleTakeSnapshot(message.constituency);

    case 'GET_TRENDS':
      return handleGetTrends(message.constituency, message.days);

    case 'GET_STATS':
      return handleGetStats();

    case 'TOGGLE_EXTRACTION':
      return handleToggleExtraction(message.tabId);

    case 'UPDATE_CONFIG':
      return handleUpdateConfig(message.key, message.value);

    case 'GET_CONFIG':
      return handleGetConfig(message.key);

    case 'CLEAR_DATA':
      return handleClearData(message.daysToKeep);

    case 'START_COLLECTION':
      return handleStartCollection(message.constituency);

    case 'STOP_COLLECTION':
      return handleStopCollection();

    case 'GET_DAILY_ANALYSIS':
      return handleGetDailyAnalysis(message.constituency);

    case 'GET_CUMULATIVE_ANALYSIS':
      return handleGetCumulativeAnalysis(message.constituency, message.days);

    default:
      console.warn(`${LOG_PREFIX} Unknown message type: ${type}`);
      return { error: `Unknown message type: ${type}` };
  }
}

// ─── Handler Implementations ───────────────────────────────────────────

/**
 * NEW_POSTS: Receive posts from content scripts, score and save them.
 */
async function handleNewPosts(posts) {
  if (!posts || posts.length === 0) {
    return { saved: 0 };
  }

  console.log(`${LOG_PREFIX} Processing ${posts.length} new posts`);

  // Load keywords
  if (!_keywordsCache) {
    try {
      _keywordsCache = await loadKeywords();
    } catch (err) {
      console.error(`${LOG_PREFIX} Keywords load failed, scoring without keywords`);
      _keywordsCache = { combined: {} };
    }
  }

  // Separate posts and comments
  const regularPosts = posts.filter((p) => p.type !== 'comment');
  const comments = posts.filter((p) => p.type === 'comment');

  // Score regular posts first
  const scoredRegularPosts = regularPosts.map((post) => {
    const scores = scorePost(post, _keywordsCache);
    const constituency = post.constituency ||
      detectConstituency(post.text || '', (_keywordsCache.combined || _keywordsCache).candidates || {});

    return {
      ...post,
      scores,
      issues: scores.issues,
      isMeme: scores.isMeme,
      constituency: constituency || '',
      extractedAt: post.extractedAt || new Date().toISOString(),
    };
  });

  // Build a lookup of parent post scores for comment scoring
  const parentScoreLookup = {};
  for (const sp of scoredRegularPosts) {
    if (sp.url) parentScoreLookup[sp.url] = sp.scores;
  }

  // Score comments individually with crowd reaction classification
  const scoredComments = comments.map((comment) => {
    const parentScore = (comment.parentPostUrl && parentScoreLookup[comment.parentPostUrl]) || null;
    const commentResult = scoreComment(comment, parentScore, _keywordsCache);
    const constituency = comment.constituency ||
      detectConstituency(comment.text || '', (_keywordsCache.combined || _keywordsCache).candidates || {});

    return {
      ...comment,
      scores: commentResult.scores,
      issues: commentResult.issues,
      crowdReaction: commentResult.reaction,
      constituency: constituency || '',
      extractedAt: comment.extractedAt || new Date().toISOString(),
    };
  });

  const scoredPosts = [...scoredRegularPosts, ...scoredComments];

  // Save to IndexedDB
  const saved = await savePosts(scoredPosts);
  console.log(`${LOG_PREFIX} Saved ${saved} scored posts`);

  // Update badge
  await updateBadge();

  return { saved, scored: scoredPosts.length };
}

/**
 * GET_DASHBOARD: Aggregate all posts for a constituency and return dashboard data.
 */
async function handleGetDashboard(constituency) {
  const activeConstituency = constituency || (await getConfig('activeConstituency')) || 'kochi';
  console.log(`${LOG_PREFIX} Building dashboard for: ${activeConstituency}`);

  // Get all posts (could filter by constituency, but aggregate broadly for adjustment)
  const allPosts = await getAllPosts();

  // Filter for constituency if specific posts are tagged
  const constituencyPosts = allPosts.filter((p) => {
    const pc = (p.constituency || '').toLowerCase();
    return pc === activeConstituency.toLowerCase() || pc === '';
  });

  const platformData = aggregateByPlatform(constituencyPosts);
  const memeData = aggregateMemes(constituencyPosts, activeConstituency);

  // Get ground reports from latest snapshot or config
  const latestSnapshot = await getLatestSnapshot(activeConstituency);
  const groundReports = (latestSnapshot && latestSnapshot.data && latestSnapshot.data.ground_reports) || null;

  const adjustment = computeSentimentAdjustment(platformData, memeData, groundReports);
  const stats = await getStats();

  return {
    constituency: activeConstituency,
    platformData,
    memeData,
    adjustment,
    stats,
    postCount: constituencyPosts.length,
  };
}

/**
 * EXPORT_JSON: Build full sentiment_data.json and trigger download.
 */
async function handleExportJSON(constituency) {
  const activeConstituency = constituency || (await getConfig('activeConstituency')) || 'kochi';
  console.log(`${LOG_PREFIX} Exporting JSON for: ${activeConstituency}`);

  const allPosts = await getAllPosts();
  const constituencyPosts = allPosts.filter((p) => {
    const pc = (p.constituency || '').toLowerCase();
    return pc === activeConstituency.toLowerCase() || pc === '';
  });

  const platformData = aggregateByPlatform(constituencyPosts);
  const memeData = aggregateMemes(constituencyPosts, activeConstituency);

  const latestSnapshot = await getLatestSnapshot(activeConstituency);
  const groundReports = (latestSnapshot && latestSnapshot.data && latestSnapshot.data.ground_reports) || null;

  const adjustment = computeSentimentAdjustment(platformData, memeData, groundReports);
  const sentimentJSON = buildSentimentJSON(activeConstituency, platformData, memeData, adjustment, groundReports);

  const result = await exportToJSON(sentimentJSON);
  console.log(`${LOG_PREFIX} Export complete for ${activeConstituency}`);

  return { success: true, result };
}

/**
 * TAKE_SNAPSHOT: Save current aggregated state as a dated snapshot.
 */
async function handleTakeSnapshot(constituency) {
  const activeConstituency = constituency || (await getConfig('activeConstituency')) || 'kochi';
  console.log(`${LOG_PREFIX} Taking snapshot for: ${activeConstituency}`);

  const allPosts = await getAllPosts();
  const constituencyPosts = allPosts.filter((p) => {
    const pc = (p.constituency || '').toLowerCase();
    return pc === activeConstituency.toLowerCase() || pc === '';
  });

  const platformData = aggregateByPlatform(constituencyPosts);
  const memeData = aggregateMemes(constituencyPosts, activeConstituency);
  const adjustment = computeSentimentAdjustment(platformData, memeData, null);

  const snapshotData = {
    platformData,
    memeData,
    adjustment,
    postCount: constituencyPosts.length,
  };

  await saveSnapshot(activeConstituency, snapshotData);

  // Save trend points for each front
  const today = new Date().toISOString().split('T')[0];
  for (const front of ['LDF', 'UDF', 'NDA']) {
    const key = `${front}_adjustment`;
    await saveTrend(activeConstituency, front, today, adjustment[key] || 0);
  }

  console.log(`${LOG_PREFIX} Snapshot saved for ${activeConstituency}`);
  return { success: true, constituency: activeConstituency, date: today };
}

/**
 * GET_TRENDS: Return trend data for popup chart.
 */
async function handleGetTrends(constituency, days) {
  const activeConstituency = constituency || (await getConfig('activeConstituency')) || 'kochi';
  const trendDays = days || 30;

  const trends = await getTrends(activeConstituency, trendDays);
  console.log(`${LOG_PREFIX} Returning ${trends.length} trend points for ${activeConstituency}`);

  return { constituency: activeConstituency, trends, days: trendDays };
}

/**
 * GET_STATS: Return collection statistics.
 */
async function handleGetStats() {
  const stats = await getStats();
  console.log(`${LOG_PREFIX} Stats: ${stats.total} total posts`);
  return stats;
}

/**
 * TOGGLE_EXTRACTION: Send start/stop message to active tab's content script.
 */
async function handleToggleExtraction(tabId) {
  _isCollecting = !_isCollecting;
  await setConfig('extractionActive', _isCollecting);

  console.log(`${LOG_PREFIX} Extraction ${_isCollecting ? 'STARTED' : 'STOPPED'}`);

  // Update badge color
  chrome.action.setBadgeBackgroundColor({
    color: _isCollecting ? '#4CAF50' : '#9E9E9E', // green or gray
  });

  // Send to content script in active tab
  if (tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: _isCollecting ? 'START_EXTRACTION' : 'STOP_EXTRACTION',
      });
    } catch (err) {
      console.warn(`${LOG_PREFIX} Could not reach content script in tab ${tabId}:`, err.message);
    }
  } else {
    // Try to send to current active tab
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        await chrome.tabs.sendMessage(tab.id, {
          type: _isCollecting ? 'START_EXTRACTION' : 'STOP_EXTRACTION',
        });
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Could not reach active tab content script:`, err.message);
    }
  }

  return { collecting: _isCollecting };
}

/**
 * UPDATE_CONFIG: Save config changes from options page.
 */
async function handleUpdateConfig(key, value) {
  if (!key) return { error: 'Config key is required' };
  await setConfig(key, value);
  console.log(`${LOG_PREFIX} Config updated: ${key}`);

  // Invalidate keywords cache if keyword-related config changes
  if (key === 'customKeywords') {
    _keywordsCache = null;
  }

  return { success: true, key, value };
}

/**
 * GET_CONFIG: Return current config value.
 */
async function handleGetConfig(key) {
  if (!key) {
    // Return all known config keys
    const keys = ['activeConstituency', 'enabledPlatforms', 'extractionActive', 'customKeywords'];
    const config = {};
    for (const k of keys) {
      config[k] = await getConfig(k);
    }
    return config;
  }
  const value = await getConfig(key);
  return { key, value };
}

/**
 * CLEAR_DATA: Clear old posts from IndexedDB.
 */
async function handleClearData(daysToKeep) {
  const days = daysToKeep || DEFAULT_DAYS_TO_KEEP;
  const deleted = await clearOldPosts(days);
  console.log(`${LOG_PREFIX} Cleared ${deleted} posts older than ${days} days`);
  await updateBadge();
  return { deleted, daysKept: days };
}

// ─── Auto-Tab Collection Handlers ─────────────────────────────────────

/**
 * START_COLLECTION: Open platform tabs and start content script extraction.
 */
async function handleStartCollection(constituency) {
  const activeConstituency = constituency || (await getConfig('activeConstituency')) || 'kochi';
  console.log(`${LOG_PREFIX} Starting auto-collection for: ${activeConstituency}`);

  // Load candidates data
  if (!_candidatesCache) {
    try {
      const resp = await fetch(chrome.runtime.getURL('keywords/candidates.json'));
      if (resp.ok) {
        _candidatesCache = await resp.json();
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to load candidates.json:`, err);
    }
  }

  // Build search query from candidate names
  const constituencyData = _candidatesCache &&
    _candidatesCache.constituencies &&
    _candidatesCache.constituencies[activeConstituency.toLowerCase()];

  let queryParts = ['Kerala election', activeConstituency];
  if (constituencyData && constituencyData.candidates) {
    for (const [front, candidate] of Object.entries(constituencyData.candidates)) {
      if (candidate.name && candidate.name !== 'TBD') {
        queryParts.push(candidate.name);
      }
    }
  }
  const query = queryParts.join(' ');
  const encodedQuery = encodeURIComponent(query);

  // Open 4 platform tabs
  const urls = [
    `https://www.reddit.com/r/Kerala/search/?q=${encodedQuery}&t=month&sort=relevance`,
    `https://x.com/search?q=${encodedQuery}&src=typed_query&f=live`,
    `https://www.facebook.com/search/posts/?q=${encodedQuery}`,
    `https://www.instagram.com/explore/tags/keralaelection2026/`,
  ];

  _collectionTabIds = [];
  for (const url of urls) {
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      _collectionTabIds.push(tab.id);
      console.log(`${LOG_PREFIX} Opened collection tab ${tab.id}: ${url}`);
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to open tab for ${url}:`, err.message);
    }
  }

  // Store tab IDs for tracking
  await setConfig('collectionTabIds', _collectionTabIds);
  await setConfig('collectionConstituency', activeConstituency);

  // Wait 3 seconds for pages to load, then send START_COLLECTION to content scripts
  setTimeout(async () => {
    for (const tabId of _collectionTabIds) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'START_EXTRACTION',
          constituency: activeConstituency,
        });
        console.log(`${LOG_PREFIX} Sent START_EXTRACTION to tab ${tabId}`);
      } catch (err) {
        console.warn(`${LOG_PREFIX} Could not reach content script in tab ${tabId}:`, err.message);
      }
    }
  }, 3000);

  // Set a 5-minute timeout to auto-stop collection
  chrome.alarms.create(ALARM_COLLECTION_TIMEOUT, {
    delayInMinutes: COLLECTION_TIMEOUT_MINUTES,
  });

  _isCollecting = true;
  await setConfig('extractionActive', true);
  chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });

  console.log(`${LOG_PREFIX} Auto-collection started, timeout in ${COLLECTION_TIMEOUT_MINUTES} min`);
  return { success: true, tabsOpened: _collectionTabIds.length, constituency: activeConstituency };
}

/**
 * STOP_COLLECTION: Send stop message to all tracked collection tabs.
 */
async function handleStopCollection() {
  console.log(`${LOG_PREFIX} Stopping collection across ${_collectionTabIds.length} tabs`);

  // Recover tab IDs if service worker was suspended
  if (_collectionTabIds.length === 0) {
    const stored = await getConfig('collectionTabIds');
    if (stored && Array.isArray(stored)) {
      _collectionTabIds = stored;
    }
  }

  for (const tabId of _collectionTabIds) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'TOGGLE_EXTRACTION',
        enabled: false,
      });
      console.log(`${LOG_PREFIX} Sent stop to tab ${tabId}`);
    } catch (err) {
      console.warn(`${LOG_PREFIX} Could not reach tab ${tabId}:`, err.message);
    }
  }

  // Clear the timeout alarm
  chrome.alarms.clear(ALARM_COLLECTION_TIMEOUT);

  _isCollecting = false;
  await setConfig('extractionActive', false);
  chrome.action.setBadgeBackgroundColor({ color: '#9E9E9E' });
  _collectionTabIds = [];
  await setConfig('collectionTabIds', []);

  console.log(`${LOG_PREFIX} Collection stopped`);
  return { success: true, collecting: false };
}

/**
 * GET_DAILY_ANALYSIS: Return analysis for today's posts only.
 */
async function handleGetDailyAnalysis(constituency) {
  const activeConstituency = constituency || (await getConfig('activeConstituency')) || 'kochi';
  const today = new Date().toISOString().split('T')[0];

  console.log(`${LOG_PREFIX} Building daily analysis for ${activeConstituency} on ${today}`);

  const todayPosts = await getPostsByDate(today);

  // Filter by constituency
  const constituencyPosts = todayPosts.filter((p) => {
    const pc = (p.constituency || '').toLowerCase();
    return pc === activeConstituency.toLowerCase() || pc === '';
  });

  const dailyData = aggregateDaily(constituencyPosts, today);

  return {
    constituency: activeConstituency,
    date: today,
    ...dailyData,
  };
}

/**
 * GET_CUMULATIVE_ANALYSIS: Return recency-weighted analysis across all collected data.
 */
async function handleGetCumulativeAnalysis(constituency, days) {
  const activeConstituency = constituency || (await getConfig('activeConstituency')) || 'kochi';
  const totalDays = days || 30;

  console.log(`${LOG_PREFIX} Building cumulative analysis for ${activeConstituency} over ${totalDays} days`);

  const allPosts = await getAllPosts();

  // Filter by constituency
  const constituencyPosts = allPosts.filter((p) => {
    const pc = (p.constituency || '').toLowerCase();
    return pc === activeConstituency.toLowerCase() || pc === '';
  });

  const cumulativeData = aggregateCumulative(constituencyPosts, totalDays);

  return {
    constituency: activeConstituency,
    ...cumulativeData,
  };
}

// ─── Badge Management ──────────────────────────────────────────────────

/**
 * Update badge text with total posts collected today.
 */
async function updateBadge() {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayPosts = await getAllPosts(todayStart.toISOString());
    const count = todayPosts.length;

    const text = count > 999 ? '999+' : String(count);
    chrome.action.setBadgeText({ text });

    // Update color based on collection state
    const isActive = await getConfig('extractionActive');
    chrome.action.setBadgeBackgroundColor({
      color: isActive ? '#4CAF50' : '#9E9E9E',
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} Badge update error:`, err);
  }
}

console.log(`${LOG_PREFIX} Service worker loaded`);
