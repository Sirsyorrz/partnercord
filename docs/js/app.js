'use strict';

const CHUNK_SIZE = 200;
const INITIAL_RENDER = 400;
const DATA = 'data/';

let channelList = [];
let currentChannelId = null;
let currentMessages = [];
let filteredMessages = null; // null = showing all; kept for search.js compatibility

// Pending cross-channel navigation state (set by search.js)
let pendingJumpId = null;      // message ID to scroll to after channel loads
let pendingSearchTerm = null;  // channel search term to apply after channel loads

// Per-channel saved scroll positions
const channelScrollPos = new Map();

// Incremental render state
let renderMsgs = [];   // messages currently being rendered into the DOM
let renderOffset = 0;  // how many have been rendered so far
let scrollObserver = null;

// ── Utilities ─────────────────────────────────────────────────

async function loadJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
  return r.json();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTs(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatTsShort(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Sidebar ────────────────────────────────────────────────────

function buildSidebar(channels, activeId) {
  const el = document.getElementById('sidebar-channels');
  if (!el) return;

  const isChannelPage = !!document.getElementById('messages-container');
  const isStatsPage = !!document.getElementById('stats-content');

  const cats = {};
  for (const ch of channels) {
    if (!cats[ch.category]) cats[ch.category] = [];
    cats[ch.category].push(ch);
  }

  let html = '';

  const statsHref = 'index.html';
  const statsActive = isStatsPage ? ' active' : '';
  html += `<a href="${statsHref}" class="stats-link${statsActive}">📊 <span>Statistics</span></a>`;

  for (const [cat, chs] of Object.entries(cats)) {
    html += `<div class="category">${escapeHtml(cat)}</div>`;
    for (const ch of chs) {
      const active = ch.id === activeId ? ' active' : '';
      const href = `channel.html#${ch.id}`;
      const count = ch.messageCount ? ` <span class="msg-count">${ch.messageCount.toLocaleString()}</span>` : '';
      html += `<a href="${href}" class="channel-item${active}" data-channel-id="${ch.id}">
        <span class="hash">#</span>
        <span class="channel-name">${escapeHtml(ch.name)}</span>${count}
      </a>`;
    }
  }

  el.innerHTML = html;
}

// ── Message rendering ──────────────────────────────────────────

function renderMessages(msgs) {
  const container = document.getElementById('messages-container');
  if (!container) return;

  if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }

  renderMsgs = msgs || [];
  renderOffset = 0;

  if (renderMsgs.length === 0) {
    container.innerHTML = '<div class="no-results">No messages found.</div>';
    return;
  }

  const end = Math.min(INITIAL_RENDER, renderMsgs.length);
  let html = '';
  for (let i = 0; i < end; i++) {
    html += renderMessage(renderMsgs[i], i > 0 ? renderMsgs[i - 1] : null);
  }
  renderOffset = end;
  container.innerHTML = html;
  container.scrollTop = 0;

  if (renderOffset < renderMsgs.length) {
    setupScrollSentinel(container);
  }
}

function setupScrollSentinel(container) {
  const sentinel = document.createElement('div');
  sentinel.className = 'load-sentinel';
  container.appendChild(sentinel);

  scrollObserver = new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting) return;

    const end = Math.min(renderOffset + CHUNK_SIZE, renderMsgs.length);
    let html = '';
    for (let i = renderOffset; i < end; i++) {
      html += renderMessage(renderMsgs[i], renderMsgs[i - 1] || null);
    }
    renderOffset = end;

    sentinel.insertAdjacentHTML('beforebegin', html);

    // Notify search module that new messages were rendered
    if (typeof afterMessagesRendered === 'function') afterMessagesRendered();

    if (renderOffset >= renderMsgs.length) {
      scrollObserver.disconnect();
      scrollObserver = null;
      sentinel.remove();
    }
  }, { root: container, rootMargin: '400px' });

  scrollObserver.observe(sentinel);
}

