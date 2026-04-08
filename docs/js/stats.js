'use strict';

// Stats module — depends on app.js globals: channelList, loadJSON, escapeHtml, DATA

// Local debounce (search.js not loaded on stats page)
function debounceStats(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function initStats(channels) {
  const loading = document.getElementById('stats-loading');
  const body = document.getElementById('stats-body');
  if (!body) return;

  let stats;
  try {
    stats = await loadJSON(`${DATA}stats.json`);
  } catch (e) {
    if (loading) loading.textContent = `Failed to load stats: ${escapeHtml(e.message)}`;
    return;
  }

  if (loading) loading.classList.add('hidden');
  body.classList.remove('hidden');

  const allUsers = stats.users; // sorted by messageCount desc from parse.js
  const totalUsers = allUsers.length;
  const totalChannels = stats.channels.length;

  // Summary cards
  let html = `<div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">${stats.totalMessages.toLocaleString()}</div>
      <div class="stat-label">Total Messages</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${totalUsers.toLocaleString()}</div>
      <div class="stat-label">Unique Members</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${totalChannels}</div>
      <div class="stat-label">Channels</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${stats.timeline.length}</div>
      <div class="stat-label">Months Active</div>
    </div>
  </div>`;

  // Channel activity
  const maxCh = Math.max(...stats.channels.map(c => c.messageCount));
  html += `<div class="stats-section">
    <h3>Channel Activity</h3>
    <div class="bar-chart">`;
  for (const ch of stats.channels) {
    const pct = maxCh > 0 ? (ch.messageCount / maxCh * 100).toFixed(1) : 0;
    html += `<div class="bar-row">
      <a class="bar-label" href="channel.html#${ch.id}" title="${escapeHtml(ch.name)}"># ${escapeHtml(ch.name)}</a>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <span class="bar-count">${ch.messageCount.toLocaleString()}</span>
    </div>`;
  }
  html += `</div></div>`;

  // Leaderboard — all members with filter + sort
  const maxUser = allUsers[0] ? allUsers[0].messageCount : 1;
  html += `<div class="stats-section" id="leaderboard-section">
    <h3>All Members (${totalUsers.toLocaleString()})</h3>
    <div class="lb-controls">
      <input id="member-filter" type="text" placeholder="Filter by name…" autocomplete="off">
      <div class="lb-sort-btns">
        <button id="sort-by-msgs" class="btn-secondary active" title="Sort by message count">By Messages</button>
        <button id="sort-by-name" class="btn-secondary" title="Sort alphabetically">A–Z</button>
      </div>
    </div>
    <div id="lb-count" class="lb-count">Showing ${totalUsers.toLocaleString()} members</div>
    <div class="leaderboard">
      <table class="leaderboard-table" id="leaderboard-table">
        <thead><tr>
          <th class="rank">#</th>
          <th>Member</th>
          <th>Messages</th>
          <th style="min-width:160px">Activity</th>
          <th></th>
        </tr></thead>
        <tbody id="leaderboard-body"></tbody>
      </table>
    </div>
  </div>`;

  // Timeline
  if (stats.timeline.length > 0) {
    const maxT = Math.max(...stats.timeline.map(t => t.count));
    html += `<div class="stats-section">
      <h3>Message Timeline</h3>
      <div class="timeline-chart">`;
    for (const { month, count } of stats.timeline) {
      const h = maxT > 0 ? Math.max(2, Math.round((count / maxT) * 130)) : 2;
      html += `<div class="timeline-bar" title="${escapeHtml(month)}: ${count.toLocaleString()} msgs">
        <div class="timeline-fill" style="height:${h}px"></div>
        <div class="timeline-label">${escapeHtml(month)}</div>
      </div>`;
    }
    html += `</div></div>`;
  }

  // Keyword tracker
  html += `<div class="stats-section">
    <h3>Keyword Search</h3>
    <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Search across all channels. Results show total count and breakdown by channel and member.</p>
    <div class="keyword-search">
      <input id="keyword-input" type="text" placeholder="Enter a word or phrase…" autocomplete="off">
      <button id="keyword-btn" class="btn-primary">Search</button>
    </div>
    <div id="keyword-results"></div>
  </div>`;

  body.innerHTML = html;

  // ── Leaderboard state ──────────────────────────────────────

  let sortMode = 'msgs'; // 'msgs' | 'name'
  let filterTerm = '';

  function getFilteredSorted() {
    let list = allUsers;
    if (filterTerm) {
      const fl = filterTerm.toLowerCase();
      list = list.filter(u => {
        const name = (u.name || u.username || u.id || '').toLowerCase();
        return name.includes(fl);
      });
    }
    if (sortMode === 'name') {
      list = list.slice().sort((a, b) => {
        const na = (a.name || a.username || '').toLowerCase();
        const nb = (b.name || b.username || '').toLowerCase();
        return na.localeCompare(nb);
      });
    }
    // sortMode === 'msgs' keeps existing order (already sorted desc by parse.js)
    return list;
  }

  function renderLeaderboard() {
    const tbody = document.getElementById('leaderboard-body');
    const countEl = document.getElementById('lb-count');
    if (!tbody) return;

    const list = getFilteredSorted();
    if (countEl) {
      countEl.textContent = filterTerm
        ? `Showing ${list.length.toLocaleString()} of ${totalUsers.toLocaleString()} members`
        : `Showing ${list.length.toLocaleString()} members`;
    }

    let rows = '';
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      const pct = (u.messageCount / maxUser * 100).toFixed(1);
      const hasBreakdown = u.perChannel && Object.keys(u.perChannel).length > 0;
      const expandBtn = hasBreakdown
        ? `<button class="lb-expand-btn" data-user-id="${escapeHtml(u.id)}" title="Show per-channel breakdown">▶</button>`
        : '';
      // Use original rank (index in allUsers sorted by msgs) for the rank column when filtering or sorting by name
      const rank = sortMode === 'msgs' && !filterTerm ? i + 1 : (allUsers.indexOf(u) + 1);
      rows += `<tr data-user-id="${escapeHtml(u.id)}">
        <td class="rank">${rank}</td>
        <td class="username">${escapeHtml(u.name || u.username || u.id)}</td>
        <td>${u.messageCount.toLocaleString()}</td>
        <td><div class="inline-bar">
          <div class="inline-bar-fill" style="width:${pct}%"></div>
          <span>${pct}%</span>
        </div></td>
        <td>${expandBtn}</td>
      </tr>`;
    }
    tbody.innerHTML = rows;
  }

  renderLeaderboard();

  // Filter input
  const filterInput = document.getElementById('member-filter');
  if (filterInput) {
    filterInput.addEventListener('input', debounceStats(() => {
      filterTerm = filterInput.value.trim();
      renderLeaderboard();
    }, 150));
  }

  // Sort buttons
  const sortMsgsBtn = document.getElementById('sort-by-msgs');
  const sortNameBtn = document.getElementById('sort-by-name');
  if (sortMsgsBtn) {
    sortMsgsBtn.addEventListener('click', () => {
      sortMode = 'msgs';
      sortMsgsBtn.classList.add('active');
      if (sortNameBtn) sortNameBtn.classList.remove('active');
      renderLeaderboard();
    });
  }
  if (sortNameBtn) {
    sortNameBtn.addEventListener('click', () => {
      sortMode = 'name';
      sortNameBtn.classList.add('active');
      if (sortMsgsBtn) sortMsgsBtn.classList.remove('active');
      renderLeaderboard();
    });
  }

  // Expandable channel breakdown rows — event delegation on tbody
  const tbody = document.getElementById('leaderboard-body');
  if (tbody) {
    tbody.addEventListener('click', e => {
      const btn = e.target.closest('.lb-expand-btn');
      if (!btn) return;

      const userId = btn.dataset.userId;
      const parentRow = btn.closest('tr');
      if (!parentRow) return;

      // Toggle: check if breakdown row already exists after this row
      const next = parentRow.nextElementSibling;
      if (next && next.classList.contains('lb-breakdown-row')) {
        next.remove();
        btn.textContent = '▶';
        return;
      }

      // Build breakdown row
      const user = allUsers.find(u => u.id === userId);
      if (!user || !user.perChannel) return;

      const channelMap = {};
      for (const ch of stats.channels) channelMap[ch.id] = ch.name;

      const sorted = Object.entries(user.perChannel).sort(([, a], [, b]) => b - a);
      let inner = '<table class="lb-breakdown-table"><tbody>';
      for (const [chId, count] of sorted) {
        const chName = channelMap[chId] || chId;
        inner += `<tr>
          <td><a href="channel.html#${escapeHtml(chId)}" class="lb-breakdown-ch"># ${escapeHtml(chName)}</a></td>
          <td class="lb-breakdown-count">${count.toLocaleString()}</td>
        </tr>`;
      }
      inner += '</tbody></table>';

      const breakdownRow = document.createElement('tr');
      breakdownRow.className = 'lb-breakdown-row';
      breakdownRow.innerHTML = `<td colspan="5"><div class="lb-breakdown-wrap">${inner}</div></td>`;
      parentRow.insertAdjacentElement('afterend', breakdownRow);
      btn.textContent = '▼';
    });
  }

  // ── Keyword tracker ────────────────────────────────────────

  const kwInput = document.getElementById('keyword-input');
  const kwBtn = document.getElementById('keyword-btn');
  const kwResults = document.getElementById('keyword-results');

  async function runKeywordSearch() {
    const q = kwInput ? kwInput.value.trim() : '';
    if (!q || !kwResults) return;

    kwResults.innerHTML = '<div class="loading">Searching…</div>';
    const ql = q.toLowerCase();

    let totalCount = 0;
    const channelBreakdown = [];
    const userMap = {};

    for (const ch of channels) {
      let idx;
      try {
        idx = await loadJSON(`${DATA}search-${ch.id}.json`);
      } catch { continue; }

      const hits = idx.filter(m =>
        (m.text && m.text.toLowerCase().includes(ql)) ||
        (m.authorName && m.authorName.toLowerCase().includes(ql)) ||
        (m.authorUsername && m.authorUsername.toLowerCase().includes(ql))
      );

      if (hits.length === 0) continue;
      totalCount += hits.length;
      channelBreakdown.push({ channel: ch, count: hits.length });

      for (const m of hits) {
        const key = m.authorId || m.authorUsername;
        if (!userMap[key]) userMap[key] = { name: m.authorName || m.authorUsername || key, count: 0 };
        userMap[key].count++;
      }
    }

    if (totalCount === 0) {
      kwResults.innerHTML = `<div class="keyword-total">No results for "${escapeHtml(q)}".</div>`;
      return;
    }

    const sortedUsers = Object.values(userMap).sort((a, b) => b.count - a.count);
    const INITIAL_SHOW = 20;
    const hasMore = sortedUsers.length > INITIAL_SHOW;

    let rhtml = `<div class="keyword-total">${totalCount.toLocaleString()} message${totalCount !== 1 ? 's' : ''} mention "${escapeHtml(q)}"</div>`;
    rhtml += `<div class="keyword-breakdown">`;
    for (const { channel, count } of channelBreakdown.sort((a, b) => b.count - a.count)) {
      rhtml += `<div class="keyword-ch-row">
        <a href="channel.html#${channel.id}"># ${escapeHtml(channel.name)}</a>
        <span class="keyword-ch-count">${count.toLocaleString()}</span>
      </div>`;
    }
    rhtml += `</div>`;

    rhtml += `<h4 style="font-size:12px;color:var(--text-category);text-transform:uppercase;letter-spacing:.04em;margin:12px 0 8px">Members mentioning this term (${sortedUsers.length.toLocaleString()})</h4>`;
    rhtml += `<div class="keyword-users" id="kw-users-list">`;
    for (const u of sortedUsers.slice(0, INITIAL_SHOW)) {
      rhtml += `<div class="keyword-user-row">
        <span>${escapeHtml(u.name)}</span>
        <span>${u.count.toLocaleString()}</span>
      </div>`;
    }
    rhtml += `</div>`;

    if (hasMore) {
      rhtml += `<button class="kw-show-all" id="kw-show-all-btn">Show all ${sortedUsers.length.toLocaleString()} members</button>`;
    }

    kwResults.innerHTML = rhtml;

    if (hasMore) {
      const showAllBtn = document.getElementById('kw-show-all-btn');
      const usersList = document.getElementById('kw-users-list');
      if (showAllBtn && usersList) {
        showAllBtn.addEventListener('click', () => {
          let extra = '';
          for (const u of sortedUsers.slice(INITIAL_SHOW)) {
            extra += `<div class="keyword-user-row">
              <span>${escapeHtml(u.name)}</span>
              <span>${u.count.toLocaleString()}</span>
            </div>`;
          }
          usersList.insertAdjacentHTML('beforeend', extra);
          showAllBtn.remove();
        });
      }
    }
  }

  if (kwBtn) kwBtn.addEventListener('click', runKeywordSearch);
  if (kwInput) kwInput.addEventListener('keydown', e => { if (e.key === 'Enter') runKeywordSearch(); });

  buildSidebar(channels, null);
}
