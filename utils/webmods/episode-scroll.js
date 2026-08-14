// Stremio Community v5 Webmod: Episode Scroll Reveal (Side Drawer)
//
// When the player's right-side episode drawer is opened and the episode list
// is long, reveals the currently playing episode. Re-reveals it when the
// URL/current episode changes while the drawer stays open, and after a
// season/list change. A bounded user-interaction guard suppresses auto-reveal
// on pure current-id changes while the user is browsing the list; real
// list/season changes always trigger. No-ops on short or already-visible lists.
//
// Bounded design (no unbounded loops, no mutation feedback loops):
//  - exactly ONE MutationObserver (debounced; its callback performs no DOM
//    writes — scrollTo is not a DOM mutation, so it cannot feed back on itself)
//  - exactly ONE 'transitionend' listener (capture phase, drawer-scoped)
//  - pushState/replaceState patched exactly once; single 'popstate' +
//    'hashchange' listeners (hash-routed and path-routed builds)
//  - a fixed set of passive capture listeners for the user-interaction guard
//  - NO setInterval, no recursive setTimeout chains (single trailing debounce
//    timer, replaced never stacked)
//  - whole install guarded by a global marker (idempotent)

(function() {
    'use strict';
    if (window.top !== window) return;

    var INSTALL_KEY = '__stremioCommunityEpisodeScrollInstalled';
    try {
        if (window[INSTALL_KEY]) return;
        window[INSTALL_KEY] = true;
    } catch (e) { return; }

    var DEBOUNCE_MS = 120; // observer / history / transition debounce

    var state = {
        observer: null,
        checkTimer: null,
        historyPatched: false,
        interactionTracking: false,
        lastList: null,        // current episode list element (drawer identity)
        lastVideoId: null,     // last current video id
        lastSignature: null,   // last content-based episode-row signature
        userInteracted: false  // user scrolled/interacted with the list since open
    };

    console.log('[EpisodeScroll] Webmod loaded v1');

    // ------------------------------------------------------------------
    // Small helpers (all DOM access guarded)
    // ------------------------------------------------------------------

    function scrollBehavior() {
        try {
            if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                return 'auto';
            }
        } catch (e) { /* ignore */ }
        return 'smooth';
    }

    // Viewport overlap + basic computed-style visibility.
    function isOnScreen(el) {
        try {
            if (!el || !el.isConnected) return false;
            var cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            var r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            var vw = window.innerWidth || document.documentElement.clientWidth;
            var vh = window.innerHeight || document.documentElement.clientHeight;
            return r.left < vw && r.right > 0 && r.top < vh && r.bottom > 0;
        } catch (e) { return false; }
    }

    // ------------------------------------------------------------------
    // Current video id: last decoded path segment of a /player/ route
    // (hash-routed shells use #/player/...; path-routed builds fall back to
    // the pathname; only /player/ routes are ever operated on)
    // ------------------------------------------------------------------

    function getPlayerRoute() {
        var hash = '';
        try { hash = window.location.hash || ''; } catch (e) { hash = ''; }
        if (hash.indexOf('#/player/') === 0) return hash.slice(1);
        var path = '';
        try { path = window.location.pathname || ''; } catch (e) { path = ''; }
        if (path.indexOf('/player/') === 0) return path;
        return null;
    }

    function getCurrentVideoId() {
        var route = getPlayerRoute();
        if (!route) return null; // player routes only
        var segs = route.split('/').filter(function(s) { return s.length > 0; });
        if (segs.length < 4) return null; // player/<type>/<metaId>/<videoId>
        var raw = segs[segs.length - 1];
        if (!raw) return null;
        try { return decodeURIComponent(raw); } catch (e) { return null; }
    }

    // ------------------------------------------------------------------
    // Drawer/list location. The drawer identity IS the visible episode list:
    // a "[class*='videos']" container inside a "[class*='side-drawer']"
    // ancestor (the side-drawer BUTTON shares the substring, so it is
    // excluded). Visibility and scroll decisions are made on this list itself,
    // never on the full-screen side-drawer layer.
    // ------------------------------------------------------------------

    function hasVideoRowChild(list) {
        for (var i = 0; i < list.children.length; i++) {
            var c = list.children[i];
            if (c.nodeType !== 1) continue;
            try {
                if (String(c.className || '').indexOf('video-container') !== -1) return true;
            } catch (e) { /* ignore */ }
        }
        return false;
    }

    function findDrawerList() {
        var lists = document.querySelectorAll('[class*="videos"]');
        var best = null, bestScore = -1;
        for (var i = 0; i < lists.length; i++) {
            var el = lists[i];
            if (!el || el.nodeType !== 1 || !el.isConnected) continue;
            if (el.children.length === 0) continue;
            var ancestor = null;
            try { ancestor = el.closest('[class*="side-drawer"]'); } catch (e) { ancestor = null; }
            if (!ancestor) continue;
            try {
                if (String(ancestor.className || '').indexOf('side-drawer-button') !== -1) continue;
            } catch (e) { continue; }
            if (!isOnScreen(el)) continue;
            var score = hasVideoRowChild(el) ? 1000 : 0;
            var r = el.getBoundingClientRect();
            score += r.width * r.height;
            if (score > bestScore) { bestScore = score; best = el; }
        }
        return best;
    }

    // ------------------------------------------------------------------
    // Episode row identification. DOM ids are an optional fast path (upstream
    // Video destructures `id` and drops it), so we also match by selected
    // state and by the season/episode numbers rendered in the row text.
    // ------------------------------------------------------------------

    // Row text prefers the title container (which holds the episode number and
    // title) so watched/status changes rendered elsewhere do not churn the
    // content-based signature. Falls back to the whole row's text.
    function getRowText(row) {
        var text = '';
        try {
            var title = row.querySelector('[class*="title-container"]');
            text = title ? (title.textContent || '') : (row.textContent || '');
        } catch (e) {
            try { text = (row.textContent || ''); } catch (e2) { text = ''; }
        }
        return text.replace(/\s+/g, ' ').trim().toLowerCase();
    }

    // Trailing ":<season>:<episode>" on the Stremio video id, e.g. "tt...:1:2".
    function parseCurrentSeasonEpisode(currentId) {
        var m = /:(\d+):(\d+)$/.exec(currentId);
        if (!m) return null;
        return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
    }

    // Season currently selected in the drawer's season selector (hashed class
    // "seasons-popup-label-container"; label text is "Season N" or "Special").
    // Returns the season number, 0 for "Special", or null when unreadable.
    function readDrawerSeason(list) {
        var root = null;
        try { root = list.closest('[class*="side-drawer"]'); } catch (e) { root = null; }
        var label = null;
        try {
            if (root) label = root.querySelector('[class*="seasons-popup-label-container"]');
            if (!label) label = list.querySelector('[class*="seasons-popup-label-container"]');
        } catch (e) { label = null; }
        if (!label || !label.isConnected) return null;
        var text = '';
        try { text = (label.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e) { return null; }
        if (!text) return null;
        var m = /^season\s+(\d+)/i.exec(text);
        if (m) return parseInt(m[1], 10);
        if (/^special/i.test(text)) return 0;
        return null;
    }

    // Rendered episode info from a row: "S1 E2" first, then the leading number
    // ("2. Title" or "2 Title") as the episode number.
    function getRowSeasonEpisode(row) {
        var text = getRowText(row);
        var m = /s(\d+)\s*e(\d+)/i.exec(text);
        if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
        m = /^(\d+)/.exec(text);
        if (m) return { season: null, episode: parseInt(m[1], 10) };
        return null;
    }

    function findRowBySeasonEpisode(list, se) {
        var children = list.children;
        var episodeOnly = null;
        for (var i = 0; i < children.length; i++) {
            var c = children[i];
            if (c.nodeType !== 1) continue;
            var rowSe = null;
            try { rowSe = getRowSeasonEpisode(c); } catch (e) { continue; }
            if (!rowSe || rowSe.episode !== se.episode) continue;
            if (se.season != null && rowSe.season === se.season) return c;
            if (rowSe.season == null && !episodeOnly) episodeOnly = c;
        }
        return episodeOnly;
    }

    function isRowSelected(row) {
        try {
            var cls = String(row.className || '');
            if (cls.indexOf('selected') !== -1) return true;
        } catch (e) { /* ignore */ }
        try {
            // Only truthy values count: selected="" (presence) or "true" is
            // selected; explicit "false" values are not.
            var sel = row.getAttribute('selected');
            if (sel != null && sel !== 'false') return true;
            if (row.getAttribute('aria-selected') === 'true') return true;
            var dataSel = row.getAttribute('data-selected');
            if (dataSel != null && dataSel !== '' && dataSel !== 'false') return true;
        } catch (e) { /* ignore */ }
        return false;
    }

    function findSelectedRow(list) {
        var children = list.children;
        for (var i = 0; i < children.length; i++) {
            var c = children[i];
            if (c.nodeType === 1 && isRowSelected(c)) return c;
        }
        return null;
    }

    // Row lookup:
    //  - preferSelected (drawer open / list or season change): selected row
    //    first, then season/episode text matching
    //  - pure current-id change (autoplay/next): season/episode matching first,
    //    then the selected row
    function findRow(list, currentId, preferSelected) {
        if (!list || !currentId) return null;
        // fast path: DOM id (unreliable upstream, harmless when present)
        var el = null;
        try { el = document.getElementById(currentId); } catch (e) { el = null; }
        if (el && el.isConnected && list.contains(el)) return el;

        var se = null;
        try { se = parseCurrentSeasonEpisode(currentId); } catch (e) { se = null; }

        // If the drawer shows a season different from the playing episode, the
        // current row is not in this list — never match an episode number from
        // the wrong season (e.g. "1" in Season 2 when the current id is S1E1).
        // Treat the row as absent so real list changes reset the list to top.
        if (se) {
            var drawerSeason = null;
            try { drawerSeason = readDrawerSeason(list); } catch (e) { drawerSeason = null; }
            if (drawerSeason != null && se.season != null && drawerSeason !== se.season) return null;
        }

        var bySeasonEpisode = se ? findRowBySeasonEpisode(list, se) : null;
        var bySelected = findSelectedRow(list);

        if (preferSelected) return bySelected || bySeasonEpisode || null;
        return bySeasonEpisode || bySelected || null;
    }

    // ------------------------------------------------------------------
    // Content-based row signature (ids + normalized title/episode text), so a
    // same-length season switch — even with dropped row ids — changes the
    // signature and retriggers reveal/reset.
    // ------------------------------------------------------------------

    function buildSignature(list) {
        var parts = [];
        var children = list.children;
        for (var i = 0; i < children.length; i++) {
            var c = children[i];
            var id = (c.nodeType === 1) ? (c.id || '') : '';
            var text = '';
            try { text = getRowText(c); } catch (e) { text = ''; }
            parts.push(id + '|' + text);
        }
        return parts.join('\n');
    }

    // Only treat the list as a real episode list once it renders recognizable
    // rows (guards the reset-to-top against placeholder-only mounts).
    function looksLikeEpisodeList(list) {
        var children = list.children;
        for (var i = 0; i < children.length; i++) {
            var c = children[i];
            if (c.nodeType !== 1) continue;
            if (c.id) return true;
            try {
                if (String(c.className || '').indexOf('video-container') !== -1) return true;
            } catch (e) { /* ignore */ }
            try {
                if (getRowSeasonEpisode(c)) return true;
            } catch (e) { /* ignore */ }
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Scrolling (list's own scrollTo, minimal delta, block:'nearest' semantics)
    // ------------------------------------------------------------------

    function scrollListToTop(list) {
        if (!list || !list.isConnected) return;
        if (list.scrollHeight <= list.clientHeight + 1) return; // short list
        if (list.scrollTop <= 0) return;
        try {
            list.scrollTo({ top: 0, behavior: scrollBehavior() });
        } catch (e) { /* guarded */ }
    }

    function revealRow(list, row) {
        if (!list || !row || !list.isConnected || !row.isConnected) return;
        if (list.scrollHeight <= list.clientHeight + 1) return; // short list: no-op

        var listRect = list.getBoundingClientRect();
        var rowRect = row.getBoundingClientRect();
        if (listRect.height <= 0 || rowRect.height <= 0) return;

        // Compare in the list's own content coordinates (immune to the drawer's
        // slide transform, which translates both equally).
        var top = list.scrollTop;
        var bottom = top + list.clientHeight;
        var rowTop = top + (rowRect.top - listRect.top);
        var rowBottom = top + (rowRect.bottom - listRect.top);

        // Already fully visible: never touch the scroll position.
        if (rowTop >= top - 1 && rowBottom <= bottom + 1) return;

        // Minimal delta with block:'nearest' semantics — align the overflowing
        // edge of the row with the corresponding edge of the visible window.
        var delta = rowTop < top ? (rowTop - top) : (rowBottom - bottom);
        var maxScroll = list.scrollHeight - list.clientHeight;
        if (maxScroll < 0) return;
        var target = Math.max(0, Math.min(maxScroll, list.scrollTop + delta));
        if (Math.abs(target - list.scrollTop) < 1) return;

        try {
            list.scrollTo({ top: target, behavior: scrollBehavior() });
        } catch (e) { /* guarded */ }
    }

    // ------------------------------------------------------------------
    // Change handling: act on list identity / current id / signature changes
    // ------------------------------------------------------------------

    function onMaybeChange() {
        var list = null, currentId = null;
        try { list = findDrawerList(); } catch (e) { list = null; }
        try { currentId = getCurrentVideoId(); } catch (e) { currentId = null; }

        if (!list) {
            // Drawer closed or not mounted yet: forget state so the next open
            // counts as a change (and re-reveals).
            state.lastList = null;
            state.lastSignature = null;
            state.userInteracted = false;
            return;
        }

        var signature = '';
        try { signature = buildSignature(list); } catch (e) { signature = ''; }

        var listChanged = list !== state.lastList;
        var idChanged = currentId !== state.lastVideoId;
        var sigChanged = signature !== state.lastSignature;
        var realListChange = listChanged || sigChanged;

        if (!listChanged && !idChanged && !sigChanged) return;

        state.lastList = list;
        state.lastVideoId = currentId;
        state.lastSignature = signature;
        if (listChanged) state.userInteracted = false; // fresh mount = fresh window

        if (!currentId) return; // nothing playing -> do nothing

        // Pure current-id change while the drawer stays open (autoplay/next):
        // reveal only if the user hasn't been browsing the list. A real
        // list/season change always triggers in the branch below.
        if (idChanged && !realListChange) {
            var rowId = null;
            try { rowId = findRow(list, currentId, false); } catch (e) { rowId = null; }
            if (!rowId) return;            // cannot locate reliably -> do nothing
            if (state.userInteracted) return; // user is scrolling -> don't hijack
            try { revealRow(list, rowId); } catch (e) { /* guarded */ }
            return;
        }

        // Drawer open / list mount / season or list change.
        var row = null;
        try { row = findRow(list, currentId, true); } catch (e) { row = null; }
        if (!row) {
            // Current episode is not in the (new) selected season: reset the
            // list to top — only on a real list change and only once the list
            // actually renders episode rows.
            if (realListChange && looksLikeEpisodeList(list)) {
                try { scrollListToTop(list); } catch (e) { /* guarded */ }
            }
            return;
        }
        try { revealRow(list, row); } catch (e) { /* guarded */ }
    }

    function scheduleCheck() {
        if (state.checkTimer) clearTimeout(state.checkTimer);
        state.checkTimer = setTimeout(function() {
            state.checkTimer = null;
            onMaybeChange();
        }, DEBOUNCE_MS);
    }

    // ------------------------------------------------------------------
    // Event wiring (bounded, registered exactly once)
    // ------------------------------------------------------------------

    // User-interaction guard: wheel/touch/key/pointer input inside the open
    // episode list marks it as user-scrolled, so pure current-id changes do not
    // hijack a manual scroll. Programmatic scrollTo fires scroll events, not
    // these input events, so it cannot mark interaction itself.
    function onUserInput(e) {
        var t = e.target;
        if (!t || t.nodeType !== 1) return;
        if (!state.lastList || !state.lastList.isConnected) return;
        try {
            if (!state.lastList.contains(t)) return;
        } catch (err) { return; }
        state.userInteracted = true;
    }

    function startInteractionTracking() {
        if (state.interactionTracking) return;
        state.interactionTracking = true;
        document.addEventListener('wheel', onUserInput, { capture: true, passive: true });
        document.addEventListener('touchmove', onUserInput, { capture: true, passive: true });
        document.addEventListener('pointerdown', onUserInput, { capture: true });
        document.addEventListener('keydown', onUserInput, { capture: true });
    }

    function isDrawerTransitionEvent(e) {
        var path = [];
        try { path = e.composedPath ? e.composedPath() : []; } catch (err) { path = []; }
        if (!path.length && e.target) path = [e.target];
        var inDrawer = false;
        for (var i = 0; i < path.length; i++) {
            var el = path[i];
            if (!el || el.nodeType !== 1) continue;
            var cls = '';
            try { cls = String(el.className || ''); } catch (err) { continue; }
            if (cls.indexOf('side-drawer-button') !== -1) return false;
            if (cls.indexOf('side-drawer') !== -1) inDrawer = true;
        }
        return inDrawer;
    }

    function onTransitionEnd(e) {
        try {
            if (isDrawerTransitionEvent(e)) scheduleCheck();
        } catch (err) { /* guarded */ }
    }

    function startObserver() {
        if (state.observer) return;
        if (!document.body) return;
        state.observer = new MutationObserver(function() {
            scheduleCheck();
        });
        state.observer.observe(document.body, { childList: true, subtree: true });
    }

    function startHistoryTracking() {
        if (state.historyPatched) return;
        state.historyPatched = true;
        try {
            window.addEventListener('popstate', scheduleCheck);
            window.addEventListener('hashchange', scheduleCheck);
            var push = history.pushState;
            var replace = history.replaceState;
            history.pushState = function() {
                var r = push.apply(this, arguments);
                scheduleCheck();
                return r;
            };
            history.replaceState = function() {
                var r = replace.apply(this, arguments);
                scheduleCheck();
                return r;
            };
        } catch (e) { /* guarded */ }
    }

    // ------------------------------------------------------------------
    // Init
    // ------------------------------------------------------------------

    function init() {
        try {
            startObserver();
            startHistoryTracking();
            startInteractionTracking();
            document.addEventListener('transitionend', onTransitionEnd, true);
            onMaybeChange(); // player/drawer may already be mounted at injection time
        } catch (e) { /* guarded */ }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
