# Plan: Sea of Thieves Creators Discord Archive — Interactive GitHub Pages App

## Goal
Build a static web app (deployable to GitHub Pages) that presents a full Discord server archive from exported HTML files. Features: Discord-like channel sidebar navigation, merged duplicate channels, full-text + username search across all channels, and a home/statistics page showing per-user message counts and keyword mention tracking.

---

## Steps

### Phase 1: Understand the Source Data

1. **Audit all 14 HTML files** across both folders (`2019-2025/` and `2025-2026/`). Merge all channels that represent the same logical Discord channel, even if the filename or category label changed between exports. Identified logical equivalents to merge:
   - `Partner Chat - general` (2019-2025) + `Partner Chat - partner-general` (2025-2026) — same channel, renamed
   - `All Roles - tavern` (2019-2025) + `Tavern - tavern` (2025-2026) — same channel, category renamed
   - `Server - rare-answers` (2019-2025) + `Rare Official - rare-answers` (2025-2026) — same channel, category renamed
   - `Rare Official - announcements` — identical filename in both folders
   - `Rare Official - ask-rare-2-electric-boogaloo` — identical filename in both folders

   Channels unique to one folder (no merge needed):
   - `2019-2025/` only: Partner Chat / how-to-partner, All Roles / collabs
   - `2025-2026/` only: Rare Official / roadmap, Tavern / drops-feedback

2. **Document the final channel list** (9 logical channels total — 5 merged across both periods, 4 standalone):
   - **Partner Chat**: general *(merged: 2019-2025 "general" + 2025-2026 "partner-general")*
   - **Partner Chat**: how-to-partner *(2019-2025 only)*
   - **All Roles**: collabs *(2019-2025 only)*
   - **Rare Official**: announcements *(merged from both folders)*
   - **Rare Official**: ask-rare-2-electric-boogaloo *(merged from both folders)*
   - **Rare Official**: rare-answers *(merged: 2019-2025 "Server/rare-answers" + 2025-2026 "Rare Official/rare-answers")*
   - **Rare Official**: roadmap *(2025-2026 only)*
   - **Tavern**: tavern *(merged: 2019-2025 "All Roles/tavern" + 2025-2026 "Tavern/tavern")*
   - **Tavern**: drops-feedback *(2025-2026 only)*

---

### Phase 2: Build the HTML Parser / Data Extraction Script

3. **Write `scripts/parse.js`** (Node.js, no external deps beyond `node:fs` and `node:path`). For each HTML file:
   - Use a regex/string-based parser (no DOM — files are too large for JSDOM to be practical) to extract:
     - Guild name and channel name from `.preamble__entry`
     - Each `chatlog__message-group` → array of messages
     - Per message: `data-message-id`, author display name (`chatlog__author` text), author `data-user-id`, author color (`style=color:...`), timestamp (`chatlog__timestamp` title attribute), raw message HTML (the `.chatlog__content` inner HTML), whether it is a reply, and reaction counts
   - Output a structured JSON for each logical channel

4. **Implement channel merging logic** in the parse script — **critical**: every channel that maps to a logical channel must have ALL messages from ALL source files included, spanning the full 2019-2026 range:
   - For each logical channel, collect messages from every source HTML file that maps to it (1 or 2 files)
   - When a logical channel has the **same filename** in both folders (e.g. `announcements`), both files are read independently and their messages are combined — the 2019-2025 file is NOT skipped or overwritten by the 2025-2026 file
   - Combine all collected message arrays into one flat array
   - Sort by message timestamp ascending (parsed from the `title` attribute on `.chatlog__timestamp` e.g. `"Thursday, 28 April 2022 11:21 PM"`) so messages flow chronologically from 2019 through 2026
   - Deduplicate by `data-message-id` after sorting — if the same message ID appears in both exports, keep only the first occurrence
   - Result: each output `channel-{id}.json` contains the complete message history for that channel across both time periods

