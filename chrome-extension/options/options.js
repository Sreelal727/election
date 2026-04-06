// Election Pulse — Options Page Logic

(function () {
  'use strict';

  // ---- Default config ----
  const DEFAULTS = {
    constituency: '',
    platforms: {
      reddit: { enabled: true, subreddits: ['r/Kerala', 'r/Kochi', 'r/india'] },
      facebook: { enabled: true, pages: [] },
      twitter: { enabled: true, hashtags: [] },
      instagram: { enabled: true, hashtags: ['#KeralaElection2026', '#Kochi'] },
    },
    keywords: {
      ldf: ['CPM', 'CPI', 'LDF', 'Pinarayi', 'Vijayan'],
      udf: ['Congress', 'UDF', 'INC', 'Muslim League'],
      nda: ['BJP', 'NDA', 'Sangh', 'RSS'],
    },
    rateInterval: 5,
    groundReports: {
      rallyLDF: 0,
      rallyUDF: 0,
      rallyNDA: 0,
      doorToDoor: '',
      mediaPresence: '',
    },
  };

  let config = JSON.parse(JSON.stringify(DEFAULTS));

  // ---- DOM refs ----
  const $ = (id) => document.getElementById(id);
  const toast = $('toast');

  // ---- Init ----
  document.addEventListener('DOMContentLoaded', () => {
    loadConfig();
    bindEvents();
  });

  // ---- Messaging ----
  function sendMessage(type, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        resolve(response || {});
      });
    });
  }

  // ---- Toast ----
  function showToast(msg) {
    toast.textContent = msg || 'Saved';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  }

  // ---- Load Config ----
  async function loadConfig() {
    try {
      const resp = await sendMessage('GET_CONFIG');
      if (resp && resp.config) {
        config = mergeDeep(JSON.parse(JSON.stringify(DEFAULTS)), resp.config);
      }
    } catch (e) {
      console.warn('Could not load config from background:', e);
    }

    populateConstituencyDropdown();
    populatePlatforms();
    populateKeywords();
    populateRate();
    populateGround();
    loadStorageStats();
  }

  // ---- Constituency ----
  let _candidatesData = null;

  async function populateConstituencyDropdown() {
    const select = $('optConstituency');
    select.innerHTML = '<option value="">-- Select --</option>';
    try {
      const url = chrome.runtime.getURL('keywords/candidates.json');
      const resp = await fetch(url);
      _candidatesData = await resp.json();
      const constituencies = _candidatesData.constituencies || {};

      Object.keys(constituencies).forEach((key) => {
        const info = constituencies[key];
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = (info.name || key.charAt(0).toUpperCase() + key.slice(1)) +
          (info.no ? ' (#' + info.no + ')' : '');
        select.appendChild(opt);
      });
      if (config.constituency) select.value = config.constituency;
      loadConstituencyInfo();
    } catch (e) {
      console.warn('candidates.json not available:', e.message);
    }
  }

  function loadConstituencyInfo() {
    const info = $('candidateInfo');
    const selected = $('optConstituency').value;
    if (!selected || !_candidatesData) {
      info.innerHTML = '<p class="muted">Select a constituency to view candidates.</p>';
      return;
    }
    const constituencies = _candidatesData.constituencies || {};
    const entry = constituencies[selected];
    if (!entry) {
      info.innerHTML = '<p class="muted">No candidate data for this constituency.</p>';
      return;
    }
    const candidates = entry.candidates || {};
    const fronts = Object.keys(candidates);
    if (fronts.length === 0) {
      info.innerHTML = '<p class="muted">No candidate data available.</p>';
      return;
    }
    info.innerHTML = fronts
      .map((front) => {
        const c = candidates[front];
        const cls = front.toLowerCase();
        const name = c.name || 'TBD';
        const party = c.party || '';
        return `<div class="candidate-row"><span class="front ${cls}">${front}</span><span>${name} (${party})</span></div>`;
      })
      .join('');
  }

  // ---- Platforms ----
  function populatePlatforms() {
    const platforms = config.platforms || {};

    $('toggleReddit').checked = platforms.reddit?.enabled !== false;
    $('toggleFacebook').checked = platforms.facebook?.enabled !== false;
    $('toggleTwitter').checked = platforms.twitter?.enabled !== false;
    $('toggleInstagram').checked = platforms.instagram?.enabled !== false;

    renderTags('Reddit', platforms.reddit?.subreddits || []);
    renderTags('Facebook', platforms.facebook?.pages || []);
    renderTags('Twitter', platforms.twitter?.hashtags || []);
    renderTags('Instagram', platforms.instagram?.hashtags || []);
  }

  function renderTags(platform, items) {
    const container = $('tagList' + platform);
    container.innerHTML = '';
    items.forEach((item, idx) => {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.innerHTML = `${escapeHtml(item)} <span class="tag-remove" data-platform="${platform}" data-index="${idx}">&times;</span>`;
      container.appendChild(tag);
    });
  }

  function getTagItems(platform) {
    const p = config.platforms;
    switch (platform) {
      case 'Reddit': return p.reddit?.subreddits || [];
      case 'Facebook': return p.facebook?.pages || [];
      case 'Twitter': return p.twitter?.hashtags || [];
      case 'Instagram': return p.instagram?.hashtags || [];
      default: return [];
    }
  }

  function setTagItems(platform, items) {
    switch (platform) {
      case 'Reddit': config.platforms.reddit.subreddits = items; break;
      case 'Facebook': config.platforms.facebook.pages = items; break;
      case 'Twitter': config.platforms.twitter.hashtags = items; break;
      case 'Instagram': config.platforms.instagram.hashtags = items; break;
    }
  }

  function addTag(platform) {
    const input = $('input' + platform);
    const val = input.value.trim();
    if (!val) return;
    const items = getTagItems(platform);
    if (!items.includes(val)) {
      items.push(val);
      setTagItems(platform, items);
      renderTags(platform, items);
      savePlatforms();
    }
    input.value = '';
  }

  function removeTag(platform, index) {
    const items = getTagItems(platform);
    items.splice(index, 1);
    setTagItems(platform, items);
    renderTags(platform, items);
    savePlatforms();
  }

  async function savePlatforms() {
    config.platforms.reddit.enabled = $('toggleReddit').checked;
    config.platforms.facebook.enabled = $('toggleFacebook').checked;
    config.platforms.twitter.enabled = $('toggleTwitter').checked;
    config.platforms.instagram.enabled = $('toggleInstagram').checked;

    await sendMessage('UPDATE_CONFIG', { config: { platforms: config.platforms } });
    showToast('Platform settings saved');
  }

  // ---- Keywords ----
  function populateKeywords() {
    $('keywordsEditor').value = JSON.stringify(config.keywords || {}, null, 2);
  }

  async function saveKeywords() {
    const raw = $('keywordsEditor').value.trim();
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Must be an object');
      config.keywords = parsed;
      await sendMessage('UPDATE_CONFIG', { config: { keywords: config.keywords } });
      showToast('Keywords saved');
    } catch (e) {
      alert('Invalid JSON: ' + e.message);
    }
  }

  // ---- Rate ----
  function populateRate() {
    const slider = $('rateSlider');
    slider.value = config.rateInterval || 5;
    $('rateValue').textContent = slider.value;
  }

  async function saveRate() {
    config.rateInterval = parseInt($('rateSlider').value, 10);
    await sendMessage('UPDATE_CONFIG', { config: { rateInterval: config.rateInterval } });
    showToast('Interval saved');
  }

  // ---- Ground Reports ----
  function populateGround() {
    const gr = config.groundReports || {};
    $('rallyLDF').value = gr.rallyLDF || 0;
    $('rallyUDF').value = gr.rallyUDF || 0;
    $('rallyNDA').value = gr.rallyNDA || 0;
    $('doorToDoor').value = gr.doorToDoor || '';
    $('mediaPresence').value = gr.mediaPresence || '';
  }

  async function saveGround() {
    config.groundReports = {
      rallyLDF: parseInt($('rallyLDF').value, 10) || 0,
      rallyUDF: parseInt($('rallyUDF').value, 10) || 0,
      rallyNDA: parseInt($('rallyNDA').value, 10) || 0,
      doorToDoor: $('doorToDoor').value,
      mediaPresence: $('mediaPresence').value,
    };
    await sendMessage('UPDATE_CONFIG', { config: { groundReports: config.groundReports } });
    showToast('Ground reports saved');
  }

  // ---- Storage Stats ----
  async function loadStorageStats() {
    try {
      const resp = await sendMessage('GET_STORAGE_STATS');
      if (resp) {
        $('statPostCount').textContent = resp.postCount || 0;
        $('statDbSize').textContent = resp.dbSize || '0 KB';
        $('statOldest').textContent = resp.oldest || '--';
        $('statNewest').textContent = resp.newest || '--';
      }
    } catch (e) {
      console.warn('Could not load storage stats');
    }
  }

  // ---- Data Management ----
  async function clearAllPosts() {
    if (!confirm('Are you sure you want to clear ALL collected posts? This cannot be undone.')) return;
    if (!confirm('This will permanently delete all data. Confirm again?')) return;
    await sendMessage('CLEAR_ALL_POSTS');
    showToast('All posts cleared');
    loadStorageStats();
  }

  async function exportSnapshots() {
    const resp = await sendMessage('EXPORT_SNAPSHOTS');
    if (resp && resp.data) {
      downloadJSON(resp.data, 'election-pulse-snapshots.json');
      showToast('Snapshots exported');
    } else {
      showToast('No snapshots to export');
    }
  }

  function triggerImport() {
    $('importFile').click();
  }

  async function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function (ev) {
      try {
        const data = JSON.parse(ev.target.result);
        await sendMessage('IMPORT_DATA', { data });
        showToast('Data imported successfully');
        loadStorageStats();
      } catch (err) {
        alert('Invalid JSON file: ' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // ---- Bind Events ----
  function bindEvents() {
    // Constituency
    $('optConstituency').addEventListener('change', async () => {
      config.constituency = $('optConstituency').value;
      await sendMessage('UPDATE_CONFIG', { config: { constituency: config.constituency } });
      loadConstituencyInfo();
      showToast('Constituency updated');
    });

    // Platform toggles
    ['Reddit', 'Facebook', 'Twitter', 'Instagram'].forEach((p) => {
      $('toggle' + p).addEventListener('change', savePlatforms);
      $('add' + p).addEventListener('click', () => addTag(p));
      $('input' + p).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addTag(p); }
      });
    });

    // Tag removal (delegated)
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('tag-remove')) {
        const platform = e.target.dataset.platform;
        const index = parseInt(e.target.dataset.index, 10);
        removeTag(platform, index);
      }
    });

    // Keywords
    $('saveKeywords').addEventListener('click', saveKeywords);

    // Rate
    $('rateSlider').addEventListener('input', () => {
      $('rateValue').textContent = $('rateSlider').value;
    });
    $('saveRate').addEventListener('click', saveRate);

    // Data management
    $('btnClearAll').addEventListener('click', clearAllPosts);
    $('btnExportSnapshots').addEventListener('click', exportSnapshots);
    $('btnImport').addEventListener('click', triggerImport);
    $('importFile').addEventListener('change', handleImport);

    // Ground reports
    $('saveGround').addEventListener('click', saveGround);
  }

  // ---- Helpers ----
  function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function mergeDeep(target, source) {
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key]) target[key] = {};
        mergeDeep(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  }
})();
