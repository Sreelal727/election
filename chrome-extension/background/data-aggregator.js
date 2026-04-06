/**
 * Data Aggregator
 *
 * Transforms scored posts into the exact sentiment_data.json format
 * matching the Python backend output from sentiment_collector.py.
 *
 * Kerala 2026 Election Sentiment Chrome Extension
 */

'use strict';

const PLATFORM_WEIGHTS = {
  reddit: 0.10,
  facebook: 0.10,
  twitter: 0.05,
  instagram: 0.20,
};
const MEME_WEIGHT = 0.10;
const GROUND_WEIGHT = 0.45;
const MAX_ADJUSTMENT = 3.0;

const FRONTS = ['LDF', 'UDF', 'NDA'];

/**
 * Group scored posts by platform and compute per-front sentiment stats.
 * @param {Array<Object>} scoredPosts - Posts with .scores { LDF, UDF, NDA }, .platform, .issues, etc.
 * @returns {Object} Keyed by platform, each containing front_sentiment with score/mentions/themes/samples
 */
function aggregateByPlatform(scoredPosts) {
  const grouped = {};

  for (const post of scoredPosts) {
    const plat = (post.platform || 'unknown').toLowerCase();
    if (!grouped[plat]) grouped[plat] = [];
    grouped[plat].push(post);
  }

  const result = {};

  for (const [platform, posts] of Object.entries(grouped)) {
    const frontSentiment = {};

    for (const front of FRONTS) {
      const scores = posts.map((p) => (p.scores || p)[front] || 0);
      const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      const clampedScore = Math.max(-1.0, Math.min(1.0, Math.round(avg * 1000) / 1000));

      let positive = 0;
      let negative = 0;
      let neutral = 0;
      for (const s of scores) {
        if (s > 0.1) positive++;
        else if (s < -0.1) negative++;
        else neutral++;
      }

      // Key themes: top 5 issues by frequency across all posts
      const issueCounts = {};
      for (const post of posts) {
        const issues = post.issues || (post.scores && post.scores.issues) || [];
        for (const issue of issues) {
          issueCounts[issue] = (issueCounts[issue] || 0) + 1;
        }
      }
      const keyThemes = Object.entries(issueCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([theme]) => theme);

      // Sample posts: top 3 by engagement
      const sorted = [...posts]
        .sort((a, b) => (b.engagement || 0) - (a.engagement || 0))
        .slice(0, 3);
      const samplePosts = sorted.map((p) => ({
        text: (p.text || '').substring(0, 200),
        url: p.url || '',
        engagement: p.engagement || 0,
      }));

      frontSentiment[front] = {
        score: clampedScore,
        positive_mentions: positive,
        negative_mentions: negative,
        neutral_mentions: neutral,
        key_themes: keyThemes,
        sample_posts: samplePosts,
      };
    }

    result[platform] = {
      sample_size: posts.length,
      date_range: _getDateRange(posts),
      front_sentiment: frontSentiment,
    };
  }

  return result;
}

/**
 * Extract and aggregate meme-flagged posts.
 * @param {Array<Object>} scoredPosts
 * @param {string} [constituency] - Constituency key for constituency-specific section
 * @returns {Object} Meme sentiment data matching the JSON format
 */
