# Plan: Discord-Style Search Navigation, Infinite Scroll, and Full Statistics

## Goal
Upgrade the archive app with three core improvements: (1) search that works like Discord's — finds every mention of a term/name, lets you jump through each hit one at a time while viewing the full surrounding message thread in place; (2) seamless infinite scroll replacing the prev/next pagination; (3) statistics page showing every member's stats, not just top 50.

## Steps

### Phase 1: Replace Pagination with Infinite Scroll

1. **Remove pagination UI** from `channel.html` — delete the `<div class="pagination">` block entirely. Remove `setupPagination()` call and all prev/next button logic from `app.js`.

2. **Rewrite `renderMessages()` in `app.js`** to render ALL messages in one pass into the DOM instead of slicing by page. A channel like `general` has ~8k messages as JSON objects (not 132k lines of raw HTML), so rendering 8k lightweight `<div>` elements is feasible — benchmark first. If performance is acceptable, just render all. If not, proceed to step 3.

3. **If full render is too slow: implement virtual/incremental rendering.** On initial channel load, render the first 400 messages. Add an `IntersectionObserver` sentinel `<div id="scroll-sentinel">` at the bottom of `#messages-container`. When it enters the viewport, append the next 200 messages. Add a second sentinel at the top; when it enters viewport while scrolling up, prepend the previous 200. This gives seamless Discord-like scroll with no buttons and no visible page breaks.

4. **Preserve scroll position on channel switch** — when navigating back to a previously viewed channel, restore the scroll position. Store `{ channelId, scrollTop }` in a `Map` and restore it after `loadChannel()` rerenders.

5. **Add a "Jump to date" control** in the channel header — a date input that when changed scrolls the message list to the first message on or after that date. Use a binary search on `currentMessages` (sorted by `timestampMs`) to find the index, then scroll the sentinel/rendered window to that position.

6. **Remove `currentPage` and `filteredMessages` global state** — replace with a cleaner `viewState` object: `{ channelId, allMessages, visibleStart, visibleEnd, highlightedMsgId }`. Update all references in `search.js`.

---

### Phase 2: Discord-Style Search Navigation

7. **Redesign the search results panel** in `channel.html` — replace the current flat results panel with a compact "search navigator" bar that appears below the channel header. It shows: `[← Prev hit]  Result 3 of 47  [Next hit →]  [✕ Clear]`. Styled as a thin accent-colored bar, not a full overflow panel.

8. **Rewrite `doChannelSearch()` in `search.js`**:
   - Collect all matching message indices into `searchHits: number[]` (indices into `currentMessages`)
   - Store `currentHitIndex = 0`
   - Call `jumpToHit(0)` to navigate to the first result immediately

9. **Implement `jumpToHit(hitIndex)` in `search.js`**:
   - Update the navigator bar text ("Result N of M")
   - Enable/disable prev/next arrows based on position
   - Scroll the `#messages-container` so the target message is centered in the viewport
   - Highlight the target message with a Discord-style gold/accent background flash (CSS transition, remove after 2s)
   - If using virtual rendering (step 3): ensure the hit message is within the rendered window — if not, re-render the window centered on that message's index, then scroll to it
   - Highlight all hits with a lighter background tint (so you can see all occurrences while navigating)

10. **Wire up prev/next navigation**:
    - Prev button: `currentHitIndex--; jumpToHit(currentHitIndex)`
    - Next button: `currentHitIndex++; jumpToHit(currentHitIndex)`
    - Keyboard: `F3` / `Shift+F3` (or `Ctrl+G` / `Ctrl+Shift+G`) cycle through hits within the current channel search

11. **Fix global search jump-to-message** — currently, clicking "Jump →" on a cross-channel result navigates to the channel but does NOT scroll to the specific message (it just loads the channel from the top). Fix this:
    - Store a pending jump `{ channelId, messageId }` in `sessionStorage` or a module-level variable before navigating
    - In `loadChannel()`, after rendering, check for a pending jump; if present, call `jumpToMessage(messageId)` which scrolls and highlights that message
    - Show the surrounding messages in context (the message itself plus 5 above and 5 below) — this is automatic with scroll-to since we now render all messages

12. **Add match count to search results panel** in global search mode — show "47 results in 3 channels" with a list of channel names and their counts, each clickable to jump to that channel and start navigating hits there.

