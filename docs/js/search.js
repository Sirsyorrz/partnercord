'use strict';

// Search module — depends on app.js globals:
//   channelList, currentChannelId, currentMessages, filteredMessages,
//   renderMessages, jumpToMessage, jumpToIndex, navigateToChannel, loadJSON, escapeHtml, formatTs, DATA
//   pendingJumpId, pendingSearchTerm (written here, read by loadChannel in app.js)

let searchMode = 'channel'; // 'channel' | 'global'
let searchIndexCache = {};  // channelId -> parsed index

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
  if (!input) return;

  // Reset state (navigator hidden by loadChannel already)
  input.value = '';
  activeSearchTerm = '';
  searchHits = [];
  searchHitSet = new Set();
  currentHitIndex = -1;

  input.oninput = debounce(() => {
    const q = input.value.trim();
    activeSearchTerm = q;
    if (!q) { clearSearch(); return; }
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

  // Wire up navigator buttons (idempotent — onclick replaces previous)
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

  // Keyboard shortcuts — attach once per page load
  if (!keyboardListenerAdded) {
    keyboardListenerAdded = true;
    document.addEventListener('keydown', e => {
      if (!searchHits.length || searchMode !== 'channel') return;
      const key = e.key;
      // Ctrl+G = next, Ctrl+Shift+G = prev; F3 = next, Shift+F3 = prev
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
  // Remove <mark class="search-hit"> tags (unwrap to text)
  const container = document.getElementById('messages-container');
  if (!container) return;
  container.querySelectorAll('mark.search-hit').forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
  // Remove hit background class
  container.querySelectorAll('.search-hit-msg').forEach(el => el.classList.remove('search-hit-msg'));
}

// ── Search filter parser ──────────────────────────────────────

function parseSearchQuery(q) {
  const filters = {
    text: '',
    from: [],      // array of lowercase strings (OR logic)
    mentions: [],  // array of lowercase strings — messages @mentioning this user
    before: null,  // ms timestamp (exclusive)
    after: null,   // ms timestamp (exclusive)
    during: null,  // { year, month } or { year, month: null }
    has: new Set(), // 'link' | 'image' | 'embed' | 'file' | 'video' | 'audio' | 'sticker'
    in: [],        // channel name substrings for global search
    pinned: null,  // reserved for future use — data not available
  };

  // Extract filter tokens, collect remaining text
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
      // YYYY-MM or YYYY
      const mFull = val.match(/^(\d{4})-(\d{1,2})$/);
      const mYear = val.match(/^(\d{4})$/);
      if (mFull) filters.during = { year: parseInt(mFull[1]), month: parseInt(mFull[2]) - 1 };
      else if (mYear) filters.during = { year: parseInt(mYear[1]), month: null };
    } else if (key === 'has') {
      const v = val.toLowerCase();
      if (['link','image','embed','file','video','audio','sticker'].includes(v)) filters.has.add(v);
    } else if (key === 'in') {
      filters.in.push(val.toLowerCase());
    } else if (key === 'pinned') {
      // pinned: not yet supported — data not in channel JSON
    }
  }

  // Remove consumed tokens from remaining text
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
    filters.before !== null ||
    filters.after !== null ||
    filters.during !== null ||
    filters.has.size > 0
  );
}

function messageMatchesFilters(msg, filters) {
  // Text match (plainText)
  if (filters.text) {
    const tl = filters.text.toLowerCase();
    if (!msg.plainText || !msg.plainText.toLowerCase().includes(tl)) return false;
  }

  // from: — OR logic across multiple from values
  if (filters.from.length > 0) {
    const name = (msg.authorName || '').toLowerCase();
    const uname = (msg.authorUsername || '').toLowerCase();
    const matches = filters.from.some(f => name.includes(f) || uname.includes(f));
    if (!matches) return false;
  }

  // before: / after: — timestamp range
  if (filters.before !== null && msg.timestampMs >= filters.before) return false;
  if (filters.after !== null && msg.timestampMs <= filters.after) return false;

  // during: — year and optionally month
  if (filters.during !== null) {
    const d = new Date(msg.timestampMs);
    if (d.getUTCFullYear() !== filters.during.year) return false;
    if (filters.during.month !== null && d.getUTCMonth() !== filters.during.month) return false;
  }

  // has: — AND logic (message must satisfy all specified has filters)
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

  // Hide global results panel, show navigator
  const panel = document.getElementById('search-results-panel');
  if (panel) panel.classList.add('hidden');

  clearSearchHighlights();

  const filters = parseSearchQuery(q);

  if (!filtersActive(filters)) {
    clearSearch();
    return;
  }

  // Only highlight the text portion (not filter tokens)
  activeHighlightTerm = filters.text;

  searchHits = [];
  searchHitSet = new Set();

  for (let i = 0; i < currentMessages.length; i++) {
    if (messageMatchesFilters(currentMessages[i], filters)) {
      searchHits.push(i);
      searchHitSet.add(String(currentMessages[i].id));
    }
  }

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
    // Flash highlight (reuse app.js .highlighted class)
    el.classList.remove('highlighted');
    void el.offsetWidth; // force reflow to restart transition
    el.classList.add('highlighted');
    setTimeout(() => el.classList.remove('highlighted'), 2000);
    applySearchHighlights();
  } else {
    // Message not rendered — jumpToIndex will re-render and call afterMessagesRendered
    jumpToIndex(msgIndex);
    // afterMessagesRendered → applySearchHighlights will be called from the rAF in jumpToIndex
  }
}