function aggregateMemes(scoredPosts, constituency) {
  const memes = scoredPosts.filter((p) => p.isMeme || (p.scores && p.scores.isMeme));

  const ernakulamTargeted = {
    total: memes.length,
    pro_LDF: 0,
    pro_UDF: 0,
    pro_NDA: 0,
    anti_LDF: 0,
    anti_UDF: 0,
    anti_NDA: 0,
    neutral_political: 0,
    viral_memes: [],
  };

  let neutralCount = 0;

  for (const meme of memes) {
    const scores = meme.scores || meme;
    let hasSignal = false;

    for (const front of FRONTS) {
      const s = scores[front] || 0;
      if (s > 0.1) {
        ernakulamTargeted[`pro_${front}`]++;
        hasSignal = true;
      } else if (s < -0.1) {
        ernakulamTargeted[`anti_${front}`]++;
        hasSignal = true;
      }
    }

    if (!hasSignal) {
      neutralCount++;
    }

    // Track viral memes (high engagement)
    if ((meme.engagement || 0) > 500 && ernakulamTargeted.viral_memes.length < 10) {
      ernakulamTargeted.viral_memes.push({
        text: (meme.text || '').substring(0, 200),
        url: meme.url || '',
        engagement: meme.engagement || 0,
        platform: meme.platform || '',
      });
    }
  }

  ernakulamTargeted.neutral_political = neutralCount;

  // Constituency-specific meme breakdown
  const constituencyKey = (constituency || 'kochi').toLowerCase();
  const constituencyMemes = memes.filter((m) => {
    const mc = (m.constituency || '').toLowerCase();
    return mc === constituencyKey || mc === '';
  });

  const constituencySpecific = {
    total: constituencyMemes.length,
    candidate_memes: {},
    development_memes: 0,
    corruption_memes: 0,
    communal_memes: 0,
  };

  for (const meme of constituencyMemes) {
    const issues = meme.issues || (meme.scores && meme.scores.issues) || [];
    if (issues.includes('development')) constituencySpecific.development_memes++;
    if (issues.includes('corruption')) constituencySpecific.corruption_memes++;
    if (issues.includes('communal_harmony')) constituencySpecific.communal_memes++;
  }

  const result = {
    platforms_tracked: ['Instagram', 'Facebook', 'Twitter/X', 'WhatsApp_groups'],
    total_memes_analyzed: memes.length,
    date_range: _getDateRange(memes),
    ernakulam_targeted: ernakulamTargeted,
  };
  result[`${constituencyKey}_specific`] = constituencySpecific;

  return result;
}

/**
 * Compute vote share adjustment from platform and meme data.
 * EXACT port of Python compute_sentiment_score from sentiment_collector.py.
 *
 * @param {Object} platformData - Output of aggregateByPlatform
 * @param {Object} [memeData] - Output of aggregateMemes
 * @param {Object} [groundReports] - Ground reports data with candidate_visibility
 * @returns {Object} { LDF_adjustment, UDF_adjustment, NDA_adjustment, confidence, methodology }
 */
