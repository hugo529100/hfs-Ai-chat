exports.version = 6.3
exports.description = "AI Chat - Admin-only chat UI for HFS. Multi-model, streaming, Markdown, per-model isolation, cross-device realtime sync, activity-based sorting, optional web search, retry & edit-resend & regenerate & per-message delete. Paginated pair-based storage + full-text search + daily snapshot txt backup."
exports.apiRequired = 8.87
exports.repo = "Hug3O/Ai-chat"
exports.frontend_js = ['main.js']
exports.frontend_css = ['style.css']

exports.config = {
    modelList: {
        type: 'array',
        label: 'Model List',
        helperText: 'One model per row. All must be OpenAI /v1/chat/completions compatible.',
        fields: {
            id: { label: 'Model ID', helperText: 'Unique identifier' },
            label: { label: 'Display Name' },
            baseUrl: {
                label: 'API Base URL',
                defaultValue: 'https://api.deepseek.com',
                helperText: 'Without /v1'
            },
            apiKey: { label: 'API Key', helperText: 'Backend only' },
            modelName: { label: 'API model field' },
            supportsSearch: {
                type: 'boolean',
                label: 'Supports web search',
                defaultValue: false,
                helperText: 'Enable web_search parameter for this model'
            },
            isFree: {
                type: 'boolean',
                label: 'Mark as free',
                defaultValue: false
            },
            loginOnly: {
                type: 'boolean',
                label: 'Login only',
                defaultValue: false,
                helperText: 'Only logged-in users (not guests) can use this model'
            }
        },
        defaultValue: [{
            id: 'deepseek-chat',
            label: 'DeepSeek Chat',
            baseUrl: 'https://api.deepseek.com',
            apiKey: '',
            modelName: 'deepseek-chat',
            supportsSearch: false,
            isFree: false,
            loginOnly: false
        }],
        frontend: true
    },

    defaultModelId: {
        type: 'string',
        label: 'Default Model ID',
        defaultValue: 'deepseek-chat',
        frontend: true
    },

    systemPrompt: {
        type: 'string',
        multiline: true,
        label: 'System Prompt',
        defaultValue: 'You are a helpful assistant.',
        frontend: true
    },
    temperature: {
        type: 'number',
        min: 0, max: 2, step: 0.1,
        defaultValue: 0.7,
        label: 'Temperature',
        frontend: true
    },
    maxTokens: {
        type: 'number',
        defaultValue: 4096,
        label: 'Max output tokens',
        frontend: true
    },
    maxContextMessages: {
        type: 'number',
        defaultValue: 100,
        min: 2, max: 200,
        label: 'Max context messages',
        frontend: true
    },
    enableStream: {
        type: 'boolean',
        label: 'Stream responses',
        defaultValue: true,
        frontend: true
    },
    apiTimeout: {
        type: 'number',
        defaultValue: 300,
        min: 10, max: 1200,
        label: 'Request timeout (seconds)',
        frontend: true
    },
    pageSize: {
        type: 'number',
        defaultValue: 200,
        min: 5, max: 200,
        label: 'Pairs per page',
        frontend: true
    },
    showReasoning: {
        type: 'boolean',
        label: 'Show reasoning',
        defaultValue: true,
        frontend: true
    },
    allowGuest: {
        type: 'boolean',
        label: 'Allow guest access',
        defaultValue: true,
        helperText: 'Allow non-admin (guest) users to open the chat, create conversations and send messages. When off, only admin can use the chat.',
        frontend: false
    },
    backupConversations: {
        type: 'boolean',
        label: 'Auto backup conversations as txt',
        defaultValue: true,
        helperText: 'Save a human-readable .txt copy of every conversation to storage/backup/<date>/, one snapshot per conversation per day.',
        frontend: false
    },
    backupDays: {
        type: 'number',
        defaultValue: 30,
        min: 1, max: 365,
        label: 'Backup retention (days)',
        helperText: 'Delete backup day-folders older than this many days. Runs on startup and periodically. Snapshots are kept per-day, so old versions remain recoverable until retention expires.',
        frontend: false
    },
    // [NEW] 删除会话时是否也清除其历史备份
    backupPurgeOnDelete: {
        type: 'boolean',
        label: 'Purge backups when conversation is deleted',
        defaultValue: false,
        helperText: 'When ON, deleting a conversation also removes all its historical backup snapshots. When OFF (recommended), historical snapshots are preserved for recovery.',
        frontend: false
    }
}