// ── Text highlighting ─────────────────────────────────────────

function applySearchHighlights() {
  if (!activeSearchTerm || !searchHitSet.size) return;
  const container = document.getElementById('messages-container');
  if (!container) return;

  // First clear existing marks (in case of re-render)
  container.querySelectorAll('mark.search-hit').forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
  container.querySelectorAll('.search-hit-msg').forEach(el => el.classList.remove('search-hit-msg'));

  // Build text regex only from the text portion (not filter tokens)
  const re = activeHighlightTerm
    ? new RegExp(escapeRegex(activeHighlightTerm), 'gi')
    : null;

  // Walk all rendered message containers
  container.querySelectorAll('.message-container').forEach(msgEl => {
    const msgId = msgEl.id.replace(/^msg-/, '');
    if (!searchHitSet.has(msgId)) return;

    msgEl.classList.add('search-hit-msg');

    // Highlight text inside .message-content only when there's a text term
    if (re) {
      const contentEl = msgEl.querySelector('.message-content');
      if (contentEl) highlightTextInElement(contentEl, re);
    }
  });
}

function highlightTextInElement(el, re) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip text inside existing marks, code, and pre elements
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

async function doGlobalSearch(q) {
  // Clear channel search state
  clearSearchHighlights();
  searchHits = [];
  searchHitSet = new Set();
  currentHitIndex = -1;
  const nav = document.getElementById('search-navigator');
  if (nav) nav.classList.add('hidden');

  const panel = document.getElementById('search-results-panel');
  if (panel) { panel.classList.remove('hidden'); panel.innerHTML = '<div class="loading">Searching…</div>'; }

  const ql = q.toLowerCase();
  const allResults = []; // { channel, messages: [] }

  for (const ch of channelList) {
    if (!searchIndexCache[ch.id]) {
      try {
        searchIndexCache[ch.id] = await loadJSON(`${DATA}search-${ch.id}.json`);
      } catch { searchIndexCache[ch.id] = []; }
    }
    const idx = searchIndexCache[ch.id];
    const hits = idx.filter(m =>
      (m.text && m.text.toLowerCase().includes(ql)) ||
      (m.authorName && m.authorName.toLowerCase().includes(ql)) ||
      (m.authorUsername && m.authorUsername.toLowerCase().includes(ql))
    );
    if (hits.length > 0) allResults.push({ channel: ch, messages: hits });
  }

  const total = allResults.reduce((s, r) => s + r.messages.length, 0);
  const channelCount = allResults.length;

  if (!panel) return;
  if (total === 0) {
    panel.innerHTML = '<div class="search-count">No results found.</div>';
    return;
  }

  let html = `<div class="search-count">${total.toLocaleString()} result${total !== 1 ? 's' : ''} in ${channelCount} channel${channelCount !== 1 ? 's' : ''}</div>`;

  // Channel pills summary
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
      const snippet = highlightSnippet(truncate(m.text, 120), q);
      html += `<div class="search-result-item">
        <span class="search-author">${escapeHtml(m.authorName || m.authorUsername || '?')}</span>
        <span class="search-ts">${escapeHtml(ts)}</span>
        <a class="jump-link" href="channel.html#${escapeHtml(channel.id)}" data-jump-channel="${escapeHtml(channel.id)}" data-jump-msg="${escapeHtml(String(m.id))}">Jump →</a>
        <div class="search-snippet">${snippet}</div>
      </div>`;
    }
    if (messages.length > 5) {
      html += `<div class="search-more">… and ${(messages.length - 5).toLocaleString()} more — <button class="search-show-channel" data-jump-channel="${escapeHtml(channel.id)}" data-search-q="${escapeHtml(q)}">Search in #${escapeHtml(channel.name)}</button></div>`;
    }
    html += '</div>';
  }

  panel.innerHTML = html;

  // Wire up channel pill clicks — switch to channel-mode search for that channel
  panel.querySelectorAll('[data-jump-channel][data-search-q]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      const cid = btn.dataset.jumpChannel;
      const term = btn.dataset.searchQ;
      if (cid === currentChannelId) {
        // Switch to channel search mode for this channel
        searchMode = 'channel';
        const scopeBtn = document.getElementById('search-scope-btn');
        if (scopeBtn) { scopeBtn.textContent = 'This channel'; scopeBtn.classList.remove('active'); }
        doChannelSearch(term);
      } else {
        // Navigate to channel and trigger search there
        pendingSearchTerm = term;
        navigateToChannel(cid);
      }
    });
  });

  // Wire up jump links — scroll to specific message
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