function computeSentimentAdjustment(platformData, memeData, groundReports) {
  const adjustments = { LDF: 0.0, UDF: 0.0, NDA: 0.0 };
  let weightsUsed = 0.0;

  // Platform sentiments with individual weights
  const platformKeyMap = {
    reddit: 'reddit',
    facebook: 'facebook',
    twitter: 'twitter',
    instagram: 'instagram',
  };

  for (const [platformKey, weight] of Object.entries(PLATFORM_WEIGHTS)) {
    const data = platformData[platformKey];
    if (!data || !data.front_sentiment) continue;

    const fs = data.front_sentiment;
    const hasData = FRONTS.some((f) => fs[f] && fs[f].score !== 0);
    if (!hasData) continue;

    for (const front of FRONTS) {
      const score = (fs[front] && fs[front].score) || 0;
      adjustments[front] += score * MAX_ADJUSTMENT * weight;
    }
    weightsUsed += weight;
  }

  // Meme sentiment (weight: 0.10)
  if (memeData) {
    const ernakulam = memeData.ernakulam_targeted || {};
    const totalMemes = ernakulam.total || 0;
    if (totalMemes > 0) {
      for (const front of FRONTS) {
        const pro = ernakulam[`pro_${front}`] || 0;
        const anti = ernakulam[`anti_${front}`] || 0;
        const net = (pro - anti) / totalMemes;
        adjustments[front] += net * MAX_ADJUSTMENT * MEME_WEIGHT;
      }
      weightsUsed += MEME_WEIGHT;
    }
  }

  // Ground reports (weight: 0.45) — rally_share proxy, same as Python
  if (groundReports) {
    const vis = groundReports.candidate_visibility || {};
    const totalRallies = FRONTS.reduce(
      (sum, f) => sum + ((vis[f] && vis[f].rallies) || 0),
      0
    );
    if (totalRallies > 0) {
      for (const front of FRONTS) {
        const rallyShare = ((vis[front] && vis[front].rallies) || 0) / totalRallies;
        adjustments[front] += (rallyShare - 0.33) * MAX_ADJUSTMENT * GROUND_WEIGHT;
      }
      weightsUsed += GROUND_WEIGHT;
    }
  }

  // Normalize if partial data (same logic as Python)
  if (weightsUsed > 0 && weightsUsed < 1.0) {
    for (const front of FRONTS) {
      adjustments[front] = (adjustments[front] / weightsUsed) * weightsUsed;
    }
  }

  // Confidence level
  let confidence;
  if (weightsUsed >= 0.7) {
    confidence = 'high';
  } else if (weightsUsed >= 0.4) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // Clamp all adjustments to [-3.0, +3.0]
  for (const front of FRONTS) {
    adjustments[front] = Math.max(
      -MAX_ADJUSTMENT,
      Math.min(MAX_ADJUSTMENT, Math.round(adjustments[front] * 100) / 100)
    );
  }

  return {
    LDF_adjustment: adjustments.LDF,
    UDF_adjustment: adjustments.UDF,
    NDA_adjustment: adjustments.NDA,
    confidence,
    weights_used: Math.round(weightsUsed * 100) / 100,
    methodology:
      'Weighted average: Reddit(0.10) + Facebook(0.10) + Twitter(0.05) + Instagram(0.20) + Memes(0.10) + GroundReports(0.45)',
  };
}

/**
 * Build the full sentiment_data.json object matching the Python backend structure.
 *
 * @param {string} constituency - e.g. 'kochi', 'kalamassery'
 * @param {Object} platformData - Output of aggregateByPlatform
 * @param {Object} memeData - Output of aggregateMemes
 * @param {Object} adjustment - Output of computeSentimentAdjustment
 * @param {Object} [groundReports] - Ground reports data
 * @returns {Object} Full sentiment_data JSON
 */
