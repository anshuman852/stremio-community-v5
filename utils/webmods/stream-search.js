// Stremio Community v5 Webmod: Stream List Search + Quality Tabs
// Adds a search input and quality filter tabs to filter streams

(function() {
    'use strict';
    if (window.top !== window) return;

    const SEARCH_ID = 'stremio-community-stream-search';
    const TABS_ID = 'stremio-community-quality-tabs';
    const STYLE_ID = 'stremio-community-stream-filter-css';
    let inputEl = null;
    let activeContainer = null;
    let observer = null;
    let filterQuery = '';
    let qualityFilter = 'all';
    let observerTimer = null;

    const QUALITY_ORDER = { '4K': 0, '2160P': 1, '1080P': 2, '720P': 3, '480P': 4 };
    const QUALITY_RE = /\b(4K|2160p|1080p|720p|480p)\b/i;

    console.log('[StreamSearch] Webmod loaded v3 (quality tabs)');

    function getStreamQuality(el) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const m = text.match(QUALITY_RE);
        return m ? m[1].toUpperCase() : null;
    }

    function ensureFilterStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = '[data-stream-filter-hidden="1"] { display: none !important; }';
        (document.head || document.documentElement).appendChild(style);
    }

    function getVisibleText(el) {
        return (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function isStreamItem(el) {
        if (!el || el.nodeType !== 1) return false;
        const tag = el.tagName;
        if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'LINK') return false;
        if (el.id === SEARCH_ID || el.id === TABS_ID) return false;
        if (el.querySelector('[class*="placeholder"]')) return false;
        if (el.querySelector('[class*="addons-loading"]')) return false;
        if (el.querySelector('[class*="install-button"]')) return false;
        return true;
    }

    function getStreamItems() {
        if (!activeContainer) return [];
        return Array.from(activeContainer.children).filter(isStreamItem);
    }

    function recalcQualityCounts(items) {
        const counts = {};
        items.forEach(el => {
            const q = getStreamQuality(el) || 'Unknown';
            counts[q] = (counts[q] || 0) + 1;
        });
        counts['all'] = items.length;
        return counts;
    }

    function renderQualityTabs(items) {
        if (!activeContainer) return;

        const counts = recalcQualityCounts(items);
        const total = items.length;

        // Don't show tabs until we have actual stream items (ignore loading placeholders)
        if (total === 0) {
            let tabsEl = document.getElementById(TABS_ID);
            if (tabsEl) tabsEl.remove();
            return;
        }

        // Pause observer while we modify the DOM
        if (observer) observer.disconnect();

        let tabsEl = document.getElementById(TABS_ID);

        const qualities = Object.keys(counts).filter(k => k !== 'all').sort((a, b) =>
            (QUALITY_ORDER[a] ?? 99) - (QUALITY_ORDER[b] ?? 99)
        );
        const allTabs = ['all', ...qualities];

        if (!tabsEl) {
            tabsEl = document.createElement('div');
            tabsEl.id = TABS_ID;
            Object.assign(tabsEl.style, {
                display: 'flex',
                gap: '4px',
                padding: '0.5rem 1rem 0.6rem 1rem',
                flex: 'none',
                overflowX: 'auto',
                scrollbarWidth: 'none',
                msOverflowStyle: 'none',
                zIndex: '1',
                fontFamily: 'inherit',
                fontSize: 'inherit'
            });

            // Insert between search input and streams container
            const parent = activeContainer.parentElement;
            if (parent) {
                parent.insertBefore(tabsEl, activeContainer);
            }
        }

        // Rebuild tab buttons
        const currentBtns = tabsEl.querySelectorAll('button');
        if (currentBtns.length !== allTabs.length) {
            tabsEl.textContent = '';
            allTabs.forEach(q => {
                const label = q === 'all' ? 'All' : q;
                const count = counts[q] || 0;
                const isActive = qualityFilter === q;

                const btn = document.createElement('button');
                btn.textContent = `${label}(${count})`;

                Object.assign(btn.style, {
                    padding: '3px 8px',
                    borderRadius: '4px',
                    fontSize: '10.5px',
                    fontWeight: isActive ? '700' : '500',
                    textTransform: 'uppercase',
                    letterSpacing: '0.3px',
                    whiteSpace: 'nowrap',
                    border: 'none',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    background: isActive ? 'var(--primary-accent-color, #7b5cbf)' : 'rgba(255,255,255,0.05)',
                    color: isActive ? '#fff' : 'rgba(255,255,255,0.5)',
                    fontFamily: 'inherit',
                    lineHeight: '1.4'
                });

                btn.addEventListener('mouseenter', () => {
                    if (qualityFilter !== q) btn.style.color = 'rgba(255,255,255,0.8)';
                });
                btn.addEventListener('mouseleave', () => {
                    if (qualityFilter !== q) btn.style.color = 'rgba(255,255,255,0.5)';
                });
                btn.addEventListener('click', () => {
                    qualityFilter = q;
                    applyFilter();
                });

                tabsEl.appendChild(btn);
            });
        } else {
            // Just update counts and active state on existing buttons
            allTabs.forEach((q, i) => {
                const btn = currentBtns[i];
                if (!btn) return;
                const label = q === 'all' ? 'All' : q;
                const count = counts[q] || 0;
                const isActive = qualityFilter === q;
                btn.textContent = `${label}(${count})`;
                btn.style.background = isActive ? 'var(--primary-accent-color, #7b5cbf)' : 'rgba(255,255,255,0.05)';
                btn.style.color = isActive ? '#fff' : 'rgba(255,255,255,0.5)';
                btn.style.fontWeight = isActive ? '700' : '500';
            });
        }

        // Re-observe
        if (observer) observer.observe(document.body, { childList: true, subtree: true });
    }

    function applyFilter() {
        if (!activeContainer) return;

        const items = getStreamItems();
        const q = filterQuery.trim().toLowerCase();

        let visibleCount = 0;
        let totalCount = 0;

        items.forEach(el => {
            totalCount++;
            let show = true;

            // Quality filter
            if (qualityFilter !== 'all') {
                const streamQ = getStreamQuality(el) || 'Unknown';
                if (streamQ !== qualityFilter) show = false;
            }

            // Text filter
            if (show && q.length > 0) {
                const text = getVisibleText(el);
                if (!text.includes(q)) show = false;
            }

            if (show) {
                delete el.dataset.streamFilterHidden;
                visibleCount++;
            } else {
                el.dataset.streamFilterHidden = '1';
            }
        });

        if (inputEl && (q.length > 0 || qualityFilter !== 'all') && totalCount > 0) {
            inputEl.placeholder = `Filter streams... (${visibleCount}/${totalCount})`;
        } else if (inputEl) {
            inputEl.placeholder = 'Filter streams...';
        }

        // Update tab counts
        renderQualityTabs(items);
    }

    function createSearchInput(container) {
        if (document.getElementById(SEARCH_ID)) return;

        const wrapper = document.createElement('div');
        wrapper.id = SEARCH_ID;
        Object.assign(wrapper.style, {
            margin: '0.5rem 1rem 0.2rem 1rem',
            padding: '0',
            flex: 'none',
            zIndex: '1'
        });

        inputEl = document.createElement('input');
        inputEl.type = 'text';
        inputEl.placeholder = 'Filter streams...';
        inputEl.autocomplete = 'off';
        inputEl.spellcheck = false;
        Object.assign(inputEl.style, {
            width: '100%',
            height: '3rem',
            padding: '0 1.5rem',
            fontSize: '1rem',
            background: 'var(--overlay-color, rgba(255,255,255,0.08))',
            color: 'var(--primary-foreground-color, #e0e0e0)',
            border: 'var(--focus-outline-size, 2px) solid transparent',
            borderRadius: '3rem',
            outline: 'none',
            boxSizing: 'border-box',
            fontFamily: 'inherit'
        });
        inputEl.style.setProperty('--focus-outline-size', '2px');

        const updatePlaceholderStyle = (opacity) => {
            // Use CSS custom property approach for placeholder
            inputEl.style.setProperty('--placeholder-opacity', opacity);
        };

        inputEl.addEventListener('focus', () => {
            inputEl.style.borderColor = 'var(--primary-foreground-color, #e0e0e0)';
        });
        inputEl.addEventListener('blur', () => {
            inputEl.style.borderColor = 'transparent';
        });
        inputEl.addEventListener('input', () => {
            filterQuery = inputEl.value;
            applyFilter();
        });
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                inputEl.value = '';
                filterQuery = '';
                qualityFilter = 'all';
                applyFilter();
                inputEl.blur();
            }
        });

        wrapper.appendChild(inputEl);

        const parent = container.parentElement;
        if (parent) {
            parent.insertBefore(wrapper, container);
        }

        activeContainer = container;
        console.log('[StreamSearch] Search bar + quality tabs added');

        // Initial tab render
        const items = getStreamItems();
        renderQualityTabs(items);
    }

    function findAndAttach() {
        const containers = document.querySelectorAll('[class*="streams-container"]');
        for (const c of containers) {
            if (c.closest('[class*="select-choices"]')) continue;
            if (c.closest('[class*="multiselect"]')) continue;

            const parent = c.closest('[class*="streams-list"]');
            if (parent && c !== activeContainer) {
                activeContainer = c;
                filterQuery = inputEl ? inputEl.value : '';
                qualityFilter = 'all';
                createSearchInput(c);
                applyFilter();
                return;
            }
        }
    }

    function startObserver() {
        if (observer) return;
        ensureFilterStyle();
        console.log('[StreamSearch] Starting observer');

        observer = new MutationObserver(() => {
            if (observerTimer) clearTimeout(observerTimer);
            observerTimer = setTimeout(() => {
                observerTimer = null;
                findAndAttach();
                // Re-render tabs and re-apply filter when streams change
                if (activeContainer) {
                    const items = getStreamItems();
                    renderQualityTabs(items);
                    if (filterQuery.length > 0 || qualityFilter !== 'all') {
                        applyFilter();
                    }
                }
            }, 100);
        });
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
        findAndAttach();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startObserver);
    } else {
        startObserver();
    }
})();
