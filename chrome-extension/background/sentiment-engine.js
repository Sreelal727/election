/**
 * Keyword-Based Sentiment Scoring Engine
 *
 * Scores social media posts for political sentiment (LDF/UDF/NDA)
 * using keyword matching with engagement and recency weighting.
 *
 * Kerala 2026 Election Sentiment Chrome Extension
 */

'use strict';

let _keywords = null;

/**
 * Load keyword dictionaries from extension assets.
 * Caches after first load.
 * @returns {Promise<Object>} Combined keywords object
 */
async function loadKeywords() {
  if (_keywords) return _keywords;

  try {
    const [englishResp, malayalamResp] = await Promise.allSettled([
      fetch(chrome.runtime.getURL('keywords/english.json')),
      fetch(chrome.runtime.getURL('keywords/malayalam.json')),
    ]);

    let english = {};
    let malayalam = {};

    if (englishResp.status === 'fulfilled' && englishResp.value.ok) {
      english = await englishResp.value.json();
    } else {
      console.warn('[SentimentBG] Failed to load english.json');
    }

    if (malayalamResp.status === 'fulfilled' && malayalamResp.value.ok) {
      malayalam = await malayalamResp.value.json();
    } else {
      console.warn('[SentimentBG] malayalam.json not available, using English only');
    }

    _keywords = {
      english,
      malayalam,
      // Merge for convenience: all fronts from both languages
      combined: _mergeKeywords(english, malayalam),
    };

    console.log('[SentimentBG] Keywords loaded successfully');
    return _keywords;
  } catch (err) {
    console.error('[SentimentBG] Error loading keywords:', err);
    throw err;
  }
}

/**
 * Merge English and Malayalam keyword sets into a single lookup.
 * @param {Object} english
 * @param {Object} malayalam
 * @returns {Object}
 */
function _mergeKeywords(english, malayalam) {
  const merged = {};
  const categories = [
    'pro_LDF', 'anti_LDF',
    'pro_UDF', 'anti_UDF',
    'pro_NDA', 'anti_NDA',
  ];

  for (const cat of categories) {
    merged[cat] = {
      strong: [
        ...((english[cat] && english[cat].strong) || []),
        ...((malayalam[cat] && malayalam[cat].strong) || []),
      ],
      moderate: [
        ...((english[cat] && english[cat].moderate) || []),
        ...((malayalam[cat] && malayalam[cat].moderate) || []),
      ],
    };
  }

  // Merge issues
  merged.issues = {};
  const engIssues = english.issues || {};
  const malIssues = malayalam.issues || {};
  const allIssueKeys = new Set([...Object.keys(engIssues), ...Object.keys(malIssues)]);
  for (const key of allIssueKeys) {
    merged.issues[key] = [
      ...(engIssues[key] || []),
      ...(malIssues[key] || []),
    ];
  }

  // Merge candidates
  merged.candidates = { ...(english.candidates || {}), ...(malayalam.candidates || {}) };

  // Merge manglish
  merged.manglish = english.manglish || malayalam.manglish || {};

  return merged;
}

/**
 * Score a single post for LDF/UDF/NDA sentiment.
 *
 * Algorithm:
 *   For each front:
 *     pro_score  = count(strong pro) * 1.0 + count(moderate pro) * 0.5
 *     anti_score = count(strong anti) * 1.0 + count(moderate anti) * 0.5
 *     base_score = clamp(pro_score - anti_score, -2, +2)
 *     engagement_multiplier = min(1.5, log10(1 + engagement) / 3)
 *     recency_weight = 1.0 if <= 7d, 0.7 if <= 30d, 0.4 if <= 90d, else 0.1
 *     final_score = base_score * engagement_multiplier * recency_weight
 *
 * @param {Object} post - Must have: text, timestamp (ms or ISO), engagement (number)
 * @param {Object} keywords - The combined keywords object
 * @returns {Object} { LDF, UDF, NDA, issues, isMeme }
 */
