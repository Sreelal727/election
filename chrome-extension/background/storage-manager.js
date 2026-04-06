/**
 * IndexedDB Storage Manager
 * Database: ElectionSentiment2026, version 1
 *
 * Manages raw posts, snapshots, trends, and config for the
 * Kerala 2026 Election Sentiment Chrome Extension.
 */

'use strict';

const DB_NAME = 'ElectionSentiment2026';
const DB_VERSION = 1;

const STORES = {
  RAW_POSTS: 'raw_posts',
  SNAPSHOTS: 'snapshots',
  TRENDS: 'trends',
  CONFIG: 'config',
};

let _db = null;

/**
 * Generate a UUID v4.
 * @returns {string}
 */
function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Format a date as YYYY-MM-DD.
 * @param {Date|number} date
 * @returns {string}
 */
function formatDate(date) {
  const d = new Date(date);
  return d.toISOString().split('T')[0];
}

/**
 * Initialize (open/create) the database. Caches the connection.
 * @returns {Promise<IDBDatabase>}
 */
async function initDB() {
  if (_db) return _db;

  _db = await openDB(DB_NAME, DB_VERSION, (db, oldVersion) => {
    // raw_posts store
    if (!db.objectStoreNames.contains(STORES.RAW_POSTS)) {
      const rawStore = db.createObjectStore(STORES.RAW_POSTS, { keyPath: 'id' });
      rawStore.createIndex('platform', 'platform', { unique: false });
      rawStore.createIndex('extractedAt', 'extractedAt', { unique: false });
      rawStore.createIndex('constituency', 'constituency', { unique: false });
    }

    // snapshots store
    if (!db.objectStoreNames.contains(STORES.SNAPSHOTS)) {
      const snapStore = db.createObjectStore(STORES.SNAPSHOTS, { keyPath: 'id' });
      snapStore.createIndex('constituency', 'constituency', { unique: false });
      snapStore.createIndex('date', 'date', { unique: false });
    }

    // trends store
    if (!db.objectStoreNames.contains(STORES.TRENDS)) {
      const trendStore = db.createObjectStore(STORES.TRENDS, { keyPath: 'id' });
      trendStore.createIndex('constituency', 'constituency', { unique: false });
      trendStore.createIndex('date', 'date', { unique: false });
    }

    // config store
    if (!db.objectStoreNames.contains(STORES.CONFIG)) {
      db.createObjectStore(STORES.CONFIG, { keyPath: 'key' });
    }
  });

  return _db;
}

/**
 * Save an array of raw posts. Auto-generates UUIDs for each.
 * @param {Array<Object>} posts
 * @returns {Promise<number>} Number of posts saved
 */
async function savePosts(posts) {
  const db = await initDB();
  const { tx, store } = getStore(db, STORES.RAW_POSTS, 'readwrite');

  let count = 0;
  for (const post of posts) {
    const record = {
      ...post,
      id: post.id || generateUUID(),
      extractedAt: post.extractedAt || new Date().toISOString(),
    };
    store.put(record);
    count++;
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(count);
    tx.onerror = () => reject(new Error(`savePosts failed: ${tx.error?.message}`));
  });
}

/**
 * Get posts filtered by platform and optional since-date.
 * @param {string} platform - e.g. 'reddit', 'facebook', 'twitter', 'instagram'
 * @param {string|Date} [since] - ISO date string or Date, only return posts after this
 * @returns {Promise<Array>}
 */
async function getPostsByPlatform(platform, since) {
  const db = await initDB();
  const all = await getAll(db, STORES.RAW_POSTS);
  const sinceMs = since ? new Date(since).getTime() : 0;

  return all.filter((p) => {
    if (p.platform !== platform) return false;
    if (sinceMs && new Date(p.extractedAt).getTime() < sinceMs) return false;
    return true;
  });
}

/**
 * Get posts filtered by constituency and optional since-date.
 * @param {string} constituency
 * @param {string|Date} [since]
 * @returns {Promise<Array>}
 */
