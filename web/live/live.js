/* Kerala 2026 Live Election Tracker — Frontend Logic */

const STATE = {
  mode: 1,
  predictions: null,
  news: null,
  sentiment: null,
  trends: null,
  status: null,
  cardIndex: 0,
  cardTimer: null,
  cardPaused: false,
  prevSeats: { LDF: 0, UDF: 0, NDA: 0 },
  sentimentChart: null,
};

// Detect if running on localhost (API mode) or static deployment (file mode)
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const API = IS_LOCAL ? '/api' : null;
const DATA_DIR = IS_LOCAL ? null : 'data'; // Static JSON files relative to live/
const REFRESH_MS = 60000;
const PAGE_RELOAD_MS = 20 * 60 * 1000; // Full page reload every 20 min
const CARD_MS = 45000;
const CARD_COUNT = 5;
const FRONTS = ['LDF', 'UDF', 'NDA'];
const COLORS = { LDF: '#e53935', UDF: '#1e88e5', NDA: '#f9a825' };
const BG_COLORS = {
  LDF: 'rgba(229,57,53,0.15)',
  UDF: 'rgba(30,136,229,0.15)',
  NDA: 'rgba(249,168,37,0.15)',
};

// ===== CLOCK =====
function updateClock() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 - now.getTimezoneOffset()) * 60000);
  const h = String(ist.getHours()).padStart(2, '0');
  const m = String(ist.getMinutes()).padStart(2, '0');
  const s = String(ist.getSeconds()).padStart(2, '0');
  document.getElementById('clock').textContent = `${h}:${m}:${s} IST`;
}
setInterval(updateClock, 1000);
updateClock();