function isGroupContinuation(msg, prev) {
  if (!prev) return false;
  if (msg.authorId !== prev.authorId) return false;
  if (!msg.timestampMs || !prev.timestampMs) return false;
  return (msg.timestampMs - prev.timestampMs) < 7 * 60 * 1000;
}

function renderMessage(msg, prev) {
  const isCont = isGroupContinuation(msg, prev);
  const cls = isCont ? 'message-container continuation' : 'message-container';
  const ts = msg.timestampMs ? formatTs(msg.timestampMs) : (msg.timestampStr || '');
  const tsShort = msg.timestampMs ? formatTsShort(msg.timestampMs) : '';

  let aside, header;
  if (isCont) {
    aside = `<div class="message-aside"><div class="short-timestamp" title="${escapeHtml(ts)}">${escapeHtml(tsShort)}</div></div>`;
    header = '';
  } else {
    const avatarSrc = msg.authorAvatar || '';
    const avatarEl = avatarSrc
      ? `<img class="avatar" src="${escapeHtml(avatarSrc)}" alt="" loading="lazy">`
      : '<div class="avatar-placeholder"></div>';
    aside = `<div class="message-aside">${avatarEl}</div>`;
    const colorStyle = msg.authorColor ? ` style="color:${escapeHtml(msg.authorColor)}"` : '';
    header = `<div class="message-header">
      <span class="author"${colorStyle}>${escapeHtml(msg.authorName || '?')}</span>
      <span class="timestamp" title="${escapeHtml(ts)}">${escapeHtml(ts)}</span>
    </div>`;
  }

  const content = msg.contentHtml
    ? `<div class="message-content">${msg.contentHtml}</div>`
    : '';

  return `<div class="${cls}" id="msg-${escapeHtml(msg.id)}">
    ${aside}
    <div class="message-primary">${header}${content}</div>
  </div>`;
}

// ── Jump to message / date ─────────────────────────────────────