async function getPostsByConstituency(constituency, since) {
  const db = await initDB();
  const all = await getAll(db, STORES.RAW_POSTS);
  const sinceMs = since ? new Date(since).getTime() : 0;
  const key = constituency.toLowerCase();

  return all.filter((p) => {
    if ((p.constituency || '').toLowerCase() !== key) return false;
    if (sinceMs && new Date(p.extractedAt).getTime() < sinceMs) return false;
    return true;
  });
}

/**
 * Get all posts, optionally since a date.
 * @param {string|Date} [since]
 * @returns {Promise<Array>}
 */
async function getAllPosts(since) {
  const db = await initDB();
  const all = await getAll(db, STORES.RAW_POSTS);

  if (!since) return all;

  const sinceMs = new Date(since).getTime();
  return all.filter((p) => new Date(p.extractedAt).getTime() >= sinceMs);
}

/**
 * Save a dated sentiment snapshot for a constituency.
 * @param {string} constituency
 * @param {Object} sentimentData
 * @returns {Promise<IDBValidKey>}
 */
async function saveSnapshot(constituency, sentimentData) {
  const db = await initDB();
  const today = formatDate(new Date());
  const record = {
    id: `${constituency.toLowerCase()}_${today}`,
    constituency: constituency.toLowerCase(),
    date: today,
    data: sentimentData,
    createdAt: new Date().toISOString(),
  };
  return put(db, STORES.SNAPSHOTS, record);
}

/**
 * Get all snapshots for a constituency, sorted by date ascending.
 * @param {string} constituency
 * @returns {Promise<Array>}
 */