exports.init = async api => {
    const { getCurrentUsername } = api.require('./auth')
    const fs = api.require('fs/promises')
    const path = api.require('path')
    const crypto = api.require('crypto')

    const STORAGE = api.storageDir
    const API_BASE = `${api.Const.API_URI}chat/`
    const CHAT_DIR = path.join(STORAGE, 'conversations')
    const INDEX_FILE = path.join(CHAT_DIR, '_index.json')
    const STREAM_DIR = path.join(STORAGE, 'streaming')
    const BACKUP_DIR = path.join(STORAGE, 'backup')

    await fs.mkdir(CHAT_DIR, { recursive: true }).catch(() => {})
    await fs.mkdir(STREAM_DIR, { recursive: true }).catch(() => {})
    await fs.mkdir(BACKUP_DIR, { recursive: true }).catch(() => {})
    try { await fs.stat(INDEX_FILE) }
    catch {
        await fs.writeFile(INDEX_FILE,
            JSON.stringify({ conversations: [] }, null, 2))
    }

    // ============================================
    // === Helpers ===
    // ============================================
    function sanitizeForDb(text) {
        if (!text || typeof text !== 'string') return ''
        return text
            .replace(/\x00/g, '')
            .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
            .replace(/\u200B/g, '')
            .replace(/\uFEFF/g, '')
            .normalize('NFC')
    }

    function isAllowed(ctx) {
        if (getCurrentUsername(ctx) === 'admin') return true
        return api.getConfig('allowGuest') !== false
    }

    function isLoggedIn(ctx) {
        const u = getCurrentUsername(ctx)
        return !!u && u !== '' && u !== 'guest'
    }

    function genId() {
        return Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex')
    }

    function safeId(id) {
        return String(id).replace(/[\\/:*?"<>|]/g, '_')
    }

    function convDir(id) { return path.join(CHAT_DIR, safeId(id)) }
    function metaPath(id) { return path.join(convDir(id), 'meta.json') }
    function pairsDir(id) { return path.join(convDir(id), 'pairs') }
    function pairPath(id, n) {
        return path.join(pairsDir(id), String(n).padStart(4, '0') + '.json')
    }
    function legacyMsgPath(id) { return path.join(convDir(id), 'messages.json') }
    function streamPath(id) { return path.join(STREAM_DIR, safeId(id) + '.json') }

    // ============================================
    // === Backup paths (daily snapshot) ===
    // [CHANGED] 结构改为 backup/<YYYY-MM-DD>/<convId>.txt
    // ============================================
    function todayKey(d = new Date()) {
        const y = d.getFullYear()
        const m = String(d.getMonth() + 1).padStart(2, '0')
        const dd = String(d.getDate()).padStart(2, '0')
        return y + '-' + m + '-' + dd
    }
    function isDayKey(name) {
        return /^\d{4}-\d{2}-\d{2}$/.test(name)
    }
    function backupDayDir(dayKey) { return path.join(BACKUP_DIR, dayKey) }
    function backupTxtPath(id, dayKey) {
        return path.join(backupDayDir(dayKey), safeId(id) + '.txt')
    }
    function backupMetaPath(id, dayKey) {
        return path.join(backupDayDir(dayKey), safeId(id) + '.meta.json')
    }

    async function loadIndex() {
        try { return JSON.parse(await fs.readFile(INDEX_FILE, 'utf-8')) }
        catch { return { conversations: [] } }
    }
    async function saveIndex(idx) {
        await fs.writeFile(INDEX_FILE, JSON.stringify(idx, null, 2))
    }
    async function loadMeta(id) {
        try { return JSON.parse(await fs.readFile(metaPath(id), 'utf-8')) }
        catch { return null }
    }
    async function saveMeta(meta) {
        await fs.mkdir(convDir(meta.id), { recursive: true }).catch(() => {})
        await fs.writeFile(metaPath(meta.id), JSON.stringify(meta, null, 2))
        scheduleBackup(meta.id)
    }
    async function touchMeta(meta, ts) {
        meta.updatedAt = ts
        meta.lastActivity = ts
        await saveMeta(meta)
        const idx = await loadIndex()
        const i = idx.conversations.findIndex(c => c.id === meta.id)
        if (i >= 0) idx.conversations[i] = meta
        await saveIndex(idx)
    }

    // ---------- Pair storage ----------
    async function ensureMigrated(id) {
        const legacy = legacyMsgPath(id)
        let raw
        try { raw = await fs.readFile(legacy, 'utf-8') } catch { return }
        let list
        try { list = JSON.parse(raw) } catch { list = [] }

        const pairs = []
        let curUser = null
        for (const m of list) {
            if (m.role === 'user') {
                if (curUser) pairs.push({ q: curUser, a: null, ts: curUser.ts })
                curUser = m
            } else if (m.role === 'assistant') {
                if (curUser) {
                    pairs.push({ q: curUser, a: m, ts: curUser.ts })
                    curUser = null
                } else {
                    pairs.push({ q: null, a: m, ts: m.ts })
                }
            }
        }
        if (curUser) pairs.push({ q: curUser, a: null, ts: curUser.ts })

        await fs.mkdir(pairsDir(id), { recursive: true }).catch(() => {})
        for (let i = 0; i < pairs.length; i++) {
            await fs.writeFile(pairPath(id, i + 1), JSON.stringify(pairs[i], null, 2))
        }
        const meta = await loadMeta(id)
        if (meta) {
            meta.pairCount = pairs.length
            await saveMeta(meta)
            const idx = await loadIndex()
            const k = idx.conversations.findIndex(c => c.id === id)
            if (k >= 0) idx.conversations[k] = meta
            await saveIndex(idx)
        }
        await fs.rm(legacy, { force: true }).catch(() => {})
    }

    async function listPairNumbers(id) {
        try {
            const files = await fs.readdir(pairsDir(id))
            return files
                .filter(f => /^\d{4}\.json$/.test(f))
                .map(f => parseInt(f.slice(0, 4), 10))
                .sort((a, b) => a - b)
        } catch { return [] }
    }

    async function loadPair(id, n) {
        try {
            return JSON.parse(await fs.readFile(pairPath(id, n), 'utf-8'))
        } catch { return null }
    }

    async function savePair(id, n, pair) {
        await fs.mkdir(pairsDir(id), { recursive: true }).catch(() => {})
        await fs.writeFile(pairPath(id, n), JSON.stringify(pair, null, 2))
        scheduleBackup(id)
    }

    async function appendPair(id, q, a) {
        const nums = await listPairNumbers(id)
        const next = nums.length ? nums[nums.length - 1] + 1 : 1
        await savePair(id, next, { q, a, ts: (q && q.ts) || (a && a.ts) || Date.now() })
        return next
    }

    async function setPairAssistant(id, n, assistant) {
        const pair = await loadPair(id, n) || { q: null, a: null, ts: Date.now() }
        pair.a = assistant
        if (!pair.ts) pair.ts = assistant.ts || Date.now()
        await savePair(id, n, pair)
        return n
    }

    async function setLastPairAssistant(id, assistant) {
        const nums = await listPairNumbers(id)
        if (!nums.length) return null
        return setPairAssistant(id, nums[nums.length - 1], assistant)
    }

    async function markPairFailed(id, n, error) {
        const pair = await loadPair(id, n)
        if (!pair) return null
        if (pair.q) {
            pair.q.failed = true
            pair.error = error || 'fetch failed'
        }
        await savePair(id, n, pair)
        return pair
    }

    async function clearPairFailed(id, n) {
        const pair = await loadPair(id, n)
        if (!pair) return null
        if (pair.q) {
            delete pair.q.failed
            delete pair.error
        }
        await savePair(id, n, pair)
        return pair
    }

    async function updatePairCount(id) {
        const nums = await listPairNumbers(id)
        const meta = await loadMeta(id)
        if (meta) {
            meta.pairCount = nums.length
            await saveMeta(meta)
            const idx = await loadIndex()
            const k = idx.conversations.findIndex(c => c.id === id)
            if (k >= 0) idx.conversations[k] = meta
            await saveIndex(idx)
        }
        return nums.length
    }

    // ============================================
    // === Backup as readable txt (daily snapshot) ===
    // ============================================
    const pendingBackups = new Map()
    let backupTimer = null

    function formatTs(ts) {
        if (!ts) return ''
        try { return new Date(ts).toISOString().replace('T', ' ').replace(/\..+/, '') }
        catch { return '' }
    }

    function formatConversationTxt(meta, pairs) {
        const lines = []
        lines.push('='.repeat(70))
        lines.push('AI Chat Conversation Backup')
        lines.push('='.repeat(70))
        lines.push('ID       : ' + (meta.id || ''))
        lines.push('Title    : ' + (meta.title || 'Untitled'))
        lines.push('Model    : ' + (meta.modelLabel || meta.modelId || ''))
        lines.push('Created  : ' + formatTs(meta.createdAt))
        lines.push('Updated  : ' + formatTs(meta.updatedAt || meta.lastActivity))
        lines.push('Pairs    : ' + (meta.pairCount || pairs.length))
        lines.push('='.repeat(70))
        lines.push('')

        for (let i = 0; i < pairs.length; i++) {
            const p = pairs[i]
            if (!p) continue
            lines.push('-'.repeat(70))
            lines.push('# Pair ' + (p.index || i + 1) + '  @ ' + formatTs(p.ts))
            lines.push('-'.repeat(70))
            if (p.q) {
                lines.push('[USER]' + (p.q.failed ? '  (FAILED)' : '') + '  ' + formatTs(p.q.ts))
                lines.push('')
                lines.push(p.q.content || '')
                lines.push('')
            }
            if (p.a) {
                lines.push('[ASSISTANT]' + (p.a.modelLabel ? '  (' + p.a.modelLabel + ')' : '') + '  ' + formatTs(p.a.ts))
                lines.push('')
                lines.push(p.a.content || '')
                lines.push('')
                if (p.a.reasoning) {
                    lines.push('--- reasoning ---')
                    lines.push(p.a.reasoning)
                    lines.push('')
                }
            }
            if (p.error) {
                lines.push('[ERROR] ' + p.error)
                lines.push('')
            }
        }
        lines.push('='.repeat(70))
        lines.push('End of backup')
        lines.push('='.repeat(70))
        lines.push('')
        return lines.join('\n')
    }

    // [NEW] 原子写入：先写临时文件再 rename，避免半截文件
    async function atomicWrite(file, content) {
        const dir = path.dirname(file)
        await fs.mkdir(dir, { recursive: true }).catch(() => {})
        const tmp = file + '.tmp-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex')
        try {
            await fs.writeFile(tmp, content, 'utf-8')
            await fs.rename(tmp, file)
        } catch (e) {
            await fs.rm(tmp, { force: true }).catch(() => {})
            throw e
        }
    }

    // [CHANGED] 只写当天目录，不覆盖旧日期
    async function writeBackup(id) {
        if (api.getConfig('backupConversations') === false) return
        try {
            const meta = await loadMeta(id)
            if (!meta) return
            const nums = await listPairNumbers(id)
            const pairs = []
            for (const n of nums) {
                const p = await loadPair(id, n)
                if (p) pairs.push({ ...p, index: n })
            }
            const dayKey = todayKey()
            const txt = formatConversationTxt(meta, pairs)
            await atomicWrite(backupTxtPath(id, dayKey), txt)
            await atomicWrite(backupMetaPath(id, dayKey), JSON.stringify(meta, null, 2))
        } catch (e) {
            // silent
        }
    }

    function scheduleBackup(id) {
        if (!id) return
        if (api.getConfig('backupConversations') === false) return
        pendingBackups.set(id, Date.now())
        if (backupTimer) return
        backupTimer = setTimeout(async () => {
            backupTimer = null
            const ids = Array.from(pendingBackups.keys())
            pendingBackups.clear()
            for (const cid of ids) {
                await writeBackup(cid)
            }
        }, 1500)
    }

    // [CHANGED] 按目录名日期滚动删，不看 mtime
    async function cleanOldBackups() {
        const days = api.getConfig('backupDays') || 30
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
        let entries
        try {
            entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true })
        } catch { return }
        for (const ent of entries) {
            if (!ent.isDirectory()) continue
            if (!isDayKey(ent.name)) continue
            const d = Date.parse(ent.name + 'T00:00:00')
            if (isNaN(d)) continue
            // 用「当天结束」判断，保证今天永远不会被删
            const dayEnd = d + 24 * 60 * 60 * 1000
            if (dayEnd < cutoff) {
                await fs.rm(path.join(BACKUP_DIR, ent.name), { recursive: true, force: true }).catch(() => {})
            }
        }
    }

    // [NEW] 可选：删除会话时清掉它所有历史备份
    async function purgeBackupsOfConv(id) {
        const fname = safeId(id) + '.txt'
        const mname = safeId(id) + '.meta.json'
        let entries
        try { entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true }) } catch { return }
        for (const ent of entries) {
            if (!ent.isDirectory()) continue
            if (!isDayKey(ent.name)) continue
            const dir = path.join(BACKUP_DIR, ent.name)
            await fs.rm(path.join(dir, fname), { force: true }).catch(() => {})
            await fs.rm(path.join(dir, mname), { force: true }).catch(() => {})
        }
    }

    cleanOldBackups().catch(() => {})
    const cleanupInterval = setInterval(() => { cleanOldBackups().catch(() => {}) }, 6 * 60 * 60 * 1000)
    if (cleanupInterval.unref) cleanupInterval.unref()

    // ============================================
    // === Streaming state ===
    const activeStreams = new Map()

    function startStream(id) {
        const st = {
            seq: 0,
            content: '',
            reasoning: '',
            startedAt: Date.now(),
            flushTimer: null,
            dirty: false,
            done: false
        }
        activeStreams.set(id, st)
        return st
    }
    function flushStream(id) {
        const st = activeStreams.get(id)
        if (!st) return
        st.dirty = false
        const payload = {
            conversationId: id,
            seq: st.seq,
            content: st.content,
            reasoning: st.reasoning || '',
            startedAt: st.startedAt,
            updatedAt: Date.now(),
            done: st.done
        }
        fs.writeFile(streamPath(id), JSON.stringify(payload)).catch(() => {})
    }
    function scheduleFlush(id) {
        const st = activeStreams.get(id)
        if (!st) return
        st.dirty = true
        if (st.flushTimer) return
        st.flushTimer = setTimeout(() => {
            st.flushTimer = null
            if (st.dirty) flushStream(id)
        }, 200)
    }
    function appendStream(id, contentDelta, reasoningDelta) {
        const st = activeStreams.get(id)
        if (!st) return
        if (contentDelta) st.content += contentDelta
        if (reasoningDelta) st.reasoning += reasoningDelta
        st.seq++
        scheduleFlush(id)
    }
    async function endStream(id) {
        const st = activeStreams.get(id)
        if (st) {
            if (st.flushTimer) { clearTimeout(st.flushTimer); st.flushTimer = null }
            st.done = true
            flushStream(id)
        }
        activeStreams.delete(id)
        await fs.rm(streamPath(id), { force: true }).catch(() => {})
    }

    function findModel(modelId, ctx) {
        const list = api.getConfig('modelList') || []
        if (!list.length) return null
        if (modelId) {
            const found = list.find(m => m.id === modelId)
            if (found) return found
        }
        const def = api.getConfig('defaultModelId')
        if (def) {
            const found = list.find(m => m.id === def)
            if (found) return found
        }
        return list[0]
    }

    function canUseModel(ctx, model) {
        if (!model) return false
        if (getCurrentUsername(ctx) === 'admin') return true
        if (model.loginOnly && !isLoggedIn(ctx)) return false
        return true
    }

    function sortConversations(list) {
        return [...list].sort((a, b) => {
            const sa = a.starred ? 1 : 0
            const sb = b.starred ? 1 : 0
            if (sa !== sb) return sb - sa
            const ta = b.lastActivity || b.updatedAt || b.createdAt || 0
            const tb = a.lastActivity || a.updatedAt || a.createdAt || 0
            return ta - tb
        })
    }

    // ============================================
    // === Core completion runner ===
    // ============================================
    async function runCompletion(ctx, conversationId, pairNum, userText, opts = {}) {
        const meta = await loadMeta(conversationId)
        if (!meta) { ctx.status = 404; ctx.body = { error: 'Conversation not found' }; return }

        const model = findModel(opts.modelId || meta.modelId, ctx)
        if (!model) {
            await markPairFailed(conversationId, pairNum, 'Model not configured')
            await endStream(conversationId)
            api.notifyClient('chat', 'messageFailed', {
                conversationId, pairIndex: pairNum, error: 'Model not configured: ' + (opts.modelId || meta.modelId)
            })
            api.notifyClient('chat', 'streamingEnded', { conversationId })
            ctx.status = 500
            ctx.body = { error: 'Model not configured: ' + (opts.modelId || meta.modelId), pairIndex: pairNum }
            return
        }

        if (!canUseModel(ctx, model)) {
            await markPairFailed(conversationId, pairNum, 'Model not allowed for this user')
            await endStream(conversationId)
            api.notifyClient('chat', 'messageFailed', {
                conversationId, pairIndex: pairNum, error: 'Model not allowed for this user'
            })
            api.notifyClient('chat', 'streamingEnded', { conversationId })
            ctx.status = 403
            ctx.body = { error: 'Model not allowed for this user', pairIndex: pairNum }
            return
        }

        const key = model.apiKey
        if (!key) {
            await markPairFailed(conversationId, pairNum, 'API Key not configured')
            await endStream(conversationId)
            api.notifyClient('chat', 'messageFailed', {
                conversationId, pairIndex: pairNum, error: 'API Key not configured'
            })
            api.notifyClient('chat', 'streamingEnded', { conversationId })
            ctx.status = 500
            ctx.body = { error: 'API Key not configured for model: ' + model.id, pairIndex: pairNum }
            return
        }

        const enableSearch = !!opts.enableSearch

        // 组装上下文
        const maxCtx = api.getConfig('maxContextMessages') || 100
        const nums = await listPairNumbers(conversationId)
        const ctxPairs = []
        const takeFrom = Math.max(0, nums.length - Math.ceil(maxCtx / 2))
        for (const n of nums.slice(takeFrom)) {
            if (n === pairNum) continue
            const p = await loadPair(conversationId, n)
            if (!p) continue
            if (p.q && !p.q.failed) ctxPairs.push({ role: 'user', content: p.q.content })
            if (p.a) ctxPairs.push({ role: 'assistant', content: p.a.content })
        }

        const userMsg = { role: 'user', content: userText, ts: Date.now() }

        let sys = api.getConfig('systemPrompt') || ''
        if (enableSearch && model.supportsSearch) {
            sys = (sys ? sys + '\n\n' : '') +
                '[Web search is ENABLED for this turn. Answer using up-to-date information when needed.]'
        }
        const apiMessages = sys
            ? [{ role: 'system', content: sys }, ...ctxPairs, userMsg]
            : [...ctxPairs, userMsg]

        const stream = api.getConfig('enableStream') !== false
        const payload = {
            model: model.modelName || model.id,
            messages: apiMessages,
            temperature: api.getConfig('temperature') ?? 0.7,
            max_tokens: api.getConfig('maxTokens') || 4096,
            stream
        }
        if (enableSearch && model.supportsSearch) {
            payload.web_search = true
            payload.enable_search = true
        }

        const base = (model.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
        const url = base + '/v1/chat/completions'

        const timeoutMs = (api.getConfig('apiTimeout') || 300) * 1000
        const controller = new AbortController()
        const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

        let resp
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + key,
                    'Accept': stream ? 'text/event-stream' : 'application/json'
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            })
        } catch (e) {
            clearTimeout(timeoutHandle)
            await markPairFailed(conversationId, pairNum, e.message)
            await endStream(conversationId)
            api.notifyClient('chat', 'messageFailed', {
                conversationId, pairIndex: pairNum, error: e.message
            })
            api.notifyClient('chat', 'streamingEnded', { conversationId })
            ctx.status = 502
            ctx.body = { error: 'Upstream request failed: ' + e.message, pairIndex: pairNum }
            return
        }

        if (!resp.ok) {
            clearTimeout(timeoutHandle)
            let errText = ''
            try { errText = await resp.text() } catch {}
            const errMsg = 'Upstream ' + resp.status + ': ' + errText.slice(0, 500)
            await markPairFailed(conversationId, pairNum, errMsg)
            await endStream(conversationId)
            api.notifyClient('chat', 'messageFailed', {
                conversationId, pairIndex: pairNum, error: errMsg
            })
            api.notifyClient('chat', 'streamingEnded', { conversationId })
            ctx.status = resp.status
            ctx.body = { error: errMsg, pairIndex: pairNum }
            return
        }

        // ---------- 非流式 ----------
        if (!stream) {
            clearTimeout(timeoutHandle)
            let json
            try { json = await resp.json() } catch {
                const errMsg = 'Invalid JSON from upstream'
                await markPairFailed(conversationId, pairNum, errMsg)
                await endStream(conversationId)
                api.notifyClient('chat', 'messageFailed', {
                    conversationId, pairIndex: pairNum, error: errMsg
                })
                api.notifyClient('chat', 'streamingEnded', { conversationId })
                ctx.status = 502
                ctx.body = { error: errMsg, pairIndex: pairNum }
                return
            }
            const choice = (json.choices && json.choices[0]) || {}
            const content2 = (choice.message && choice.message.content) || ''
            const reasoning2 = (choice.message && choice.message.reasoning_content) || ''
            const doneAt = Date.now()
            const assistant = {
                role: 'assistant',
                content: content2,
                reasoning: reasoning2 || undefined,
                modelId: model.id,
                modelLabel: model.label || model.id,
                ts: doneAt
            }
            await setPairAssistant(conversationId, pairNum, assistant)
            await updatePairCount(conversationId)
            await touchMeta(meta, doneAt)

            api.notifyClient('chat', 'assistantMessage', {
                conversationId,
                message: assistant,
                meta,
                pairIndex: pairNum
            })
            await endStream(conversationId)
            api.notifyClient('chat', 'streamingEnded', { conversationId })
            ctx.body = { ok: true, message: assistant, pairIndex: pairNum }
            ctx.status = 200
            return
        }

        // ---------- 流式 ----------
        ctx.status = 200
        ctx.body = { ok: true, streaming: true, pairIndex: pairNum }

        ;(async () => {
            const reader = resp.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            let accContent = ''
            let accReasoning = ''

            try {
                while (true) {
                    const r = await reader.read()
                    if (r.done) break
                    buffer += decoder.decode(r.value, { stream: true })
                    const lines = buffer.split('\n')
                    buffer = lines.pop() || ''
                    for (const line of lines) {
                        const t = line.trim()
                        if (!t) continue
                        if (t.indexOf('data:') !== 0) continue
                        const data = t.slice(5).trim()
                        if (data === '[DONE]') continue
                        try {
                            const json = JSON.parse(data)
                            const delta = (json.choices && json.choices[0] && json.choices[0].delta) || {}
                            const c = delta.content || ''
                            const rc = delta.reasoning_content || ''
                            if (c || rc) {
                                accContent += c
                                accReasoning += rc
                                appendStream(conversationId, c, rc)
                                api.notifyClient('chat', 'streamDelta', {
                                    conversationId,
                                    seq: activeStreams.get(conversationId)?.seq || 0,
                                    delta: c || null,
                                    reasoningDelta: rc || null,
                                    pairIndex: pairNum
                                })
                            }
                        } catch {}
                    }
                }
            } catch (e) {
                api.notifyClient('chat', 'streamDelta', {
                    conversationId,
                    seq: activeStreams.get(conversationId)?.seq || 0,
                    error: e.message,
                    pairIndex: pairNum
                })
            } finally {
                clearTimeout(timeoutHandle)
                const doneAt = Date.now()
                const assistant = {
                    role: 'assistant',
                    content: accContent,
                    reasoning: accReasoning || undefined,
                    modelId: model.id,
                    modelLabel: model.label || model.id,
                    ts: doneAt
                }
                if (accContent || accReasoning) {
                    await setPairAssistant(conversationId, pairNum, assistant)
                } else {
                    await markPairFailed(conversationId, pairNum, 'Empty response')
                    api.notifyClient('chat', 'messageFailed', {
                        conversationId, pairIndex: pairNum, error: 'Empty response'
                    })
                }
                await updatePairCount(conversationId)
                await touchMeta(meta, doneAt)

                if (accContent || accReasoning) {
                    api.notifyClient('chat', 'assistantMessage', {
                        conversationId,
                        message: assistant,
                        meta,
                        pairIndex: pairNum
                    })
                }
                await endStream(conversationId)
                api.notifyClient('chat', 'streamingEnded', { conversationId })
            }
        })()
    }

    // ============================================
    // === Routes ===
    // ============================================
    async function checkAccess(ctx) {
        const allowed = isAllowed(ctx)
        const isAdmin = getCurrentUsername(ctx) === 'admin'
        const models = (api.getConfig('modelList') || [])
            .filter(m => canUseModel(ctx, m))
            .map(m => ({
                id: m.id,
                label: m.label || m.id,
                isFree: !!m.isFree,
                supportsSearch: !!m.supportsSearch,
                loginOnly: !!m.loginOnly
            }))
        const defId = api.getConfig('defaultModelId')
        const defaultModelId = models.some(m => m.id === defId)
            ? defId
            : (models[0] && models[0].id) || null
        ctx.body = {
            allowed,
            isAdmin,
            isLoggedIn: isLoggedIn(ctx),
            defaultModelId,
            models,
            pageSize: api.getConfig('pageSize') || 200,
            ui: {
                enableStream: api.getConfig('enableStream') !== false,
                showReasoning: api.getConfig('showReasoning') !== false
            }
        }
        ctx.status = 200
    }

    async function listConversations(ctx) {
        if (!isAllowed(ctx)) { ctx.status = 403; return }
        const filterModelId = ctx.query?.modelId
        const idx = await loadIndex()
        let list = idx.conversations || []
        if (filterModelId) list = list.filter(c => c.modelId === filterModelId)
        ctx.body = { conversations: sortConversations(list) }
        ctx.status = 200
    }

    async function createConversation(ctx) {
        if (!isAllowed(ctx)) { ctx.status = 403; return }
        const body = ctx.state.params || ctx.request?.body || {}
        const modelId = body.modelId || api.getConfig('defaultModelId')
        const model = findModel(modelId, ctx)
        if (!model) {
            ctx.status = 500
            ctx.body = { error: 'No model configured.' }
            return
        }
        if (!canUseModel(ctx, model)) {
            ctx.status = 403
            ctx.body = { error: 'Model not allowed for this user' }
            return
        }
        const now = Date.now()
        const id = genId()
        const meta = {
            id,
            title: 'New chat',
            modelId: model.id,
            modelLabel: model.label || model.id,
            createdAt: now,
            updatedAt: now,
            lastActivity: now,
            starred: false,
            pairCount: 0
        }
        await saveMeta(meta)
        await fs.mkdir(pairsDir(id), { recursive: true }).catch(() => {})
        const idx = await loadIndex()
        idx.conversations.push(meta)
        await saveIndex(idx)

        api.notifyClient('chat', 'conversationCreated', { meta })
        ctx.body = meta
        ctx.status = 200
    }

    async function getConversation(ctx) {
        if (!isAllowed(ctx)) { ctx.status = 403; return }
        const id = ctx.query?.id
        if (!id) { ctx.status = 400; return }
        const meta = await loadMeta(id)
        if (!meta) { ctx.status = 404; return }

        await ensureMigrated(id)

        const totalPairs = (await listPairNumbers(id)).length
        const pageSize = parseInt(ctx.query?.limit, 10) || api.getConfig('pageSize') || 200
        let offset = parseInt(ctx.query?.offset, 10)
        if (isNaN(offset) || offset < 0) offset = 0
        const summary = ctx.query?.summary === '1'

        const nums = await listPairNumbers(id)
        const start = Math.max(0, nums.length - offset - pageSize)
        const end = Math.max(0, nums.length - offset)
        const slice = nums.slice(start, end)

        const pairs = []
        for (const n of slice) {
            const p = await loadPair(id, n)
            if (!p) continue
            if (summary) {
                const trunc = (s) => s ? (s.length > 200 ? s.slice(0, 200) + '…' : s) : s
                pairs.push({
                    q: p.q ? { role: 'user', content: trunc(p.q.content), ts: p.q.ts, failed: !!p.q.failed } : null,
                    a: p.a ? {
                        role: 'assistant',
                        content: trunc(p.a.content),
                        reasoning: undefined,
                        modelId: p.a.modelId,
                        modelLabel: p.a.modelLabel,
                        ts: p.a.ts
                    } : null,
                    ts: p.ts,
                    index: n,
                    truncated: true
                })
            } else {
                pairs.push({ ...p, index: n })
            }
        }

        ctx.body = {
            meta,
            pairs,
            hasMore: start > 0,
            offset,
            totalPairs,
            pageSize
        }
        ctx.status = 200
    }

    async function getPair(ctx) {
        if (!isAllowed(ctx)) { ctx.status = 403; return }
        const id = ctx.query?.id
        const n = parseInt(ctx.query?.n, 10)
        if (!id || !n) { ctx.status = 400; return }
        const pair = await loadPair(id, n)
        if (!pair) { ctx.status = 404; return }
        ctx.body = pair
        ctx.status = 200
    }

    async function getStreamState(ctx) {
        if (!isAllowed(ctx)) { ctx.status = 403; return }
        const id = ctx.query?.id
        if (!id) { ctx.status = 400; return }
        const st = activeStreams.get(id)
        if (st) {
            ctx.body = {
                conversationId: id,
                seq: st.seq,
                content: st.content,
                reasoning: st.reasoning || '',
                startedAt: st.startedAt,
                updatedAt: Date.now(),
                done: false
            }
            ctx.status = 200
            return
        }
        try {
            const raw = await fs.readFile(streamPath(id), 'utf-8')
            ctx.body = JSON.parse(raw)
        } catch {
            ctx.body = null
        }
        ctx.status = 200
    }

    async function searchAll(ctx) {
        if (!isAllowed(ctx)) { ctx.status = 403; return }
        const q = (ctx.query?.q || '').trim()
        if (!q) { ctx.body = { results: [] }; ctx.status = 200; return }
        const filterModelId = ctx.query?.modelId || null
        const lower = q.toLowerCase()

        const idx = await loadIndex()
        let list = idx.conversations || []
        if (filterModelId) list = list.filter(c => c.modelId === filterModelId)

        const results = []
        for (const conv of list) {
            await ensureMigrated(conv.id)
            const nums = await listPairNumbers(conv.id)
            let titleHit = (conv.title || '').toLowerCase().includes(lower)
            const matches = []
            let count = 0

            for (const n of nums) {
                const p = await loadPair(conv.id, n)
                if (!p) continue
                const checkText = (role, text, ts) => {
                    if (!text) return
                    const lt = text.toLowerCase()
                    let idx2 = lt.indexOf(lower)
                    while (idx2 !== -1) {
                        count++
                        if (matches.length < 20) {
                            const start = Math.max(0, idx2 - 30)
                            const end = Math.min(text.length, idx2 + q.length + 30)
                            matches.push({
                                pairIndex: n,
                                role,
                                ts,
                                snippet: (start > 0 ? '…' : '') + text.slice(start, end) +
                                    (end < text.length ? '…' : '')
                            })
                        }
                        idx2 = lt.indexOf(lower, idx2 + lower.length)
                    }
                }
                if (p.q) checkText('user', p.q.content, p.q.ts)
                if (p.a) checkText('assistant', p.a.content, p.a.ts)
            }

            if (titleHit || count > 0) {
                results.push({
                    convId: conv.id,
                    title: conv.title || 'Untitled',
                    starred: !!conv.starred,
                    lastActivity: conv.lastActivity || conv.updatedAt || conv.createdAt || 0,
                    titleHit,
                    count,
                    matches
                })
            }
        }

        results.sort((a, b) => {
            if (a.starred !== b.starred) return a.starred ? -1 : 1
            return b.lastActivity - a.lastActivity
        })

        ctx.body = { results }
        ctx.status = 200
    }

    async function deleteConversation(ctx) {
        if (!isAllowed(ctx)) { ctx.status = 403; return }
        const body = ctx.state.params || ctx.request?.body || {}
        if (!body.id) { ctx.status = 400; return }
        if (activeStreams.has(body.id)) {
            const st = activeStreams.get(body.id)
            if (st.flushTimer) clearTimeout(st.flushTimer)
            activeStreams.delete(body.id)
        }
        await fs.rm(streamPath(body.id), { force: true }).catch(() => {})
        await fs.rm(convDir(body.id), { recursive: true, force: true }).catch(() => {})
        // [CHANGED] 是否清历史备份可配置
        if (api.getConfig('backupPurgeOnDelete') === true) {
            await purgeBackupsOfConv(body.id)
        }
        const idx = await loadIndex()
        idx.conversations = idx.conversations.filter(c => c.id !== body.id)
        await saveIndex(idx)
        api.notifyClient('chat', 'conversationDeleted', { id: body.id })
        ctx.status = 200
        ctx.body = { ok: true }
    }

    async function renameConversation(ctx) {
        if (!isAllowed(ctx)) { ctx.status = 403; return }
        const body = ctx.state.params || ctx.request?.body || {}
        const { id, title } = body
        if (!id || title == null) { ctx.status = 400; return }
        const meta = await loadMeta(id)
        if (!meta) { ctx.status = 404; return }
        meta.title = sanitizeForDb(String(title).trim()).slice(0, 100) || 'Untitled'
        await touchMeta(meta, Date.now())
        api.notifyClient('chat', 'conversationRenamed', { id, title: meta.title, meta })
        ctx.status = 200
        ctx.body = { ok: true, meta }
    }

    async function toggleStar(ctx) {
        if (!isAllowed(ctx)) { ctx.status = 403; return }
        const body = ctx.state.params || ctx.request?.body || {}
        const { id } = body
        if (!id) { ctx.status = 400; return }
        const meta = await loadMeta(id)
        if (!meta) { ctx.status = 404; return }
        meta.starred = !meta.starred
        await touchMeta(meta, Date.now())
        api.notifyClient('chat', 'conversationStarred', { id, starred: !!meta.starred, meta })
        ctx.status = 200
        ctx.body = { ok: true, meta }
    }

    async function clearAll(ctx) {
        if (!isAllowed(ctx)) { ctx.status = 403; return }
        const body = ctx.state.params || ctx.request?.body || {}
        const filterModelId = body.modelId
        const idx = await loadIndex()
        let targets = idx.conversations
        if (filterModelId) targets = targets.filter(c => c.modelId === filterModelId)
        for (const c of targets) {
            if (activeStreams.has(c.id)) {
                const st = activeStreams.get(c.id)
                if (st.flushTimer) clearTimeout(st.flushTimer)
                activeStreams.delete(c.id)
            }
            await fs.rm(streamPath(c.id), { force: true }).catch(() => {})
            await fs.rm(convDir(c.id), { recursive: true, force: true }).catch(() => {})
            if (api.getConfig('backupPurgeOnDelete') === true) {
                await purgeBackupsOfConv(c.id)
            }
        }
        const targetIds = new Set(targets.map(c => c.id))
        idx.conversations = idx.conversations.filter(c => !targetIds.has(c.id))
        await saveIndex(idx)
        api.notifyClient('chat', 'allCleared', { modelId: filterModelId || null })
        ctx.status = 200
        ctx.body = { ok: true, deleted: targets.length }
    }

    // ============================================
    // === 发送消息 ===
    // ============================================
    async function sendMessage(ctx) {
        if (!isAllowed(ctx)) {
            ctx.status = 403
            ctx.body = { error: 'Access denied' }
            return
        }

        const body = ctx.state.params || ctx.request?.body || {}
        const { conversationId, content, enableSearch, modelId } = body

        if (!conversationId || !content || typeof content !== 'string') {
            ctx.status = 400
            ctx.body = { error: 'Missing conversationId or content' }
            return
        }
        if (activeStreams.has(conversationId)) {
            ctx.status = 409
            ctx.body = { error: 'This conversation is already generating a response' }
            return
        }

        const meta = await loadMeta(conversationId)
        if (!meta) { ctx.status = 404; ctx.body = { error: 'Conversation not found' }; return }
        await ensureMigrated(conversationId)

        const model = findModel(modelId || meta.modelId, ctx)
        if (!model) {
            ctx.status = 500
            ctx.body = { error: 'Model not configured: ' + (modelId || meta.modelId) }
            return
        }
        if (!canUseModel(ctx, model)) {
            ctx.status = 403
            ctx.body = { error: 'Model not allowed for this user' }
            return
        }

        const text = sanitizeForDb(content).trim()
        if (!text) { ctx.status = 400; ctx.body = { error: 'Empty content' }; return }
        if (text.length > 32000) { ctx.status = 400; ctx.body = { error: 'Message too long' }; return }

        const now = Date.now()
        const userMsg = { role: 'user', content: text, ts: now }
        const pairNum = await appendPair(conversationId, userMsg, null)

        if (meta.title === 'New chat') {
            meta.title = text.slice(0, 30) + (text.length > 30 ? '…' : '')
        }
        if (modelId && modelId !== meta.modelId) {
            meta.lastModelId = modelId
        }
        await touchMeta(meta, now)

        api.notifyClient('chat', 'userMessage', {
            conversationId,
            message: userMsg,
            meta,
            pairIndex: pairNum
        })

        startStream(conversationId)
        api.notifyClient('chat', 'streamingStarted', { conversationId })

        await runCompletion(ctx, conversationId, pairNum, text, { enableSearch, modelId })
    }

    // ============================================
    // === 重试 ===
    // ============================================
    async function retryMessage(ctx) {
        if (!isAllowed(ctx)) { ctx.status = 403; ctx.body = { error: 'Access denied' }; return }
        const body = ctx.state.params || ctx.request?.body || {}
        const { conversationId, enableSearch, modelId } = body
        const n = parseInt(body.pairIndex, 10)
        if (!conversationId || !n) { ctx.status = 400; ctx.body = { error: 'Missing conversationId or pairIndex' }; return }
        if (activeStreams.has(conversationId)) {
            ctx.status = 409; ctx.body = { error: 'This conversation is already generating a response' }; return
        }

        const meta = await loadMeta(conversationId)
        if (!meta) { ctx.status = 404; ctx.body = { error: 'Conversation not found' }; return }

        const pair = await loadPair(conversationId, n)
        if (!pair || !pair.q) { ctx.status = 404; ctx.body = { error: 'Pair not found' }; return }

        const text = sanitizeForDb(pair.q.content || '').trim()
        if (!text) { ctx.status = 400; ctx.body = { error: 'Empty content' }; return }

        await clearPairFailed(conversationId, n)
        const cleared = await loadPair(conversationId, n)
        cleared.a = null
        await savePair(conversationId, n, cleared)

        api.notifyClient('chat', 'userMessageRetried', {
            conversationId, pairIndex: n, ts: Date.now()
        })

        startStream(conversationId)
        api.notifyClient('chat', 'streamingStarted', { conversationId })

        await runCompletion(ctx, conversationId, n, text, { enableSearch: !!enableSearch, modelId })
    }

    // ============================================
    // === 重新输出 ===
    // ============================================
    async function regenerate(ctx) {
        if (!isAllowed(ctx)) { ctx.status = 403; ctx.body = { error: 'Access denied' }; return }
        const body = ctx.state.params || ctx.request?.body || {}
        const { conversationId, enableSearch, modelId } = body
        const n = parseInt(body.pairIndex, 10)
        if (!conversationId || !n) {
            ctx.status = 400; ctx.body = { error: 'Missing conversationId/pairIndex' }; return
        }
        if (activeStreams.has(conversationId)) {
            ctx.status = 409; ctx.body = { error: 'This conversation is already generating a response' }; return
        }

        const pair = await loadPair(conversationId, n)
        if (!pair || !pair.q) { ctx.status = 404; ctx.body = { error: 'Pair not found' }; return }

        const text = sanitizeForDb(pair.q.content || '').trim()
        if (!text) { ctx.status = 400; ctx.body = { error: 'Empty content' }; return }

        pair.a = null
        delete pair.error
        if (pair.q) delete pair.q.failed
        await savePair(conversationId, n, pair)

        api.notifyClient('chat', 'assistantRegenerating', {
            conversationId, pairIndex: n, ts: Date.now()
        })

        startStream(conversationId)
        api.notifyClient('chat', 'streamingStarted', { conversationId })

        await runCompletion(ctx, conversationId, n, text, { enableSearch, modelId })
    }

    // ============================================
    // === 编辑并重发 ===
    // ============================================
    async function editAndResend(ctx) {
        if (!isAllowed(ctx)) { ctx.status = 403; ctx.body = { error: 'Access denied' }; return }
        const body = ctx.state.params || ctx.request?.body || {}
        const { conversationId, content, enableSearch, modelId } = body
        const n = parseInt(body.pairIndex, 10)
        if (!conversationId || !n || typeof content !== 'string') {
            ctx.status = 400; ctx.body = { error: 'Missing conversationId/pairIndex/content' }; return
        }
        if (activeStreams.has(conversationId)) {
            ctx.status = 409; ctx.body = { error: 'This conversation is already generating a response' }; return
        }

        const meta = await loadMeta(conversationId)
        if (!meta) { ctx.status = 404; ctx.body = { error: 'Conversation not found' }; return }

        const text = sanitizeForDb(content).trim()
        if (!text) { ctx.status = 400; ctx.body = { error: 'Empty content' }; return }
        if (text.length > 32000) { ctx.status = 400; ctx.body = { error: 'Message too long' }; return }

        const nums = await listPairNumbers(conversationId)
        for (const k of nums) {
            if (k >= n) {
                await fs.rm(pairPath(conversationId, k), { force: true }).catch(() => {})
            }
        }

        const now = Date.now()
        const pair = { q: { role: 'user', content: text, ts: now }, a: null, ts: now }
        await savePair(conversationId, n, pair)
        await updatePairCount(conversationId)
        await touchMeta(meta, now)

        api.notifyClient('chat', 'userMessageEdited', {
            conversationId, pairIndex: n, content: text, ts: now, meta
        })
        api.notifyClient('chat', 'pairsTruncated', {
            conversationId, fromIndex: n
        })

        startStream(conversationId)
        api.notifyClient('chat', 'streamingStarted', { conversationId })

        await runCompletion(ctx, conversationId, n, text, { enableSearch, modelId })
    }

    // ============================================
    // === 删除单个 pair ===
    // ============================================
    async function deletePair(ctx) {
        if (!isAllowed(ctx)) { ctx.status = 403; return }
        const body = ctx.state.params || ctx.request?.body || {}
        const { conversationId } = body
        const n = parseInt(body.pairIndex, 10)
        if (!conversationId || !n) { ctx.status = 400; return }
        if (activeStreams.has(conversationId)) {
            ctx.status = 409; ctx.body = { error: 'Generating, try later' }; return
        }
        const pair = await loadPair(conversationId, n)
        if (!pair) { ctx.status = 404; return }

        const withUser = body.withUser !== false
        if (withUser) {
            await fs.rm(pairPath(conversationId, n), { force: true }).catch(() => {})
        } else {
            pair.a = null
            delete pair.error
            if (pair.q) delete pair.q.failed
            await savePair(conversationId, n, pair)
        }
        await updatePairCount(conversationId)
        const meta = await loadMeta(conversationId)
        if (meta) await touchMeta(meta, Date.now())

        api.notifyClient('chat', 'pairDeleted', {
            conversationId, pairIndex: n, withUser, meta
        })
        ctx.status = 200
        ctx.body = { ok: true }
    }

    return {
        async middleware(ctx) {
            const p = ctx.path
            const m = ctx.method.toUpperCase()
            if (p.indexOf(API_BASE) !== 0) return

            if (p === API_BASE + 'check' && m === 'GET') { await checkAccess(ctx); return }
            if (p === API_BASE + 'conversations' && m === 'GET') { await listConversations(ctx); return }
            if (p === API_BASE + 'conversation' && m === 'POST') { await createConversation(ctx); return }
            if (p === API_BASE + 'conversation' && m === 'GET') { await getConversation(ctx); return }
            if (p === API_BASE + 'pair' && m === 'GET') { await getPair(ctx); return }
            if (p === API_BASE + 'conversation/delete' && m === 'POST') { await deleteConversation(ctx); return }
            if (p === API_BASE + 'conversation/rename' && m === 'POST') { await renameConversation(ctx); return }
            if (p === API_BASE + 'conversation/toggle-star' && m === 'POST') { await toggleStar(ctx); return }
            if (p === API_BASE + 'conversation/clear-all' && m === 'POST') { await clearAll(ctx); return }
            if (p === API_BASE + 'stream-state' && m === 'GET') { await getStreamState(ctx); return }
            if (p === API_BASE + 'search' && m === 'GET') { await searchAll(ctx); return }
            if (p === API_BASE + 'send' && m === 'POST') { await sendMessage(ctx); return }
            if (p === API_BASE + 'retry' && m === 'POST') { await retryMessage(ctx); return }
            if (p === API_BASE + 'regenerate' && m === 'POST') { await regenerate(ctx); return }
            if (p === API_BASE + 'edit-resend' && m === 'POST') { await editAndResend(ctx); return }
            if (p === API_BASE + 'pair/delete' && m === 'POST') { await deletePair(ctx); return }
        }
    }
}