5. **Output data files** to `docs/data/`:
   - `docs/data/channels.json` — array of `{ id, name, category, file }` for sidebar generation
   - `docs/data/channel-{id}.json` — array of messages for each channel (keeping the original inner HTML of `.chatlog__content` so formatting, emoji images, embeds, and reactions render as-is)
   - `docs/data/stats.json` — pre-computed statistics:
     - Total message count per `data-user-id` + display name
     - Total messages per channel
     - Top 20 most-used words (excluding stop words)
     - Reaction totals per user

---

### Phase 3: Build the Static App Shell

> **Design approach**: Use the **frontend-design skill** for all UI work. The aesthetic direction is **Discord-faithful but elevated** — same layout DNA (3-column: server strip / channel sidebar / main content), same dark palette, but with production-grade polish: refined typography, subtle micro-interactions, atmospheric depth, and meticulous spacing. The result should feel like Discord if a design studio rebuilt it. Apply the skill's design-thinking process before writing any CSS: commit to the exact font pairing, motion language, and texture approach first.

6. **Create `docs/index.html`** — the statistics/home page. Structure:
   - Discord 3-column layout: narrow server-icon strip (left) + channel sidebar + main stats area
   - No framework — vanilla HTML + JS
   - Design with frontend-design skill: stats cards with atmospheric depth, CSS-only bar charts with animated fills, staggered load-in animations, distinctive typography (a characterful monospace or geometric display font paired with a refined body font — not Inter)

7. **Create `docs/channel.html`** — the channel viewer page. Structure:
   - Same 3-column Discord-like layout
   - Channel header with channel name, category, and message count badge
   - Scrollable message list area
   - Search bar fixed at top with focus animations
   - Messages rendered from JSON data, preserving the original `.chatlog__*` HTML structure and CSS classes
   - Design with frontend-design skill: avatar ring glow on hover, timestamp reveal on message hover, subtle message highlight on scroll-to, reply thread indentation with accent line

8. **Create `docs/css/style.css`** — Discord-faithful dark theme with design-skill polish:
   - Base palette matches Discord exactly: `#36393f` (main), `#2f3136` (sidebar), `#202225` (server strip), `#dcddde` (text), `#72767d` (timestamps)
   - Elevate with: noise grain overlay on sidebar (CSS `filter: url(#noise)` or SVG), subtle box-shadow depth on message groups, custom scrollbar styled to match, CSS variables for all color tokens
   - Typography: pick a distinctive font pair via Google Fonts — e.g. a geometric or humanist display for channel names/headers + a readable body font for message text; avoid Inter/Roboto/Arial
   - Micro-interactions: channel item hover slide-in indicator, category collapse chevron rotation, reaction pill hover scale, sidebar channel unread dot pulse
   - Replicated `.chatlog__*` class styles so embedded content HTML from the exported files renders correctly without the original inline `<style>` tag
   - Responsive: sidebar collapses to off-canvas drawer on narrow screens with hamburger toggle

9. **Create `docs/js/app.js`** — core application logic:
   - On load: fetch `channels.json`, render sidebar grouped by category with staggered CSS animation-delay reveal
   - Channel navigation: URL hash-based (`#channel/{id}`), loads `channel-{id}.json` and renders messages
   - Pagination (200 messages per page with "Load more" button) — needed because `general` has 132k lines
   - Highlight active channel in sidebar with smooth indicator transition

---

### Phase 4: Search Feature

10. **Full-text search** — implemented client-side in `docs/js/search.js`:
    - Search input in the top header bar
    - Two modes toggled by a button/tab:
      - **Global search**: searches across all channel JSON files (loads them lazily on first search), returns results grouped by channel showing message snippet + author + timestamp + a "Jump to message" link
      - **Channel search**: filters currently visible channel's messages in real time
    - Searches the plain text content (strip HTML tags from `.chatlog__content` before indexing)
    - Username search: matches against `chatlog__author` names (case-insensitive, partial match)
    - Highlight matched terms in results