async function getSnapshots(constituency) {
  const db = await initDB();
  const all = await getAll(db, STORES.SNAPSHOTS);
  const key = constituency.toLowerCase();

  return all
    .filter((s) => s.constituency === key)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Get the most recent snapshot for a constituency.
 * @param {string} constituency
 * @returns {Promise<Object|null>}
 */
async function getLatestSnapshot(constituency) {
  const snapshots = await getSnapshots(constituency);
  return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
}

/**
 * Save a daily trend data point.
 * @param {string} constituency
 * @param {string} front - 'LDF', 'UDF', or 'NDA'
 * @param {string} date - YYYY-MM-DD
 * @param {number} score
 * @returns {Promise<IDBValidKey>}
 */
async function saveTrend(constituency, front, date, score) {
  const db = await initDB();
  const key = constituency.toLowerCase();
  const record = {
    id: `${key}_${front}_${date}`,
    constituency: key,
    front,
    date,
    score,
    createdAt: new Date().toISOString(),
  };
  return put(db, STORES.TRENDS, record);
}

/**
 * Get trend data for a constituency over the last N days.
 * @param {string} constituency
 * @param {number} [days=30]
 * @returns {Promise<Array>}
 */
async function getTrends(constituency, days) {
  days = days || 30;
  const db = await initDB();
  const all = await getAll(db, STORES.TRENDS);
  const key = constituency.toLowerCase();
  const cutoff = formatDate(Date.now() - days * 86400000);

  return all
    .filter((t) => t.constituency === key && t.date >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Get a config value by key.
 * @param {string} key
 * @returns {Promise<*>} The value, or undefined
 */
async function getConfig(key) {
  const db = await initDB();
  const record = await get(db, STORES.CONFIG, key);
  return record ? record.value : undefined;
}

/**
 * Set a config value.
 * @param {string} key
 * @param {*} value
 * @returns {Promise<IDBValidKey>}
 */
async function setConfig(key, value) {
  const db = await initDB();
  return put(db, STORES.CONFIG, { key, value, updatedAt: new Date().toISOString() });
}

/**
 * Delete posts older than N days.
 * @param {number} [daysToKeep=90]
 * @returns {Promise<number>} Number of deleted records
 */
async function clearOldPosts(daysToKeep) {
  daysToKeep = daysToKeep || 90;
  const db = await initDB();
  const all = await getAll(db, STORES.RAW_POSTS);
  const cutoffMs = Date.now() - daysToKeep * 86400000;

  const toDelete = all.filter((p) => new Date(p.extractedAt).getTime() < cutoffMs);

  if (toDelete.length === 0) return 0;

  const { tx, store } = getStore(db, STORES.RAW_POSTS, 'readwrite');
  for (const post of toDelete) {
    store.delete(post.id);
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(toDelete.length);
    tx.onerror = () => reject(new Error(`clearOldPosts failed: ${tx.error?.message}`));
  });
}

/**
 * Return collection statistics: counts per platform, total posts, date range.
 * @returns {Promise<Object>}
 */
async function getStats() {
  const db = await initDB();
  const all = await getAll(db, STORES.RAW_POSTS);

  const stats = {
    total: all.length,
    byPlatform: {},
    dateRange: { from: null, to: null },
  };

  if (all.length === 0) return stats;

  let minDate = Infinity;
  let maxDate = -Infinity;

  for (const post of all) {
    // Count by platform
    const plat = post.platform || 'unknown';
    stats.byPlatform[plat] = (stats.byPlatform[plat] || 0) + 1;

    // Track date range
    const ts = new Date(post.extractedAt).getTime();
    if (ts < minDate) minDate = ts;
    if (ts > maxDate) maxDate = ts;
  }

  stats.dateRange.from = new Date(minDate).toISOString();
  stats.dateRange.to = new Date(maxDate).toISOString();

  return stats;
}

// ─── Date & Comment Query Functions ───────────────────────────────────

/**
 * Get posts filtered by a specific date (YYYY-MM-DD).
 * Matches on the date portion of the extractedAt ISO string.
 * @param {string} date - Date string in YYYY-MM-DD format
 * @returns {Promise<Array>}
 */
async function getPostsByDate(date) {
  const db = await initDB();
  const all = await getAll(db, STORES.RAW_POSTS);

  return all.filter((p) => {
    const postDate = (p.extractedAt || '').split('T')[0];
    return postDate === date;
  });
}

/**
 * Get posts with type='post' joined with their comments.
 * Comments are matched to parent posts via parentPostUrl matching the post's url.
 * @returns {Promise<Array<Object>>} Array of posts, each with a .comments array
 */
async function getPostsWithComments() {
  const db = await initDB();
  const all = await getAll(db, STORES.RAW_POSTS);

  // Separate posts and comments
  const posts = all.filter((p) => p.type !== 'comment');
  const comments = all.filter((p) => p.type === 'comment');

  // Index comments by parentPostUrl
  const commentsByParent = {};
  for (const comment of comments) {
    if (comment.parentPostUrl) {
      if (!commentsByParent[comment.parentPostUrl]) {
        commentsByParent[comment.parentPostUrl] = [];
      }
      commentsByParent[comment.parentPostUrl].push(comment);
    }
  }

  // Join comments to their parent posts
  return posts.map((post) => ({
    ...post,
    comments: (post.url && commentsByParent[post.url]) || [],
  }));
}

/**
 * Save a daily snapshot for a constituency with a specific date.
 * Key format: {constituency}_{date}
 * @param {string} constituency
 * @param {string} date - YYYY-MM-DD
 * @param {Object} data - The snapshot data to save
 * @returns {Promise<IDBValidKey>}
 */
async function saveDailySnapshot(constituency, date, data) {
  const db = await initDB();
  const key = constituency.toLowerCase();
  const record = {
    id: `${key}_${date}`,
    constituency: key,
    date,
    data,
    createdAt: new Date().toISOString(),
  };
  return put(db, STORES.SNAPSHOTS, record);
}

/**
 * Get the last N daily snapshots for a constituency, sorted by date descending.
 * @param {string} constituency
 * @param {number} [limit=7] - Maximum number of snapshots to return
 * @returns {Promise<Array>}
 */
async function getDailySnapshots(constituency, limit) {
  limit = limit || 7;
  const db = await initDB();
  const all = await getAll(db, STORES.SNAPSHOTS);
  const key = constituency.toLowerCase();

  return all
    .filter((s) => s.constituency === key)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}