// ===== DATA FETCHING =====
async function fetchJSON(apiPath, staticFile) {
  const url = API ? `${API}/${apiPath}` : `${DATA_DIR}/${staticFile}?t=${Date.now()}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function fetchAll() {
  try {
    const [pred, news, sent, trends, status] = await Promise.all([
      fetchJSON('predictions', 'predictions_live.json'),
      fetchJSON('news', 'news_feed.json'),
      fetchJSON('sentiment', 'sentiment_hourly.json'),
      fetchJSON('trends', 'trends.json'),
      fetchJSON('status', 'system_status.json'),
    ]);
    STATE.predictions = pred;
    STATE.news = news;
    STATE.sentiment = sent;
    STATE.trends = trends;
    STATE.status = status;

    document.getElementById('connectionLost').style.display = 'none';

    const updated = pred.last_updated
      ? timeAgo(new Date(pred.last_updated))
      : 'Base predictions';
    document.getElementById('lastUpdated').textContent = `Updated ${updated}`;

    renderAll();
  } catch (e) {
    console.error('Fetch error:', e);
    document.getElementById('connectionLost').style.display = 'block';
  }
}

function timeAgo(date) {
  const diff = (Date.now() - date.getTime()) / 60000;
  if (diff < 1) return 'just now';
  if (diff < 60) return `${Math.floor(diff)}m ago`;
  return `${Math.floor(diff / 60)}h ${Math.floor(diff % 60)}m ago`;
}

// ===== RENDER ALL =====
function renderAll() {
  renderDashboard();
  renderConstGrid();
  renderTicker();
  renderCards();
  renderSplit();
}

// ===== MODE SWITCHING =====
function switchMode(m) {
  STATE.mode = m;
  document.querySelectorAll('.mode-panel').forEach(p => p.style.display = 'none');
  document.getElementById(`mode${m}`).style.display = '';
  document.querySelectorAll('.mode-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.mode) === m);
  });
  if (m === 2) startCardCycle();
  else stopCardCycle();
}

// ===== KEYBOARD =====
document.addEventListener('keydown', e => {
  if (e.key === '1') switchMode(1);
  else if (e.key === '2') switchMode(2);
  else if (e.key === '3') switchMode(3);
  else if (e.key === 'ArrowRight' && STATE.mode === 2) nextCard();
  else if (e.key === 'ArrowLeft' && STATE.mode === 2) prevCard();
  else if (e.key === ' ' && STATE.mode === 2) { e.preventDefault(); togglePause(); }
});

// ===== ANIMATE NUMBER =====
function animateNumber(el, from, to, duration = 1200) {
  const start = performance.now();
  const diff = to - from;
  function step(ts) {
    const t = Math.min((ts - start) / duration, 1);
    const ease = 1 - Math.pow(1 - t, 3);
    el.textContent = Math.round(from + diff * ease);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ===== HELPERS =====
function getSeats() {
  const s = STATE.predictions?.summary?.seat_projections;
  if (!s) return { LDF: { median: 0, p5: 0, p95: 0 }, UDF: { median: 0, p5: 0, p95: 0 }, NDA: { median: 0, p5: 0, p95: 0 } };
  return s;
}

function getMomentum() {
  return STATE.sentiment?.momentum || { LDF: 'stable', UDF: 'stable', NDA: 'stable' };
}

function getArticles() {
  return STATE.news?.articles || [];
}

function getHotSeats() {
  const updates = STATE.trends?.updates || [];
  if (updates.length === 0) return [];
  return updates[updates.length - 1].hot_constituencies || [];
}

function frontClass(front) {
  if (!front) return '';
  return front.toLowerCase();
}

function frontColor(front) {
  return COLORS[front] || '#7a8194';
}

// ===== CONSTITUENCY GRID =====
function renderConstGrid() {
  const preds = STATE.predictions?.predictions || [];
  if (preds.length === 0) return;

  const search = (document.getElementById('constSearch')?.value || '').toLowerCase();
  const filter = document.getElementById('constFilter')?.value || 'all';

  const filtered = preds.filter(p => {
    if (search && !p.Constituency.toLowerCase().includes(search) && !p.District.toLowerCase().includes(search)) return false;
    if (filter !== 'all') {
      const cat = p.Category.toLowerCase();
      if (filter === 'toss' && !cat.includes('toss')) return false;
      if (filter === 'lean' && !cat.includes('lean')) return false;
      if (filter === 'likely' && !cat.includes('likely')) return false;
      if (filter === 'safe' && !cat.includes('safe')) return false;
    }
    return true;
  });

  const container = document.getElementById('constGrid');
  if (!container) return;

  let html = '';
  for (const p of filtered) {
    const ldf = p.Adjusted_LDF || 0;
    const udf = p.Adjusted_UDF || 0;
    const nda = p.Adjusted_NDA || 0;
    const oth = Math.max(0, 100 - ldf - udf - nda);

    // Winner
    const probs = { LDF: p.LDF_Win_Prob, UDF: p.UDF_Win_Prob, NDA: p.NDA_Win_Prob };
    const winner = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
    const winFront = winner[0];
    const winProb = winner[1];

    // Category color
    const cat = p.Category || '';
    let catBg = 'var(--surface)';
    let catColor = 'var(--text-dim)';
    if (cat.includes('Safe')) { catBg = COLORS[winFront] + '33'; catColor = COLORS[winFront]; }
    else if (cat.includes('Likely')) { catBg = COLORS[winFront] + '22'; catColor = COLORS[winFront]; }
    else if (cat.includes('Lean')) { catBg = 'rgba(255,255,255,0.08)'; catColor = COLORS[winFront]; }
    else { catBg = 'rgba(249,168,37,0.15)'; catColor = '#f9a825'; }

    html += `
      <div class="const-item">
        <div class="const-item-header">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="const-item-no">#${p.Constituency_No}</span>
            <span class="const-item-name">${p.Constituency}</span>
          </div>
          <span class="const-item-cat" style="background:${catBg};color:${catColor}">${cat}</span>
        </div>
        <div class="const-vote-bars">
          <div class="const-vote-bar" style="width:${ldf}%;background:var(--ldf);">${ldf.toFixed(1)}</div>
          <div class="const-vote-bar" style="width:${udf}%;background:var(--udf);">${udf.toFixed(1)}</div>
          <div class="const-vote-bar" style="width:${nda}%;background:var(--nda);">${nda.toFixed(1)}</div>
          ${oth > 3 ? `<div class="const-vote-bar" style="width:${oth}%;background:var(--surface);color:var(--text-dim);">${oth.toFixed(0)}</div>` : ''}
        </div>
        <div class="const-prob-row">
          <span style="color:var(--ldf)">LDF ${p.LDF_Win_Prob.toFixed(0)}%</span>
          <span style="color:var(--udf)">UDF ${p.UDF_Win_Prob.toFixed(0)}%</span>
          <span style="color:var(--nda)">NDA ${p.NDA_Win_Prob.toFixed(0)}%</span>
          <span class="const-winner-tag" style="background:${COLORS[winFront]}22;color:${COLORS[winFront]}">&#9654; ${winFront} ${winProb.toFixed(0)}%</span>
        </div>
      </div>`;
  }

  container.innerHTML = html;
}

// Search/filter event listeners
document.getElementById('constSearch')?.addEventListener('input', renderConstGrid);
document.getElementById('constFilter')?.addEventListener('change', renderConstGrid);

// ===== MODE 1: DASHBOARD =====
function renderDashboard() {
  const seats = getSeats();
  const momentum = getMomentum();

  // Seat cards
  let html = '';
  for (const f of FRONTS) {
    const s = seats[f] || { median: 0, p5: 0, p95: 0 };
    const mom = momentum[f] || 'stable';
    const momClass = `momentum-${mom}`;
    const momLabel = mom === 'up' ? '&#9650; Trending Up' : mom === 'down' ? '&#9660; Trending Down' : '&#9679; Stable';
    html += `
      <div class="seat-card ${f.toLowerCase()}">
        <div class="front-name">${f}</div>
        <div class="seat-number" id="seat-${f}">${s.median}</div>
        <div class="seat-range">${s.p5} &ndash; ${s.p95} seats</div>
        <div class="momentum-badge ${momClass}">${momLabel}</div>
      </div>`;

    // Animate if changed
    const prev = STATE.prevSeats[f];
    if (prev !== s.median) {
      requestAnimationFrame(() => {
        const el = document.getElementById(`seat-${f}`);
        if (el) animateNumber(el, prev, s.median);
      });
      STATE.prevSeats[f] = s.median;
    }
  }
  document.getElementById('seatCards').innerHTML = html;

  // Majority
  const udfSeats = seats.UDF?.median || 0;
  document.getElementById('majorityIndicator').innerHTML =
    `Majority mark: <strong>71 seats</strong> &mdash; UDF currently at <strong>${udfSeats}</strong> (${udfSeats >= 71 ? 'ABOVE majority' : `${71 - udfSeats} short`})`;

  // Sparklines
  renderSparklines();

  // Hot seats
  const hot = getHotSeats();
  let hotHtml = '';
  if (hot.length === 0) {
    hotHtml = '<div style="color:var(--text-dim);font-size:13px;">Waiting for first prediction cycle...</div>';
  }
  for (const h of hot) {
    hotHtml += `
      <div class="hot-seat">
        <div class="hot-seat-name">#${h.no} ${h.name}</div>
        <div class="hot-seat-change" style="color:${h.change?.includes('+') ? 'var(--success)' : 'var(--danger)'}">${h.change || ''}</div>
        <div class="hot-seat-cat">${h.category || ''}</div>
      </div>`;
  }
  document.getElementById('hotSeats').innerHTML = hotHtml;
}

function renderSparklines() {
  const hourly = STATE.sentiment?.hourly || [];
  const container = document.getElementById('sparklines');
  let html = '';

  for (const f of FRONTS) {
    const scores = hourly.map(h => h[f]?.score || 0);
    const current = STATE.sentiment?.current_scores?.[f] || 0;
    const color = frontClass(f);
    html += `
      <div class="sparkline-row">
        <div class="sparkline-label text-${color}">${f}</div>
        <canvas class="sparkline-canvas" id="spark-${f}"></canvas>
        <div class="sparkline-value" style="color:${current >= 0 ? 'var(--success)' : 'var(--danger)'}">
          ${current >= 0 ? '+' : ''}${current.toFixed(2)}
        </div>
      </div>`;
  }
  container.innerHTML = html;

  // Draw sparklines
  requestAnimationFrame(() => {
    for (const f of FRONTS) {
      const canvas = document.getElementById(`spark-${f}`);
      if (!canvas) continue;
      const ctx = canvas.getContext('2d');
      const scores = hourly.map(h => h[f]?.score || 0);
      drawSparkline(ctx, canvas, scores, COLORS[f]);
    }
  });
}

function drawSparkline(ctx, canvas, data, color) {
  const w = canvas.width = canvas.offsetWidth * 2;
  const h = canvas.height = canvas.offsetHeight * 2;
  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;

  const min = Math.min(...data, -0.5);
  const max = Math.max(...data, 0.5);
  const range = max - min || 1;
  const step = w / (data.length - 1);

  // Zero line
  const zeroY = h - ((0 - min) / range) * h;
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, zeroY);
  ctx.lineTo(w, zeroY);
  ctx.stroke();

  // Data line
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  data.forEach((v, i) => {
    const x = i * step;
    const y = h - ((v - min) / range) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // End dot
  const lastX = (data.length - 1) * step;
  const lastY = h - ((data[data.length - 1] - min) / range) * h;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(lastX, lastY, 5, 0, Math.PI * 2);
  ctx.fill();
}

// ===== NEWS TICKER =====
function renderTicker() {
  const articles = getArticles().slice(0, 30);
  if (articles.length === 0) return;

  const now = Date.now();
  let items = '';
  for (const a of articles) {
    const front = a.sentiment?.front || 'neutral';
    const color = frontColor(front);
    const isNew = (now - new Date(a.scraped_at).getTime()) < 1800000;
    items += `
      <div class="ticker-item">
        <span class="ticker-dot" style="background:${color}"></span>
        <span class="ticker-source">${a.source}</span>
        ${isNew ? '<span class="ticker-new">NEW</span>' : ''}
        <span>${a.title}</span>
      </div>`;
  }
  // Duplicate for seamless loop
  const track = document.getElementById('tickerTrack');
  track.innerHTML = items + items;
  const duration = articles.length * 6;
  track.style.animationDuration = `${duration}s`;
}

// ===== MODE 2: CARDS =====
function renderCards() {
  renderCard1();
  renderCard2();
  renderCard3();
  renderCard4();
  renderCard5();
}

function renderCard1() {
  const seats = getSeats();
  const maxSeats = 140;
  const majPct = (71 / maxSeats) * 100;

  let html = '<div class="card-header">State Seat Projection</div>';
  for (const f of FRONTS) {
    const s = seats[f] || { median: 0, p5: 0, p95: 0 };
    const pct = (s.median / maxSeats) * 100;
    html += `
      <div class="seat-bar-row">
        <div class="seat-bar-label" style="color:${COLORS[f]}">${f}</div>
        <div class="seat-bar-track">
          <div class="seat-bar-fill" style="width:${pct}%;background:${COLORS[f]}">
            <span class="bar-num">${s.median}</span>
          </div>
          <div class="majority-line" style="left:${majPct}%">
            <div class="majority-label">71 (Majority)</div>
          </div>
        </div>
        <div class="seat-bar-range">${s.p5} - ${s.p95}</div>
      </div>`;
  }
  document.getElementById('card1').innerHTML = html;
}

function renderCard2() {
  const articles = getArticles().slice(0, 5);
  let html = '<div class="card-header">Latest News</div>';
  for (const a of articles) {
    const front = a.sentiment?.front || 'neutral';
    const dir = a.sentiment?.direction || 'neutral';
    const bg = BG_COLORS[front] || 'var(--surface-2)';
    const color = COLORS[front] || 'var(--text-dim)';
    const badge = front !== 'neutral' ? `${dir === 'pro' ? '+' : '-'}${front}` : 'Neutral';
    const ago = timeAgo(new Date(a.published));
    html += `
      <div class="news-card-item">
        <div class="news-front-badge" style="background:${bg};color:${color}">${badge}</div>
        <div class="news-card-title">${a.title}</div>
        <div class="news-card-meta">${a.source} &bull; ${ago}</div>
      </div>`;
  }
  if (articles.length === 0) html += '<div style="color:var(--text-dim);padding:40px;text-align:center;font-size:18px;">Waiting for news feed...</div>';
  document.getElementById('card2').innerHTML = html;
}

function renderCard3() {
  const container = document.getElementById('card3');
  container.innerHTML = '<div class="card-header">Sentiment Trend (24 Hours)</div><div class="chart-container"><canvas id="sentimentChartCanvas"></canvas></div>';

  const hourly = STATE.sentiment?.hourly || [];
  if (hourly.length === 0) return;

  requestAnimationFrame(() => {
    const canvas = document.getElementById('sentimentChartCanvas');
    if (!canvas) return;

    if (STATE.sentimentChart) {
      STATE.sentimentChart.destroy();
      STATE.sentimentChart = null;
    }

    const labels = hourly.map(h => {
      const d = new Date(h.hour);
      return `${String(d.getHours()).padStart(2, '0')}:00`;
    });

    STATE.sentimentChart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: FRONTS.map(f => ({
          label: f,
          data: hourly.map(h => h[f]?.score || 0),
          borderColor: COLORS[f],
          backgroundColor: 'transparent',
          borderWidth: 3,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 6,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: '#e8eaf0', font: { size: 14, weight: 'bold' }, padding: 20 },
          },
        },
        scales: {
          x: {
            ticks: { color: '#7a8194', font: { size: 12 }, maxTicksLimit: 12 },
            grid: { color: 'rgba(255,255,255,0.05)' },
          },
          y: {
            min: -1, max: 1,
            ticks: { color: '#7a8194', font: { size: 12 } },
            grid: { color: 'rgba(255,255,255,0.05)' },
          },
        },
      },
    });
  });
}

function renderCard4() {
  const hot = getHotSeats();
  let html = '<div class="card-header">Hot Constituencies &mdash; Biggest Shifts</div>';
  if (hot.length === 0) {
    html += '<div style="color:var(--text-dim);padding:40px;text-align:center;font-size:18px;">Waiting for prediction comparison...</div>';
  }
  for (const h of hot) {
    const isPositive = h.change?.includes('+');
    html += `
      <div class="hot-card-item">
        <div class="hot-card-no">#${h.no}</div>
        <div class="hot-card-name">${h.name}</div>
        <div class="hot-card-change" style="color:${isPositive ? 'var(--success)' : 'var(--danger)'}">${h.change}</div>
        <div class="hot-card-cat">${h.category}</div>
      </div>`;
  }
  document.getElementById('card4').innerHTML = html;
}

function renderCard5() {
  const preds = STATE.predictions?.predictions || [];
  const kochi = preds.find(p => p.Constituency_No === 80);
  let html = '<div class="card-header">Spotlight &mdash; Kochi (#80)</div>';

  if (!kochi) {
    html += '<div style="color:var(--text-dim);padding:40px;text-align:center;font-size:18px;">Loading constituency data...</div>';
    document.getElementById('card5').innerHTML = html;
    return;
  }

  html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-bottom:30px;">';
  for (const f of FRONTS) {
    const prob = kochi[`${f}_Win_Prob`];
    const cand = kochi[`${f}_Candidate`];
    const party = kochi[`${f}_Party`];
    html += `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;text-align:center;border-top:3px solid ${COLORS[f]}">
        <div style="font-size:36px;font-family:'JetBrains Mono',monospace;font-weight:700;color:${COLORS[f]}">${prob.toFixed(1)}%</div>
        <div style="font-size:14px;font-weight:600;margin-top:8px;">${cand}</div>
        <div style="font-size:12px;color:var(--text-dim)">${party} (${f})</div>
      </div>`;
  }
  html += '</div>';
  html += `<div style="text-align:center;color:var(--text-dim);font-size:14px;">Category: <strong style="color:var(--text)">${kochi.Category}</strong> &bull; 2021 Winner: ${kochi.Winner_2021} (margin: ${kochi.Margin_2021?.toLocaleString()})</div>`;
  document.getElementById('card5').innerHTML = html;
}

// Card cycling
function startCardCycle() {
  stopCardCycle();
  if (!STATE.cardPaused) {
    STATE.cardTimer = setInterval(nextCard, CARD_MS);
  }
}

function stopCardCycle() {
  if (STATE.cardTimer) { clearInterval(STATE.cardTimer); STATE.cardTimer = null; }
}

function showCard(idx) {
  STATE.cardIndex = idx;
  document.querySelectorAll('.card').forEach((c, i) => c.classList.toggle('active', i === idx));
  document.querySelectorAll('.card-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
}

function nextCard() { showCard((STATE.cardIndex + 1) % CARD_COUNT); }
function prevCard() { showCard((STATE.cardIndex - 1 + CARD_COUNT) % CARD_COUNT); }

function togglePause() {
  STATE.cardPaused = !STATE.cardPaused;
  document.getElementById('pausedBadge').style.display = STATE.cardPaused ? 'block' : 'none';
  if (STATE.cardPaused) stopCardCycle();
  else startCardCycle();
}

// Card dots click
document.querySelectorAll('.card-dot').forEach(d => {
  d.addEventListener('click', () => showCard(parseInt(d.dataset.card)));
});

// ===== MODE 3: SPLIT =====
function renderSplit() {
  renderSplitNews();
  renderSplitDashboard();
}

function renderSplitNews() {
  const articles = getArticles().slice(0, 50);
  let html = '<div class="panel-title" style="margin-bottom:12px;">Live News Feed</div>';
  for (const a of articles) {
    const front = a.sentiment?.front || 'neutral';
    const cls = frontClass(front);
    const ago = timeAgo(new Date(a.published));
    html += `
      <div class="split-news-item ${cls}">
        <div class="split-news-title">${a.title}</div>
        <div class="split-news-meta">
          <span>${a.source}</span>
          <span>${ago}</span>
          <span style="color:${frontColor(front)}">${front !== 'neutral' ? front : ''}</span>
        </div>
      </div>`;
  }
  if (articles.length === 0) html += '<div style="color:var(--text-dim);padding:20px;">Waiting for news...</div>';
  document.getElementById('splitNews').innerHTML = html;
}

function renderSplitDashboard() {
  const seats = getSeats();
  const momentum = getMomentum();

  let html = '<div class="panel-title" style="margin-bottom:12px;">Seat Projections</div>';
  html += '<div class="split-seat-row">';
  for (const f of FRONTS) {
    const s = seats[f] || { median: 0, p5: 0, p95: 0 };
    const mom = momentum[f];
    const momIcon = mom === 'up' ? '&#9650;' : mom === 'down' ? '&#9660;' : '&#9679;';
    const momColor = mom === 'up' ? 'var(--success)' : mom === 'down' ? 'var(--danger)' : 'var(--text-dim)';
    html += `
      <div class="split-seat-card" style="border-top:3px solid ${COLORS[f]}">
        <div class="num" style="color:${COLORS[f]}">${s.median}</div>
        <div class="label" style="color:${COLORS[f]}">${f}</div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:4px;">${s.p5} - ${s.p95}</div>
        <div style="font-size:12px;color:${momColor};margin-top:4px;">${momIcon} ${mom}</div>
      </div>`;
  }
  html += '</div>';

  // Sentiment scores
  html += '<div class="panel-title" style="margin-top:20px;margin-bottom:12px;">Sentiment Scores</div>';
  const scores = STATE.sentiment?.current_scores || {};
  for (const f of FRONTS) {
    const s = scores[f] || 0;
    const barWidth = Math.abs(s) * 100;
    const isPos = s >= 0;
    html += `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
        <div style="width:32px;font-size:12px;font-weight:700;color:${COLORS[f]}">${f}</div>
        <div style="flex:1;height:20px;background:var(--surface);border-radius:4px;overflow:hidden;position:relative;">
          <div style="position:absolute;${isPos ? 'left:50%' : `right:50%`};width:${barWidth / 2}%;height:100%;background:${COLORS[f]};opacity:0.6;border-radius:4px;"></div>
          <div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--border);"></div>
        </div>
        <div style="width:50px;text-align:right;font-family:'JetBrains Mono',monospace;font-size:12px;color:${isPos ? 'var(--success)' : 'var(--danger)'}">
          ${isPos ? '+' : ''}${s.toFixed(2)}
        </div>
      </div>`;
  }

  // Hot seats
  const hot = getHotSeats();
  if (hot.length > 0) {
    html += '<div class="panel-title" style="margin-top:20px;margin-bottom:12px;">Hot Constituencies</div>';
    for (const h of hot) {
      html += `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
          <span style="color:var(--text-dim)">#${h.no}</span>
          <span style="flex:1;font-weight:600;">${h.name}</span>
          <span style="font-family:'JetBrains Mono',monospace;font-size:12px;color:${h.change?.includes('+') ? 'var(--success)' : 'var(--danger)'}">${h.change}</span>
        </div>`;
    }
  }

  document.getElementById('splitDashboard').innerHTML = html;
}

// ===== INIT =====
async function init() {
  await fetchAll();
  setInterval(fetchAll, REFRESH_MS);
  // Full page reload every 20 min to pick up any code/data changes
  setInterval(() => location.reload(), PAGE_RELOAD_MS);
  // Refresh on focus (if tab was inactive)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) fetchAll();
  });
}

init();