function buildSentimentJSON(constituency, platformData, memeData, adjustment, groundReports) {
  const now = new Date().toISOString();
  const name = constituency.charAt(0).toUpperCase() + constituency.slice(1).toLowerCase();

  // Helper: build platform section
  function buildPlatformSection(key, extra) {
    const data = platformData[key] || {};
    const frontSentiment = {};
    for (const front of FRONTS) {
      frontSentiment[front] = (data.front_sentiment && data.front_sentiment[front]) || {
        score: 0.0,
        positive_mentions: 0,
        negative_mentions: 0,
        neutral_mentions: 0,
        key_themes: [],
        sample_posts: [],
      };
    }
    return {
      ...extra,
      sample_size: data.sample_size || 0,
      date_range: data.date_range || { from: '', to: '' },
      front_sentiment: frontSentiment,
    };
  }

  // Build crowd reaction data per front
  const crowdReactionByFront = _computeCrowdReactionByFront(platformData);

  // Build daily snapshots (last 7 days)
  const dailySnapshots = _buildRecentDailySnapshots(platformData);

  // Build narrative gaps
  const narrativeGaps = _findNarrativeGaps(platformData);

  const result = {
    meta: {
      constituency: name,
      district: 'Ernakulam',
      last_updated: now,
      collection_method: 'chrome_extension',
      notes: 'Sentiment scores: -1.0 (strongly negative) to +1.0 (strongly positive)',
    },

    reddit_sentiment: buildPlatformSection('reddit', {
      subreddits_tracked: ['r/Kerala', 'r/Kochi', 'r/india'],
      topics: [],
    }),

    facebook_sentiment: buildPlatformSection('facebook', {
      pages_tracked: [],
      groups_tracked: [],
    }),

    twitter_sentiment: buildPlatformSection('twitter', {
      handles_tracked: [],
      hashtags_tracked: [],
    }),

    instagram_sentiment: buildPlatformSection('instagram', {
      hashtags_tracked: [],
      pages_tracked: [],
    }),

    meme_sentiment: memeData || {
      platforms_tracked: ['Instagram', 'Facebook', 'Twitter/X', 'WhatsApp_groups'],
      total_memes_analyzed: 0,
      date_range: { from: '', to: '' },
      ernakulam_targeted: {
        total: 0,
        pro_LDF: 0, pro_UDF: 0, pro_NDA: 0,
        anti_LDF: 0, anti_UDF: 0, anti_NDA: 0,
        neutral_political: 0,
        viral_memes: [],
      },
    },

    social_media_general: {
      candidate_followings: {},
      trending_hashtags: _extractTrendingHashtags(platformData),
      issue_sentiment: _computeIssueSentiment(platformData),
    },

    ground_reports: groundReports || {
      booth_level_intel: [],
      local_events: [],
      candidate_visibility: {
        LDF: { rallies: 0, door_to_door: '', media_presence: '' },
        UDF: { rallies: 0, door_to_door: '', media_presence: '' },
        NDA: { rallies: 0, door_to_door: '', media_presence: '' },
      },
    },

    computed_sentiment_adjustment: {
      LDF_adjustment: adjustment.LDF_adjustment || 0.0,
      UDF_adjustment: adjustment.UDF_adjustment || 0.0,
      NDA_adjustment: adjustment.NDA_adjustment || 0.0,
      confidence: adjustment.confidence || 'low',
      methodology: adjustment.methodology ||
        'Weighted average: Reddit(0.10) + Facebook(0.10) + Twitter(0.05) + Instagram(0.20) + Memes(0.10) + GroundReports(0.45)',
    },

    crowd_reaction: crowdReactionByFront,

    daily_snapshots: dailySnapshots,

    narrative_gaps: narrativeGaps,
  };

  return result;
}

/**
 * Export data as a JSON file download via chrome.downloads or blob URL.
 * @param {Object} data - The full sentiment JSON
 * @param {string} [filename] - Optional filename override
 * @returns {Promise<void>}
 */
async function exportToJSON(data, filename) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const defaultFilename = filename ||
    `sentiment_data_${data.meta?.constituency?.toLowerCase() || 'export'}_${_todayStr()}.json`;

  if (typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.download) {
    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: url,
          filename: defaultFilename,
          saveAs: true,
        },
        (downloadId) => {
          URL.revokeObjectURL(url);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            console.log(`[SentimentBG] Export started, download ID: ${downloadId}`);
            resolve(downloadId);
          }
        }
      );
    });
  } else {
    // Fallback: send URL to popup/content script for download
    console.warn('[SentimentBG] chrome.downloads not available, returning blob URL');
    return { url, filename: defaultFilename };
  }
}

// --- Internal helpers ---

/**
 * Get date range from an array of posts.
 * @param {Array<Object>} posts
 * @returns {{ from: string, to: string }}
 */
function _getDateRange(posts) {
  if (!posts || posts.length === 0) return { from: '', to: '' };

  let min = Infinity;
  let max = -Infinity;

  for (const p of posts) {
    const ts = new Date(p.extractedAt || p.timestamp || 0).getTime();
    if (ts < min) min = ts;
    if (ts > max) max = ts;
  }

  return {
    from: new Date(min).toISOString().split('T')[0],
    to: new Date(max).toISOString().split('T')[0],
  };
}

/**
 * Get today as YYYY-MM-DD.
 * @returns {string}
 */
function _todayStr() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Extract trending hashtags from all platform data.
 * @param {Object} platformData
 * @returns {Array<string>}
 */