function scorePost(post, keywords) {
  const combined = keywords.combined || keywords;
  const text = normalizeText(post.text || '');
  const fronts = ['LDF', 'UDF', 'NDA'];
  const scores = {};

  // Score each front
  for (const front of fronts) {
    const proKey = `pro_${front}`;
    const antiKey = `anti_${front}`;

    const proData = combined[proKey] || { strong: [], moderate: [] };
    const antiData = combined[antiKey] || { strong: [], moderate: [] };

    const proStrong = _countMatches(text, proData.strong);
    const proModerate = _countMatches(text, proData.moderate);
    const antiStrong = _countMatches(text, antiData.strong);
    const antiModerate = _countMatches(text, antiData.moderate);

    const proScore = proStrong * 1.0 + proModerate * 0.5;
    const antiScore = antiStrong * 1.0 + antiModerate * 0.5;

    // Base score capped to [-2, +2]
    const baseScore = Math.max(-2, Math.min(2, proScore - antiScore));

    // Engagement multiplier
    const engagement = post.engagement || 0;
    const engagementMultiplier = Math.min(1.5, Math.log10(1 + engagement) / 3);

    // Recency weight
    const postTime = typeof post.timestamp === 'string'
      ? new Date(post.timestamp).getTime()
      : (post.timestamp || Date.now());
    const recencyDays = (Date.now() - postTime) / 86400000;
    let recencyWeight;
    if (recencyDays <= 7) {
      recencyWeight = 1.0;
    } else if (recencyDays <= 30) {
      recencyWeight = 0.7;
    } else if (recencyDays <= 90) {
      recencyWeight = 0.4;
    } else {
      recencyWeight = 0.1;
    }

    scores[front] = baseScore * engagementMultiplier * recencyWeight;
  }

  // Detect issues and meme status
  const issues = detectIssues(text, combined);
  const isMeme = detectMeme(post, combined);

  return {
    LDF: Math.round(scores.LDF * 1000) / 1000,
    UDF: Math.round(scores.UDF * 1000) / 1000,
    NDA: Math.round(scores.NDA * 1000) / 1000,
    issues,
    isMeme,
  };
}

/**
 * Count keyword matches in text. Case-insensitive whole-word-ish matching.
 * @param {string} text - Normalized text
 * @param {Array<string>} keywords - Keyword list
 * @returns {number}
 */
function _countMatches(text, keywords) {
  let count = 0;
  for (const kw of keywords) {
    const pattern = kw.toLowerCase();
    if (text.includes(pattern)) {
      count++;
    }
  }
  return count;
}

/**
 * Detect if a post is likely a meme.
 * Heuristics:
 *  - Short text (<100 chars) with political keywords and high engagement
 *  - From known meme pages/accounts
 * @param {Object} post
 * @param {Object} keywords
 * @returns {boolean}
 */
function detectMeme(post, keywords) {
  const text = (post.text || '').trim();

  // Known meme page indicators
  const memePagePatterns = [
    'troll', 'meme', 'trollan', 'icuchalu', 'icu', 'political troll',
    'trollrepublic', 'trollmalayalam', 'international chalu union',
  ];
  const source = ((post.author || '') + ' ' + (post.source || '')).toLowerCase();
  for (const pattern of memePagePatterns) {
    if (source.includes(pattern)) return true;
  }

  // Short text with political keywords + high engagement
  if (text.length < 100 && (post.engagement || 0) > 50) {
    const combined = keywords.combined || keywords;
    const normalizedText = normalizeText(text);
    const allPoliticalKeywords = [
      ...((combined.pro_LDF || {}).strong || []),
      ...((combined.pro_UDF || {}).strong || []),
      ...((combined.pro_NDA || {}).strong || []),
      ...((combined.anti_LDF || {}).strong || []),
      ...((combined.anti_UDF || {}).strong || []),
      ...((combined.anti_NDA || {}).strong || []),
    ];
    const hasKeyword = allPoliticalKeywords.some((kw) =>
      normalizedText.includes(kw.toLowerCase())
    );
    if (hasKeyword) return true;
  }

  // Image-heavy post flagged as meme by content script
  if (post.isMeme || post.type === 'meme') return true;

  return false;
}

/**
 * Detect issue categories mentioned in text.
 * @param {string} text - Raw or normalized text
 * @param {Object} keywords - Combined keywords with issues property
 * @returns {Array<string>} Matched issue category names
 */
function detectIssues(text, keywords) {
  const issues = (keywords.combined || keywords).issues || {};
  const normalizedText = normalizeText(text);
  const matched = [];

  for (const [category, terms] of Object.entries(issues)) {
    for (const term of terms) {
      if (normalizedText.includes(term.toLowerCase())) {
        matched.push(category);
        break; // One match per category is enough
      }
    }
  }

  return matched;
}

/**
 * Try to match text to a constituency based on candidate names/aliases and location keywords.
 * @param {string} text
 * @param {Object} candidates - candidates dict from keywords: { constituency: { front: [aliases] } }
 * @returns {string|null} Matched constituency key or null
 */
