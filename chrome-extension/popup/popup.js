// Election Pulse — Popup Logic

(function () {
  'use strict';

  // ---- DOM refs ----
  const constituencySelect = document.getElementById('constituencySelect');
  const collectionToggle = document.getElementById('collectionToggle');
  const scoreLDF = document.getElementById('scoreLDF');
  const scoreUDF = document.getElementById('scoreUDF');
  const scoreNDA = document.getElementById('scoreNDA');
  const trendCanvas = document.getElementById('trendCanvas');
  const btnExport = document.getElementById('btnExport');
  const btnSnapshot = document.getElementById('btnSnapshot');
  const btnSettings = document.getElementById('btnSettings');
  const btnStartCollection = document.getElementById('btnStartCollection');
  const btnDaily = document.getElementById('btnDaily');
  const btnCumulative = document.getElementById('btnCumulative');

  let refreshTimer = null;
  let currentView = 'daily';

  // ---- Init ----
  document.addEventListener('DOMContentLoaded', () => {
    loadConstituencies();
    requestDashboard();
    startAutoRefresh();

    constituencySelect.addEventListener('change', onConstituencyChange);
    collectionToggle.addEventListener('change', onToggleCollection);
    btnExport.addEventListener('click', onExport);
    btnSnapshot.addEventListener('click', onSnapshot);
    btnSettings.addEventListener('click', onSettings);
    btnStartCollection.addEventListener('click', onStartCollection);
    btnDaily.addEventListener('click', () => switchView('daily'));
    btnCumulative.addEventListener('click', () => switchView('cumulative'));
  });

  // ---- Messaging helpers ----
  function sendMessage(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        resolve(response || {});
      });
    });
  }

  // ---- Dashboard ----
  async function requestDashboard() {
    const constituency = constituencySelect.value || '';
    // Try view-specific message first, fall back to GET_DASHBOARD
    const msgType = currentView === 'daily' ? 'GET_DAILY_ANALYSIS' : 'GET_CUMULATIVE_ANALYSIS';
    let data = await sendMessage(msgType, { constituency });
    // Fallback if the specific handler doesn't exist yet
    if (!data || Object.keys(data).length === 0) {
      data = await sendMessage('GET_DASHBOARD', { constituency });
    }
    if (data) {
      updateScoreCards(data);
      updatePlatformBars(data);
      updateStats(data);
      updateCrowdReaction(data);
      updateTopPosts(data);
      if (data.trends) drawTrendChart(data.trends);
      if (typeof data.collectionEnabled === 'boolean') {
        collectionToggle.checked = data.collectionEnabled;
      }
    }
  }

  // ---- Score Cards ----
  function updateScoreCards(data) {
    const scores = data.scores || {};
    setScore(scoreLDF, scores.ldf);
    setScore(scoreUDF, scores.udf);
    setScore(scoreNDA, scores.nda);
  }

  function setScore(el, value) {
    const v = typeof value === 'number' ? value : 0;
    el.textContent = v >= 0 ? '+' + v.toFixed(2) : v.toFixed(2);
    el.classList.remove('positive', 'negative', 'zero');
    if (v > 0) el.classList.add('positive');
    else if (v < 0) el.classList.add('negative');
    else el.classList.add('zero');
  }

  // ---- Platform Bars ----
  function updatePlatformBars(data) {
    const platforms = data.platforms || {};
    const counts = {
      Reddit: platforms.reddit || 0,
      Facebook: platforms.facebook || 0,
      Twitter: platforms.twitter || 0,
      Instagram: platforms.instagram || 0,
      Memes: platforms.memes || 0,
    };
    const max = Math.max(1, ...Object.values(counts));

    Object.keys(counts).forEach((name) => {
      const bar = document.getElementById('bar' + name);
      const countEl = document.getElementById('count' + name);
      if (bar) bar.style.width = ((counts[name] / max) * 100).toFixed(1) + '%';
      if (countEl) countEl.textContent = formatNumber(counts[name]);
    });
  }

  // ---- Stats ----
  function updateStats(data) {
    const stats = data.stats || {};
    document.getElementById('postsToday').textContent = formatNumber(stats.postsToday || 0);
    document.getElementById('totalPosts').textContent = formatNumber(stats.totalPosts || 0);
    const sourcesTodayEl = document.getElementById('sourcesToday');
    if (sourcesTodayEl) sourcesTodayEl.textContent = formatNumber(stats.sourcesToday || 0);
    document.getElementById('lastScrape').textContent = stats.lastScrapeTime
      ? formatRelativeTime(stats.lastScrapeTime)
      : '--';
  }

  // ---- Start Collection ----
  async function onStartCollection() {
    const constituency = constituencySelect.value || 'kochi';
    if (btnStartCollection.classList.contains('collecting')) {
      // Stop
      await sendMessage('STOP_COLLECTION');
      btnStartCollection.textContent = 'Start Collection';
      btnStartCollection.classList.remove('collecting');
    } else {
      // Start
      await sendMessage('START_COLLECTION', { constituency });
      btnStartCollection.textContent = 'Stop Collection';
      btnStartCollection.classList.add('collecting');
      // Auto-stop after 5 minutes
      setTimeout(() => {
        btnStartCollection.textContent = 'Start Collection';
        btnStartCollection.classList.remove('collecting');
      }, 5 * 60 * 1000);
    }
  }

  // ---- View Toggle ----
  function switchView(view) {
    currentView = view;
    btnDaily.classList.toggle('active', view === 'daily');
    btnCumulative.classList.toggle('active', view === 'cumulative');
    requestDashboard();
  }

  // ---- Crowd Reaction ----
  function updateCrowdReaction(data) {
    const crowd = data.crowdReaction || {};
    const supportive = crowd.supportiveRatio || 0;
    const against = crowd.againstRatio || 0;
    const neutral = 1 - supportive - against;

    const elSupp = document.getElementById('crowdSupportive');
    const elAgainst = document.getElementById('crowdAgainst');
    const elNeutral = document.getElementById('crowdNeutral');

    if (!elSupp || !elAgainst || !elNeutral) return;

    elSupp.textContent = Math.round(supportive * 100) + '%';
    elAgainst.textContent = Math.round(against * 100) + '%';
    elNeutral.textContent = Math.round(Math.max(0, neutral) * 100) + '%';

    // Color coding
    elSupp.className = 'crowd-value ' + (supportive > 0.5 ? 'high' : supportive > 0.3 ? 'mid' : 'low');
    elAgainst.className = 'crowd-value ' + (against > 0.5 ? 'low' : against > 0.3 ? 'mid' : 'high');
    elNeutral.className = 'crowd-value mid';

    // Narrative gaps
    const gapsEl = document.getElementById('narrativeGaps');
    const gaps = data.narrativeGaps || [];
    if (gaps.length > 0) {
      gapsEl.innerHTML = gaps.slice(0, 3).map(g =>
        `<div class="gap-alert">\u26A0 ${g.description || 'Post sentiment differs from crowd reaction'}</div>`
      ).join('');
    } else {
      gapsEl.innerHTML = '';
    }
  }

  // ---- Top Posts ----
  function updateTopPosts(data) {
    const container = document.getElementById('topPostsList');
    if (!container) return;
    const posts = data.topPosts || [];

    if (posts.length === 0) {
      container.innerHTML = '<div style="color:#666; font-size:10px; text-align:center; padding:10px;">No posts collected yet</div>';
      return;
    }

    container.innerHTML = posts.slice(0, 5).map(p => {
      const reactionClass = (p.crowdReaction || {}).dominantReaction || 'mixed';
      const reactionLabel = reactionClass.charAt(0).toUpperCase() + reactionClass.slice(1);
      const engagement = p.engagement || 0;
      return `
        <div class="top-post-item">
          <div class="top-post-text">${escapeHtml(p.text || '')}</div>
          <div class="top-post-meta">
            <span class="top-post-platform">${p.platform || '?'}</span>
            <span>\uD83D\uDC4D ${formatNumber(engagement)}</span>
            <span>${(p.crowdReaction || {}).totalComments || 0} comments</span>
            <span class="top-post-reaction ${reactionClass}">${reactionLabel}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---- Trend Chart (Canvas 2D) ----
  function drawTrendChart(trends) {
    const canvas = trendCanvas;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 380 * dpr;
    canvas.height = 120 * dpr;
    ctx.scale(dpr, dpr);

    const W = 380;
    const H = 120;
    const pad = { top: 10, right: 10, bottom: 20, left: 32 };
    const chartW = W - pad.left - pad.right;
    const chartH = H - pad.top - pad.bottom;

    // Clear
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#16213e';
    ctx.fillRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = '#2a2a4a';
    ctx.lineWidth = 0.5;
    const yTicks = [-1, -0.5, 0, 0.5, 1];
    yTicks.forEach((v) => {
      const y = pad.top + chartH - ((v + 1) / 2) * chartH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + chartW, y);
      ctx.stroke();
    });

    // Y-axis labels
    ctx.fillStyle = '#666';
    ctx.font = '9px system-ui';
    ctx.textAlign = 'right';
    yTicks.forEach((v) => {
      const y = pad.top + chartH - ((v + 1) / 2) * chartH;
      ctx.fillText(v.toFixed(1), pad.left - 4, y + 3);
    });

    // Determine number of data points
    const ldfData = trends.ldf || [];
    const udfData = trends.udf || [];
    const ndaData = trends.nda || [];
    const labels = trends.labels || [];
    const points = Math.max(ldfData.length, udfData.length, ndaData.length, 1);

    // X-axis date labels (show ~5 labels)
    if (labels.length > 0) {
      ctx.fillStyle = '#666';
      ctx.font = '8px system-ui';
      ctx.textAlign = 'center';
      const step = Math.max(1, Math.floor(labels.length / 5));
      for (let i = 0; i < labels.length; i += step) {
        const x = pad.left + (i / (points - 1 || 1)) * chartW;
        ctx.fillText(labels[i], x, H - 4);
      }
    }

    // Draw lines
    const lineColors = {
      ldf: '#E53935',
      udf: '#1E88E5',
      nda: '#FF8F00',
    };
    const datasets = { ldf: ldfData, udf: udfData, nda: ndaData };

    Object.keys(datasets).forEach((key) => {
      const arr = datasets[key];
      if (arr.length < 2) return;
      ctx.beginPath();
      ctx.strokeStyle = lineColors[key];
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      arr.forEach((v, i) => {
        const x = pad.left + (i / (points - 1)) * chartW;
        const y = pad.top + chartH - ((v + 1) / 2) * chartH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });

    // Zero line emphasis
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([4, 3]);
    const zeroY = pad.top + chartH / 2;
    ctx.beginPath();
    ctx.moveTo(pad.left, zeroY);
    ctx.lineTo(pad.left + chartW, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ---- Load Constituencies ----
  async function loadConstituencies() {
    try {
      const url = chrome.runtime.getURL('keywords/candidates.json');
      const resp = await fetch(url);
      const data = await resp.json();
      const constituencies = data.constituencies || {};

      Object.keys(constituencies).forEach((key) => {
        const info = constituencies[key];
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = (info.name || key.charAt(0).toUpperCase() + key.slice(1)) +
          (info.no ? ' (#' + info.no + ')' : '');
        constituencySelect.appendChild(opt);
      });

      // Restore last selection
      const stored = await chrome.storage.local.get('selectedConstituency');
      if (stored.selectedConstituency) {
        constituencySelect.value = stored.selectedConstituency;
      }
    } catch (e) {
      console.warn('Could not load candidates.json:', e.message);
    }
  }

  // ---- Event Handlers ----
  function onConstituencyChange() {
    chrome.storage.local.set({ selectedConstituency: constituencySelect.value });
    requestDashboard();
  }

  async function onToggleCollection() {
    const enabled = collectionToggle.checked;
    await sendMessage('TOGGLE_EXTRACTION', { enabled });
  }

  async function onExport() {
    await sendMessage('EXPORT_JSON');
  }

  async function onSnapshot() {
    await sendMessage('TAKE_SNAPSHOT');
  }

  function onSettings() {
    chrome.runtime.openOptionsPage();
  }

  // ---- Auto-refresh ----
  function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      requestDashboard();
    }, 30000);
  }

  // ---- Utility: Format Numbers ----
  function formatNumber(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  // ---- Utility: Relative Time ----
  function formatRelativeTime(timestamp) {
    const now = Date.now();
    const ts = typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
    const diff = now - ts;
    if (isNaN(diff) || diff < 0) return '--';

    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return seconds + 's ago';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    if (hours < 48) return 'yesterday';
    const days = Math.floor(hours / 24);
    return days + 'd ago';
  }
})();