function _extractTrendingHashtags(platformData) {
  const tagCounts = {};
  for (const plat of Object.values(platformData)) {
    if (!plat.front_sentiment) continue;
    for (const front of FRONTS) {
      const themes = (plat.front_sentiment[front] && plat.front_sentiment[front].key_themes) || [];
      for (const theme of themes) {
        tagCounts[theme] = (tagCounts[theme] || 0) + 1;
      }
    }
  }
  return Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag]) => tag);
}

/**
 * Compute issue-level sentiment across all platforms.
 * @param {Object} platformData
 * @returns {Object}
 */
function _computeIssueSentiment(platformData) {
  const issueCategories = ['development', 'corruption', 'employment', 'welfare', 'communal_harmony'];
  const result = {};

  for (const category of issueCategories) {
    // Find which front dominates mentions of this issue
    const frontMentions = { LDF: 0, UDF: 0, NDA: 0 };
    const frontScoreSum = { LDF: 0, UDF: 0, NDA: 0 };

    for (const plat of Object.values(platformData)) {
      if (!plat.front_sentiment) continue;
      for (const front of FRONTS) {
        const themes = (plat.front_sentiment[front] && plat.front_sentiment[front].key_themes) || [];
        if (themes.includes(category)) {
          frontMentions[front]++;
          frontScoreSum[front] += plat.front_sentiment[front].score || 0;
        }
      }
    }

    const dominant = FRONTS.reduce((best, f) =>
      frontMentions[f] > frontMentions[best] ? f : best, 'LDF');
    const totalMentions = FRONTS.reduce((s, f) => s + frontMentions[f], 0);
    const avgScore = totalMentions > 0
      ? Math.round((frontScoreSum[dominant] / Math.max(1, frontMentions[dominant])) * 100) / 100
      : 0.0;

    result[category] = {
      dominant_front: totalMentions > 0 ? dominant : '',
      score: avgScore,
    };
  }

  result.local_issues = [];

  return result;
}

// ─── Crowd Reaction Analysis ──────────────────────────────────────────

/**
 * Compute crowd reaction metrics for a post based on its scored comments.
 *
 * @param {Object} post - Scored post with scores { LDF, UDF, NDA }
 * @param {Array<Object>} comments - Scored comments with .crowdReaction field
 * @returns {Object} Crowd reaction summary
 */
function computeCrowdReaction(post, comments) {
  const counts = {
    supportive: 0,
    against: 0,
    neutral: 0,
    counter_narrative: 0,
  };

  for (const comment of comments) {
    const reaction = comment.crowdReaction || 'neutral';
    if (counts.hasOwnProperty(reaction)) {
      counts[reaction]++;
    } else {
      counts.neutral++;
    }
  }

  const totalComments = comments.length;
  const supportiveRatio = totalComments > 0 ? Math.round((counts.supportive / totalComments) * 1000) / 1000 : 0;
  const againstRatio = totalComments > 0 ? Math.round((counts.against / totalComments) * 1000) / 1000 : 0;

  // Check for narrative gap: post is positive for a front but >50% of comments are against
  let narrativeGap = false;
  if (totalComments >= 3) {
    const oppositionRatio = (counts.against + counts.counter_narrative) / totalComments;
    if (oppositionRatio > 0.5) {
      // Check if post has a clear positive sentiment for any front
      const postScores = post.scores || post;
      const hasPositiveSentiment = FRONTS.some((f) => (postScores[f] || 0) > 0.1);
      if (hasPositiveSentiment) {
        narrativeGap = true;
      }
    }
  }

  // Determine dominant reaction
  let dominantReaction = 'neutral';
  let maxCount = 0;
  for (const [reaction, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      dominantReaction = reaction;
    }
  }

  return {
    totalComments,
    supportive: counts.supportive,
    against: counts.against,
    neutral: counts.neutral,
    counter_narrative: counts.counter_narrative,
    supportiveRatio,
    againstRatio,
    narrativeGap,
    dominantReaction,
  };
}