13. **Highlight matched text within messages** — when a channel search is active, wrap matched text spans in `<mark class="search-hit">` inside the rendered message content. Strip existing marks before re-rendering. Use a regex replace on `contentHtml` with the match term (escape regex special chars first). Remove highlights when search is cleared.

---

### Phase 3: Full Member Statistics

14. **Remove the `slice(0, 50)` cap in `stats.js`** — change `const top = stats.users.slice(0, 50)` to `const allUsers = stats.users` (already sorted by message count descending from the parse step).

15. **Add a search/filter input above the leaderboard** — `<input id="member-filter" placeholder="Filter by name…">` that on `oninput` filters the rendered rows client-side. Debounce at 150ms. Show "Showing X of Y members" below the input.

16. **Implement progressive rendering for the leaderboard** — if there are hundreds of users, rendering all rows at once is fine for a table (no images, lightweight DOM). Render all rows but only attach the `IntersectionObserver` trick if testing shows >500ms render time. Otherwise just render all and rely on the member filter for navigation.

17. **Add per-channel breakdown expandable rows** — each leaderboard row gets a `▶` expand button. On click, fetch the channel-specific message count from `stats.json` (which should already have `user.channels: { [channelId]: count }` from the parse script). Render an indented sub-table showing that user's count per channel. If `stats.json` doesn't have per-user channel breakdown, update `scripts/parse.js` to add it (step 18).

18. **Update `scripts/parse.js` to store per-user channel breakdown** — in the user stats accumulation loop, track `userMap[id].channels[channelId]++` alongside the total count. Serialize this into `stats.json` as `users[n].channels: { channelId: count, ... }`. This adds ~10-50KB to stats.json, acceptable.

19. **Add a "Show all" toggle** to the keyword tracker's top-members breakdown — currently capped at 20. Change to: render top 20 by default, show a "Show all N members" button that expands to the full sorted list inline.

20. **Update the stats summary cards** — change "Top Members" heading to "All Members (N)" where N is the total unique member count. Add a sort toggle to the leaderboard: sort by total messages (default), or alphabetically by name.

---

### Phase 4: CSS & UX Polish

21. **Add CSS for the search navigator bar** in `style.css`:
    - `.search-navigator`: fixed thin bar below header, `background: var(--accent)`, flex row with hit counter centered and nav arrows on sides
    - `.search-hit` mark: `background: rgba(250, 166, 26, 0.4)` (Discord's gold highlight), `border-radius: 2px`
    - `.message-container.highlighted`: stronger `background: rgba(250, 166, 26, 0.15)` with a left border `3px solid var(--accent)`, fades out via CSS transition after JS removes the class

22. **Remove pagination CSS** — delete `.pagination`, `#page-info` styles from `style.css`.

23. **Style the member filter input** — matches existing `#keyword-input` style, placed inside `.stats-section` above the leaderboard table.

24. **Style expandable leaderboard rows** — `.lb-expand-btn` is a small `▶`/`▼` inline icon button; `.lb-channel-breakdown` is a sub-table with `padding-left: 40px`, smaller font, muted colors.

---

## Notes

- **Infinite scroll implementation order matters**: remove pagination first (step 1), then test if full render is fast enough before adding the virtual scroll sentinel (step 3). For most channels it will be; only `general` (~8k messages) needs the sentinel approach.
- **`searchHits` as indices vs message IDs**: use indices into `currentMessages` array for O(1) `jumpToHit()` access. Message IDs are only needed for the cross-channel jump case.
- **Text highlighting in HTML content**: `contentHtml` may contain raw HTML from the Discord export (embeds, mentions, emoji images). Use a DOM approach — `el.innerHTML = contentHtml`, then walk `TreeWalker` text nodes to wrap matches — to avoid corrupting HTML tags. Do this post-render, not in the HTML string.
- **stats.json size after step 18**: adding `channels` breakdown per user. With ~200 users × 9 channels × ~15 bytes each = ~27KB added. Acceptable.
- **`general` channel size**: channel JSON is ~8k message objects averaging ~300 bytes each = ~2.4MB. Fetching and parsing this is fine on modern hardware. The bottleneck is DOM insertion, hence the sentinel approach only if needed.
- **Keyboard shortcut conflict**: `Ctrl+F` is the browser's native find — don't intercept it. Use `Ctrl+G` / `Ctrl+Shift+G` for cycling hits, matching VS Code's behavior.
- **No framework changes**: stay vanilla HTML + JS. No bundler, no dependencies added.
