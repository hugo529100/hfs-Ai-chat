"use strict";
(function () {

    const { h } = HFS;
    const { useState, useEffect, useRef, useCallback } = HFS.React;

    const CACHE_MODEL = 'aiChat_modelId_v6';
    const CACHE_SIDEBAR = 'aiChat_sidebarOpen_v6';
    const CACHE_ACTIVE_CONV = 'aiChat_activeConv_v6';
    const CACHE_SEARCH = 'aiChat_enableSearch_v6';
    const CACHE_FONT_SIZE = 'aiChat_fontSize_v6';

    const DRAFT_SENTINEL = '__draft__';

    function getActiveConvKey() {
        return CACHE_ACTIVE_CONV;
    }

    function sortConversations(list) {
        return [...list].sort((a, b) => {
            const sa = a.starred ? 1 : 0;
            const sb = b.starred ? 1 : 0;
            if (sa !== sb) return sb - sa;
            const ta = b.lastActivity || b.updatedAt || b.createdAt || 0;
            const tb = a.lastActivity || a.updatedAt || a.createdAt || 0;
            return ta - tb;
        });
    }

    // ============================================
    // === Markdown ===
    // ============================================
    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeRegExp(s) {
        return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function renderMarkdown(text, searchTerm) {
        if (!text) return '';
        let html = escapeHtml(text);

        html = html.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_, lang, code) =>
            '<pre class="chat-code-block"><code>' + code.trimEnd() + '</code></pre>');
        html = html.replace(/`([^`\n]+)`/g, '<code class="chat-code-inline">$1</code>');

        html = html.replace(
            /(^|\n)((?:\|.*\|\s*\n)+)/g,
            (match, prefix, tableBlock) => {
                const lines = tableBlock.trim().split('\n').map(l => l.trim()).filter(Boolean);
                if (lines.length < 2) return match;
                const sepLine = lines[1];
                if (!/^\|[\s:|-]+\|$/.test(sepLine)) return match;
                const parseRow = (line) =>
                    line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
                const headers = parseRow(lines[0]);
                const aligns = parseRow(sepLine).map(sep => {
                    const left = sep.startsWith(':');
                    const right = sep.endsWith(':');
                    if (left && right) return 'center';
                    if (right) return 'right';
                    if (left) return 'left';
                    return '';
                });
                let table = '<table class="chat-table"><thead><tr>';
                headers.forEach((h, i) => {
                    const align = aligns[i] ? ' style="text-align:' + aligns[i] + '"' : '';
                    table += '<th' + align + '>' + h + '</th>';
                });
                table += '</tr></thead><tbody>';
                for (let i = 2; i < lines.length; i++) {
                    const cells = parseRow(lines[i]);
                    table += '<tr>';
                    headers.forEach((_, ci) => {
                        const align = aligns[ci] ? ' style="text-align:' + aligns[ci] + '"' : '';
                        table += '<td' + align + '>' + (cells[ci] || '') + '</td>';
                    });
                    table += '</tr>';
                }
                table += '</tbody></table>';
                return prefix + table;
            }
        );

        html = html.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
        html = html.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
        html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
        html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

        html = html.replace(/^---+$/gm, '<hr>');
        html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

        html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
        html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

        html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
            '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        html = html.replace(/(^|[^"'=>])(https?:\/\/[^\s<>"'\)]+)/g,
            '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

        html = html.replace(
            /(^|\n)((?:[ \t]*[-*+] .+(?:\n|$))+)/g,
            (match, prefix, block) => {
                const items = block.trimEnd().split('\n').map(line => {
                    const m = line.match(/^([ \t]*)[-*+] (.+)$/);
                    if (!m) return '';
                    const depth = Math.floor(m[1].length / 2);
                    return '<li data-depth="' + depth + '">' + m[2] + '</li>';
                }).join('');
                return prefix + '<ul>' + items + '</ul>';
            }
        );

        html = html.replace(
            /(^|\n)((?:[ \t]*\d+\. .+(?:\n|$))+)/g,
            (match, prefix, block) => {
                const items = block.trimEnd().split('\n').map(line => {
                    const m = line.match(/^[ \t]*\d+\. (.+)$/);
                    if (!m) return '';
                    return '<li>' + m[1] + '</li>';
                }).join('');
                return prefix + '<ol>' + items + '</ol>';
            }
        );

        html = html.replace(
            /^(?!<[huplbo]|<pre|<code|<bl|<hr|<ta|<ul|<ol|<li)(.+)$/gm,
            '<p>$1</p>'
        );

        html = html.replace(/<p>\s*<\/p>/g, '');

        if (searchTerm && searchTerm.trim()) {
            const re = new RegExp('(' + escapeRegExp(searchTerm) + ')', 'gi');
            html = html.replace(/>([^<]+)</g, (m, inner) =>
                '>' + inner.replace(re, '<mark class="chat-hl">$1</mark>') + '<'
            );
        }

        return html;
    }

    // ============================================
    // === Message Bubble ===
    // ============================================
    function MessageBubble(props) {
        const { msg, showReasoning, searchTerm, markRef,
                matchOffset, isActiveMatch, onAction } = props;
        const isUser = msg.role === 'user';
        const [reasoningOpen, setReasoningOpen] = useState(false);
        const containerRef = useRef(null);
        const longPressRef = useRef(null);

        useEffect(() => {
            if (!containerRef.current || !searchTerm || matchOffset == null) return;
            const marks = containerRef.current.querySelectorAll('mark.chat-hl');
            const el = marks[matchOffset];
            if (!el) return;
            if (isActiveMatch) {
                el.classList.add('chat-hl-active');
                if (markRef) markRef.current = el;
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
                el.classList.remove('chat-hl-active');
            }
        }, [searchTerm, matchOffset, isActiveMatch, markRef, msg.content]);

        let contentNode;
        if (isUser) {
            contentNode = h('div', {
                dangerouslySetInnerHTML: { __html: renderMarkdown(msg.content || '', searchTerm) }
            });
        } else if (msg.content) {
            contentNode = h('div', {
                dangerouslySetInnerHTML: { __html: renderMarkdown(msg.content, searchTerm) }
            });
        } else {
            contentNode = h('div', { style: { whiteSpace: 'pre-wrap' } }, msg.content || '');
        }

        const openMenu = (x, y) => {
            if (!onAction) return;
            onAction({ type: 'openMenu', msg, x, y });
        };

        const handleContextMenu = (e) => {
            e.preventDefault();
            openMenu(e.clientX, e.clientY);
        };

        const handlePointerDown = (e) => {
            if (e.pointerType === 'mouse') return;
            longPressRef.current = setTimeout(() => {
                openMenu(e.clientX, e.clientY);
                longPressRef.current = null;
            }, 500);
        };
        const clearLongPress = () => {
            if (longPressRef.current) {
                clearTimeout(longPressRef.current);
                longPressRef.current = null;
            }
        };

        return h('div', {
            className: 'chat-msg ' + (isUser ? 'chat-msg-user' : 'chat-msg-ai') +
                (msg.failed ? ' chat-msg-failed' : ''),
            ref: containerRef,
            onContextMenu: handleContextMenu,
            onPointerDown: handlePointerDown,
            onPointerUp: clearLongPress,
            onPointerLeave: clearLongPress,
            onPointerCancel: clearLongPress
        },
            !isUser && msg.modelLabel && h('div', { className: 'chat-msg-model' }, msg.modelLabel),
            !isUser && showReasoning && msg.reasoning && h('div', {
                className: 'chat-reasoning' + (reasoningOpen ? ' chat-reasoning-open' : '')
            },
                h('div', {
                    className: 'chat-reasoning-toggle',
                    onClick: () => setReasoningOpen(o => !o),
                    title: reasoningOpen ? 'Hide reasoning' : 'Show reasoning'
                }, reasoningOpen ? '▾ Reasoning' : '▸ Reasoning'),
                reasoningOpen && h('pre', { className: 'chat-reasoning-body' }, msg.reasoning)
            ),
            h('div', { className: 'chat-msg-content' }, contentNode),
            msg._streaming && h('span', { className: 'chat-cursor' }, '▋\uFE0E'),
            isUser && msg.failed && h('button', {
                className: 'chat-retry-btn',
                onClick: () => onAction && onAction({ type: 'retry', msg }),
                title: 'Retry sending'
            }, '↻ Retry')
        );
    }

    // ============================================
    // === Chat Panel ===
    // ============================================
    function ChatPanel(props) {
        const { onClose, config, onChatEvent } = props;
        const pageSize = config.pageSize || 200;

        const [conversations, setConversations] = useState([]);
        const [activeConvId, setActiveConvId] = useState(null);
        const [messages, setMessages] = useState([]);
        const [input, setInput] = useState('');
        const [streaming, setStreaming] = useState(false);
        const [loading, setLoading] = useState(false);
        const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);

        const [isDraft, setIsDraft] = useState(false);

        const [hasMore, setHasMore] = useState(false);
        const [loadingMore, setLoadingMore] = useState(false);
        const totalPairsRef = useRef(0);

        const [renamingConvId, setRenamingConvId] = useState(null);
        const [renameValue, setRenameValue] = useState('');
        const renameInputRef = useRef(null);
        const longPressTimerRef = useRef(null);

        const [showSearch, setShowSearch] = useState(false);
        const [searchTerm, setSearchTerm] = useState('');
        const [searchResults, setSearchResults] = useState([]);
        const [isSearching, setIsSearching] = useState(false);
        const searchAbortRef = useRef(null);
        const searchInputRef = useRef(null);

        const [bodySearchTerm, setBodySearchTerm] = useState('');
        const [matches, setMatches] = useState([]);
        const [currentMatch, setCurrentMatch] = useState(0);
        const activeMarkRef = useRef(null);

        const [menu, setMenu] = useState(null);
        const [editing, setEditing] = useState(null);
        const [editValue, setEditValue] = useState('');

        // ===== 全屏状态：由面板自身 state 驱动 =====
        const [isFullscreen, setIsFullscreen] = useState(false);
        const isFullscreenRef = useRef(false);
        useEffect(() => { isFullscreenRef.current = isFullscreen; }, [isFullscreen]);

        const [fontSize, setFontSize] = useState(() => {
            try {
                const cached = localStorage.getItem(CACHE_FONT_SIZE);
                if (cached) {
                    const n = parseInt(cached, 10);
                    if (n >= 14 && n <= 24) return n;
                }
            } catch (e) {}
            return 14;
        });

        const [currentModelId, setCurrentModelId] = useState(() => {
            try {
                const cached = localStorage.getItem(CACHE_MODEL);
                if (cached && config.models.some(m => m.id === cached)) return cached;
            } catch (e) {}
            return config.defaultModelId;
        });

        const [showSidebar, setShowSidebar] = useState(() => {
            try {
                const cached = localStorage.getItem(CACHE_SIDEBAR);
                if (cached === '0') return false;
                if (cached === '1') return true;
            } catch (e) {}
            return window.innerWidth > 768;
        });

        const [enableSearch, setEnableSearch] = useState(() => {
            try {
                const cached = localStorage.getItem(CACHE_SEARCH);
                if (cached === '0') return false;
                if (cached === '1') return true;
            } catch (e) {}
            return true;
        });

        const listRef = useRef(null);
        const inputRef = useRef(null);
        const activeConvIdRef = useRef(null);
        const streamingRef = useRef(false);
        const currentModelIdRef = useRef(currentModelId);
        const isDraftRef = useRef(false);
        const panelRef = useRef(null);
        const appliedSeqRef = useRef(0);

        useEffect(() => { activeConvIdRef.current = activeConvId; }, [activeConvId]);
        useEffect(() => { streamingRef.current = streaming; }, [streaming]);
        useEffect(() => { currentModelIdRef.current = currentModelId; }, [currentModelId]);
        useEffect(() => { isDraftRef.current = isDraft; }, [isDraft]);

        useEffect(() => { try { localStorage.setItem(CACHE_MODEL, currentModelId); } catch (e) {} }, [currentModelId]);
        useEffect(() => { try { localStorage.setItem(CACHE_SIDEBAR, showSidebar ? '1' : '0'); } catch (e) {} }, [showSidebar]);
        useEffect(() => { try { localStorage.setItem(CACHE_SEARCH, enableSearch ? '1' : '0'); } catch (e) {} }, [enableSearch]);
        useEffect(() => { try { localStorage.setItem(CACHE_FONT_SIZE, String(fontSize)); } catch (e) {} }, [fontSize]);

        useEffect(() => {
            const onResize = () => setIsMobile(window.innerWidth <= 768);
            window.addEventListener('resize', onResize);
            return () => window.removeEventListener('resize', onResize);
        }, []);

        // ===== 只同步“面板自己”的全屏状态；宿主全屏变化不影响 =====
        useEffect(() => {
            const onChange = () => {
                const owns = document.fullscreenElement === panelRef.current;
                if (!owns) setIsFullscreen(false);
            };
            document.addEventListener('fullscreenchange', onChange);
            document.addEventListener('webkitfullscreenchange', onChange);
            document.addEventListener('msfullscreenchange', onChange);
            return () => {
                document.removeEventListener('fullscreenchange', onChange);
                document.removeEventListener('webkitfullscreenchange', onChange);
                document.removeEventListener('msfullscreenchange', onChange);
            };
        }, []);

        // ===== 全屏切换：判断依据是面板自身 state，目标是面板元素 =====
        const toggleFullscreen = useCallback(() => {
            const el = panelRef.current;
            if (!el) return;
            try {
                if (!isFullscreenRef.current) {
                    const req = el.requestFullscreen
                        ? el.requestFullscreen()
                        : (el.webkitRequestFullscreen
                            ? el.webkitRequestFullscreen()
                            : (el.msRequestFullscreen ? el.msRequestFullscreen() : null));
                    if (req && req.then) {
                        req.then(() => setIsFullscreen(true)).catch(() => {});
                    } else {
                        setIsFullscreen(true);
                    }
                } else {
                    if (document.exitFullscreen) document.exitFullscreen();
                    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
                    else if (document.msExitFullscreen) document.msExitFullscreen();
                    setIsFullscreen(false);
                }
            } catch (e) {
                HFS.toast('Fullscreen not supported', 'error');
            }
        }, []);

        useEffect(() => {
            if (!isMobile) return;
            const handleVisualViewport = () => {
                const viewport = window.visualViewport;
                if (!viewport || !panelRef.current) return;
                const panel = panelRef.current;
                if (viewport.height < window.innerHeight) {
                    panel.style.height = viewport.height + 'px';
                    panel.style.maxHeight = viewport.height + 'px';
                    panel.style.top = viewport.offsetTop + 'px';
                    panel.style.bottom = 'auto';
                } else {
                    panel.style.height = '';
                    panel.style.maxHeight = '';
                    panel.style.top = '';
                    panel.style.bottom = '';
                }
            };
            if (window.visualViewport) {
                window.visualViewport.addEventListener('resize', handleVisualViewport);
                window.visualViewport.addEventListener('scroll', handleVisualViewport);
            }
            return () => {
                if (window.visualViewport) {
                    window.visualViewport.removeEventListener('resize', handleVisualViewport);
                    window.visualViewport.removeEventListener('scroll', handleVisualViewport);
                }
                const panel = panelRef.current;
                if (panel) {
                    panel.style.height = '';
                    panel.style.maxHeight = '';
                    panel.style.top = '';
                    panel.style.bottom = '';
                }
            };
        }, [isMobile]);

        const scrollBottom = useCallback(() => {
            const el = listRef.current;
            if (!el) return;
            requestAnimationFrame(() => {
                if (el) el.scrollTop = el.scrollHeight;
            });
        }, []);

        useEffect(() => { scrollBottom(); }, [messages.length, scrollBottom]);

        useEffect(() => {
            if (!bodySearchTerm.trim()) {
                setMatches([]);
                setCurrentMatch(0);
                return;
            }
            const term = bodySearchTerm.toLowerCase();
            const found = [];
            messages.forEach((m, mi) => {
                const text = (m.content || '');
                const lt = text.toLowerCase();
                let idx = lt.indexOf(term);
                let localOffset = 0;
                while (idx !== -1) {
                    found.push({ msgIndex: mi, localOffset });
                    localOffset++;
                    idx = lt.indexOf(term, idx + term.length);
                }
            });
            setMatches(found);
            setCurrentMatch(found.length ? 0 : -1);
        }, [bodySearchTerm, messages]);

        useEffect(() => {
            if (currentMatch < 0 || !matches[currentMatch]) return;
            const el = activeMarkRef.current;
            if (el && el.scrollIntoView) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, [currentMatch, matches]);

        const loadConversations = useCallback(async () => {
            try {
                const res = await fetch('/~/api/chat/conversations');
                if (!res.ok) return [];
                const data = await res.json();
                const sorted = sortConversations(data.conversations || []);
                setConversations(sorted);
                return sorted;
            } catch (e) { return []; }
        }, []);

        const flattenPairs = useCallback((pairs) => {
            const out = [];
            for (const p of pairs) {
                if (p.q) out.push({
                    role: 'user', content: p.q.content, ts: p.q.ts,
                    failed: !!p.q.failed,
                    _pairIndex: p.index, _truncated: p.truncated
                });
                if (p.a) out.push({
                    role: 'assistant', content: p.a.content, reasoning: p.a.reasoning,
                    modelId: p.a.modelId, modelLabel: p.a.modelLabel,
                    ts: p.a.ts, _pairIndex: p.index, _truncated: p.truncated
                });
            }
            return out;
        }, []);

        const loadConversation = useCallback(async (id, keepScroll = false) => {
            if (!id) return;
            setLoading(true);
            setIsDraft(false);
            try {
                const url = '/~/api/chat/conversation?id=' + encodeURIComponent(id) +
                    '&offset=0&limit=' + pageSize;
                const res = await fetch(url);
                if (!res.ok) { setMessages([]); return; }
                const data = await res.json();
                const flat = flattenPairs(data.pairs || []);

                let streamState = null;
                try {
                    const sres = await fetch('/~/api/chat/stream-state?id=' + encodeURIComponent(id));
                    if (sres.ok) streamState = await sres.json();
                } catch (e) {}

                if (streamState && !streamState.done && (streamState.content || streamState.reasoning)) {
                    flat.push({
                        role: 'assistant',
                        content: streamState.content || '',
                        reasoning: streamState.reasoning || undefined,
                        ts: streamState.startedAt || Date.now(),
                        _streaming: true,
                        _remotePlaceholder: true
                    });
                    appliedSeqRef.current = streamState.seq || 0;
                    setStreaming(true);
                } else {
                    appliedSeqRef.current = 0;
                }

                setMessages(flat);
                setHasMore(!!data.hasMore);
                totalPairsRef.current = data.totalPairs || 0;
                setActiveConvId(id);
                try { localStorage.setItem(getActiveConvKey(), id); } catch (e) {}

                if (!keepScroll) setTimeout(() => scrollBottom(), 50);
            } catch (e) {
                setMessages([]);
            } finally {
                setLoading(false);
            }
        }, [pageSize, flattenPairs, scrollBottom]);

        const loadOlder = useCallback(async () => {
            const id = activeConvIdRef.current;
            if (!id || loadingMore || !hasMore) return;
            setLoadingMore(true);
            const el = listRef.current;
            const prevScrollHeight = el ? el.scrollHeight : 0;
            try {
                const currentOffset = messages.filter(m => !m._streaming).length / 2 | 0;
                const url = '/~/api/chat/conversation?id=' + encodeURIComponent(id) +
                    '&offset=' + currentOffset + '&limit=' + pageSize;
                const res = await fetch(url);
                if (!res.ok) return;
                const data = await res.json();
                const older = flattenPairs(data.pairs || []);
                if (older.length) setMessages(prev => [...older, ...prev]);
                setHasMore(!!data.hasMore);
                totalPairsRef.current = data.totalPairs || 0;
                requestAnimationFrame(() => {
                    if (el) {
                        const newScrollHeight = el.scrollHeight;
                        el.scrollTop = newScrollHeight - prevScrollHeight;
                    }
                });
            } catch (e) {} finally {
                setLoadingMore(false);
            }
        }, [messages, loadingMore, hasMore, pageSize, flattenPairs]);

        const resetToEmpty = useCallback(() => {
            setActiveConvId(null);
            setMessages([]);
            setStreaming(false);
            setHasMore(false);
            setIsDraft(false);
            totalPairsRef.current = 0;
            appliedSeqRef.current = 0;
            try { localStorage.setItem(getActiveConvKey(), DRAFT_SENTINEL); } catch (e) {}
        }, []);

        const enterDraft = useCallback(() => {
            if (streamingRef.current) { HFS.toast('Please wait for the current response', 'info'); return; }
            setActiveConvId(null);
            setMessages([]);
            setHasMore(false);
            setIsDraft(true);
            totalPairsRef.current = 0;
            appliedSeqRef.current = 0;
            try { localStorage.setItem(getActiveConvKey(), DRAFT_SENTINEL); } catch (e) {}
            setTimeout(() => { inputRef.current && inputRef.current.focus(); }, 50);
        }, []);

        useEffect(() => {
            let cancelled = false;
            (async () => {
                setLoading(true);
                const list = await loadConversations();
                if (cancelled) return;
                let restoreId = null;
                try { restoreId = localStorage.getItem(getActiveConvKey()); } catch (e) {}

                if (restoreId === DRAFT_SENTINEL) {
                    enterDraft();
                } else if (restoreId && list.some(c => c.id === restoreId)) {
                    await loadConversation(restoreId);
                } else if (list.length > 0) {
                    await loadConversation(list[0].id);
                } else {
                    resetToEmpty();
                    setIsDraft(true);
                }
                if (!cancelled) setLoading(false);
            })();
            return () => { cancelled = true; };
        }, [loadConversations, loadConversation, resetToEmpty, enterDraft]);

        // ===== 事件处理函数（不再依赖 SSE useEffect） =====
        const handleChatEvent = useCallback((event, data) => {
            if (!data) return;
            if (event === 'conversationCreated') {
                const m = data.meta;
                if (m) {
                    setConversations(prev => prev.some(c => c.id === m.id) ? prev : sortConversations([m, ...prev]));
                }
                return;
            }
            if (event === 'conversationDeleted') {
                setConversations(prev => prev.filter(c => c.id !== data.id));
                if (activeConvIdRef.current === data.id) { setActiveConvId(null); setMessages([]); setStreaming(false); }
                return;
            }
            if (event === 'conversationRenamed') {
                setConversations(prev => sortConversations(prev.map(c =>
                    c.id === data.id ? (data.meta ? { ...c, ...data.meta } : { ...c, title: data.title, lastActivity: Date.now() }) : c)));
                return;
            }
            if (event === 'conversationStarred') {
                setConversations(prev => sortConversations(prev.map(c =>
                    c.id === data.id ? (data.meta ? { ...c, ...data.meta } : { ...c, starred: data.starred }) : c)));
                return;
            }
            if (event === 'allCleared') {
                setConversations([]); setActiveConvId(null); setMessages([]); setStreaming(false);
                return;
            }
            if (event === 'streamingStarted') {
                if (data.conversationId === activeConvIdRef.current) setStreaming(true);
                return;
            }
            if (event === 'streamingEnded') {
                if (data.conversationId === activeConvIdRef.current) setStreaming(false);
                return;
            }
            if (event === 'streamDelta') {
                if (data.conversationId !== activeConvIdRef.current) return;
                const seq = data.seq || 0;
                if (seq && seq <= appliedSeqRef.current) return;
                if (seq) appliedSeqRef.current = seq;
                setMessages(prev => {
                    const copy = [...prev];
                    for (let i = copy.length - 1; i >= 0; i--) {
                        const m = copy[i];
                        if (m.role === 'assistant' && (m._streaming || m._remotePlaceholder)) {
                            copy[i] = {
                                ...m,
                                content: (m.content || '') + (data.delta || ''),
                                reasoning: ((m.reasoning || '') + (data.reasoningDelta || '')) || undefined,
                                _streaming: true,
                                _remotePlaceholder: true
                            };
                            return copy;
                        }
                    }
                    return [...copy, {
                        role: 'assistant',
                        content: data.delta || '',
                        reasoning: data.reasoningDelta || undefined,
                        ts: Date.now(),
                        _streaming: true,
                        _remotePlaceholder: true
                    }];
                });
                return;
            }
            if (event === 'userMessage') {
                setConversations(prev => sortConversations(prev.map(c =>
                    c.id === data.conversationId
                        ? { ...c, title: (data.meta && data.meta.title) || c.title, lastActivity: (data.meta && data.meta.lastActivity) || Date.now(), updatedAt: (data.meta && data.meta.updatedAt) || Date.now(), lastModelId: (data.meta && data.meta.lastModelId) || c.lastModelId }
                        : c)));
                if (data.conversationId !== activeConvIdRef.current) return;
                setMessages(prev => {
                    const idx = prev.findIndex(m =>
                        m.role === 'user' && m.content === data.message.content && m._pairIndex == null);
                    if (idx >= 0) {
                        const copy = [...prev];
                        copy[idx] = { ...copy[idx], ts: data.message.ts, _pairIndex: data.pairIndex };
                        return copy;
                    }
                    const dupIdx = prev.findIndex(m =>
                        m.role === data.message.role && m.content === data.message.content && m._pairIndex === data.pairIndex);
                    if (dupIdx >= 0) {
                        const copy = [...prev];
                        copy[dupIdx] = { ...copy[dupIdx], ts: data.message.ts };
                        return copy;
                    }
                    return [...prev, { ...data.message, _pairIndex: data.pairIndex }];
                });
                return;
            }
            if (event === 'assistantMessage') {
                setConversations(prev => sortConversations(prev.map(c =>
                    c.id === data.conversationId
                        ? { ...c, title: (data.meta && data.meta.title) || c.title, lastActivity: (data.meta && data.meta.lastActivity) || Date.now(), updatedAt: (data.meta && data.meta.updatedAt) || Date.now() }
                        : c)));
                if (data.conversationId !== activeConvIdRef.current) return;
                setMessages(prev => {
                    for (let i = prev.length - 1; i >= 0; i--) {
                        const m = prev[i];
                        if (m.role === 'assistant' && (m._streaming || m._remotePlaceholder)) {
                            const copy = [...prev];
                            copy[i] = { ...data.message, _streaming: false, _remotePlaceholder: false, _pairIndex: data.pairIndex };
                            return copy;
                        }
                    }
                    return [...prev, { ...data.message, _streaming: false, _pairIndex: data.pairIndex }];
                });
                return;
            }
            if (event === 'messageFailed') {
                if (data.conversationId !== activeConvIdRef.current) return;
                setMessages(prev => prev.map(m =>
                    (m.role === 'user' && m._pairIndex === data.pairIndex)
                        ? { ...m, failed: true } : m));
                setStreaming(false);
                return;
            }
            if (event === 'userMessageRetried') {
                if (data.conversationId !== activeConvIdRef.current) return;
                setMessages(prev => prev.map(m =>
                    (m.role === 'user' && m._pairIndex === data.pairIndex)
                        ? { ...m, failed: false, ts: data.ts || m.ts } : m));
                return;
            }
            if (event === 'assistantRegenerating') {
                if (data.conversationId !== activeConvIdRef.current) return;
                setMessages(prev => {
                    const idx = prev.findIndex(m =>
                        m.role === 'assistant' && m._pairIndex === data.pairIndex);
                    if (idx < 0) return prev;
                    const copy = [...prev];
                    copy[idx] = {
                        role: 'assistant', content: '', reasoning: undefined,
                        ts: data.ts || Date.now(), _streaming: true,
                        _pairIndex: data.pairIndex
                    };
                    return copy.slice(0, idx + 1);
                });
                setStreaming(true);
                return;
            }
            if (event === 'userMessageEdited') {
                if (data.conversationId !== activeConvIdRef.current) return;
                setMessages(prev => {
                    const idx = prev.findIndex(m => m._pairIndex === data.pairIndex);
                    if (idx < 0) return prev;
                    const copy = [...prev];
                    copy[idx] = {
                        ...copy[idx],
                        role: 'user',
                        content: data.content,
                        ts: data.ts,
                        failed: false
                    };
                    return copy.slice(0, idx + 1);
                });
                if (data.meta) {
                    setConversations(prev => sortConversations(prev.map(c =>
                        c.id === data.conversationId ? { ...c, ...data.meta } : c)));
                }
                return;
            }
            if (event === 'pairsTruncated') {
                if (data.conversationId !== activeConvIdRef.current) return;
                setMessages(prev => prev.filter(m =>
                    m._pairIndex == null || m._pairIndex < data.fromIndex));
                return;
            }
            if (event === 'pairDeleted') {
                if (data.conversationId !== activeConvIdRef.current) return;
                setMessages(prev => {
                    if (data.withUser) {
                        return prev.filter(m => m._pairIndex !== data.pairIndex);
                    }
                    return prev.filter(m =>
                        !(m.role === 'assistant' && m._pairIndex === data.pairIndex));
                });
                if (data.meta) {
                    setConversations(prev => sortConversations(prev.map(c =>
                        c.id === data.conversationId ? { ...c, ...data.meta } : c)));
                }
                return;
            }
        }, []);

        // 把 handler 存到 ref，供父层通知时调用
        const chatEventHandlerRef = useRef(null);
        useEffect(() => {
            chatEventHandlerRef.current = handleChatEvent;
        }, [handleChatEvent]);

        // 订阅来自 ChatApp 的统一 SSE 事件
        useEffect(() => {
            if (!onChatEvent) return;
            const unsub = onChatEvent((event, data) => {
                const fn = chatEventHandlerRef.current;
                if (fn) fn(event, data);
            });
            return typeof unsub === 'function' ? unsub : undefined;
        }, [onChatEvent]);

        const createConversation = useCallback(async () => {
            try {
                const res = await fetch('/~/api/chat/conversation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ modelId: currentModelIdRef.current })
                });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    HFS.toast('Failed to create chat: ' + (err.error || res.status), 'error');
                    return null;
                }
                const m = await res.json();
                setConversations(prev => sortConversations(prev.some(c => c.id === m.id) ? prev : [m, ...prev]));
                setActiveConvId(m.id);
                setIsDraft(false);
                setMessages([]);
                setHasMore(false);
                totalPairsRef.current = 0;
                appliedSeqRef.current = 0;
                try { localStorage.setItem(getActiveConvKey(), m.id); } catch (e) {}
                if (window.innerWidth <= 768) setShowSidebar(false);
                return m.id;
            } catch (e) { HFS.toast('Failed to create chat', 'error'); return null; }
        }, []);

        const deleteConversation = useCallback(async (id, e) => {
            if (e) e.stopPropagation();
            const conv = conversations.find(c => c.id === id);
            const title = conv ? (conv.title || 'Untitled') : 'this chat';
            let confirmed = false;
            try {
                if (HFS.dialogLib && HFS.dialogLib.confirmDialog) {
                    confirmed = await HFS.dialogLib.confirmDialog('Delete Chat', `Delete "${title}"? This cannot be undone.`);
                } else {
                    confirmed = window.confirm(`Delete "${title}"?`);
                }
            } catch { confirmed = window.confirm(`Delete "${title}"?`); }
            if (!confirmed) return;
            try {
                await fetch('/~/api/chat/conversation/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id })
                });
                setConversations(prev => prev.filter(c => c.id !== id));
                if (activeConvIdRef.current === id) {
                    const remaining = conversations.filter(c => c.id !== id);
                    if (remaining.length) {
                        loadConversation(remaining[0].id);
                    } else {
                        resetToEmpty();
                        setIsDraft(true);
                    }
                }
            } catch (e) {}
        }, [conversations, resetToEmpty, loadConversation]);

        const toggleStarConversation = useCallback(async (id, e) => {
            if (e) e.stopPropagation();
            setConversations(prev => sortConversations(prev.map(c => c.id === id ? { ...c, starred: !c.starred } : c)));
            try {
                await fetch('/~/api/chat/conversation/toggle-star', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id })
                });
            } catch (e) { loadConversations(); }
        }, [loadConversations]);

        const startRename = useCallback((conv) => {
            setRenamingConvId(conv.id);
            setRenameValue(conv.title || '');
            setTimeout(() => {
                if (renameInputRef.current) { renameInputRef.current.focus(); renameInputRef.current.select(); }
            }, 50);
        }, []);
        const saveRename = useCallback(async () => {
            const id = renamingConvId;
            if (!id) return;
            const newTitle = renameValue.trim();
            setRenamingConvId(null);
            const conv = conversations.find(c => c.id === id);
            const oldTitle = conv ? (conv.title || '') : '';
            if (!newTitle || newTitle === oldTitle) return;
            setConversations(prev => sortConversations(prev.map(c =>
                c.id === id ? { ...c, title: newTitle, updatedAt: Date.now(), lastActivity: Date.now() } : c)));
            try {
                await fetch('/~/api/chat/conversation/rename', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, title: newTitle })
                });
            } catch (e) { loadConversations(); }
        }, [renamingConvId, renameValue, conversations, loadConversations]);
        const cancelRename = useCallback(() => { setRenamingConvId(null); setRenameValue(''); }, []);
        const handleRenameKeyDown = useCallback((e) => {
            if (e.key === 'Enter') { e.preventDefault(); saveRename(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
        }, [saveRename, cancelRename]);
        const handleConvLongPressStart = useCallback((conv) => {
            if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = setTimeout(() => { startRename(conv); longPressTimerRef.current = null; }, 600);
        }, [startRename]);
        const handleConvLongPressEnd = useCallback(() => {
            if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
        }, []);
        const handleConvDoubleClick = useCallback((conv) => { startRename(conv); }, [startRename]);

        const cancelSearch = useCallback(() => {
            if (searchAbortRef.current) {
                try { searchAbortRef.current.abort(); } catch (e) {}
                searchAbortRef.current = null;
            }
            setIsSearching(false);
        }, []);

        const runSearch = useCallback(async (term) => {
            if (!term) return;
            if (searchAbortRef.current) { try { searchAbortRef.current.abort(); } catch (e) {} }
            const controller = new AbortController();
            searchAbortRef.current = controller;
            setIsSearching(true);
            setSearchResults([]);
            try {
                const url = '/~/api/chat/search?q=' + encodeURIComponent(term);
                const res = await fetch(url, { signal: controller.signal });
                if (res.ok) {
                    const data = await res.json();
                    setSearchResults(data.results || []);
                }
            } catch (e) {} finally {
                if (!controller.signal.aborted) setIsSearching(false);
            }
        }, []);

        useEffect(() => {
            if (!showSearch) return;
            const term = searchTerm.trim();
            if (!term) {
                cancelSearch();
                setSearchResults([]);
                return;
            }
            const t = setTimeout(() => runSearch(term), 300);
            return () => clearTimeout(t);
        }, [searchTerm, showSearch, runSearch, cancelSearch]);

        useEffect(() => {
            if (showSearch && searchInputRef.current) {
                setTimeout(() => searchInputRef.current?.focus(), 50);
            }
        }, [showSearch]);

        const closeSearchAll = useCallback(() => {
            setShowSearch(false);
            setSearchTerm('');
            setSearchResults([]);
            setBodySearchTerm('');
            setMatches([]);
            setCurrentMatch(0);
        }, []);

        const jumpToSearchResult = useCallback(async (result) => {
            await loadConversation(result.convId);
            setBodySearchTerm(searchTerm.trim());
            if (window.innerWidth <= 768) setShowSidebar(false);
        }, [loadConversation, searchTerm]);

        const goPrevMatch = () => {
            if (!matches.length) return;
            setCurrentMatch(prev => prev <= 0 ? matches.length - 1 : prev - 1);
        };
        const goNextMatch = () => {
            if (!matches.length) return;
            setCurrentMatch(prev => prev >= matches.length - 1 ? 0 : prev + 1);
        };

        const handleModelChange = useCallback((newModelId) => {
            if (streamingRef.current) { HFS.toast('Please wait for the current response', 'info'); return; }
            if (newModelId === currentModelIdRef.current) return;
            setCurrentModelId(newModelId);
            const m = config.models.find(x => x.id === newModelId);
            HFS.toast('Next reply will use: ' + (m ? m.label : newModelId), 'info');
        }, [config.models]);

        const doRetry = useCallback(async (msg) => {
            const convId = activeConvIdRef.current;
            if (!convId || streamingRef.current) return;
            if (msg._pairIndex == null) return;
            setMessages(prev => prev.map(m =>
                (m.role === 'user' && m._pairIndex === msg._pairIndex)
                    ? { ...m, failed: false } : m));
            setStreaming(true);
            appliedSeqRef.current = 0;
            try {
                const res = await fetch('/~/api/chat/retry', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        conversationId: convId,
                        pairIndex: msg._pairIndex,
                        enableSearch,
                        modelId: currentModelIdRef.current
                    })
                });
                if (!res.ok) {
                    let errMsg = 'HTTP ' + res.status;
                    try { const j = await res.json(); errMsg = j.error || errMsg; } catch {}
                    setMessages(prev => prev.concat([{
                        role: 'assistant', content: '⚠️ ' + errMsg, ts: Date.now()
                    }]));
                    setStreaming(false);
                }
            } catch (e) {
                setStreaming(false);
            }
        }, [enableSearch]);

        const doRegenerate = useCallback(async (msg) => {
            const convId = activeConvIdRef.current;
            if (!convId || streamingRef.current) return;
            if (msg._pairIndex == null) return;
            setMessages(prev => {
                const idx = prev.findIndex(m =>
                    m.role === 'assistant' && m._pairIndex === msg._pairIndex);
                if (idx < 0) return prev;
                const copy = prev.slice(0, idx + 1);
                copy[idx] = {
                    role: 'assistant', content: '', reasoning: undefined,
                    ts: Date.now(), _streaming: true, _pairIndex: msg._pairIndex
                };
                return copy;
            });
            setStreaming(true);
            appliedSeqRef.current = 0;
            try {
                const res = await fetch('/~/api/chat/regenerate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        conversationId: convId,
                        pairIndex: msg._pairIndex,
                        enableSearch,
                        modelId: currentModelIdRef.current
                    })
                });
                if (!res.ok) {
                    let errMsg = 'HTTP ' + res.status;
                    try { const j = await res.json(); errMsg = j.error || errMsg; } catch {}
                    setMessages(prev => prev.concat([{
                        role: 'assistant', content: '⚠️ ' + errMsg, ts: Date.now()
                    }]));
                    setStreaming(false);
                }
            } catch (e) {
                setStreaming(false);
            }
        }, [enableSearch]);

        const doDeleteMessage = useCallback(async (msg) => {
            const convId = activeConvIdRef.current;
            if (!convId || streamingRef.current) return;
            if (msg._pairIndex == null) return;
            const withUser = msg.role === 'user';
            const label = withUser
                ? 'Delete this question and its answer?'
                : 'Delete this answer?';
            let ok = false;
            try {
                if (HFS.dialogLib && HFS.dialogLib.confirmDialog) {
                    ok = await HFS.dialogLib.confirmDialog('Delete', label);
                } else {
                    ok = window.confirm(label);
                }
            } catch { ok = window.confirm(label); }
            if (!ok) return;

            setMessages(prev => {
                if (withUser) {
                    return prev.filter(m => m._pairIndex !== msg._pairIndex);
                }
                return prev.filter(m =>
                    !(m.role === 'assistant' && m._pairIndex === msg._pairIndex));
            });

            try {
                await fetch('/~/api/chat/pair/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        conversationId: convId,
                        pairIndex: msg._pairIndex,
                        withUser
                    })
                });
            } catch (e) {}
        }, []);

        const doPrint = useCallback((msg, mode) => {
            const convId = activeConvIdRef.current;
            if (!convId) return;
            if (msg._pairIndex == null) {
                HFS.toast('Cannot determine message index', 'error');
                return;
            }

            const conv = conversations.find(c => c.id === convId);
            const title = conv ? (conv.title || 'Untitled') : 'AI Chat';

            const esc = (s) => String(s || '')
                .replace(/&/g, '&amp;').replace(/</g, '&lt;')
                .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

            let blocks = [];

            if (mode === 'single') {
                const roleLabel = msg.role === 'user' ? 'QUESTION' : 'ANSWER';
                const label = msg.role === 'assistant' && msg.modelLabel
                    ? `ASSISTANT · ${esc(msg.modelLabel)}`
                    : roleLabel;
                const cls = msg.role === 'user' ? 'print-msg-user' : 'print-msg-ai';
                blocks.push(
                    `<div class="print-msg ${cls}">` +
                    `<div class="print-role">${label}</div>` +
                    `<div class="print-content">${renderMarkdown(msg.content || '')}</div>` +
                    `</div>`
                );
            } else {
                const pairMsgs = messages.filter(m => m._pairIndex === msg._pairIndex);
                const userMsg = pairMsgs.find(m => m.role === 'user');
                const aiMsg = pairMsgs.find(m => m.role === 'assistant');
                if (userMsg) {
                    blocks.push(
                        `<div class="print-msg print-msg-user">` +
                        `<div class="print-role">QUESTION</div>` +
                        `<div class="print-content">${renderMarkdown(userMsg.content || '')}</div>` +
                        `</div>`
                    );
                }
                if (aiMsg) {
                    const label = aiMsg.modelLabel ? `ASSISTANT · ${esc(aiMsg.modelLabel)}` : 'ASSISTANT';
                    blocks.push(
                        `<div class="print-msg print-msg-ai">` +
                        `<div class="print-role">${label}</div>` +
                        `<div class="print-content">${renderMarkdown(aiMsg.content || '')}</div>` +
                        `</div>`
                    );
                }
            }

            const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)} - Print</title>
<style>
  @page { margin: 12mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang TC",
                 "Microsoft JhengHei", "Noto Sans CJK TC", sans-serif;
    font-size: 13px;
    line-height: 1.5;
    color: #222;
    background: #fff;
    margin: 0;
    padding: 0;
  }
  h1, h2, h3, h4, h5, h6 { margin: 0.5em 0 0.3em; line-height: 1.25; page-break-after: avoid; }
  h1 { font-size: 1.3em; }
  h2 { font-size: 1.18em; }
  h3 { font-size: 1.08em; }
  p { margin: 0.3em 0; }
  ul, ol { margin: 0.3em 0; padding-left: 1.4em; }
  li { margin: 0.08em 0; }
  hr { border: none; border-top: 1px solid #ccc; margin: 0.5em 0; }
  blockquote {
    margin: 0.3em 0; padding: 2px 8px;
    border-left: 3px solid #ccc; opacity: 0.85; font-style: italic;
  }
  code {
    background: #f2f2f2; padding: 1px 4px; border-radius: 3px;
    font-family: "SF Mono", Consolas, "Courier New", monospace;
    font-size: 0.88em;
  }
  pre {
    background: #f2f2f2; border: 1px solid #ddd; border-radius: 6px;
    padding: 6px 8px; margin: 0.4em 0; overflow-x: auto;
    font-family: "SF Mono", Consolas, "Courier New", monospace;
    font-size: 0.82em; line-height: 1.4; white-space: pre; tab-size: 4;
    page-break-inside: avoid;
  }
  table {
    width: fit-content; max-width: 100%;
    border-collapse: collapse; margin: 0.5em auto; font-size: 0.8em;
    page-break-inside: avoid;
  }
  table th, table td {
    border: 1px solid #ccc; padding: 3px 6px;
    text-align: left; vertical-align: top; white-space: normal;
  }
  table th { background: #f5f5f5; font-weight: bold; }
  table tr:nth-child(even) td { background: #fafafa; }
  a { color: inherit; text-decoration: underline; }
  strong { font-weight: bold; }
  em { font-style: italic; }
  del { text-decoration: line-through; opacity: 0.7; }

  .print-msg {
    border: 1px solid #ddd; border-radius: 6px;
    padding: 8px 10px; margin-bottom: 10px;
    page-break-inside: avoid;
  }
  .print-msg-user { background: #f7f7f7; }
  .print-msg-ai { background: #fff; }
  .print-role {
    font-size: 0.7em; font-weight: bold; letter-spacing: 0.5px;
    opacity: 0.6; margin-bottom: 4px; text-transform: uppercase;
  }
  .print-content { word-break: break-word; }

  @media print {
    body { padding: 0; }
    .print-msg { border: 1px solid #ccc; }
  }
</style>
</head>
<body>
${blocks.join('\n')}
<script>
  window.onload = function () {
    setTimeout(function () {
      window.print();
      setTimeout(function () { window.close(); }, 300);
    }, 100);
  };
<\/script>
</body>
</html>`;

            const w = window.open('', '_blank', 'width=800,height=600');
            if (!w) {
                HFS.toast('Print window blocked. Please allow pop-ups.', 'error');
                return;
            }
            w.document.open();
            w.document.write(html);
            w.document.close();
        }, [messages, conversations]);

        const handleMsgAction = useCallback((action) => {
            if (action.type === 'openMenu') {
                setMenu({ msg: action.msg, x: action.x, y: action.y });
                return;
            }
            if (action.type === 'retry') {
                setMenu(null);
                doRetry(action.msg);
                return;
            }
            if (action.type === 'regenerate') {
                setMenu(null);
                doRegenerate(action.msg);
                return;
            }
            if (action.type === 'delete') {
                setMenu(null);
                doDeleteMessage(action.msg);
                return;
            }
            if (action.type === 'print-pair') {
                setMenu(null);
                doPrint(action.msg, 'pair');
                return;
            }
            if (action.type === 'print-single') {
                setMenu(null);
                doPrint(action.msg, 'single');
                return;
            }
            if (action.type === 'copy') {
                try { navigator.clipboard.writeText(action.msg.content || ''); } catch (e) {}
                HFS.toast('Copied', 'info');
                setMenu(null);
                return;
            }
            if (action.type === 'edit') {
                setEditing({ msg: action.msg, pairIndex: action.msg._pairIndex });
                setEditValue(action.msg.content || '');
                setMenu(null);
                return;
            }
        }, [doRetry, doRegenerate, doDeleteMessage, doPrint]);

        const submitEdit = useCallback(async () => {
            if (!editing) return;
            const text = editValue.trim();
            if (!text) return;
            if (streamingRef.current) { HFS.toast('Please wait for the current response', 'info'); return; }
            const convId = activeConvIdRef.current;
            const pairIndex = editing.pairIndex;
            setEditing(null);
            setMessages(prev => {
                const idx = prev.findIndex(m => m._pairIndex === pairIndex && m.role === 'user');
                if (idx < 0) return prev;
                const copy = prev.slice(0, idx);
                copy.push({
                    role: 'user', content: text, ts: Date.now(),
                    _pairIndex: pairIndex, failed: false
                });
                return copy;
            });
            setStreaming(true);
            appliedSeqRef.current = 0;
            try {
                const res = await fetch('/~/api/chat/edit-resend', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        conversationId: convId,
                        pairIndex,
                        content: text,
                        enableSearch,
                        modelId: currentModelIdRef.current
                    })
                });
                if (!res.ok) {
                    let errMsg = 'HTTP ' + res.status;
                    try { const j = await res.json(); errMsg = j.error || errMsg; } catch {}
                    setMessages(prev => prev.concat([{
                        role: 'assistant', content: '⚠️ ' + errMsg, ts: Date.now()
                    }]));
                    setStreaming(false);
                }
            } catch (e) {
                setStreaming(false);
            }
        }, [editing, editValue, enableSearch]);

        const handleSend = useCallback(async () => {
            const text = input.trim();
            if (!text || streamingRef.current) return;
            let convId = activeConvIdRef.current;
            if (!convId) {
                convId = await createConversation();
                if (!convId) return;
            }
            const nowTs = Date.now();
            setConversations(prev => sortConversations(prev.map(c =>
                c.id === convId ? { ...c, lastActivity: nowTs, updatedAt: nowTs } : c)));
            setMessages(prev => prev.concat([{ role: 'user', content: text, ts: nowTs }]));
            setInput('');
            setStreaming(true);
            appliedSeqRef.current = 0;
            try {
                const res = await fetch('/~/api/chat/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        conversationId: convId,
                        content: text,
                        enableSearch,
                        modelId: currentModelIdRef.current
                    })
                });
                if (!res.ok) {
                    let errMsg = 'HTTP ' + res.status;
                    try { const j = await res.json(); errMsg = j.error || errMsg; } catch {}
                    setMessages(prev => prev.concat([{ role: 'assistant', content: '⚠️ ' + errMsg, ts: Date.now() }]));
                    setStreaming(false);
                    return;
                }
                loadConversations();
            } catch (e) {
                setMessages(prev => prev.concat([{ role: 'assistant', content: '⚠️ ' + e.message, ts: Date.now() }]));
                setStreaming(false);
            }
        }, [input, createConversation, loadConversations, enableSearch]);

        const handleKeyDown = useCallback((e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                handleSend();
            }
        }, [handleSend]);

        const stopStreaming = useCallback(() => { setStreaming(false); }, []);

        const handleClose = useCallback(() => {
            if (streamingRef.current) {
                if (!window.confirm('Response in progress. Close anyway?')) return;
            }
            onClose();
        }, [onClose]);

        useEffect(() => {
            return () => {
                if (searchAbortRef.current) { try { searchAbortRef.current.abort(); } catch (e) {} }
                if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
            };
        }, []);

        const currentModel = config.models.find(m => m.id === currentModelId);
        const currentModelLabel = currentModel
            ? currentModel.label + (currentModel.isFree ? ' (Free)' : '')
            : currentModelId;
        const supportsSearch = currentModel && currentModel.supportsSearch;

        let sidebarList;
        if (showSearch && searchTerm.trim()) {
            sidebarList = searchResults.map(r => ({ isSearch: true, ...r }));
        } else {
            const starred = conversations.filter(c => c.starred);
            const normal = conversations.filter(c => !c.starred);
            const items = [];
            if (starred.length) {
                for (const c of starred) items.push({ isSearch: false, conv: c });
                if (normal.length) items.push({ isSeparator: true, key: 'sep_star' });
            }
            for (const c of normal) items.push({ isSearch: false, conv: c });
            sidebarList = items;
        }

        const showEmptyState = !loading && messages.length === 0;

        return h('div', {
            className: 'chat-panel' + (isFullscreen ? ' fullscreen' : ''),
            ref: panelRef,
            style: { fontSize: fontSize + 'px' }
        },
            h('div', { className: 'chat-header' },
                h('button', {
                    className: 'chat-icon-btn chat-sidebar-toggle',
                    onClick: () => setShowSidebar(s => !s),
                    title: showSidebar ? 'Hide sidebar' : 'Show sidebar'
                }, showSidebar ? '▤\uFE0E' : '▤\uFE0E'),
                h('span', {
                    className: 'chat-title' + (isFullscreen ? ' fullscreen' : ''),
                    onClick: toggleFullscreen,
                    title: isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen',
                    style: { cursor: 'pointer' }
                },
                    'Ⓐ\uFE0E AI-Chat +',
                    h('label', {
                        className: 'chat-search-toggle' + (enableSearch ? ' active' : '') + (supportsSearch ? '' : ' disabled'),
                        title: supportsSearch ? (enableSearch ? 'Web search: ON' : 'Web search: OFF') : 'This model does not support web search',
                        onClick: (e) => e.stopPropagation()
                    },
                        h('input', {
                            type: 'checkbox',
                            checked: enableSearch,
                            disabled: !supportsSearch || streaming,
                            onChange: (e) => setEnableSearch(e.target.checked)
                        }),
                        h('span', { className: 'chat-search-icon' }, '₪\uFE0E'),
                        h('span', { className: 'chat-search-label' }, 'Web Search')
                    ),
                    streaming && h('span', { className: 'chat-thinking-indicator', title: 'Thinking...' }, ' ⇋\uFE0E Thinking')
                ),
                h('span', { className: 'chat-header-spacer' }),
                h('select', {
                    className: 'chat-model-select',
                    value: currentModelId,
                    onChange: (e) => handleModelChange(e.target.value),
                    disabled: streaming,
                    title: currentModelLabel
                },
                    config.models.length === 0
                        ? h('option', { value: '' }, '(no models configured)')
                        : config.models.map(m => h('option', { key: m.id, value: m.id },
                            m.label + (m.isFree ? ' (Free)' : '') + (m.supportsSearch ? ' ₪\uFE0E' : '') + (m.loginOnly ? ' 🔒\uFE0E' : '')))
                ),
                h('button', { className: 'chat-icon-btn chat-close-btn', onClick: handleClose, title: 'Close' }, '×')
            ),

            showSearch && h('div', { className: 'chat-body-search-bar' },
                h('span', { className: 'chat-body-search-label' }, 'Find:'),
                h('input', {
                    ref: searchInputRef,
                    className: 'chat-body-search-input',
                    value: searchTerm,
                    onChange: (e) => setSearchTerm(e.target.value),
                    placeholder: 'Search title & messages...'
                }),
                isSearching
                    ? h('span', { className: 'chat-body-search-count' }, '…')
                    : (searchTerm.trim() && h('span', { className: 'chat-body-search-count' },
                        `${searchResults.length} chats`)),
                bodySearchTerm.trim() && h('span', { className: 'chat-body-search-count' },
                    matches.length ? `${currentMatch + 1}/${matches.length}` : '0/0'),
                h('button', {
                    className: 'chat-body-search-btn',
                    onClick: goPrevMatch,
                    disabled: !matches.length,
                    title: 'Previous match'
                }, '▲'),
                h('button', {
                    className: 'chat-body-search-btn',
                    onClick: goNextMatch,
                    disabled: !matches.length,
                    title: 'Next match'
                }, '▼'),
                h('button', {
                    className: 'chat-body-search-btn chat-body-search-close',
                    onClick: closeSearchAll,
                    title: 'Close search'
                }, '✕')
            ),

            h('div', { className: 'chat-body' + (showSidebar ? ' sidebar-open' : ' sidebar-closed') },
                showSidebar && h('div', { className: 'chat-sidebar-backdrop', onClick: () => setShowSidebar(false) }),

                showSidebar && h('aside', { className: 'chat-sidebar' },
                    h('div', { className: 'chat-sidebar-header' },
                        h('span', { className: 'chat-sidebar-title' }, 'Chats'),
                        h('button', {
                            className: 'chat-font-btn',
                            onClick: () => setFontSize(s => Math.max(14, s - 1)),
                            disabled: fontSize <= 14,
                            title: 'Decrease font size'
                        }, 'A-'),
                        h('button', {
                            className: 'chat-font-btn',
                            onClick: () => setFontSize(s => Math.min(24, s + 1)),
                            disabled: fontSize >= 24,
                            title: 'Increase font size'
                        }, 'A+'),
                        h('button', {
                            className: 'chat-sidebar-search-btn' + (showSearch ? ' active' : ''),
                            onClick: () => {
                                if (showSearch) closeSearchAll();
                                else setShowSearch(true);
                            },
                            title: showSearch ? 'Close search' : 'Search all conversations'
                        }, showSearch ? '✕' : 'Ⓢ\uFE0E'),
                        h('button', { className: 'chat-sidebar-close', onClick: () => setShowSidebar(false), title: 'Close sidebar' }, '×')
                    ),

                    h('button', {
                        className: 'chat-new-btn' + (isDraft ? ' active' : ''),
                        onClick: enterDraft,
                        disabled: streaming
                    }, '+ New Chat'),

                    h('div', { className: 'chat-conv-list' },
                        sidebarList.length === 0
                            ? h('div', { className: 'chat-empty-sidebar' },
                                showSearch && searchTerm.trim()
                                    ? (isSearching ? 'Searching…' : 'No matches')
                                    : 'No conversations')
                            : sidebarList.map(item => {
                                if (item.isSeparator) {
                                    return h('div', {
                                        key: item.key,
                                        className: 'chat-conv-separator'
                                    });
                                }
                                if (item.isSearch) {
                                    const r = item;
                                    return h('div', {
                                        key: r.convId,
                                        className: 'chat-conv-item chat-conv-search-result' +
                                            (r.convId === activeConvId ? ' active' : '') +
                                            (r.starred ? ' starred' : ''),
                                        onClick: () => jumpToSearchResult(r),
                                        title: r.title
                                    },
                                        h('span', { className: 'chat-conv-title' },
                                            (r.starred ? '★\uFE0E ' : '') + (r.title || 'Untitled')),
                                        h('span', { className: 'chat-conv-hit' },
                                            (r.titleHit ? 'T' : '') +
                                            (r.count ? (r.titleHit ? '+' : '') + r.count : ''))
                                    );
                                }
                                const c = item.conv;
                                const isRenaming = renamingConvId === c.id;
                                const isActive = c.id === activeConvId;
                                return h('div', {
                                    key: c.id,
                                    className: 'chat-conv-item' + (isActive ? ' active' : '') + (c.starred ? ' starred' : ''),
                                    onClick: () => {
                                        if (isRenaming) return;
                                        if (streamingRef.current) return;
                                        loadConversation(c.id);
                                        if (window.innerWidth <= 768) setShowSidebar(false);
                                    },
                                    onDoubleClick: () => handleConvDoubleClick(c),
                                    onPointerDown: () => handleConvLongPressStart(c),
                                    onPointerUp: handleConvLongPressEnd,
                                    onPointerLeave: handleConvLongPressEnd,
                                    title: c.title
                                },
                                    isRenaming
                                        ? h('input', {
                                            ref: renameInputRef,
                                            className: 'chat-conv-rename-input',
                                            value: renameValue,
                                            onChange: (e) => setRenameValue(e.target.value),
                                            onKeyDown: handleRenameKeyDown,
                                            onBlur: saveRename,
                                            onClick: (e) => e.stopPropagation()
                                        })
                                        : h('span', { className: 'chat-conv-title' },
                                            (c.title || 'Untitled')),
                                    h('button', {
                                        className: 'chat-conv-star' + (c.starred ? ' starred' : ''),
                                        onClick: (e) => toggleStarConversation(c.id, e),
                                        title: c.starred ? 'Unstar' : 'Star (pin to top)'
                                    }, c.starred ? '★\uFE0E' : '☆\uFE0E'),
                                    h('button', {
                                        className: 'chat-conv-del',
                                        onClick: (e) => deleteConversation(c.id, e),
                                        title: 'Delete'
                                    }, '×')
                                );
                            })
                    )
                ),

                h('main', { className: 'chat-messages', ref: listRef },
                    hasMore && !loading && h('div', {
                        className: 'chat-load-older' + (loadingMore ? ' loading' : ''),
                        onClick: loadingMore ? undefined : loadOlder
                    }, loadingMore ? '▲ Loading older…' : '▲ Load older messages'),

                    loading
                        ? h('div', { className: 'chat-empty' }, 'Loading…')
                        : messages.length === 0
                            ? h('div', { className: 'chat-empty' },
                                h('div', { className: 'chat-empty-icon' }, '₪\uFE0E'),
                                h('div', null, 'Start a new conversation'),
                                h('div', { className: 'chat-empty-sub' }, 'Current model: ' + currentModelLabel))
                            : messages.map((m, i) => {
                                let matchOffset = null;
                                let isActive = false;
                                if (matches.length) {
                                    const localMatches = matches
                                        .map((mt, idx) => ({ ...mt, idx }))
                                        .filter(mt => mt.msgIndex === i);
                                    if (localMatches.length) {
                                        const activeLocal = localMatches.find(mt => mt.idx === currentMatch);
                                        if (activeLocal) {
                                            matchOffset = activeLocal.localOffset;
                                            isActive = true;
                                        } else {
                                            matchOffset = localMatches[0].localOffset;
                                        }
                                    }
                                }
                                return h(MessageBubble, {
                                    key: (m.ts || i) + '_' + i,
                                    msg: m,
                                    showReasoning: config.ui.showReasoning,
                                    searchTerm: bodySearchTerm,
                                    markRef: activeMarkRef,
                                    matchOffset,
                                    isActiveMatch: isActive,
                                    onAction: handleMsgAction
                                });
                            })
                )
            ),

            h('div', { className: 'chat-input-form' },
                h('textarea', {
                    ref: inputRef,
                    value: input,
                    onChange: (e) => {
                        setInput(e.target.value);
                        const ta = e.target;
                        ta.style.height = 'auto';
                        ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
                    },
                    onKeyDown: handleKeyDown,
                    placeholder: 'Enter to send, Shift+Enter for newline',
                    className: 'chat-input',
                    rows: 1,
                    disabled: loading
                }),
                streaming
                    ? h('button', { className: 'chat-send-btn chat-stop-btn', onClick: stopStreaming, title: 'Stop' }, '■\uFE0E')
                    : h('button', {
                        className: 'chat-send-btn',
                        onClick: handleSend,
                        disabled: !input.trim() || loading,
                        title: 'Send'
                    }, 'Send')
            ),

            menu && h('div', {
                className: 'chat-ctx-menu-backdrop',
                onClick: () => setMenu(null),
                onContextMenu: (e) => { e.preventDefault(); setMenu(null); }
            },
                h('div', {
                    className: 'chat-ctx-menu',
                    style: {
                        left: Math.min(menu.x, Math.max(8, window.innerWidth - 160)) + 'px',
                        top: Math.min(menu.y, Math.max(8, window.innerHeight - 160)) + 'px'
                    },
                    onClick: (e) => e.stopPropagation()
                },
                    h('div', {
                        className: 'chat-ctx-item',
                        onClick: () => handleMsgAction({ type: 'copy', msg: menu.msg })
                    }, 'Copy'),
                    menu.msg.role === 'user' && h('div', {
                        className: 'chat-ctx-item',
                        onClick: () => handleMsgAction({ type: 'edit', msg: menu.msg })
                    }, 'Edit'),
                    menu.msg.role === 'user' && h('div', {
                        className: 'chat-ctx-item',
                        onClick: () => handleMsgAction({ type: 'retry', msg: menu.msg })
                    }, 'Resend'),
                    menu.msg.role === 'assistant' && h('div', {
                        className: 'chat-ctx-item',
                        onClick: () => handleMsgAction({ type: 'regenerate', msg: menu.msg })
                    }, 'Regenerate'),
                    h('div', {
                        className: 'chat-ctx-item',
                        onClick: () => handleMsgAction({ type: 'print-pair', msg: menu.msg })
                    }, 'Print Q&A'),
                    h('div', {
                        className: 'chat-ctx-item',
                        onClick: () => handleMsgAction({ type: 'print-single', msg: menu.msg })
                    }, menu.msg.role === 'user' ? 'Print Question' : 'Print Answer'),
                    h('div', {
                        className: 'chat-ctx-item chat-ctx-danger',
                        onClick: () => handleMsgAction({ type: 'delete', msg: menu.msg })
                    }, 'Delete')
                )
            ),

            editing && h('div', { className: 'chat-edit-backdrop' },
                h('div', { className: 'chat-edit-box', onClick: (e) => e.stopPropagation() },
                    h('div', { className: 'chat-edit-title' }, 'Edit Message'),
                    h('textarea', {
                        className: 'chat-edit-textarea',
                        value: editValue,
                        onChange: (e) => setEditValue(e.target.value),
                        onKeyDown: (e) => {
                            if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                e.preventDefault();
                                submitEdit();
                            }
                        }
                    }),
                    h('div', { className: 'chat-edit-actions' },
                        h('button', {
                            className: 'chat-edit-cancel',
                            onClick: () => setEditing(null)
                        }, 'Cancel'),
                        h('button', {
                            className: 'chat-edit-save',
                            onClick: submitEdit,
                            disabled: !editValue.trim()
                        }, 'Save & Resend')
                    )
                )
            )
        );
    }

    // ============================================
    // === ChatApp（统一 SSE 注册在这里） ===
    // ============================================
    function ChatApp() {
        const [show, setShow] = useState(false);
        const [config, setConfig] = useState(null);
        const mountRef = useRef(null);
        const configRef = useRef(null);
        const initializedRef = useRef(false);
        const chatEventSubscribersRef = useRef(new Set());

        useEffect(() => { configRef.current = config; }, [config]);

        // 统一的 SSE 注册（只注册一次）
        useEffect(() => {
            let handle = null;
            let closed = false;
            try {
                handle = HFS.getNotifications('chat', (event, data) => {
                    if (closed) return;
                    const subs = chatEventSubscribersRef.current;
                    subs.forEach(fn => {
                        try { fn(event, data); } catch (e) {
                            console.error('[Chat] subscriber error:', e);
                        }
                    });
                });
            } catch (e) {
                console.error('[Chat] getNotifications failed:', e);
            }
            return () => {
                closed = true;
                // 如果 handle 有 close 方法就调用（防御性）
                if (handle) {
                    try {
                        if (typeof handle.close === 'function') handle.close();
                        else if (typeof handle.dispose === 'function') handle.dispose();
                    } catch (e) {}
                }
            };
        }, []);

        // 提供给 ChatPanel 的订阅函数
        const onChatEvent = useCallback((fn) => {
            const subs = chatEventSubscribersRef.current;
            subs.add(fn);
            return () => { subs.delete(fn); };
        }, []);

        useEffect(() => {
            if (initializedRef.current) return;
            initializedRef.current = true;
            fetch('/~/api/chat/check')
                .then(r => r.json())
                .then(data => { if (data.allowed) setConfig(data); })
                .catch(e => console.error('[Chat] check failed:', e));
            const onToggle = () => {
                if (!configRef.current) { HFS.toast('Chat is not available', 'error'); return; }
                setShow(prev => !prev);
            };
            window.addEventListener('toggle-chat', onToggle);
            return () => window.removeEventListener('toggle-chat', onToggle);
        }, []);

        const hasConfig = !!config;
        useEffect(() => {
            if (mountRef.current && mountRef.current.parentNode) {
                try {
                    if (HFS.ReactDOM && HFS.ReactDOM.unmountComponentAtNode) {
                        HFS.ReactDOM.unmountComponentAtNode(mountRef.current);
                    }
                } catch (e) {}
                mountRef.current.parentNode.removeChild(mountRef.current);
                mountRef.current = null;
            }
            if (!hasConfig || !show) return;
            const container = document.createElement('div');
            container.style.cssText = `
                position: fixed !important;
                top: 0 !important;
                left: 0 !important;
                width: 100% !important;
                height: 100% !important;
                z-index: 10 !important;
                pointer-events: none !important;
                overflow: hidden !important;
                touch-action: none !important;
                margin: 0 !important;
                padding: 0 !important;
                background: transparent !important;
            `;
            document.body.appendChild(container);
            mountRef.current = container;
            try {
                const element = h(ChatPanel, {
                    onClose: () => setShow(false),
                    config: configRef.current,
                    onChatEvent
                });
                if (HFS.ReactDOM && HFS.ReactDOM.render) HFS.ReactDOM.render(element, container);
                else if (HFS.React && HFS.React.render) HFS.React.render(element, container);
            } catch (e) { console.error('[Chat] render error:', e); }
            return () => {
                if (mountRef.current && mountRef.current.parentNode) {
                    try {
                        if (HFS.ReactDOM && HFS.ReactDOM.unmountComponentAtNode) {
                            HFS.ReactDOM.unmountComponentAtNode(mountRef.current);
                        }
                    } catch (e) {}
                    mountRef.current.parentNode.removeChild(mountRef.current);
                    mountRef.current = null;
                }
            };
        }, [hasConfig, show, onChatEvent]);

        return null;
    }

    HFS.onEvent('appendMenuBar', () => {
        return h('button', {
            className: 'menu-bar-chat-btn',
            onClick() { window.dispatchEvent(new CustomEvent('toggle-chat')); },
            title: 'AI Chat'
        }, [
            h('span', { 'aria-hidden': 'true' }, 'Ⓐ\uFE0E'),
            h('span', { className: 'btn-label' }, 'AI Chat')
        ]);
    });

    HFS.onEvent('footer', () => h(ChatApp));

    // console.log('[Chat] main.js loaded');

})();