// ─── Daily Aggregation ────────────────────────────────────────────────

/**
 * Aggregate posts for a specific date.
 *
 * @param {Array<Object>} posts - All posts (will be filtered to the given date)
 * @param {string} date - YYYY-MM-DD to filter by
 * @returns {Object} Daily aggregate data
 */
function aggregateDaily(posts, date) {
  // Filter posts to the target date
  const dayPosts = posts.filter((p) => {
    const postDate = (p.extractedAt || '').split('T')[0];
    return postDate === date;
  });

  // Platform counts
  const platformCounts = {};
  for (const post of dayPosts) {
    const plat = (post.platform || 'unknown').toLowerCase();
    platformCounts[plat] = (platformCounts[plat] || 0) + 1;
  }

  // Aggregate scores per front
  const frontScores = { LDF: 0, UDF: 0, NDA: 0 };
  const frontCounts = { LDF: 0, UDF: 0, NDA: 0 };

  for (const post of dayPosts) {
    const scores = post.scores || post;
    for (const front of FRONTS) {
      const s = scores[front] || 0;
      if (s !== 0) {
        frontScores[front] += s;
        frontCounts[front]++;
      }
    }
  }

  const avgScores = {};
  for (const front of FRONTS) {
    avgScores[front] = frontCounts[front] > 0
      ? Math.round((frontScores[front] / frontCounts[front]) * 1000) / 1000
      : 0;
  }

  // Find top 5 posts by engagement, include crowd reaction if available
  const postsOnly = dayPosts.filter((p) => p.type !== 'comment');
  const commentsByParent = {};
  for (const p of dayPosts) {
    if (p.type === 'comment' && p.parentPostUrl) {
      if (!commentsByParent[p.parentPostUrl]) commentsByParent[p.parentPostUrl] = [];
      commentsByParent[p.parentPostUrl].push(p);
    }
  }

  const topPosts = [...postsOnly]
    .sort((a, b) => (b.engagement || 0) - (a.engagement || 0))
    .slice(0, 5)
    .map((post) => {
      const postComments = (post.url && commentsByParent[post.url]) || [];
      const crowdReaction = postComments.length > 0
        ? computeCrowdReaction(post, postComments)
        : null;

      return {
        text: (post.text || '').substring(0, 200),
        url: post.url || '',
        platform: post.platform || '',
        engagement: post.engagement || 0,
        scores: { LDF: (post.scores || post).LDF || 0, UDF: (post.scores || post).UDF || 0, NDA: (post.scores || post).NDA || 0 },
        crowdReaction,
      };
    });

  // Issue ranking
  const issueCounts = {};
  for (const post of dayPosts) {
    const issues = post.issues || (post.scores && post.scores.issues) || [];
    for (const issue of issues) {
      issueCounts[issue] = (issueCounts[issue] || 0) + 1;
    }
  }
  const issueRanking = Object.entries(issueCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([issue, count]) => ({ issue, count }));

  // Compute sentiment adjustment for the day
  const platformData = aggregateByPlatform(dayPosts);
  const memeData = aggregateMemes(dayPosts);
  const adjustment = computeSentimentAdjustment(platformData, memeData, null);

  return {
    date,
    postCount: dayPosts.length,
    platformCounts,
    scores: avgScores,
    topPosts,
    issueRanking,
    adjustment,
  };
}

// ─── Cumulative Aggregation ───────────────────────────────────────────

/**
 * Aggregate across all days with recency weighting.
 *
 * Weight = 1.0 - (daysAgo * 0.1), minimum 0.1
 *
 * @param {Array<Object>} allPosts - All posts across all dates
 * @param {number} days - Number of days to include
 * @returns {Object} Cumulative aggregate data
 */
