#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DISCORD_DIR = path.join(ROOT, 'the discord');
const OUT_DIR = path.join(ROOT, 'docs', 'data');

const CHANNELS = [
  { id: 'general', displayName: 'partner-general', category: 'Partner Chat',
    sources: [
      '2019-2025/Sea of Thieves Creators - Partner Chat - general [157587267584655360].html',
      '2025-2026/Sea of Thieves Creators - Partner Chat - partner-general [157587267584655360].html',
    ] },
  { id: 'how-to-partner', displayName: 'how-to-partner', category: 'Partner Chat',
    sources: [
      '2019-2025/Sea of Thieves Creators - Partner Chat - how-to-partner [157587267584655360].html',
    ] },
  { id: 'collabs', displayName: 'collabs', category: 'All Roles',
    sources: [
      '2019-2025/Sea of Thieves Creators - All Roles - collabs [157587267584655360].html',
    ] },
  { id: 'announcements', displayName: 'announcements', category: 'Rare Official',
    sources: [
      '2019-2025/Sea of Thieves Creators - Rare Official - announcements [157587267584655360].html',
      '2025-2026/Sea of Thieves Creators - Rare Official - announcements [157587267584655360].html',
    ] },
  { id: 'ask-rare', displayName: 'ask-rare-2-electric-boogaloo', category: 'Rare Official',
    sources: [
      '2019-2025/Sea of Thieves Creators - Rare Official - ask-rare-2-electric-boogaloo [157587267584655360].html',
      '2025-2026/Sea of Thieves Creators - Rare Official - ask-rare-2-electric-boogaloo [157587267584655360].html',
    ] },
  { id: 'rare-answers', displayName: 'rare-answers', category: 'Rare Official',
    sources: [
      '2019-2025/Sea of Thieves Creators - Server - rare-answers [157587267584655360].html',
      '2025-2026/Sea of Thieves Creators - Rare Official - rare-answers [157587267584655360].html',
    ] },
  { id: 'roadmap', displayName: 'roadmap', category: 'Rare Official',
    sources: [
      '2025-2026/Sea of Thieves Creators - Rare Official - roadmap [157587267584655360].html',
    ] },
  { id: 'tavern', displayName: 'tavern', category: 'Tavern',
    sources: [
      '2019-2025/Sea of Thieves Creators - All Roles - tavern [157587267584655360].html',
      '2025-2026/Sea of Thieves Creators - Tavern - tavern [157587267584655360].html',
    ] },
  { id: 'drops-feedback', displayName: 'drops-feedback', category: 'Tavern',
    sources: [
      '2025-2026/Sea of Thieves Creators - Tavern - drops-feedback [157587267584655360].html',
    ] },
];

const MONTHS = {
  January:0,February:1,March:2,April:3,May:4,June:5,
  July:6,August:7,September:8,October:9,November:10,December:11,
};

function parseTimestampStr(str) {
  const m = str.match(/(\d+)\s+(\w+)\s+(\d{4})\s+(\d+):(\d+)\s+(AM|PM)/);
  if (!m) return 0;
  const [,day,monthName,year,hour,min,ampm] = m;
  let h = parseInt(hour);
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return Date.UTC(parseInt(year), MONTHS[monthName], parseInt(day), h, parseInt(min));
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n)))
    .replace(/\s+/g, ' ').trim();
}

function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n)));
}

// Extract inner HTML of a div with a specific class string, scanning from startPos.
// Uses div depth tracking to find matching close tag.
function extractDivContent(html, startPos, classStr) {
  const openIdx = html.indexOf(classStr, startPos);
  if (openIdx === -1) return null;
  const tagEnd = html.indexOf('>', openIdx);
  if (tagEnd === -1) return null;

  let depth = 1, i = tagEnd + 1;
  const contentStart = i;

  while (i < html.length && depth > 0) {
    if (html[i] === '<') {
      if (html[i + 1] === '/') {
        if (html.slice(i, i + 6) === '</div>') {
          if (--depth === 0) return html.slice(contentStart, i);
          i += 6; continue;
        }
      } else if (html.slice(i, i + 4) === '<div') {
        depth++;
      }
    }
    i++;
  }
  return html.slice(contentStart, i);
}