// Jump to a specific message by ID. If not yet rendered, renders to it first.
// Called from search.js via scrollToMessage fallback.
function jumpToMessage(msgId) {
  const el = document.getElementById(`msg-${msgId}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('highlighted');
    setTimeout(() => el.classList.remove('highlighted'), 2000);
    return;
  }

  const idx = renderMsgs.findIndex(m => String(m.id) === String(msgId));
  if (idx === -1) return;
  jumpToIndex(idx);
}

function jumpToIndex(index) {
  const container = document.getElementById('messages-container');
  if (!container || !renderMsgs || renderMsgs.length === 0) return;

  if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }

  index = Math.max(0, Math.min(index, renderMsgs.length - 1));

  // Render from a bit before the target for context
  const startIdx = Math.max(0, index - 50);
  const endIdx = Math.min(startIdx + INITIAL_RENDER, renderMsgs.length);
  let html = '';
  for (let i = startIdx; i < endIdx; i++) {
    html += renderMessage(renderMsgs[i], i > 0 ? renderMsgs[i - 1] : null);
  }
  renderOffset = endIdx;
  container.innerHTML = html;

  if (renderOffset < renderMsgs.length) setupScrollSentinel(container);

  requestAnimationFrame(() => {
    const targetMsg = renderMsgs[index];
    if (!targetMsg) return;
    const el = document.getElementById(`msg-${targetMsg.id}`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('highlighted');
      setTimeout(() => el.classList.remove('highlighted'), 2000);
    }
    // Notify search module that messages were re-rendered around a jump target
    if (typeof afterMessagesRendered === 'function') afterMessagesRendered();
  });
}

function jumpToDate(dateStr) {
  const msgs = filteredMessages || currentMessages;
  if (!dateStr || !msgs || msgs.length === 0) return;
  const targetMs = new Date(dateStr).getTime();
  if (isNaN(targetMs)) return;

  // Binary search for first message at or after target date
  let lo = 0, hi = msgs.length - 1, found = msgs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((msgs[mid].timestampMs || 0) >= targetMs) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  renderMsgs = msgs;
  jumpToIndex(found);
}

// ── Channel loading ────────────────────────────────────────────

async function loadChannel(channelId) {
  const container = document.getElementById('messages-container');
  const titleEl = document.getElementById('channel-title');
  const loading = document.getElementById('messages-loading');

  if (!container) return;

  // Save current scroll position before switching
  if (currentChannelId) {
    channelScrollPos.set(currentChannelId, container.scrollTop);
  }

  currentChannelId = channelId;
  filteredMessages = null;

  if (scrollObserver) { scrollObserver.disconnect(); scrollObserver = null; }

  if (loading) { loading.textContent = 'Loading…'; loading.classList.remove('hidden'); }
  container.innerHTML = '';

  const ch = channelList.find(c => c.id === channelId);
  if (titleEl && ch) titleEl.textContent = `# ${ch.name}`;
  document.title = ch ? `#${ch.name} — SoT Creators Archive` : 'SoT Creators Archive';

  buildSidebar(channelList, channelId);

  const srPanel = document.getElementById('search-results-panel');
  if (srPanel) srPanel.classList.add('hidden');
  const navBar = document.getElementById('search-navigator');
  if (navBar) navBar.classList.add('hidden');
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = '';
  const clearBtn = document.getElementById('search-clear-btn');
  if (clearBtn) clearBtn.classList.add('hidden');

  try {
    currentMessages = await loadJSON(`${DATA}channel-${channelId}.json`);
    if (loading) loading.classList.add('hidden');
    renderMessages(currentMessages);

    if (typeof initSearch === 'function') initSearch(channelId);

    // Handle cross-channel pending jump (set by search.js before navigating)
    const jumpId = pendingJumpId;
    const searchTerm = pendingSearchTerm;
    pendingJumpId = null;
    pendingSearchTerm = null;

    if (jumpId) {
      jumpToMessage(jumpId);
    } else if (searchTerm) {
      // Restore search term and trigger channel search
      if (typeof triggerChannelSearch === 'function') triggerChannelSearch(searchTerm);
    } else {
      // Restore scroll position if returning to this channel
      const savedPos = channelScrollPos.get(channelId);
      if (savedPos) container.scrollTop = savedPos;
    }
  } catch (e) {
    container.innerHTML = `<div class="error">Failed to load channel: ${escapeHtml(e.message)}</div>`;
  }
}

function navigateToChannel(channelId) {
  if (channelId === currentChannelId) return;
  history.pushState({ channelId }, '', `#${channelId}`);
  loadChannel(channelId);
}

// ── Hash routing ───────────────────────────────────────────────

function handleHash() {
  const hash = location.hash.slice(1);
  if (hash && channelList.find(c => c.id === hash)) {
    loadChannel(hash);
  } else if (channelList.length > 0) {
    loadChannel(channelList[0].id);
    history.replaceState({ channelId: channelList[0].id }, '', `#${channelList[0].id}`);
  }
}

// ── Date jump ──────────────────────────────────────────────────

function setupDateJump() {
  const input = document.getElementById('date-jump-input');
  if (!input) return;
  input.addEventListener('change', () => jumpToDate(input.value));
}

// ── Init ───────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    channelList = await loadJSON(`${DATA}channels.json`);
  } catch (e) {
    const el = document.getElementById('sidebar-channels');
    if (el) el.innerHTML = `<div class="error">Failed to load channels</div>`;
    return;
  }

  const isChannelPage = !!document.getElementById('messages-container');

  buildSidebar(channelList, null);

  const sidebarEl = document.getElementById('sidebar-channels');
  if (sidebarEl) {
    sidebarEl.addEventListener('click', e => {
      const item = e.target.closest('.channel-item[data-channel-id]');
      if (!item) return;
      if (!isChannelPage) return;
      e.preventDefault();
      const cid = item.dataset.channelId;
      navigateToChannel(cid);
    });
  }

  if (isChannelPage) {
    setupDateJump();
    window.addEventListener('popstate', handleHash);
    handleHash();
  } else if (typeof initStats === 'function') {
    initStats(channelList);
  }
});