function aggregateCumulative(allPosts, days) {
  days = days || 30;
  const now = new Date();
  const cutoffMs = now.getTime() - days * 86400000;

  // Filter to the requested window
  const windowPosts = allPosts.filter((p) => {
    const ts = new Date(p.extractedAt || 0).getTime();
    return ts >= cutoffMs;
  });

  // Group posts by date
  const postsByDate = {};
  for (const post of windowPosts) {
    const dateKey = (post.extractedAt || '').split('T')[0];
    if (!postsByDate[dateKey]) postsByDate[dateKey] = [];
    postsByDate[dateKey].push(post);
  }

  const todayStr = now.toISOString().split('T')[0];

  // Weighted score calculation
  const weightedScores = { LDF: 0, UDF: 0, NDA: 0 };
  let totalWeight = 0;

  // Track per-front daily scores for trend direction
  const dailyFrontScores = {};

  for (const [dateKey, datePosts] of Object.entries(postsByDate)) {
    const dayMs = new Date(dateKey).getTime();
    const daysAgo = Math.floor((now.getTime() - dayMs) / 86400000);
    const weight = Math.max(0.1, 1.0 - daysAgo * 0.1);

    // Daily average scores
    const dailyAvg = { LDF: 0, UDF: 0, NDA: 0 };
    const dailyCounts = { LDF: 0, UDF: 0, NDA: 0 };

    for (const post of datePosts) {
      const scores = post.scores || post;
      for (const front of FRONTS) {
        const s = scores[front] || 0;
        if (s !== 0) {
          dailyAvg[front] += s;
          dailyCounts[front]++;
        }
      }
    }

    for (const front of FRONTS) {
      const avg = dailyCounts[front] > 0 ? dailyAvg[front] / dailyCounts[front] : 0;
      weightedScores[front] += avg * weight;
    }
    totalWeight += weight;

    dailyFrontScores[dateKey] = {};
    for (const front of FRONTS) {
      dailyFrontScores[dateKey][front] = dailyCounts[front] > 0
        ? Math.round((dailyAvg[front] / dailyCounts[front]) * 1000) / 1000
        : 0;
    }
  }

  // Normalize weighted scores
  if (totalWeight > 0) {
    for (const front of FRONTS) {
      weightedScores[front] = Math.round((weightedScores[front] / totalWeight) * 1000) / 1000;
    }
  }

  // Compute trend direction per front (compare last 3 days avg vs prior 3 days avg)
  const sortedDates = Object.keys(dailyFrontScores).sort();
  const trendDirection = {};

  for (const front of FRONTS) {
    if (sortedDates.length < 2) {
      trendDirection[front] = 'stable';
      continue;
    }

    const recentDates = sortedDates.slice(-3);
    const priorDates = sortedDates.slice(-6, -3);

    const recentAvg = recentDates.length > 0
      ? recentDates.reduce((s, d) => s + (dailyFrontScores[d][front] || 0), 0) / recentDates.length
      : 0;
    const priorAvg = priorDates.length > 0
      ? priorDates.reduce((s, d) => s + (dailyFrontScores[d][front] || 0), 0) / priorDates.length
      : 0;

    const diff = recentAvg - priorAvg;
    if (diff > 0.05) {
      trendDirection[front] = 'improving';
    } else if (diff < -0.05) {
      trendDirection[front] = 'declining';
    } else {
      trendDirection[front] = 'stable';
    }
  }

  // Platform counts
  const platformCounts = {};
  for (const post of windowPosts) {
    const plat = (post.platform || 'unknown').toLowerCase();
    platformCounts[plat] = (platformCounts[plat] || 0) + 1;
  }

  // Overall scores (unweighted)
  const overallScores = { LDF: 0, UDF: 0, NDA: 0 };
  const overallCounts = { LDF: 0, UDF: 0, NDA: 0 };
  for (const post of windowPosts) {
    const scores = post.scores || post;
    for (const front of FRONTS) {
      const s = scores[front] || 0;
      if (s !== 0) {
        overallScores[front] += s;
        overallCounts[front]++;
      }
    }
  }
  for (const front of FRONTS) {
    overallScores[front] = overallCounts[front] > 0
      ? Math.round((overallScores[front] / overallCounts[front]) * 1000) / 1000
      : 0;
  }

  return {
    totalDays: Object.keys(postsByDate).length,
    totalPosts: windowPosts.length,
    platformCounts,
    scores: overallScores,
    weightedScores,
    trendDirection,
    dateRange: {
      from: sortedDates[0] || '',
      to: sortedDates[sortedDates.length - 1] || '',
    },
  };
}