function parseFile(filePath) {
  process.stdout.write(`    Parsing ${path.basename(filePath)}...`);
  const content = fs.readFileSync(filePath, 'utf8');
  const messages = [];

  const groups = content.split('<div class=chatlog__message-group>');

  for (let g = 1; g < groups.length; g++) {
    const groupHtml = groups[g];
    if (groupHtml.includes('chatlog__system-notification-icon')) continue;

    const parts = groupHtml.split('<div id=chatlog__message-container-');
    if (parts.length < 2) continue;

    // Extract author info from first container in group
    let authorId = null, authorName = null, authorUsername = null;
    let authorColor = null, authorAvatar = null;

    const first = parts[1];

    const avM = first.match(/<img[^>]*class=chatlog__avatar[^>]*src="([^"]+)"/);
    if (avM) authorAvatar = avM[1];

    const auIdx = first.indexOf('class=chatlog__author');
    if (auIdx !== -1) {
      const tagEnd = first.indexOf('>', auIdx);
      const spanClose = first.indexOf('</span>', tagEnd + 1);
      if (tagEnd !== -1 && spanClose !== -1) {
        const attrs = first.slice(auIdx, tagEnd);
        authorName = decodeHtml(first.slice(tagEnd + 1, spanClose).trim());
        const cM = attrs.match(/style=color:([^\s>]+)/);
        const tM = attrs.match(/title=(?:"([^"]+)"|'([^']+)'|([^\s"'>]+))/);
        const uM = attrs.match(/data-user-id=(\d+)/);
        authorColor = cM ? cM[1] : null;
        authorUsername = tM ? (tM[1] || tM[2] || tM[3]) : null;
        authorId = uM ? uM[1] : null;
      }
    }

    if (!authorId) continue;

    for (let c = 1; c < parts.length; c++) {
      const chunk = parts[c];
      const idM = chunk.match(/^(\d+)/);
      if (!idM) continue;
      const msgId = idM[1];

      if (chunk.includes('chatlog__system-notification')) continue;

      let timestampStr = null;
      const ftM = chunk.match(/class=chatlog__timestamp title="([^"]+)"/);
      const stM = chunk.match(/class=chatlog__short-timestamp title="([^"]+)"/);
      if (ftM) timestampStr = ftM[1];
      else if (stM) timestampStr = stM[1];
      const timestampMs = timestampStr ? parseTimestampStr(timestampStr) : 0;

      const contentHtml = extractDivContent(chunk, 0, 'class="chatlog__content chatlog__markdown"') || '';
      const plainText = stripHtml(contentHtml);

      messages.push({
        id: msgId,
        authorId, authorName, authorUsername, authorColor, authorAvatar,
        timestampStr, timestampMs,
        contentHtml, plainText,
        isGroupFirst: c === 1,
      });
    }
  }

  console.log(` ${messages.length} msgs`);
  return messages;
}

function processChannel(channel) {
  console.log(`\nChannel: ${channel.displayName} [${channel.id}]`);
  const all = [];

  for (const src of channel.sources) {
    const fp = path.join(DISCORD_DIR, src);
    if (!fs.existsSync(fp)) { console.warn(`  SKIP (not found): ${src}`); continue; }
    all.push(...parseFile(fp));
  }

  all.sort((a, b) => a.timestampMs - b.timestampMs);

  const seen = new Set(), deduped = [];
  for (const m of all) {
    if (!seen.has(m.id)) { seen.add(m.id); deduped.push(m); }
  }

  console.log(`  => ${deduped.length} messages (after dedup)`);
  return deduped;
}

function computeStats(channelResults) {
  const userMap = {}, channelStats = [], timelineMap = {};
  let totalMessages = 0;

  for (const { channel, messages } of channelResults) {
    channelStats.push({
      id: channel.id, name: channel.displayName,
      category: channel.category, messageCount: messages.length,
    });
    totalMessages += messages.length;

    for (const msg of messages) {
      if (!userMap[msg.authorId]) {
        userMap[msg.authorId] = {
          id: msg.authorId, name: msg.authorName, username: msg.authorUsername,
          messageCount: 0, perChannel: {},
        };
      }
      userMap[msg.authorId].messageCount++;
      userMap[msg.authorId].perChannel[channel.id] =
        (userMap[msg.authorId].perChannel[channel.id] || 0) + 1;

      if (msg.timestampMs > 0) {
        const d = new Date(msg.timestampMs);
        const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        timelineMap[k] = (timelineMap[k] || 0) + 1;
      }
    }
  }

  return {
    totalMessages,
    channels: channelStats,
    users: Object.values(userMap).sort((a, b) => b.messageCount - a.messageCount),
    timeline: Object.entries(timelineMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, count]) => ({ month, count })),
  };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const channelResults = [], channelList = [];

  for (const channel of CHANNELS) {
    const messages = processChannel(channel);
    channelResults.push({ channel, messages });
    channelList.push({
      id: channel.id, name: channel.displayName,
      category: channel.category, messageCount: messages.length,
    });

    fs.writeFileSync(
      path.join(OUT_DIR, `channel-${channel.id}.json`),
      JSON.stringify(messages)
    );

    const searchIndex = messages.map(m => ({
      id: m.id,
      authorId: m.authorId,
      authorName: m.authorName,
      authorUsername: m.authorUsername,
      timestamp: m.timestampMs,
      text: m.plainText,
    }));
    fs.writeFileSync(
      path.join(OUT_DIR, `search-${channel.id}.json`),
      JSON.stringify(searchIndex)
    );

    console.log(`  Written: channel-${channel.id}.json + search-${channel.id}.json`);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'channels.json'), JSON.stringify(channelList));

  const stats = computeStats(channelResults);
  fs.writeFileSync(path.join(OUT_DIR, 'stats.json'), JSON.stringify(stats));

  console.log(`\nDone! ${stats.totalMessages.toLocaleString()} total messages across ${channelList.length} channels`);
}

main();