function detectConstituency(text, candidates) {
  if (!candidates) return null;
  const normalizedText = normalizeText(text);

  for (const [constituency, fronts] of Object.entries(candidates)) {
    for (const [, aliases] of Object.entries(fronts)) {
      for (const alias of aliases) {
        if (normalizedText.includes(alias.toLowerCase())) {
          return constituency;
        }
      }
    }
  }

  // Location keyword fallback
  const locationMap = {
    kochi: ['kochi', 'cochin', 'fort kochi', 'ernakulam', 'mattancherry', 'willingdon island'],
    kalamassery: ['kalamassery', 'kalamasseri', 'cusat', 'eloor', 'hmt junction', 'cochin shipyard'],
  };

  for (const [constituency, locations] of Object.entries(locationMap)) {
    for (const loc of locations) {
      if (normalizedText.includes(loc)) {
        return constituency;
      }
    }
  }

  return null;
}

/**
 * Check if text contains Malayalam Unicode characters (range U+0D00 - U+0D7F).
 * @param {string} text
 * @returns {boolean}
 */
function containsMalayalam(text) {
  return /[\u0D00-\u0D7F]/.test(text);
}

/**
 * Normalize text: lowercase, collapse whitespace, strip extra punctuation noise.
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/["""'']/g, '"')
    .trim();
}

// ─── Comment-Level Sentiment Scoring ──────────────────────────────────

/**
 * Score a comment and classify its reaction relative to the parent post.
 *
 * @param {Object} comment - Comment object with text, timestamp, engagement
 * @param {Object|null} postScore - Parent post's scores { LDF, UDF, NDA } or null if unknown
 * @param {Object} keywords - The combined keywords object
 * @returns {Object} { scores: {LDF, UDF, NDA}, reaction: string, issues: Array }
 */
function scoreComment(comment, postScore, keywords) {
  // Score the comment text the same way as a post
  const commentScores = scorePost(comment, keywords);

  // Classify the reaction relative to the parent post
  const reaction = postScore
    ? classifyReaction(commentScores, postScore, comment.text || '')
    : 'neutral';

  return {
    scores: {
      LDF: commentScores.LDF,
      UDF: commentScores.UDF,
      NDA: commentScores.NDA,
    },
    reaction,
    issues: commentScores.issues || [],
  };
}

/**
 * Classify a comment's reaction relative to its parent post's sentiment.
 *
 * Categories:
 *   - supportive: comment sentiment aligns with post sentiment (same sign for same front)
 *   - against: comment sentiment opposes post sentiment (opposite sign)
 *   - neutral: comment has no clear sentiment (abs score < 0.1)
 *   - counter_narrative: comment explicitly argues against the post
 *     (strong opposite + contains argumentative words)
 *
 * @param {Object} commentScore - { LDF, UDF, NDA, ... } from scorePost
 * @param {Object} postScore - { LDF, UDF, NDA, ... } from parent post
 * @param {string} commentText - Raw comment text for counter-narrative detection
 * @returns {string} 'supportive' | 'against' | 'neutral' | 'counter_narrative'
 */
function classifyReaction(commentScore, postScore, commentText) {
  const fronts = ['LDF', 'UDF', 'NDA'];

  // Find the dominant front in the post (highest absolute score)
  let dominantFront = 'LDF';
  let maxAbsScore = 0;
  for (const front of fronts) {
    const absScore = Math.abs(postScore[front] || 0);
    if (absScore > maxAbsScore) {
      maxAbsScore = absScore;
      dominantFront = front;
    }
  }

  const postVal = postScore[dominantFront] || 0;
  const commentVal = commentScore[dominantFront] || 0;

  // Check if comment has any meaningful sentiment
  const totalAbsComment = fronts.reduce((sum, f) => sum + Math.abs(commentScore[f] || 0), 0);
  if (totalAbsComment < 0.1) {
    return 'neutral';
  }

  // Check for counter-narrative: strong opposition + argumentative language
  const counterNarrativeWords = [
    'no', 'wrong', 'false', 'but', 'however', 'actually',
    'alla', 'thettanu', // Malayalam for "no" and "wrong"
    'not true', 'disagree', 'nonsense', 'rubbish', 'fake',
    'athu sheri alla', 'sheriyalla', // Malayalam "that's not right"
  ];

  const normalizedComment = normalizeText(commentText);
  const hasArgumentativeLanguage = counterNarrativeWords.some((w) =>
    normalizedComment.includes(w.toLowerCase())
  );

  // Strong opposition: opposite signs and significant magnitude
  const isStrongOpposition = (postVal > 0.1 && commentVal < -0.1) ||
    (postVal < -0.1 && commentVal > 0.1);

  if (isStrongOpposition && hasArgumentativeLanguage) {
    return 'counter_narrative';
  }

  // Against: opposite signs
  if (isStrongOpposition) {
    return 'against';
  }

  // Supportive: same sign for dominant front
  if ((postVal > 0 && commentVal > 0) || (postVal < 0 && commentVal < 0)) {
    return 'supportive';
  }

  return 'neutral';
}