// ─── Internal helpers for buildSentimentJSON crowd/daily/narrative ─────

/**
 * Compute crowd reaction ratios per front from all platform data.
 * @param {Object} platformData
 * @returns {Object}
 */
function _computeCrowdReactionByFront(platformData) {
  const result = {};
  for (const front of FRONTS) {
    let totalPositive = 0;
    let totalNegative = 0;
    let totalNeutral = 0;

    for (const plat of Object.values(platformData)) {
      if (!plat.front_sentiment || !plat.front_sentiment[front]) continue;
      const fs = plat.front_sentiment[front];
      totalPositive += fs.positive_mentions || 0;
      totalNegative += fs.negative_mentions || 0;
      totalNeutral += fs.neutral_mentions || 0;
    }

    const total = totalPositive + totalNegative + totalNeutral;
    result[front] = {
      supportive_ratio: total > 0 ? Math.round((totalPositive / total) * 1000) / 1000 : 0,
      against_ratio: total > 0 ? Math.round((totalNegative / total) * 1000) / 1000 : 0,
      total_mentions: total,
    };
  }
  return result;
}

/**
 * Build recent daily snapshot summaries (placeholder for last 7 days).
 * Actual snapshot data should come from storage; this provides structure from platform data.
 * @param {Object} platformData
 * @returns {Array}
 */
function _buildRecentDailySnapshots(platformData) {
  // This generates a single snapshot for current data; actual historical snapshots
  // should be loaded from the snapshots store via getDailySnapshots()
  const today = _todayStr();
  const scores = {};
  for (const front of FRONTS) {
    let sum = 0;
    let count = 0;
    for (const plat of Object.values(platformData)) {
      if (plat.front_sentiment && plat.front_sentiment[front]) {
        sum += plat.front_sentiment[front].score || 0;
        count++;
      }
    }
    scores[front] = count > 0 ? Math.round((sum / count) * 1000) / 1000 : 0;
  }

  return [
    {
      date: today,
      scores,
      postCount: Object.values(platformData).reduce((s, p) => s + (p.sample_size || 0), 0),
    },
  ];
}

/**
 * Find narrative gaps: fronts where platform data shows conflicting signals.
 * @param {Object} platformData
 * @returns {Array}
 */
function _findNarrativeGaps(platformData) {
  const gaps = [];

  for (const front of FRONTS) {
    const platformScores = [];
    for (const [platName, plat] of Object.entries(platformData)) {
      if (plat.front_sentiment && plat.front_sentiment[front]) {
        platformScores.push({
          platform: platName,
          score: plat.front_sentiment[front].score || 0,
        });
      }
    }

    // Check if any platform is positive while another is negative
    const positive = platformScores.filter((ps) => ps.score > 0.1);
    const negative = platformScores.filter((ps) => ps.score < -0.1);

    if (positive.length > 0 && negative.length > 0) {
      gaps.push({
        front,
        positive_platforms: positive.map((p) => p.platform),
        negative_platforms: negative.map((p) => p.platform),
        description: `${front}: positive on ${positive.map((p) => p.platform).join(', ')} but negative on ${negative.map((p) => p.platform).join(', ')}`,
      });
    }
  }

  return gaps;
}