11. **Search index**: build a lightweight pre-computed search index in `docs/data/search-index.json` during the parse step:
    - For each message: `{ channelId, messageId, authorName, authorId, timestamp, text }` where `text` is plain text stripped of HTML
    - This avoids loading all large channel JSON files for global search
    - Estimated size: ~50k messages × ~200 bytes = ~10MB max; split into per-channel index files if too large

---

### Phase 5: Statistics Home Page

12. **Stats page content** in `docs/js/stats.js` — reads `stats.json` and renders:
    - **Message leaderboard**: sortable table of users with total message count across all channels, and per-channel breakdown (expandable row)
    - **Channel activity**: bar chart (CSS-only, no library) showing message count per channel
    - **Keyword tracker**: text input where user types a word/phrase → JS scans the search index and returns count of how many messages contain it, broken down by user and by channel
    - **Top reactions**: which users received the most reactions, and which emoji were most used
    - **Timeline**: messages-per-month chart (CSS bar chart) showing server activity over time

13. **Hardcode initial statistics** into `stats.json` at parse time so the page loads instantly with no extra fetches for basic numbers. The keyword tracker does a live scan of the pre-built search index.

---

### Phase 6: GitHub Pages Setup

14. **Configure repository for GitHub Pages**:
    - All deployable files live in `docs/` (or use `gh-pages` branch — `docs/` folder is simpler)
    - Add `docs/.nojekyll` (empty file) to prevent Jekyll processing of the `_` prefixed asset names
    - Add a `docs/404.html` that redirects to `index.html` with the hash preserved (for hash-based routing)

15. **Write `README.md`** at repo root explaining:
    - How to run the parse script locally: `node scripts/parse.js`
    - How to add new HTML exports in the future (drop in `the discord/`, re-run parse)
    - How to deploy (push to main, GitHub Pages serves `docs/`)

16. **Add `package.json`** in repo root with a single `"build": "node scripts/parse.js"` script — no bundler needed.

---

### Phase 7: Polish

17. **Test all channels render correctly** — verify:
    - Embeds (Twitter cards, image previews) display with their original HTML
    - Reply chains link correctly
    - Emoji images load (they reference CDN URLs, will work if online)
    - Long messages don't break layout

18. **Test search** — verify:
    - Searching a username returns all their messages
    - Searching a phrase finds it across channels
    - Results link to correct channel + scroll to correct message via `#chatlog__message-container-{id}`

19. **Test statistics page** — verify keyword counts match manual spot-checks against raw HTML files.

20. **Final QA on GitHub Pages** — deploy and verify everything loads correctly over HTTPS with no mixed-content errors (all CDN references in the exported HTML use `https://`).

---

## Notes

- **No framework/bundler** — pure HTML + vanilla JS + CSS. Zero build dependencies beyond Node.js for the parse script. Makes GitHub Pages deployment trivial.
- **Data lives in `docs/data/`** — parse script is the only thing that touches `the discord/` folder. Source exports are never modified.
- **Merging logic**: sort by timestamp parsed from the human-readable `title` attribute. The format is `"DayOfWeek, DD Month YYYY HH:MM AM/PM"` — parse with a custom parser since it is non-standard.
- **`general` channel is huge** (132k lines in 2019-2025 alone). The channel JSON for this will be large. Implement pagination (200 messages per page with prev/next) rather than virtual scroll to keep JS simple. The search index covers all messages regardless.
- **Duplicate detection**: use `data-message-id` as the deduplication key. Same ID = same message, skip the second occurrence.
- **Stats extensibility**: `stats.json` schema is designed so new stat types can be added by re-running the parse script. The UI stats cards are component-like functions so new sections are easy to add.
- **Privacy**: all usernames and avatars are already public within the exported HTML (Discord avatar CDN URLs). No new privacy exposure from building this app.
- **Offline mode**: emoji/avatar images load from Discord/CDN — no internet = broken images, but all text content works fine.
