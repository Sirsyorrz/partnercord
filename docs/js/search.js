'use strict';

// Search module — depends on app.js globals:
//   channelList, currentChannelId, currentMessages, filteredMessages,
//   renderMessages, jumpToMessage, jumpToIndex, navigateToChannel, loadJSON, escapeHtml, formatTs, DATA
//   pendingJumpId, pendingSearchTerm (written here, read by loadChannel in app.js)

let searchMode = 'channel'; // 'channel' | 'global'
let searchIndexCache = {};  // channelId -> parsed index
let searchSortOrder = 'newest'; // 'newest' | 'oldest'

// Channel search state
let searchHits = [];        // indices into currentMessages of matching messages
let searchHitSet = new Set(); // same as searchHits but as a Set of message IDs for quick DOM lookup
let currentHitIndex = -1;   // which hit we're on (-1 = none)
let activeSearchTerm = '';
let activeHighlightTerm = ''; // text portion only, used by applySearchHighlights

// ── Init ──────────────────────────────────────────────────────

let keyboardListenerAdded = false;

function initSearch(channelId) {
  const input = document.getElementById('search-input');
  const scopeBtn = document.getElementById('search-scope-btn');
  const clearBtn = document.getElementById('search-clear-btn');
  const dropdown = document.getElementById('search-dropdown');
  if (!input) return;

  // Reset state (navigator hidden by loadChannel already)
  input.value = '';
  activeSearchTerm = '';
  searchHits = [];
  searchHitSet = new Set();
  currentHitIndex = -1;

  // ── Search dropdown (use property assignment — idempotent across initSearch calls) ──
  if (dropdown) {
    input.onfocus = () => {
      if (!input.value.trim()) dropdown.classList.remove('hidden');
    };
    input.onblur = () => {
      setTimeout(() => dropdown.classList.add('hidden'), 160);
    };

    dropdown.querySelectorAll('.search-dropdown-item[data-filter]').forEach(item => {
      item.onmousedown = e => {
        e.preventDefault();
        const filter = item.dataset.filter;
        const pos = input.selectionStart;
        const before = input.value.slice(0, pos);
        const after = input.value.slice(pos);
        const sep = before.length > 0 && !before.endsWith(' ') ? ' ' : '';
        input.value = before + sep + filter + after;
        const newPos = pos + sep.length + filter.length;
        input.setSelectionRange(newPos, newPos);
        dropdown.classList.add('hidden');
        input.focus();
        // Programmatic value change doesn't fire oninput — dispatch manually
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
    });
  }

  input.oninput = debounce(() => {
    const q = input.value.trim();
    activeSearchTerm = q;
    if (!q) {
      clearSearch();
      if (clearBtn) clearBtn.classList.add('hidden');
      if (dropdown) dropdown.classList.remove('hidden');
      return;
    }
    if (dropdown) dropdown.classList.add('hidden');
    if (clearBtn) clearBtn.classList.remove('hidden');
    if (searchMode === 'channel') doChannelSearch(q);
    else doGlobalSearch(q);
  }, 250);

  if (scopeBtn) {
    scopeBtn.onclick = () => {
      searchMode = searchMode === 'channel' ? 'global' : 'channel';
      scopeBtn.textContent = searchMode === 'channel' ? 'This channel' : 'All channels';
      scopeBtn.classList.toggle('active', searchMode === 'global');
      const q = input.value.trim();
      if (q) {
        if (searchMode === 'channel') doChannelSearch(q);
        else doGlobalSearch(q);
      }
    };
  }

  if (clearBtn) {
    clearBtn.onclick = () => {
      input.value = '';
      activeSearchTerm = '';
      clearBtn.classList.add('hidden');
      clearSearch();
    };
  }

  // ── Navigator buttons ────────────────────────────────────
  const prevBtn = document.getElementById('nav-prev');
  const nextBtn = document.getElementById('nav-next');
  const navClear = document.getElementById('nav-clear');

  if (prevBtn) prevBtn.onclick = () => { if (currentHitIndex > 0) jumpToHit(currentHitIndex - 1); };
  if (nextBtn) nextBtn.onclick = () => { if (currentHitIndex < searchHits.length - 1) jumpToHit(currentHitIndex + 1); };
  if (navClear) {
    navClear.onclick = () => {
      input.value = '';
      activeSearchTerm = '';
      if (clearBtn) clearBtn.classList.add('hidden');
      clearSearch();
    };
  }

  // ── Sort buttons ─────────────────────────────────────────
  const sortNewest = document.getElementById('nav-sort-newest');
  const sortOldest = document.getElementById('nav-sort-oldest');
  if (sortNewest) {
    sortNewest.onclick = () => {
      if (searchSortOrder === 'newest') return;
      searchSortOrder = 'newest';
      sortNewest.classList.add('active');
      if (sortOldest) sortOldest.classList.remove('active');
      if (activeSearchTerm && searchMode === 'channel') doChannelSearch(activeSearchTerm);
    };
  }
  if (sortOldest) {
    sortOldest.onclick = () => {
      if (searchSortOrder === 'oldest') return;
      searchSortOrder = 'oldest';
      sortOldest.classList.add('active');
      if (sortNewest) sortNewest.classList.remove('active');
      if (activeSearchTerm && searchMode === 'channel') doChannelSearch(activeSearchTerm);
    };
  }

  // ── Keyboard shortcuts ───────────────────────────────────
  if (!keyboardListenerAdded) {
    keyboardListenerAdded = true;
    document.addEventListener('keydown', e => {
      if (!searchHits.length || searchMode !== 'channel') return;
      const key = e.key;
      const isNext = (e.ctrlKey && !e.shiftKey && key === 'g') || (!e.ctrlKey && !e.shiftKey && key === 'F3');
      const isPrev = (e.ctrlKey && e.shiftKey && key === 'g') || (!e.ctrlKey && e.shiftKey && key === 'F3');
      if (isNext || isPrev) {
        e.preventDefault();
        if (isNext && currentHitIndex < searchHits.length - 1) jumpToHit(currentHitIndex + 1);
        if (isPrev && currentHitIndex > 0) jumpToHit(currentHitIndex - 1);
      }
    });
  }
}

// Called by app.js (loadChannel) after a cross-channel navigate to apply a pending search
function triggerChannelSearch(term) {
  const input = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear-btn');
  if (input) input.value = term;
  if (clearBtn) clearBtn.classList.remove('hidden');
  activeSearchTerm = term;
  searchMode = 'channel';
  const scopeBtn = document.getElementById('search-scope-btn');
  if (scopeBtn) { scopeBtn.textContent = 'This channel'; scopeBtn.classList.remove('active'); }
  doChannelSearch(term);
}

// Called by app.js sentinel observer and jumpToIndex rAF — reapplies highlights to newly rendered messages
function afterMessagesRendered() {
  if (!activeSearchTerm || searchMode !== 'channel') return;
  applySearchHighlights();
}

// ── Clear ─────────────────────────────────────────────────────

function clearSearch() {
  searchHits = [];
  searchHitSet = new Set();
  currentHitIndex = -1;
  activeHighlightTerm = '';
  clearSearchHighlights();

  const panel = document.getElementById('search-results-panel');
  if (panel) panel.classList.add('hidden');
  const nav = document.getElementById('search-navigator');
  if (nav) nav.classList.add('hidden');
}

function clearSearchHighlights() {
  const container = document.getElementById('messages-container');
  if (!container) return;
  container.querySelectorAll('mark.search-hit').forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
  container.querySelectorAll('.search-hit-msg').forEach(el => el.classList.remove('search-hit-msg'));
}

// ── Search filter parser ──────────────────────────────────────

function parseSearchQuery(q) {
  const filters = {
    text: '',
    from: [],
    mentions: [],
    before: null,
    after: null,
    during: null,
    has: new Set(),
    in: [],
    pinned: null,
  };

  let remaining = q;
  const tokenRe = /\b(from|mentions|before|after|during|has|in|pinned):(\S+)/gi;
  const consumed = [];
  let match;
  while ((match = tokenRe.exec(q)) !== null) {
    const key = match[1].toLowerCase();
    const val = match[2];
    consumed.push(match[0]);

    if (key === 'from') {
      filters.from.push(val.toLowerCase());
    } else if (key === 'mentions') {
      filters.mentions.push(val.toLowerCase());
    } else if (key === 'before') {
      const ms = new Date(val).getTime();
      if (!isNaN(ms)) filters.before = ms;
    } else if (key === 'after') {
      const ms = new Date(val).getTime();
      if (!isNaN(ms)) filters.after = ms;
    } else if (key === 'during') {
      const mFull = val.match(/^(\d{4})-(\d{1,2})$/);
      const mYear = val.match(/^(\d{4})$/);
      if (mFull) filters.during = { year: parseInt(mFull[1]), month: parseInt(mFull[2]) - 1 };
      else if (mYear) filters.during = { year: parseInt(mYear[1]), month: null };
    } else if (key === 'has') {
      const v = val.toLowerCase();
      if (['link','image','embed','file','video','audio','sticker'].includes(v)) filters.has.add(v);
    } else if (key === 'in') {
      filters.in.push(val.toLowerCase());
    }
  }

  for (const tok of consumed) {
    remaining = remaining.replace(tok, '');
  }
  filters.text = remaining.replace(/\s+/g, ' ').trim();

  return filters;
}

function filtersActive(filters) {
  return (
    filters.text !== '' ||
    filters.from.length > 0 ||
    filters.mentions.length > 0 ||
    filters.before !== null ||
    filters.after !== null ||
    filters.during !== null ||
    filters.has.size > 0
  );
}

function messageMatchesFilters(msg, filters) {
  if (filters.text) {
    const tl = filters.text.toLowerCase();
    if (!msg.plainText || !msg.plainText.toLowerCase().includes(tl)) return false;
  }

  if (filters.from.length > 0) {
    const name = (msg.authorName || '').toLowerCase();
    const uname = (msg.authorUsername || '').toLowerCase();
    const matches = filters.from.some(f => name.includes(f) || uname.includes(f));
    if (!matches) return false;
  }

  // mentions: — check contentHtml for @mention spans, fall back to plainText
  if (filters.mentions.length > 0) {
    const html = (msg.contentHtml || '').toLowerCase();
    const plain = (msg.plainText || '').toLowerCase();
    const matched = filters.mentions.some(f =>
      html.includes('@' + f) || plain.includes('@' + f)
    );
    if (!matched) return false;
  }

  if (filters.before !== null && msg.timestampMs >= filters.before) return false;
  if (filters.after !== null && msg.timestampMs <= filters.after) return false;

  if (filters.during !== null) {
    const d = new Date(msg.timestampMs);
    if (d.getUTCFullYear() !== filters.during.year) return false;
    if (filters.during.month !== null && d.getUTCMonth() !== filters.during.month) return false;
  }

  if (filters.has.has('link')) {
    if (!/https?:\/\//i.test((msg.plainText || '') + (msg.contentHtml || ''))) return false;
  }
  if (filters.has.has('image')) {
    if (!/chatlog__embed-image/i.test(msg.contentHtml || '')) return false;
  }
  if (filters.has.has('embed')) {
    if (!/chatlog__embed/i.test(msg.contentHtml || '')) return false;
  }

  return true;
}

// ── Channel search ────────────────────────────────────────────

function doChannelSearch(q) {
  if (!currentMessages) return;

  const panel = document.getElementById('search-results-panel');
  if (panel) panel.classList.add('hidden');

  clearSearchHighlights();

  const filters = parseSearchQuery(q);

  if (!filtersActive(filters)) {
    clearSearch();
    return;
  }

  activeHighlightTerm = filters.text;

  searchHits = [];
  searchHitSet = new Set();

  for (let i = 0; i < currentMessages.length; i++) {
    if (messageMatchesFilters(currentMessages[i], filters)) {
      searchHits.push(i);
      searchHitSet.add(String(currentMessages[i].id));
    }
  }

  // Sort by order preference (messages are chronological so index = time)
  if (searchSortOrder === 'newest') {
    searchHits.sort((a, b) => b - a);
  }
  // 'oldest' is already ascending (natural order)

  showNavigator(searchHits.length);

  if (searchHits.length === 0) return;

  applySearchHighlights();
  jumpToHit(0);
}

function showNavigator(count) {
  const nav = document.getElementById('search-navigator');
  const counter = document.getElementById('nav-counter');
  const prevBtn = document.getElementById('nav-prev');
  const nextBtn = document.getElementById('nav-next');
  if (!nav) return;

  nav.classList.remove('hidden');

  if (count === 0) {
    if (counter) counter.textContent = 'No results';
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }

  updateNavigator();
}

function updateNavigator() {
  const counter = document.getElementById('nav-counter');
  const prevBtn = document.getElementById('nav-prev');
  const nextBtn = document.getElementById('nav-next');

  if (counter) counter.textContent = `Result ${currentHitIndex + 1} of ${searchHits.length}`;
  if (prevBtn) prevBtn.disabled = currentHitIndex <= 0;
  if (nextBtn) nextBtn.disabled = currentHitIndex >= searchHits.length - 1;
}

function jumpToHit(hitIndex) {
  if (!searchHits.length) return;
  hitIndex = Math.max(0, Math.min(hitIndex, searchHits.length - 1));
  currentHitIndex = hitIndex;
  updateNavigator();

  const msgIndex = searchHits[hitIndex];
  const targetMsg = currentMessages[msgIndex];
  if (!targetMsg) return;

  const el = document.getElementById(`msg-${targetMsg.id}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('highlighted');
    void el.offsetWidth;
    el.classList.add('highlighted');
    setTimeout(() => el.classList.remove('highlighted'), 2000);
    applySearchHighlights();
  } else {
    jumpToIndex(msgIndex);
  }
}

// ── Text highlighting ─────────────────────────────────────────

function applySearchHighlights() {
  if (!activeSearchTerm || !searchHitSet.size) return;
  const container = document.getElementById('messages-container');
  if (!container) return;

  container.querySelectorAll('mark.search-hit').forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
  container.querySelectorAll('.search-hit-msg').forEach(el => el.classList.remove('search-hit-msg'));

  const re = activeHighlightTerm
    ? new RegExp(escapeRegex(activeHighlightTerm), 'gi')
    : null;

  container.querySelectorAll('.message-container').forEach(msgEl => {
    const msgId = msgEl.id.replace(/^msg-/, '');
    if (!searchHitSet.has(msgId)) return;

    msgEl.classList.add('search-hit-msg');

    if (re) {
      const contentEl = msgEl.querySelector('.message-content');
      if (contentEl) highlightTextInElement(contentEl, re);
    }
  });
}

function highlightTextInElement(el, re) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentNode;
      while (p && p !== el) {
        const tag = p.nodeName;
        if (tag === 'MARK' || tag === 'CODE' || tag === 'PRE') return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  for (const textNode of textNodes) {
    const text = textNode.textContent;
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;

    const parts = text.split(re);
    if (parts.length <= 1) continue;

    const frag = document.createDocumentFragment();
    re.lastIndex = 0;
    let match;
    let lastIdx = 0;

    while ((match = re.exec(text)) !== null) {
      if (match.index > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
      }
      const mark = document.createElement('mark');
      mark.className = 'search-hit';
      mark.textContent = match[0];
      frag.appendChild(mark);
      lastIdx = re.lastIndex;
    }
    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    }

    textNode.parentNode.replaceChild(frag, textNode);
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Global search ─────────────────────────────────────────────

function getAvatarColor(name) {
  const colors = ['#5865f2','#57f287','#3ba55d','#eb459e','#ed4245','#00b0f4','#f47fff','#faa61a'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

async function doGlobalSearch(q) {
  clearSearchHighlights();
  searchHits = [];
  searchHitSet = new Set();
  currentHitIndex = -1;
  const nav = document.getElementById('search-navigator');
  if (nav) nav.classList.add('hidden');

  const panel = document.getElementById('search-results-panel');
  if (panel) { panel.classList.remove('hidden'); panel.innerHTML = '<div class="loading">Searching…</div>'; }

  const filters = parseSearchQuery(q);
  const ql = filters.text.toLowerCase();
  const allResults = [];

  for (const ch of channelList) {
    if (!searchIndexCache[ch.id]) {
      try {
        searchIndexCache[ch.id] = await loadJSON(`${DATA}search-${ch.id}.json`);
      } catch { searchIndexCache[ch.id] = []; }
    }
    const idx = searchIndexCache[ch.id];
    const hits = idx.filter(m => {
      // Text match (also match author name when no from: filter is set)
      if (ql) {
        const textMatch = m.text && m.text.toLowerCase().includes(ql);
        const authorFallback = !filters.from.length && (
          (m.authorName && m.authorName.toLowerCase().includes(ql)) ||
          (m.authorUsername && m.authorUsername.toLowerCase().includes(ql))
        );
        if (!textMatch && !authorFallback) return false;
      }
      // from: filter
      if (filters.from.length > 0) {
        const name = (m.authorName || '').toLowerCase();
        const uname = (m.authorUsername || '').toLowerCase();
        if (!filters.from.some(f => name.includes(f) || uname.includes(f))) return false;
      }
      // mentions: filter (search index only has plain text)
      if (filters.mentions.length > 0) {
        const text = (m.text || '').toLowerCase();
        if (!filters.mentions.some(f => text.includes('@' + f))) return false;
      }
      // date filters (search index uses m.timestamp in ms)
      if (filters.before !== null && m.timestamp >= filters.before) return false;
      if (filters.after !== null && m.timestamp <= filters.after) return false;
      if (filters.during !== null) {
        const d = new Date(m.timestamp);
        if (d.getUTCFullYear() !== filters.during.year) return false;
        if (filters.during.month !== null && d.getUTCMonth() !== filters.during.month) return false;
      }
      // has:link (plain text only — image/embed not available in search index)
      if (filters.has.has('link')) {
        if (!/https?:\/\//i.test(m.text || '')) return false;
      }
      return true;
    });
    if (hits.length > 0) allResults.push({ channel: ch, messages: hits });
  }

  const total = allResults.reduce((s, r) => s + r.messages.length, 0);
  const channelCount = allResults.length;

  if (!panel) return;
  if (total === 0) {
    panel.innerHTML = '<div class="search-results-header"><span class="search-results-title">Search Results</span><span class="search-results-count">No results</span></div>';
    return;
  }

  let html = `<div class="search-results-header">
    <span class="search-results-title">Search Results</span>
    <span class="search-results-count">${total.toLocaleString()} result${total !== 1 ? 's' : ''} in ${channelCount} channel${channelCount !== 1 ? 's' : ''}</span>
    <button class="search-results-close" id="search-results-close" title="Close results">✕</button>
  </div>`;

  // Channel pills
  html += '<div class="search-channel-pills">';
  for (const { channel, messages } of allResults) {
    html += `<button class="search-channel-pill" data-jump-channel="${escapeHtml(channel.id)}" data-search-q="${escapeHtml(q)}">#${escapeHtml(channel.name)} <span class="pill-count">${messages.length.toLocaleString()}</span></button>`;
  }
  html += '</div>';

  for (const { channel, messages } of allResults) {
    const shown = messages.slice(0, 5);
    html += `<div class="search-channel-group">
      <div class="search-channel-header"># ${escapeHtml(channel.name)} — ${messages.length.toLocaleString()} result${messages.length !== 1 ? 's' : ''}</div>`;
    for (const m of shown) {
      const ts = formatTs(m.timestamp);
      const snippet = highlightSnippet(truncate(m.text, 140), q);
      const name = m.authorName || m.authorUsername || '?';
      const initials = name.charAt(0).toUpperCase();
      const avatarColor = getAvatarColor(name);
      html += `<div class="search-result-card">
        <div class="search-result-avatar" style="background:${escapeHtml(avatarColor)}">${escapeHtml(initials)}</div>
        <div class="search-result-body">
          <div class="search-result-meta">
            <span class="search-result-author">${escapeHtml(name)}</span>
            <span class="search-result-ts">${escapeHtml(ts)}</span>
            <span class="search-result-channel-tag">#${escapeHtml(channel.name)}</span>
          </div>
          <div class="search-result-text">${snippet}</div>
        </div>
        <button class="search-result-jump" data-jump-channel="${escapeHtml(channel.id)}" data-jump-msg="${escapeHtml(String(m.id))}">Jump →</button>
      </div>`;
    }
    if (messages.length > 5) {
      html += `<div class="search-more">… and ${(messages.length - 5).toLocaleString()} more — <button class="search-show-channel" data-jump-channel="${escapeHtml(channel.id)}" data-search-q="${escapeHtml(q)}">Search in #${escapeHtml(channel.name)}</button></div>`;
    }
    html += '</div>';
  }

  panel.innerHTML = html;

  // Close button
  const closeBtn = panel.querySelector('#search-results-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      panel.classList.add('hidden');
      const inp = document.getElementById('search-input');
      const clr = document.getElementById('search-clear-btn');
      if (inp) inp.value = '';
      if (clr) clr.classList.add('hidden');
      activeSearchTerm = '';
      clearSearch();
    });
  }

  // Channel pill clicks
  panel.querySelectorAll('[data-jump-channel][data-search-q]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const cid = btn.dataset.jumpChannel;
      const term = btn.dataset.searchQ;
      if (cid === currentChannelId) {
        searchMode = 'channel';
        const scopeBtn = document.getElementById('search-scope-btn');
        if (scopeBtn) { scopeBtn.textContent = 'This channel'; scopeBtn.classList.remove('active'); }
        doChannelSearch(term);
      } else {
        pendingSearchTerm = term;
        navigateToChannel(cid);
      }
    });
  });

  // Jump buttons on result cards
  panel.querySelectorAll('.search-result-jump[data-jump-channel][data-jump-msg]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const cid = btn.dataset.jumpChannel;
      const mid = btn.dataset.jumpMsg;
      if (cid === currentChannelId) {
        scrollToMessage(mid);
      } else {
        pendingJumpId = mid;
        navigateToChannel(cid);
      }
    });
  });

  // Legacy jump links (kept for compat)
  panel.querySelectorAll('a[data-jump-channel][data-jump-msg]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      const cid = a.dataset.jumpChannel;
      const mid = a.dataset.jumpMsg;
      if (cid === currentChannelId) {
        scrollToMessage(mid);
      } else {
        pendingJumpId = mid;
        navigateToChannel(cid);
      }
    });
  });
}

function scrollToMessage(msgId) {
  const el = document.getElementById(`msg-${msgId}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('highlighted');
    setTimeout(() => el.classList.remove('highlighted'), 2000);
  } else {
    if (typeof jumpToMessage === 'function') jumpToMessage(msgId);
  }
}

// ── Utilities ─────────────────────────────────────────────────

function highlightSnippet(text, q) {
  if (!q) return escapeHtml(text);
  const safe = escapeHtml(text);
  const safeQ = escapeRegex(escapeHtml(q));
  return safe.replace(new RegExp(`(${safeQ})`, 'gi'), '<mark>$1</mark>');
}

function truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max) + '…';
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
