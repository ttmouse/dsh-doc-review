/* @caihua/dsh-doc-review — 浏览器半边（手写 __ModuleLoader__ bundle，零构建）
 *
 * 注册面：conversation.view ——「批注」会话页，与「对话轨迹」「上下文」并列。
 * 交互：左边选文档 → 中间渲染正文（划词）→ 右边写意见；意见落盘到
 *       <文档目录>/.dsh-review/<文件名>.review.json，Agent 用 doc_review_* 工具读写。
 * 一键「交给 AI 改稿」：直接往当前会话排队一条消息（ctx.remote.session.prompt）。
 */
console.log('[dsh-doc-review] client v0.7.1')
window.__ModuleLoader__.load({
  id: '@caihua/dsh-doc-review',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useLayoutEffect = React.useLayoutEffect || React.useEffect
    var useRef = React.useRef
    var useMemo = React.useMemo

    var STYLE_ID = 'dsh-doc-review-style'

    // 文档范围：相关（默认）＝本会话产出的文档 + 本项目其它会话碰过的文档；工作区＝会话 cwd 全量；全库＝配置 roots
    var SCOPE_LABEL = { related: '相关', session: '本会话', workspace: '工作区', vault: '全库' }
    var SCOPE_TITLE = {
      related: '本会话产出/编辑过的文档 + 本项目其它会话碰过的文档（不是文件夹全量）',
      workspace: '这个会话工作目录下的全部 md',
      vault: '配置根目录的全库',
    }
    var SCOPE_ORDER = ['related', 'workspace', 'vault']

    var API = {
      hello: '/api/dsh-doc-review/hello',
      state: '/api/dsh-doc-review/state',
      docs: '/api/dsh-doc-review/docs',
      doc: '/api/dsh-doc-review/doc',
      docWrite: '/api/dsh-doc-review/doc-write',
      save: '/api/dsh-doc-review/save',
      snotes: '/api/dsh-doc-review/snotes',
      snote: '/api/dsh-doc-review/snote',
      props: '/api/dsh-doc-review/props',
      prop: '/api/dsh-doc-review/prop',
    }

    // apply 作用域内的宿主服务（组件通过闭包读取，重挂不丢）
    var sessions = null
    var remoteFace = null
    var convFace = null            // conversation 服务（输入框 facade），拿不到就优雅降级
    var ctxRef = null              // apply 时的 ctx：用于惰性重取 conversation（该服务可能后注册）

    /* ── 会话批注 → 聊天输入框（攒批发送）──────────────────────────────
     * 用户在对话里划词写批注，保存后直接追加到当前会话的输入框草稿里，攒够多条一次发出。
     * 依据：GitHub pending review 的官方理由就是"防止 AI 在你没写完之前按单条开工"；
     * Claude Artifacts 也是"多处攒批 + 一次应用"。
     * 输入框 facade：ctx.get('conversation').input.for(sessions.scope(sessionId))，
     * 有 state.getSnapshot().draft / setDraft(text) / focus()。
     * 用 ctx.get(...) 而不是声明依赖：拿不到就只落盘、不碰输入框，绝不让插件挂掉
     * （v0.5.0 那次客户端条目 failed 导致 web boot 崩溃的教训）。 */
    var ANNO_HEAD = '【批注 · 请逐条回应】'
    var ANNO_TAIL = '【批注结束】'
    var SELECTION_REF_SOURCE = 'dsh-doc-review-selection'

    function encodeSelectionReference(payload) {
      return 'v1:' + encodeURIComponent(JSON.stringify(payload))
    }

    function decodeSelectionReference(ref) {
      try {
        if (String(ref).indexOf('v1:') !== 0) return null
        var value = JSON.parse(decodeURIComponent(String(ref).slice(3)))
        if (!value || typeof value.text !== 'string') return null
        return value
      } catch (_) { return null }
    }

    function serializeSelectionReference(ref, signal) {
      if (signal && signal.aborted) return Promise.reject(new Error('selection reference serialization aborted'))
      var value = decodeSelectionReference(ref)
      if (!value) return Promise.reject(new Error('selection reference is unavailable'))
      var source = value.sessionId ? '当前对话 ' + value.sessionId : '当前对话'
      // Prefix every quoted line so delimiter text inside a selection stays literal.
      return Promise.resolve('【引用自' + source + '的选中文字 · v1】\n' + value.text.split('\n').map(function (line) { return '> ' + line }).join('\n') + '\n【引用结束】')
    }

    function selectionReference(text, sessionId) {
      var quote = String(text || '').trim()
      if (!quote) return null
      return {
        source: SELECTION_REF_SOURCE,
        ref: encodeSelectionReference({ text: quote, sessionId: sessionId || '' }),
        label: '引用：' + quote.replace(/\s+/g, ' ').slice(0, 24) + (quote.length > 24 ? '…' : ''),
        appearance: 'session',
        clipboardText: quote,
      }
    }

    // The desktop app owns its own bundled primitives. Render persisted quotes
    // through the documented keyed message slot instead of requiring a rebuilt app.
    function selectionQuoteParts(text) {
      var parts = [], cursor = 0
      var pattern = /【引用自([^\n]*?)的选中文字( · v1)?】\n([\s\S]*?)\n【引用结束】/g
      var match
      while ((match = pattern.exec(text))) {
        var body = match[3]
        if (match[2] && !body.split('\n').every(function (line) { return line.indexOf('> ') === 0 })) continue
        if (match.index > cursor) parts.push({ text: text.slice(cursor, match.index) })
        parts.push({ quote: match[2] ? body.replace(/^> /gm, '') : body, source: match[1] })
        cursor = pattern.lastIndex
      }
      if (cursor < text.length) parts.push({ text: text.slice(cursor) })
      return parts
    }

    function selectionMessageRenderer(Original) {
      function SelectionMessage(props) {
        var data = props && props.node && props.node.data
        var content = data && data.content
        var text = Array.isArray(content) ? content.filter(function (part) { return part.type === 'text' }).map(function (part) { return part.text }).join('') : ''
        var parts = selectionQuoteParts(text)
        // Keep one component identity and hook order while messages update.
        var copiedState = useState(false), copied = copiedState[0], setCopied = copiedState[1]
        useEffect(function () { setCopied(false) }, [text])
        if (!parts.some(function (part) { return part.quote !== undefined })) return h(Original, props)
        var ui = require('@deepseek-ai/dsh-client-ui-primitives')
        var images = content.filter(function (part) { return part.type === 'image' })
        var extra = content.filter(function (part) { return part.type !== 'text' && part.type !== 'image' })
        var label = copied ? props.t('copied') : props.t('copy')
        return h('div', { className: 'dr-sent-reference', 'data-doc-review-reference-message': true },
          images.length ? props.renderMessageImages({ images: images.map(function (part) { return { attachment: part.attachment } }), align: 'end', compact: images.length > 1 }) : null,
          h('div', { className: 'dr-sent-reference-bubble' },
            parts.map(function (part, index) {
              if (part.quote === undefined) return h(React.Fragment, { key: index }, ui.projectUserText(part.text, data.referenceLabels || [], data.skillNames || [], 'skill', { openFile: props.openFile, openSkill: props.openSkill }))
              var compact = part.quote.replace(/\s+/g, ' ')
              return h('details', { key: index, className: 'dr-sent-reference-chip', 'data-ref-chip': 'quote' },
                h('summary', { title: part.source }, pmIcon('comment'), '引用：' + compact.slice(0, 24) + (compact.length > 24 ? '…' : '')),
                h('div', { className: 'dr-sent-reference-source' }, part.source),
                h('blockquote', null, part.quote))
            }),
            extra.map(function (part, index) {
              if (part.type === 'file' && part.attachment) return h('div', { key: 'extra-' + index, className: 'dr-sent-reference-file' }, h(ui.FileTypeIcon, { path: part.attachment.name }), part.attachment.name, ' · ' + ui.fileSizeText(part.attachment.bytes))
              return h(ui.JsonBlock, { key: 'extra-' + index, label: props.t('message.extraBlock'), payload: part, truncatedLabel: function (total) { return props.t('json.truncated', { total: total }) } })
            })),
          data.referenceLabels && data.referenceLabels.length ? h('div', { className: 'dr-sent-reference-source' }, props.t('message.referenceSummary', { labels: data.referenceLabels.join(props.t('message.referenceSeparator')) })) : null,
          h('div', { className: 'dr-sent-reference-actions' },
            typeof data.time === 'number' ? h('time', { dateTime: new Date(data.time).toISOString(), title: new Date(data.time).toLocaleString() }, new Date(data.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null,
            h('button', { type: 'button', title: label, 'aria-label': label, onClick: function () { ui.writeClipboard(text).then(function (ok) { if (ok) setCopied(true) }) } }, h(copied ? ui.IconCheckOutlineRegular : ui.IconCopyOutlineRegular))))
      }
      SelectionMessage.docReviewSelectionRenderer = true
      return SelectionMessage
    }

    function registerSelectionMessages(slots) {
      return slots.inject('conversation.chat.node', function () {
        var installed = {}, closed = false
        function sync() {
          if (closed) return
          var entries = slots.entries('conversation.chat.node')
          ;['user', 'steering'].forEach(function (key) {
            var original = entries.find(function (entry) { return entry.options.key === key && !entry.component.docReviewSelectionRenderer && (!slots.isLive || slots.isLive(entry)) })
            if (installed[key] && installed[key].original === original) return
            if (installed[key]) { installed[key].dispose(); delete installed[key] }
            if (!original) return
            var options = { name: 'conversation.chat.node', key: key, priority: (original.options.priority || 0) - 1 }
            if (original.locale) options.locale = original.locale
            if (original.inject) options.inject = original.inject
            if (original.store) options.store = original.store
            if (original.children) options.children = original.children
            installed[key] = { original: original, dispose: slots.register(options, selectionMessageRenderer(original.component)) }
          })
        }
        var unsubscribe = slots.subscribe('conversation.chat.node', sync)
        sync()
        return function () {
          closed = true
          unsubscribe()
          Object.keys(installed).forEach(function (key) { installed[key].dispose() })
        }
      })
    }

    function composerShell() {
      try {
        // 惰性重取：conversation 可能比本插件晚注册，apply 时拿到 null 不等于一直没有
        if (!convFace && ctxRef) {
          try { convFace = (typeof ctxRef.get === 'function') ? (ctxRef.get('conversation') || null) : (ctxRef.conversation || null) } catch (_) { convFace = null }
        }
        if (!convFace || !convFace.input || !sessions || !sessions.scope) return null
        var sid = currentSessionId()
        if (!sid) return null
        var scoped = sessions.scope(sid)
        if (scoped === undefined || scoped === null) return null
        return convFace.input.for(scoped)
      } catch (_) { return null }
    }

    /** 正文角标的悬浮说明：已处理的要把"当时的意见 + 结论"一起带出来。
     *  依据：Google Docs / Confluence / Dropbox 的已解决评论一律离开正文、只能去 history 找，
     *  是 9 家文档产品的共同缺陷；我们保留锚点，就要让人一眼看出它是已处理、并召回原因。 */
    function markTitle(c, n) {
      var pend = (c.status || 'pending') === 'pending'
      if (pend) return '#' + n + ' ' + (c.note || '')
      return '#' + n + ' 已处理 · 当时的意见：' + (c.note || '') + (c.reply ? ' · 结论：' + c.reply : '')
    }

    /** 把草稿里已有的批注块摘掉，只留用户自己写的话 */
    function stripAnnoBlock(text) {
      var s = String(text == null ? '' : text)
      var i = s.indexOf(ANNO_HEAD)
      if (i < 0) return s
      var j = s.indexOf(ANNO_TAIL, i)
      var end = j < 0 ? s.length : j + ANNO_TAIL.length
      var before = s.slice(0, i).replace(/[\s\u3000]+$/, '')
      var after = s.slice(end).replace(/^[\s\u3000]+/, '')
      if (before && after) return before + '\n\n' + after
      return before || after
    }

    /** 按当前待处理批注重建批注块（每次保存都整体重算，不会越攒越乱）。
     *  2026-10-12 修：**已经随消息发出过的批注不再进块**（sent_at）。
     *  修前的问题：块只按 status 过滤，而批注要等 AI 调 session_note_resolve 才会变 resolved；
     *  AI 没结清时，你每写一条新的，块里就把前面所有没结清的都带上——"上一次批注的内容又回来了"。 */
    function buildAnnoBlock(notes) {
      var list = (notes || []).filter(function (n) { return (n.status || 'pending') === 'pending' && !n.sent_at })
      if (!list.length) return ''
      var L = [ANNO_HEAD + '共 ' + list.length + ' 条（我对着上面的对话内容写的）']
      list.forEach(function (n, i) {
        L.push((i + 1) + '. 原文：「' + String(n.quote || '').replace(/\s+/g, ' ').slice(0, 120) + '」')
        L.push('   意见：' + String(n.note || '').replace(/\s+/g, ' ').slice(0, 200))
      })
      L.push(ANNO_TAIL)
      return L.join('\n')
    }

    /** 把批注块同步进输入框草稿；返回 'ok' | 'empty' | 'command' | 'unavailable'
     *  已发送过的批注（sent_at / 已处理）不会出现在块里；用户自己的文字原样保留在块下方。 */
    function syncDraftToComposer(notes) {
      var shell = composerShell()
      if (!shell || !shell.state || !shell.setDraft) return 'unavailable'
      try {
        var draft = (shell.state.getSnapshot() || {}).draft || ''
        var mine = stripAnnoBlock(draft)
        if (/^\s*\//.test(mine)) return 'command'      // 斜杠命令不拼块，否则命令失效
        var block = buildAnnoBlock(notes)
        if (!block) { shell.setDraft(mine); stopWatchingDraft(); return 'empty' }
        shell.setDraft(block + (mine ? '\n\n' + mine : ''))
        watchDraftSent((notes || []).filter(function (n) {
          return (n.status || 'pending') === 'pending' && !n.sent_at
        }).map(function (n) { return n.id }))
        try { if (typeof shell.focus === 'function') shell.focus() } catch (_) {}
        return 'ok'
      } catch (_) { return 'unavailable' }
    }

    /* 用户把消息发出去以后，块就从输入框里消失了。这里盯着草稿：
     * 块一旦不在草稿里（回车发送、点发送按钮、或手动删掉整块），就把这批批注标成 sent_at，
     * 于是下一条批注的块里不会再带上它们。纯客户端探测，不依赖拦截回车，各种发送路径都能覆盖。 */
    var blockIdsRef = []
    var draftWatchTimer = null

    function stopWatchingDraft() {
      blockIdsRef = []
      if (draftWatchTimer) { clearInterval(draftWatchTimer); draftWatchTimer = null }
    }

    function watchDraftSent(ids) {
      blockIdsRef = ids || []
      if (draftWatchTimer || !blockIdsRef.length) return
      draftWatchTimer = setInterval(function () {
        var shell = null
        try { shell = composerShell() } catch (_) { shell = null }
        if (!shell || !shell.state) return
        var draft = ''
        try { draft = (shell.state.getSnapshot() || {}).draft || '' } catch (_) { return }
        if (draft.indexOf(ANNO_HEAD) >= 0) return          // 块还在输入框里，没发出去
        var ids2 = blockIdsRef.slice()
        stopWatchingDraft()
        var sid = currentSessionId()
        if (!sid || !ids2.length) return
        apiPost(API.snote, { sessionId: sid, action: 'sent', ids: ids2 }).then(function () {
          try { window.dispatchEvent(new CustomEvent('dsh-doc-review:snotes')) } catch (e) {}
        }).catch(function () {})
      }, 1500)
    }

    /* 当前会话 id：apply 与各组件共用。
     * 2026-10-11 修 v0.5.0 启动崩溃：这个函数原先只定义在 DocReviewView 内部，
     * apply 里 `apiPost(API.hello, { sessionId: currentSessionId() })` 够不到它，
     * 抛 ReferenceError ⇒ 客户端条目 failed ⇒ 整个 web boot 失败（DSH 连崩三次后
     * 用安全模式重写了 profile 配置）。提到 factory 作用域后两处都能用。 */
    function currentSessionId() {
      try {
        if (!sessions || !sessions.list) return ''
        var snap = sessions.list.getSnapshot()
        if (!snap) return ''
        if (snap.current) return String(snap.current)
        var ids = (snap.ids && snap.ids.length) ? snap.ids : Object.keys(snap.byId || {})
        var best = '', bestAt = -1
        for (var i = 0; i < ids.length; i++) {
          var row = snap.byId && snap.byId[ids[i]]
          if (!row || !row.retainedBy || !(row.retainedBy.mainView > 0)) continue
          var at = Number(row.updatedAt) || 0
          if (at > bestAt) { bestAt = at; best = String(ids[i]) }
        }
        return best
      } catch (e) { return '' }
    }

    /* ────────────────────────── 基础工具 ────────────────────────── */

    function apiGet(u, params) {
      var qs = ''
      if (params) {
        var parts = []
        Object.keys(params).forEach(function (k) {
          if (params[k] !== undefined && params[k] !== null && params[k] !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
        })
        if (parts.length) qs = '?' + parts.join('&')
      }
      return fetch(u + qs, { credentials: 'same-origin' }).then(function (r) { return r.json() })
    }

    function apiPost(u, body) {
      return fetch(u, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json() })
    }

    function uuid() {
      try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID() } catch (e) {}
      return 'dr-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    }

    function tz() {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined } catch (e) { return undefined }
    }

    function dirnameOf(p) {
      var i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
      return i < 0 ? '' : p.slice(0, i)
    }

    function basenameOf(p) {
      var i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
      return i < 0 ? p : p.slice(i + 1)
    }

    function reviewPathOf(p) {
      return dirnameOf(p) + '\\.dsh-review\\' + basenameOf(p) + '.review.json'
    }

    function nowStamp() {
      var d = new Date()
      var p = function (n) { return String(n).padStart(2, '0') }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    /** 划词弹框的落点：默认贴选区**上方**（下沿离选区上沿 GAP），上方不够放才落到下方；
     *  横向与选区左沿对齐并夹在视口内。核心诉求是绝不压住选中的文字。
     *  抽成纯函数是为了能被烟测直接断言（界面没法自动点）。 */
    function floatPlacement(rect, vw, vh) {
      var BOX_W = Math.min(430, Math.max(280, vw - 32)), GAP = 10, BOX_H = 40
      var left = Math.min(Math.max(rect.left, 16), Math.max(16, vw - BOX_W - 16))
      if (rect.top > BOX_H + GAP) {
        return { above: true, left: left, bottom: Math.max(8, vh - rect.top + GAP), top: null }
      }
      return { above: false, left: left, top: Math.min(rect.bottom + GAP, Math.max(8, vh - BOX_H - 8)), bottom: null }
    }

    /** 相对时间，粒度对齐宿主会话列表的读法：刚刚 → N分钟 → N小时 → 昨天 → MM-DD → YYYY-MM-DD。
     * 不再带「今天 16:20」这种钟点——参考图（宿主侧栏）里时间只到「12小时」这个粒度，
     * 钟点在「找文件」这个场景里没有价值，只把行撑宽。 */
    function relTime(ms) {
      if (!ms) return ''
      var d = new Date(ms), now = new Date()
      var diff = now.getTime() - ms
      var p = function (n) { return String(n).padStart(2, '0') }
      if (diff < 60000) return '刚刚'
      if (diff < 3600000) return Math.floor(diff / 60000) + '分钟'
      if (diff < 86400000) return Math.floor(diff / 3600000) + '小时'
      var same = function (a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate() }
      if (same(d, new Date(now.getTime() - 86400000))) return '昨天'
      if (d.getFullYear() === now.getFullYear()) return p(d.getMonth() + 1) + '-' + p(d.getDate())
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    }

    function newId() { return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6) }

    /* ─────────────── Feishu-style comment helpers (pure; covered by test/client-helpers.mjs) ─────────────── */

    /** Platform sniff: Mac shows ⌘, everything else Ctrl. */
    function isMacPlatform(nav) {
      if (!nav) return false
      var p = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || ''
      return /mac|iphone|ipad|ipod/i.test(String(p))
    }

    /** 'Mod+Shift+M' → '⇧⌘M' on Mac (Apple modifier order), 'Ctrl+Shift+M' elsewhere. */
    function shortcutLabel(combo, mac) {
      var parts = String(combo || '').split('+').filter(Boolean)
      var key = parts.pop() || ''
      var mods = parts.map(function (m) { return m.toLowerCase() })
      if (!mac) {
        var names = { mod: 'Ctrl', ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt' }
        return mods.map(function (m) { return names[m] || m }).concat([key]).join('+')
      }
      var sym = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘' }
      var out = ''
      ;['ctrl', 'alt', 'shift', 'mod'].forEach(function (m) { if (mods.indexOf(m) >= 0) out += sym[m] })
      return out + key
    }

    /** Drop every whitespace char, remembering where each kept char came from. */
    function squeeze(s) {
      var out = '', map = []
      for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i)
        if (/\s/.test(ch)) continue
        out += ch; map.push(i)
      }
      return { text: out, map: map }
    }

    /** Quote written against Markdown source (agent tools) → the text the reader actually sees. */
    function plainQuote(q) {
      return String(q || '')
        .replace(/^\s*(#{1,6}|>|[-*+]|\d{1,3}[.)])\s+/gm, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\*\*|__|`/g, '')
    }

    /** Find a saved quote inside rendered text: exact → whitespace-insensitive → Markdown-stripped.
     *  Returns { start, end } offsets into `text`, or null (the anchor is lost; never guess). */
    function locateQuote(text, quote) {
      text = String(text || ''); quote = String(quote || '')
      if (!text || !quote.trim()) return null
      var i = text.indexOf(quote)
      if (i >= 0) return { start: i, end: i + quote.length }
      var t = squeeze(text)
      var tries = [quote, plainQuote(quote)]
      for (var k = 0; k < tries.length; k++) {
        var q = squeeze(tries[k]).text
        if (!q) continue
        var j = t.text.indexOf(q)
        if (j >= 0) return { start: t.map[j], end: t.map[j + q.length - 1] + 1 }
      }
      return null
    }

    /** Flat text offset → { index, offset } across consecutive text-node lengths.
     *  preferEnd keeps an offset sitting on a node boundary inside the earlier node (Range end). */
    function offsetInNodes(lengths, offset, preferEnd) {
      if (!lengths || !lengths.length) return null
      var acc = 0
      for (var i = 0; i < lengths.length; i++) {
        var len = lengths[i]
        if (offset < acc + len || (preferEnd && offset === acc + len)) return { index: i, offset: offset - acc }
        acc += len
      }
      return { index: lengths.length - 1, offset: lengths[lengths.length - 1] }
    }

    /** Scroll delta that moves an item (viewport top + height) to `want`, kept inside [viewTop, viewBottom].
     *  Positive = scroll down. Used to line a card up with its anchor and vice versa. */
    function alignDelta(itemTop, itemHeight, want, viewTop, viewBottom) {
      var pad = 8
      var room = Math.max(0, viewBottom - viewTop - 2 * pad)
      var target = Math.max(viewTop + pad, Math.min(want, viewBottom - pad - Math.min(itemHeight, room)))
      return itemTop - target
    }

    /** Reply thread of a comment; legacy single `reply` only shows when `replies` is empty. */
    function threadOf(c) {
      var list = (c && Array.isArray(c.replies))
        ? c.replies.filter(function (r) { return r && String(r.text || '').trim() })
        : []
      if (list.length) return list
      if (c && c.reply) return [{ id: 'r_' + (c.id || 'x') + '_legacy', author: 'AI', role: 'agent', text: String(c.reply), createdAt: c.resolvedAt || '' }]
      return []
    }

    /** 'YYYY-MM-DD HH:mm' (nowStamp) or ISO → relTime; unparsable strings pass through. */
    function whenText(s) {
      if (!s) return ''
      var ms = typeof s === 'number' ? s : Date.parse(String(s).replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2'))
      return (isFinite(ms) && ms > 0) ? relTime(ms) : String(s)
    }

    var IS_MAC = isMacPlatform(typeof navigator !== 'undefined' ? navigator : null)
    function kbd(combo) { return shortcutLabel(combo, IS_MAC) }

    /* ─────────────── Feishu-style presentation helpers ─────────────── */

    /** Short relative time like Feishu: 刚刚 / n 分钟前 / n 小时前 / 昨天 HH:mm / 今年 M月D日 / YYYY年M月D日. */
    function timeAgo(ms) {
      if (!ms) return ''
      var d = new Date(ms), now = new Date()
      var diff = Math.max(0, now.getTime() - ms)
      var p = function (n) { return String(n).padStart(2, '0') }
      var hm = p(d.getHours()) + ':' + p(d.getMinutes())
      if (diff < 60 * 1000) return '刚刚'
      if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前'
      if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前'
      var yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      var sameDay = function (a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate() }
      if (sameDay(d, yest)) return '昨天 ' + hm
      if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm
      return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'
    }

    /** Feishu-ish avatar palette; pick by hashing the author name. */
    var AVATAR_COLORS = ['#3370FF', '#00B4C1', '#34C259', '#FF9A00', '#8F4DFF', '#F55A4E', '#00BF7F', '#FF5C33']
    function avatarColor(name) {
      var s = String(name || '')
      var h = 0
      for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
      return AVATAR_COLORS[h % AVATAR_COLORS.length]
    }

    /** Chinese names show their first char inside the avatar circle. */
    function avatarName(name) {
      var s = String(name || '').trim()
      if (!s) return '?'
      if (/[\u4e00-\u9fa5]/.test(s)) return s.charAt(0)
      var words = s.split(/\s+/).filter(Boolean)
      if (words.length > 1) return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase()
      return s.slice(0, 2).toUpperCase()
    }

    /** Round avatar chip. */
    function avatarNode(name, size) {
      var s = String(name || '').trim() || '匿名'
      var px = size || 22
      return h('span', {
        className: 'dr-avatar', title: s, 'aria-hidden': true,
        style: { width: px + 'px', height: px + 'px', background: avatarColor(s), fontSize: Math.max(10, Math.round(px * 0.46)) + 'px' },
      }, avatarName(s))
    }

    function reducedMotion() {
      try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) } catch (e) { return false }
    }
    function scrollBehavior() { return reducedMotion() ? 'auto' : 'smooth' }

    function hlSupported() {
      return typeof Highlight !== 'undefined' && !!(window.CSS && CSS.highlights)
    }

    /* Text nodes of rendered blocks overlapping source lines [ls, le] (ls = 0 → whole doc).
       Inline proposal boxes are UI, not document text, so they are skipped. */
    function blockTextNodes(root, ls, le) {
      var out = []
      if (!root) return out
      var blocks = root.querySelectorAll('.dr-block[data-ls]')
      for (var i = 0; i < blocks.length; i++) {
        var s = Number(blocks[i].getAttribute('data-ls')), e = Number(blocks[i].getAttribute('data-le'))
        if (ls && (e < ls || s > le)) continue
        var w = document.createTreeWalker(blocks[i], NodeFilter.SHOW_TEXT, null)
        var n
        while ((n = w.nextNode())) {
          if (!n.nodeValue) continue
          var p = n.parentNode
          if (p && p.closest && p.closest('.dr-inline-prop')) continue
          out.push(n)
        }
      }
      return out
    }

    /** DOM Range covering exactly the quoted characters (lines first, then whole doc); null when lost. */
    function rangeForQuote(root, c) {
      if (!root || !c || !c.quote || c.anchored === false) return null
      var ls = Number(c.lineStart) || 0, le = Number(c.lineEnd) || ls
      var scopes = ls ? [[ls, le], [0, 0]] : [[0, 0]]
      for (var k = 0; k < scopes.length; k++) {
        var nodes = blockTextNodes(root, scopes[k][0], scopes[k][1])
        if (!nodes.length) continue
        var text = '', lens = []
        for (var i = 0; i < nodes.length; i++) { text += nodes[i].nodeValue; lens.push(nodes[i].nodeValue.length) }
        var hit = locateQuote(text, c.quote)
        if (!hit) continue
        var a = offsetInNodes(lens, hit.start, false), b = offsetInNodes(lens, hit.end, true)
        if (!a || !b) continue
        var r = document.createRange()
        r.setStart(nodes[a.index], a.offset)
        r.setEnd(nodes[b.index], b.offset)
        return r
      }
      return null
    }

    /* ────────────────────── 失锚重定位（锚点永远打在 .md 源文本上） ──────────────────────
     * 照 MRSF §7.4 四步：精确匹配 → 多命中按旧行号就近消歧 → 空白归一化再匹配 → 都失败标 orphan
     * 但**绝不静默删除**批注。重锚只改行列与 anchored 标记，selected_text（quote）永不改。
     */

    function offsetToLine(content, offset) {
      var n = 1
      var lim = Math.min(Math.max(offset, 0), content.length)
      for (var i = 0; i < lim; i++) if (content.charCodeAt(i) === 10) n++
      return n
    }

    function findAll(content, needle, cap) {
      var out = []
      if (!needle) return out
      var i = content.indexOf(needle)
      while (i >= 0 && out.length < cap) { out.push(i); i = content.indexOf(needle, i + 1) }
      return out
    }

    function nearestHit(hits, text, nearLine) {
      if (hits.length < 2 || !nearLine) return hits[0]
      var best = hits[0], bestD = Infinity
      for (var i = 0; i < hits.length; i++) {
        var d = Math.abs(offsetToLine(text, hits[i]) - nearLine)
        if (d < bestD) { bestD = d; best = hits[i] }
      }
      return best
    }

    function findAnchorLines(content, needle, nearLine) {
      if (!content || !needle) return null
      // 第一层：源码精确匹配
      var hits = findAll(content, needle, 40)
      if (hits.length) {
        var p = nearestHit(hits, content, nearLine)
        return { start: offsetToLine(content, p), end: offsetToLine(content, p + needle.length - 1) }
      }
      // 第二层：空白归一化（Markdown 重排 / 换行调整后走到这里）
      var norm = '', map = [], prevSpace = false
      for (var k = 0; k < content.length; k++) {
        var ch = content.charAt(k)
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
          if (!prevSpace) { norm += ' '; map.push(k); prevSpace = true }
          continue
        }
        norm += ch; map.push(k); prevSpace = false
      }
      var nn = String(needle).replace(/\s+/g, ' ').trim()
      if (nn) {
        var h2 = findAll(norm, nn, 40)
        if (h2.length) {
          var q = nearestHit(h2, norm, nearLine)
          return { start: offsetToLine(content, map[q]), end: offsetToLine(content, map[Math.min(q + nn.length - 1, map.length - 1)]) }
        }
      }
      /* 第三层：Markdown 语法剥离后再找。
       * quote 来自渲染视图，渲染器已经去掉了 ** ` [text](url)→text 行首 #/>/列表符 等语法；
       * 源码里这些标记还在，前两层都匹配不上（这是"刚划完词打开却全部失锚"的主因）。
       * 把源码用和渲染器等价的规则剥一遍，再空白归一化；命中后数 cleaned 里的换行符还原行号。 */
      var cleaned = plainQuote(content)
      if (cleaned) {
        var cnorm = '', cmap = [], cprev = false
        for (var k2 = 0; k2 < cleaned.length; k2++) {
          var ch2 = cleaned.charAt(k2)
          if (ch2 === ' ' || ch2 === '\t' || ch2 === '\n' || ch2 === '\r') {
            if (!cprev) { cnorm += ' '; cmap.push(k2); cprev = true }
            continue
          }
          cnorm += ch2; cmap.push(k2); cprev = false
        }
        var q3 = plainQuote(needle).replace(/\s+/g, ' ').trim()
        if (q3) {
          var h3 = findAll(cnorm, q3, 40)
          if (h3.length) {
            function cleanedOffToLine(off) {
              var co = cmap[off]
              var ln = 1
              for (var j = 0; j < co; j++) if (cleaned.charCodeAt(j) === 10) ln++
              return ln
            }
            var best = h3[0], bestD = Infinity
            for (var hi = 0; hi < h3.length; hi++) {
              var dl = Math.abs(cleanedOffToLine(h3[hi]) - nearLine)
              if (dl < bestD) { bestD = dl; best = h3[hi] }
            }
            return { start: cleanedOffToLine(best), end: cleanedOffToLine(Math.min(best + q3.length - 1, cmap.length - 1)) }
          }
        }
      }
      return null
    }

    function reanchorAll(comments, content) {
      if (!comments || !comments.length) return comments || []
      return comments.map(function (c) {
        var quote = c.quote || ''
        if (!quote) return c
        var hit = findAnchorLines(content, quote, Number(c.lineStart) || 0)
        if (!hit) return Object.assign({}, c, { anchored: false })
        return Object.assign({}, c, { lineStart: hit.start, lineEnd: hit.end, anchored: true })
      })
    }

    /* ────────────────────────── 极简 Markdown 渲染（带源码行号） ──────────────────────────
     * 每个块都带 data-ls / data-le（1 基行号），划词时用来把选区映射回源码行。
     * 只覆盖方案文档常用语法：标题 / 段落 / 列表 / 表格 / 引用 / 代码块 / 分割线 / 行内强调。
     */

    function parseBlocks(src) {
      var lines = String(src || '').split(/\r?\n/)
      var blocks = []
      var i = 0
      while (i < lines.length) {
        var raw = lines[i]
        if (!raw.trim()) { i++; continue }
        var start = i
        var b = null
        var fence = raw.match(/^\s*(```|~~~)(.*)$/)
        if (fence) {
          var marker = fence[1]
          var j = i + 1
          var closeRe = new RegExp('^\\s*' + marker + '\\s*$')
          while (j < lines.length && !closeRe.test(lines[j])) j++
          b = { type: 'code', text: lines.slice(i + 1, j).join('\n'), lang: (fence[2] || '').trim() }
          i = Math.min(j + 1, lines.length)
        } else if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(raw)) {
          b = { type: 'hr' }
          i++
        } else {
          var hm = raw.match(/^(#{1,6})\s+(.*)$/)
          if (hm) {
            b = { type: 'h', level: hm[1].length, text: hm[2] }
            i++
          } else if (/^\s*>/.test(raw)) {
            var qb = []
            var q = i
            while (q < lines.length && /^\s*>/.test(lines[q])) { qb.push(lines[q].replace(/^\s*>\s?/, '')); q++ }
            b = { type: 'quote', text: qb.join('\n') }
            i = q
          } else if (/^\s*([-*+]|\d{1,3}[.)])\s+/.test(raw)) {
            var items = []
            var k = i
            while (k < lines.length) {
              var lm = lines[k].match(/^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/)
              if (lm) { items.push({ text: lm[2], ordered: /\d/.test(lm[1]) }); k++; continue }
              if (items.length && lines[k].trim() && /^\s{2,}\S/.test(lines[k])) { items[items.length - 1].text += ' ' + lines[k].trim(); k++; continue }
              break
            }
            b = { type: 'list', items: items }
            i = k
          } else if (raw.indexOf('|') >= 0 && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
            var rows = []
            var r = i
            while (r < lines.length && lines[r].indexOf('|') >= 0) { rows.push(lines[r]); r++ }
            b = { type: 'table', rows: rows }
            i = r
          } else {
            var pb = [raw]
            var p2 = i + 1
            while (p2 < lines.length && lines[p2].trim() &&
              !/^(#{1,6}\s|\s*>|\s*([-*+]|\d{1,3}[.)])\s)/.test(lines[p2]) &&
              !/^\s*(```|~~~)/.test(lines[p2])) { pb.push(lines[p2]); p2++ }
            b = { type: 'p', text: pb.join('\n') }
            i = p2
          }
        }
        b.ls = start + 1
        b.le = i
        blocks.push(b)
      }
      return blocks
    }

    function renderInline(text, keyPrefix) {
      var out = []
      var parts = String(text).split(/(`[^`]+`)/)
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i]
        if (/^`[^`]+`$/.test(p)) { out.push(h('code', { key: keyPrefix + '-c' + i }, p.slice(1, -1))); continue }
        var re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g
        var last = 0, m, n = 0
        while ((m = re.exec(p))) {
          if (m.index > last) out.push(p.slice(last, m.index))
          var tok = m[0]
          if (tok.slice(0, 2) === '**' || tok.slice(0, 2) === '__') out.push(h('strong', { key: keyPrefix + '-' + i + '-b' + (n++) }, tok.slice(2, -2)))
          else if (tok.charAt(0) === '[') {
            var mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
            out.push(h('a', { key: keyPrefix + '-' + i + '-a' + (n++), href: mm[2], target: '_blank', rel: 'noreferrer' }, mm[1]))
          } else out.push(h('em', { key: keyPrefix + '-' + i + '-i' + (n++) }, tok.slice(1, -1)))
          last = re.lastIndex
        }
        if (last < p.length) out.push(p.slice(last))
      }
      return out
    }

    /* ────────────────────────── Typora 式行级编辑：字符串渲染层 ──────────────────────────
     * 正文由命令式引擎管理（见 DocReviewView 内 initLineEditor）：光标所在行显示
     * Markdown 源码（raw），其余行渲染；生熟切换靠可见字符↔源码字符的偏移映射。
     * Chromium 三个已实测的坑（见 iterations/LEDGER.md ITER-1）：
     *  ① selectionchange 处理器内改 DOM+设光标 → 编辑位置缓存失同步（打字插到行首）
     *    → 转换挪到宏任务 + execCommand ZWSP 强制管线重读选区；
     *  ② mousedown 内同步换 innerHTML，富内联行会整体丢焦点 → 统一「先落点后转换」；
     *  ③ execCommand 插入吞插入点前的尾随空格 → 插入后按预期重建文本节点（节点保活）。 */

    function escHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    }

    /* 行内渲染（字符串版，带 可见字符→源码字符 映射表）。
     * map[v] = 第 v 个可见字符在源码中的下标；语法标记（** ` [..](..)）不产生可见字符。 */
    function renderInlineMap(src) {
      var html = '', map = [], vi = 0
      var re = /(`[^`]+`|\*\*[^*]+?\*\*|__[^_]+?__|\*[^*\n]+?\*|_[^_\n]+?_|\[[^\]]+?\]\([^)]+?\))/g
      var last = 0, m
      function emit(a, b) {
        for (var k = a; k < b; k++) { html += escHtml(src[k]); map[vi++] = k }
      }
      while ((m = re.exec(src))) {
        emit(last, m.index)
        var tok = m[0], k
        if (tok.charAt(0) === '`') {
          html += '<code>' + escHtml(tok.slice(1, -1)) + '</code>'
          map[vi++] = m.index
          for (k = 1; k < tok.length - 1; k++) map[vi++] = m.index + k
          map[vi++] = m.index + tok.length - 1
        } else if (tok.charAt(0) === '[') {
          var mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
          html += '<a href="' + escHtml(mm[2]) + '" target="_blank" rel="noreferrer">' + escHtml(mm[1]) + '</a>'
          map[vi++] = m.index
          for (k = 1; k <= mm[1].length; k++) map[vi++] = m.index + k
        } else {
          html += '<strong>' + escHtml(tok.slice(2, -2)) + '</strong>'
          map[vi++] = m.index; map[vi++] = m.index + 1
          for (k = 2; k < tok.length - 2; k++) map[vi++] = m.index + k
          map[vi++] = m.index + tok.length - 2; map[vi++] = m.index + tok.length - 1
        }
        last = re.lastIndex
      }
      emit(last, src.length)
      map.length = vi
      return { html: html, map: map }
    }

    /* 单行分类（引擎按行工作；parseBlocks 的块结构只用于徽标/行末批注钮/表格） */
    function lineKind(src) {
      var l = src, m
      if (!l.trim()) return { t: 'blank' }
      if ((m = l.match(/^(#{1,6})\s+(.*)$/))) return { t: 'h', level: m[1].length, text: m[2] }
      if ((m = l.match(/^>\s?(.*)$/))) return { t: 'quote', text: m[1] }
      if ((m = l.match(/^(\s*)([-*+])\s+(.*)$/))) return { t: 'uli', indent: m[1], marker: m[2], text: m[3] }
      if ((m = l.match(/^(\s*)(\d{1,3}[.)])\s+(.*)$/))) return { t: 'oli', indent: m[1], marker: m[2], text: m[3] }
      if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(l)) return { t: 'hr' }
      if (/^\s*(```|~~~)/.test(l)) return { t: 'fence' }
      return { t: 'p' }
    }

    /* 字符串 SVG（行内渲染走 innerHTML，pmIcon 的 h() 树进不去） */
    function pmIconStr(name, sw) {
      var parts = PM_ICON[name] || []
      var s = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (sw || 1.75) +
        '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      for (var i = 0; i < parts.length; i++) {
        var tag = parts[i][0], attrs = parts[i][1] || {}, out = ''
        for (var k in attrs) out += ' ' + k + '="' + String(attrs[k]).replace(/"/g, '&quot;') + '"'
        s += '<' + tag + out + '/>'
      }
      return s + '</svg>'
    }

    /* ────────────────────────── 视图 ────────────────────────── */

    function DocReviewView() {
      var docPair = useState(null)          // { path, name, content, mtimeMs, hash, review }
      var doc = docPair[0], setDoc = docPair[1]
      var docsPair = useState([])
      var docs = docsPair[0], setDocs = docsPair[1]
      var collPair = useState(true)         // 左栏折叠
      var collapsed = collPair[0], setCollapsed = collPair[1]
      var errPair = useState('')
      var err = errPair[0], setErr = errPair[1]
      var msgPair = useState('')
      var msg = msgPair[0], setMsg = msgPair[1]
      var savePair = useState('')
      var saveState = savePair[0], setSaveState = savePair[1]
      var rootPair = useState('')
      var root = rootPair[0], setRoot = rootPair[1]
      var authorPair = useState('')
      var author = authorPair[0], setAuthor = authorPair[1]
      var authorMenuPair = useState(false)
      var authorMenuOpen = authorMenuPair[0], setAuthorMenuOpen = authorMenuPair[1]
      /* 署名内联编辑：宿主环境 window.prompt 会被拦（点了没反应），一律菜单内改输入框 */
      var authorEditPair = useState(null)
      var authorEdit = authorEditPair[0], setAuthorEdit = authorEditPair[1]
      var qPair = useState('')
      var q = qPair[0], setQ = qPair[1]
      // 左栏排序：recent＝最近产出（默认）｜pending＝待处理优先。本机偏好，落 localStorage。
      var sortPair = useState(function () {
        try { return localStorage.getItem('dsh-doc-review.sort') === 'pending' ? 'pending' : 'recent' } catch (e) { return 'recent' }
      })
      var sortMode = sortPair[0], setSortMode = sortPair[1]
      var metaPair = useState(null)
      var meta = metaPair[0], setMeta = metaPair[1]
      var scopePair = useState(function () {
        try {
          var v = localStorage.getItem('dsh-doc-review.scope')
          if (v === 'session') return 'related'          // 旧值迁移
          return (v === 'workspace' || v === 'vault' || v === 'related') ? v : 'related'
        } catch (e) { return 'related' }
      })
      var scope = scopePair[0], setScope = scopePair[1]
      var loadingPair = useState(false)
      var loading = loadingPair[0], setLoading = loadingPair[1]
      var selPair = useState(null)          // { quote, ls, le, x, y }
      var sel = selPair[0], setSel = selPair[1]
      var draftPair = useState('')
      var draft = draftPair[0], setDraft = draftPair[1]
      var globalPair = useState('')
      var globalNote = globalPair[0], setGlobalNote = globalPair[1]
      var manualPair = useState('')
      var manual = manualPair[0], setManual = manualPair[1]
      var docRef = useRef(null)
      /* 宿主槽位不给确定高度时，height:100% 塌成内容高度，滚动全落在宿主外层页面
       * （三栏一起被滚走）。这里实测 root 距视口顶部的静态偏移，把高度钉到视口底。 */
      var rootRef = useRef(null)
      useLayoutEffect(function () {
        var el = rootRef.current
        if (!el) return undefined
        function staticTop(node) {
          var t = 0
          while (node) { t += node.offsetTop; node = node.offsetParent }
          return t
        }
        function fit() {
          var top = staticTop(el)
          if (top >= 0 && top < window.innerHeight) {
            el.style.height = Math.max(360, window.innerHeight - top) + 'px'
          }
        }
        fit()
        window.addEventListener('resize', fit)
        return function () { window.removeEventListener('resize', fit) }
      }, [])
      var saveTimer = useRef(null)
      var loadSeq = useRef(0)
      var snotePair = useState([])          // 本会话批注（在对话消息上划词写的）
      var snotes = snotePair[0], setSnotes = snotePair[1]
      var propPair = useState([])           // 待审改动提案（建议模式）
      var props = propPair[0], setProps = propPair[1]
      var rejectPair = useState('')
      var rejectReason = rejectPair[0], setRejectReason = rejectPair[1]
      // Feishu-style comment state: active card / resolved fold / in-place edit / reply drafts / rail markers
      var activePair = useState(null)
      var activeId = activePair[0], setActiveId = activePair[1]
      var cardMenuPair = useState(null)
      var cardMenuId = cardMenuPair[0], setCardMenuId = cardMenuPair[1]
      var foldPair = useState(false)
      var showResolved = foldPair[0], setShowResolved = foldPair[1]
      var editPair = useState(null)         // { id, text }
      var editing = editPair[0], setEditing = editPair[1]
      var replyPair = useState({})          // { [commentId]: draft }
      var replyDrafts = replyPair[0], setReplyDrafts = replyPair[1]
      var replyEditPair = useState(null)    // { parentId, replyId, text }
      var replyEditing = replyEditPair[0], setReplyEditing = replyEditPair[1]
      var replyMenuPair = useState(null)
      var replyMenuId = replyMenuPair[0], setReplyMenuId = replyMenuPair[1]
      var markerPair = useState([])         // [{ id, top (0..1), n }]
      var markers = markerPair[0], setMarkers = markerPair[1]
      // Feishu-style: right-panel filter (all / pending / resolved) + two-step selection (toolbar → input)
      var filterPair = useState('all')
      var filterMode = filterPair[0], setFilterMode = filterPair[1]
      var docStagePair = useState(null)     // null | 'pill' (selection toolbar) | 'open' (comment input)
      var docStage = docStagePair[0], setDocStage = docStagePair[1]
      // Typora 行级编辑引擎状态（全在 ref：正文 DOM 由引擎命令式管理，vdom 不重绘）
      var engRef = useRef(null)           // { lines, maps, rawLine, undo, burstOpen, syncing, host, disposed }
      var engHostRef = useRef(null)       // 正文宿主 div（ref 挂载点，React 不碰它的子树）
      var engSaveTimer = useRef(0)        // 正文落盘防抖
      var loadRevPair = useState(0)       // 正文引擎重建版本号：openDoc 时 +1
      var loadRev = loadRevPair[0], setLoadRev = loadRevPair[1]
      var latestDocRef = useRef(null)     // 异步回包时拿最新 doc，避免闭包旧快照覆盖并发改动
      latestDocRef.current = doc
      var collapsedPair = useState(false)   // Feishu-style: right comment panel collapsed (»» / ««)
      var notesCollapsed = collapsedPair[0], setNotesCollapsed = collapsedPair[1]
      var notesRef = useRef(null)
      var rangesRef = useRef({})            // commentId -> live DOM Range of its quote
      var anchorTickPair = useState(0)      // 锚定项测量后重排用版本号
      var anchorTick = anchorTickPair[0], setAnchorTick = anchorTickPair[1]
      var anchorHeights = useRef({})        // 锚定项实测高度（防重叠用）
      var anchorEls = useRef({})            // 锚定项 DOM 引用（测量用）
      var activeRef = useRef(null)
      var hoverRef = useRef(null)
      var flashRef = useRef(null)
      var flashTimer = useRef(null)
      var hoverRaf = useRef(0)
      activeRef.current = activeId

      var comments = (doc && doc.review && doc.review.comments) ? doc.review.comments : []
      var pending = comments.filter(function (c) { return c.status === 'pending' })
      var resolvedCount = comments.length - pending.length
      var snotePending = snotes.filter(function (n) { return (n.status || 'pending') === 'pending' })
      var propPending = props.filter(function (c) { return (c.status || 'pending') === 'pending' })
      useEffect(function () { void boot() }, [])

      // 本会话批注：进页面拉一次，浮层里保存后再拉一次（自定义事件）
      useEffect(function () {
        void loadSnotes()
        var onNew = function () { void loadSnotes() }
        window.addEventListener('dsh-doc-review:snotes', onNew)
        return function () { window.removeEventListener('dsh-doc-review:snotes', onNew) }
      }, [])

      function loadSnotes() {
        var sid = currentSessionId()
        if (!sid) return Promise.resolve()
        return apiGet(API.snotes, { sessionId: sid }).then(function (r) {
          if (r && r.ok) setSnotes(r.notes || [])
        }).catch(function () {})
      }

      /** 把还没标「已发出」的待处理批注一次标掉：它们不再进批注块（仍在清单里，可退回） */
      function markAllSent() {
        var sid = currentSessionId()
        if (!sid) return
        var ids = snotes.filter(function (n) {
          return (n.status || 'pending') === 'pending' && !n.sent_at
        }).map(function (n) { return n.id })
        if (!ids.length) return
        apiPost(API.snote, { sessionId: sid, action: 'sent', ids: ids }).then(function (r) {
          if (r && r.ok) { setSnotes(r.notes || []); syncDraftToComposer(r.notes || []); setMsg('已把 ' + ids.length + ' 条标为「已发出」，不会再进批注块') }
        }).catch(function () {})
      }

      function snoteAction(id, action) {
        var sid = currentSessionId()
        if (!sid) return
        apiPost(API.snote, { sessionId: sid, id: id, action: action }).then(function (r) {
          if (r && r.ok) { setSnotes(r.notes || []); syncDraftToComposer(r.notes || []) }
        }).catch(function () {})
      }

      /* ── 建议模式：待审改动提案 ── */
      function loadProps() {
        if (!doc || !doc.path) { setProps([]); return Promise.resolve() }
        return apiGet(API.props, { path: doc.path, sessionId: currentSessionId() }).then(function (r) {
          if (r && r.ok) setProps(r.changes || [])
        }).catch(function () {})
      }

      function propDecide(action, ids) {
        if (!doc || !doc.path) return
        var isAccept = action === 'accept'
        apiPost(API.prop, {
          path: doc.path, action: action, ids: ids || [],
          reason: isAccept ? '' : rejectReason, sessionId: currentSessionId(),
        }).then(function (r) {
          if (!r || !r.ok) { setErr('处理待审改动失败：' + ((r && r.error) || '未知')); return }
          setRejectReason('')
          if (isAccept) {
            setMsg('已接受 ' + (r.accepted || 0) + ' 条改动并写入文档' + ((r.missed && r.missed.length) ? '；' + r.missed.length + ' 条原文对不上、没写' : ''))
            void loadProps()
            void openDoc(doc.path)
          } else {
            setMsg('已拒绝 ' + (r.rejected || 0) + ' 条改动（文件没动）')
            void loadProps()
          }
        }).catch(function (e) { setErr('处理失败：' + ((e && e.message) || e)) })
      }

      function sendSnotesToAgent() {
        var todo = snotes.filter(function (n) { return (n.status || 'pending') === 'pending' })
        if (!todo.length) return
        var lines = ['我在对话里给你留了 ' + todo.length + ' 条批注（不是文档批注，是针对我们刚才对话内容的意见），请逐条回应/修正：', '']
        todo.forEach(function (n, i) {
          lines.push('[' + (i + 1) + '] 我说的原文：' + String(n.quote || '').replace(/\s+/g, ' ').slice(0, 300))
          lines.push('    我的意见：' + (n.note || ''))
          lines.push('    （id: ' + n.id + '）')
          lines.push('')
        })
        lines.push('处理完请调用 session_note_resolve 把这 ' + todo.length + ' 条标为已处理，并回填一句你改了什么。')
        var prompt = lines.join('\n')
        var sid = currentSessionId()
        if (!remoteFace || !remoteFace.session || typeof remoteFace.session.prompt !== 'function' || !sid) {
          copyToClipboard(prompt)
          setMsg('拿不到会话或 remote 面，指令已复制到剪贴板。')
          return
        }
        remoteFace.session.prompt({
          requestId: uuid(), sessionId: sid, mode: 'queue',
          content: [{ type: 'text', text: prompt }], clientTimeZone: tz(),
        }).then(function () {
          setMsg('已把 ' + todo.length + ' 条会话批注发给 AI。')
        }).catch(function (e) {
          copyToClipboard(prompt)
          setMsg('发送失败（' + ((e && e.message) || e) + '），已复制到剪贴板。')
        })
      }

      useEffect(function () {
        var onScroll = function () { if (sel) { setSel(null); setDocStage(null) } }
        window.addEventListener('scroll', onScroll, true)
        return function () { window.removeEventListener('scroll', onScroll, true) }
      }, [sel])

      // 弹框关掉（保存 / 取消 / 滚走）就把选区高亮撤掉
      useEffect(function () { if (!sel) { dropHighlight(); setDocStage(null) } }, [sel])

      /* dr-pending 只在输入框展开时出现：此时 textarea 抢走焦点、原生蓝色选区已折叠。
         划词 pill 阶段原生选区还亮着，若这时就挂高亮，会和原生选中样式叠出两套颜色。 */
      useEffect(function () {
        if (docStage === 'open' && sel && sel.range) tapHighlight(sel.range)
        else dropHighlight()
      }, [docStage, sel])

      // 打开哪篇文档，就拉哪篇的待审改动提案
      useEffect(function () { void loadProps() }, [doc && doc.path])

      // Ctrl/Cmd+Shift+M：把焦点送回批注输入框（对齐 Notion 与 Google Docs 的"给选中内容加评论"快捷键）
      useEffect(function () {
        function onKey(e) {
          if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return
          if (String(e.key || '').toLowerCase() !== 'm') return
          if (docStage === 'pill') { setDocStage('open'); return }
          var ta = document.querySelector('.dr-float-input')
          if (!ta) return
          e.preventDefault()
          try { ta.focus() } catch (_) {}
        }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [docStage])

      function boot() {
        apiPost(API.hello, {}).catch(function () {})
        apiGet(API.state).then(function (st) {
          if (!st || !st.ok) { setErr('宿主半边没应答：' + JSON.stringify(st)); return }
          if (st.author) setAuthor(st.author)
          var ws = st.roots && st.roots[0] ? st.roots[0] : ''
          setRoot(ws)
          void loadDocs(ws, '')
          if (st.lastDoc) void openDoc(st.lastDoc)
        }).catch(function (e) { setErr('读取插件状态失败：' + e.message) })
      }

      function loadDocs(ws, keyword, force) {
        setLoading(true)
        return apiGet(API.docs, { ws: ws, q: keyword, refresh: force ? '1' : '', scope: scope, sessionId: currentSessionId() }).then(function (d) {
          setLoading(false)
          if (!d || !d.ok) { setErr((d && d.error) || '列文档失败'); return }
          setDocs(d.docs || [])
          setMeta({
            total: d.total || 0, scanned: d.scanned || 0, scanMs: d.scanMs || 0,
            scopeUsed: d.scopeUsed || scope, fallback: !!d.fallback, reason: d.reason || '',
            cwd: d.cwd || '', root: d.root || '',
          })
        }).catch(function (e) { setLoading(false); setErr('列文档失败：' + e.message) })
      }

      function openDoc(p) {
        var my = ++loadSeq.current
        setErr('')
        setMsg('')
        setSel(null)
        setLoadRev(function (n) { return n + 1 })   // 正文引擎按次重建（刷新按钮/提案接受也走这里）
        return apiGet(API.doc, { path: p, sessionId: currentSessionId() }).then(function (d) {
          if (my !== loadSeq.current) return
          if (!d || !d.ok) { setErr((d && d.error) || ('打开失败：' + p)); return }
          var before = (d.review && d.review.comments) || []
          var after = reanchorAll(before, d.content)
          if (d.review) d.review.comments = after
          setDoc(d)
          var changed = after.some(function (c, i) {
            var o = before[i] || {}
            return Number(o.lineStart) !== Number(c.lineStart) || Number(o.lineEnd) !== Number(c.lineEnd) || (o.anchored === false) !== (c.anchored === false)
          })
          if (changed) persistAnchors(d.path, after)
        }).catch(function (e) { setErr('打开文档失败：' + e.message) })
      }

      /** 写回批注（整体覆盖 + 防抖 500ms） */
      function persist(nextComments, immediate) {
        if (!doc) return
        setDoc(function (cur) { return cur ? Object.assign({}, cur, { review: Object.assign({}, cur.review, { comments: nextComments }) }) : cur })
        fireSave(doc.path, nextComments, immediate)
      }

      /** 重锚结果落盘：打开文档那一刻跑一次（只在行列/失锚状态真的变了时才调） */
      function persistAnchors(docPath, nextComments) {
        setDoc(function (cur) { return (cur && cur.path === docPath) ? Object.assign({}, cur, { review: Object.assign({}, cur.review, { comments: nextComments }) }) : cur })
        fireSave(docPath, nextComments, true)
      }

      function fireSave(docPath, nextComments, immediate) {
        setSaveState('保存中…')
        var snapshot = { path: docPath, comments: nextComments, sessionId: currentSessionId() }
        var fire = function () {
          apiPost(API.save, snapshot).then(function (r) {
            if (!r || !r.ok) { setSaveState('保存失败'); setErr((r && r.error) || '保存失败'); return }
            setSaveState('已保存 ' + nowStamp().slice(11))
            setDoc(function (cur) { return (cur && cur.path === r.review.doc) ? Object.assign({}, cur, { review: r.review, hash: r.hash, mtimeMs: r.mtimeMs }) : cur })
            void loadDocs(root, q)
          }).catch(function (e) { setSaveState('保存失败'); setErr('保存失败：' + e.message) })
        }
        if (saveTimer.current) clearTimeout(saveTimer.current)
        if (immediate) fire()
        else saveTimer.current = setTimeout(fire, 500)
      }

      /* ── Typora 行级编辑引擎 ──────────────────────────────────────────
       * 正文由引擎命令式管理：光标所在行显示源码（raw），其余行渲染；光标离开即渲染回去。
       * 打字只回写引擎的 lines[]（不重建 DOM——重建会打爆 Chromium 编辑位置缓存），
       * 落盘走 600ms 防抖 /doc-write，成功后批注按 quote 重锚（既有 reanchorAll）。 */
      function eng() { return engRef.current }

      /* raw 行的视觉类：Typora 编辑标题行时保持标题字号字重（不退成正文源码样式），
       * 引用行保持竖线样式；列表/代码行本就无专属视觉，维持默认。 */
      function engRawCls(i) {
        var e = eng()
        var c = lineKind(e.lines[i] || '')
        if (c.t === 'h') return ' tl-h' + Math.min(3, c.level)
        if (c.t === 'quote') return ' tl-quote'
        return ''
      }

      function engLineHTMLInner(i, raw) {
        var e = eng()
        var src = e.lines[i]
        var attrs = 'data-ls="' + (i + 1) + '"'
        if (raw) {
          e.maps[i] = null
          return '<div ' + attrs + ' data-mode="raw" class="tl tl-raw' + engRawCls(i) + (lineKind(src).t === 'blank' ? ' tl-blank' : '') + '">' + (src ? escHtml(src) : '<br>') + '</div>'
        }
        if (engFenceDepth(i)) { e.maps[i] = null; return '<div ' + attrs + ' data-mode="r" class="tl tl-code">' + escHtml(src) + '</div>' }
        var c = lineKind(src)
        function wrap(cls, r, off) {
          e.maps[i] = off ? r.map.map(function (v) { return v + off }) : r.map
          return '<div ' + attrs + ' data-mode="r" class="tl ' + cls + '">' + r.html + '</div>'
        }
        if (c.t === 'blank') { e.maps[i] = null; return '<div ' + attrs + ' data-mode="r" class="tl tl-blank"><br></div>' }
        if (c.t === 'hr') { e.maps[i] = null; return '<div ' + attrs + ' data-mode="r" class="tl tl-hr"><br></div>' }
        if (c.t === 'fence') { e.maps[i] = null; return '<div ' + attrs + ' data-mode="r" class="tl tl-fence">' + escHtml(src) + '</div>' }
        if (c.t === 'h') {
          var r = renderInlineMap(c.text)
          return wrap('tl-h' + Math.min(3, c.level), r, src.length - c.text.length)
        }
        if (c.t === 'quote') {
          var r = renderInlineMap(c.text)
          return wrap('tl-quote', r, src.length - c.text.length)
        }
        if (c.t === 'uli') {
          var r = renderInlineMap(c.text)
          e.maps[i] = r.map.map(function (v) { return v + c.indent.length + 2 })
          return '<div ' + attrs + ' data-mode="r" class="tl tl-li">' + escHtml(c.indent) + '• ' + r.html + '</div>'
        }
        if (c.t === 'oli') {
          var r = renderInlineMap(c.text)
          e.maps[i] = r.map.map(function (v) { return v + c.indent.length + c.marker.length + 1 })
          return '<div ' + attrs + ' data-mode="r" class="tl tl-oli">' + escHtml(c.indent) + escHtml(c.marker) + ' ' + r.html + '</div>'
        }
        return wrap('', renderInlineMap(src), 0)
      }

      /* 行末批注钮（视觉行级）：Markdown 里一个源码行（.tl）会自动折成多个视觉行，
       * CSS 的 top:50% 只能相对整段居中——图标会飘在折行交界处。飞书/Notion 是按
       * 「指针所在的视觉行」定位的：每块只放一个钮，mousemove 时用 caretRangeFromPoint
       * 取指针所在视觉行的矩形，把钮吸附到那一行行末（engLineFloatMove）。 */
      function engLineBtnHTML(b) {
        return '<button type="button" class="dr-lineadd" data-act="lineadd" data-ls="' + b.ls + '" data-le="' + b.le +
          '" title="给这一段写批注" aria-label="给这一段写批注">' + pmIconStr('comment') + '</button>'
      }

      function engFenceDepth(i) {
        var e = eng(), d = 0
        for (var k = 0; k < i; k++) if (lineKind(e.lines[k]).t === 'fence') d = d ? 0 : 1
        return d
      }

      /* 块级包装：parseBlocks 的块结构决定 .dr-block[data-ls/le]（批注锚定/徽标/行末钮的挂靠单位）。
       * 文本类块内部 = 逐行 .tl；代码块 = tl-code 行；表格块 = 真表格（点入才整块转行，Typora 也无行级表格）。 */
      function engRenderAll() {
        var e = eng()
        var host = engHostRef.current
        if (!e || !host) return
        var blocks = parseBlocks(e.lines.join('\n'))
        var html = ''
        var prevEnd = 0   // 已渲染到的行（0 基）。parseBlocks 会跳过空行，块间空行单独包块，否则 resync 丢行。
        function gapLines(from1, to1) {   // [from1, to1] 1 基闭区间
          for (var g = from1; g <= to1; g++) {
            html += '<div class="dr-block" data-ls="' + g + '" data-le="' + g + '" data-blank="1">' + engLineHTMLInner(g - 1, g - 1 === e.rawLine) + '</div>'
          }
        }
        for (var bi = 0; bi < blocks.length; bi++) {
          var b = blocks[bi]
          gapLines(prevEnd + 1, b.ls - 1)
          prevEnd = b.le
          var marks = engMarksFor(b)
          var pen = engPropFor(b)
          var cls = 'dr-block'
          if (marks.length && !HL_OK) cls += ' dr-block-hl'
          if (pen) cls += ' dr-block-pending'
          html += '<div class="' + cls + '" data-ls="' + b.ls + '" data-le="' + b.le + '" data-bi="' + bi + '">'
          /* 行末批注钮：每块一个，垂直位置由 engLineFloatMove 按指针所在视觉行实时定位 */
          if (b.type !== 'table' || engTableOpened(bi)) html += engLineBtnHTML(b)
          /* 徽标：侧栏折叠时显示评论数徽标；展开时有 Highlight API 就靠正文划线 */
          if (marks.length && (notesCollapsed || !HL_OK)) {
            html += '<button type="button" class="dr-mark' + (notesCollapsed ? ' dr-mark-count' : '') +
              '" data-act="mark" data-cid="' + comments[marks[0]].id + '" title="' +
              escHtml(marks.map(function (m) { return markTitle(comments[m], m + 1) }).join('\n')) +
              '" aria-label="' + marks.length + ' 条评论">' +
              (notesCollapsed ? String(marks.length) : marks.map(function (m, k) {
                var done = (comments[m].status || 'pending') !== 'pending'
                return '<span class="' + (done ? 'dr-mark-done' : '') + '">' + (done ? '✓' : '#') + (m + 1) + (k < marks.length - 1 ? ' ' : '') + '</span>'
              }).join('')) + '</button>'
          }
          if (pen) {
            html += '<div class="dr-inline-prop"><div class="dr-inline-prop-t">拟' + (pen.kind === 'delete' ? '删除' : '改为') + '：' +
              (pen.kind === 'delete'
                ? '<span class="dr-prop-old">' + escHtml(String(pen.quote || '').replace(/\s+/g, ' ').slice(0, 140)) + '</span>'
                : '<span class="dr-prop-new">' + escHtml(String(pen.after || '').replace(/\s+/g, ' ').slice(0, 160)) + '</span>') +
              '</div>' + (pen.note ? '<div class="dr-hint">' + escHtml(pen.note) + '</div>' : '') +
              '<div class="dr-prop-bar">' +
              '<button class="dr-btn dr-btn-mini dr-btn-primary" data-act="prop-accept" data-id="' + pen.id + '">接受</button>' +
              '<button class="dr-btn dr-btn-mini" data-act="prop-reject" data-id="' + pen.id + '">拒绝</button>' +
              '<span class="dr-hint">接受后才写入文件</span></div></div>'
          }
          /* 块内容 */
          if (b.type === 'table' && !engTableOpened(bi)) {
            html += engTableHTML(b, bi)
          } else if (b.type === 'code') {
            for (var l = b.ls; l <= b.le; l++) html += engLineHTMLInner(l - 1, l - 1 === e.rawLine)
          } else {
            for (var l2 = b.ls; l2 <= b.le; l2++) html += engLineHTMLInner(l2 - 1, l2 - 1 === e.rawLine)
          }
          html += '</div>'
        }
        gapLines(prevEnd + 1, e.lines.length)   // 末尾空行（含文档末换行）
        host.innerHTML = html
      }

      function engTableOpened(bi) {
        var e = eng()
        return !!(e && e.tableOpen && e.tableOpen[bi])
      }

      function engTableHTML(b, bi) {
        var grid = b.rows.map(function (row) {
          return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim() })
        })
        var head = grid[0] || []
        var body = grid.slice(1).filter(function (row) { return !row.every(function (c) { return /^:?-{2,}:?$/.test(c) || c === '' }) })
        var s = '<table class="dr-table tl-table" data-bi="' + bi + '"><thead><tr>'
        head.forEach(function (c) { s += '<th>' + renderInlineMap(c).html + '</th>' })
        s += '</tr></thead><tbody>'
        body.forEach(function (row) {
          s += '<tr>'
          row.forEach(function (c) { s += '<td>' + renderInlineMap(c).html + '</td>' })
          s += '</tr>'
        })
        return s + '</tbody></table>'
      }

      function engMarksFor(b) {
        var set = []
        for (var l = b.ls; l <= b.le; l++) {
          var arr = byLine[l]
          if (!arr) continue
          for (var i = 0; i < arr.length; i++) if (set.indexOf(arr[i]) < 0) set.push(arr[i])
        }
        return set
      }

      function engPropFor(b) {
        for (var i = 0; i < propPending.length; i++) {
          var c = propPending[i]
          var ls = Number(c.line) || 0
          if (!ls) continue
          var le = ls + String(c.quote || '').split('\n').length - 1
          if (b.le >= ls && b.ls <= le) return c
        }
        return null
      }

      /* 软刷新：批注/提案/折叠状态变了 → 重建全部块；raw 行保持不动，光标不丢。 */
      function engSoftRefresh() {
        var e = eng()
        if (!e) return
        if (e.rawLine >= 0) {
          var rawI = e.rawLine, rawEl = engLineAt(rawI)
          var saved = rawEl ? rawEl.outerHTML : null
          engRenderAll()
          if (saved) {
            var el = engLineAt(rawI)
            if (el) {
              el.outerHTML = saved
              var el2 = engLineAt(rawI)
              var rOff = engCaretOffsetIn(el2)
              e.lines[rawI] = el2.textContent.replace(/[\u00a0]/g, ' ').replace(/\u200B/g, '')
              if (rOff > e.lines[rawI].length) rOff = e.lines[rawI].length
              engSetCaret(el2, rOff)
              engSyncPipeline(el2, e.lines[rawI], rOff)
            }
          }
        } else {
          engRenderAll()
        }
      }

      function engLineAt(i) {
        var host = engHostRef.current
        return host ? host.querySelector('.tl[data-ls="' + (i + 1) + '"]') : null
      }

      function engCaretEl() {
        var s = window.getSelection()
        if (!s || !s.rangeCount) return null
        var n = s.getRangeAt(0).startContainer
        var el = n.nodeType === 1 ? n : n.parentNode
        return el && el.closest ? el.closest('.tl') : null
      }

      function engCaretOffsetIn(el) {
        var s = window.getSelection()
        if (!s || !s.rangeCount) return 0
        var r = document.createRange()
        r.selectNodeContents(el)
        try { r.setEnd(s.getRangeAt(0).startContainer, s.getRangeAt(0).startOffset) } catch (e2) { return 0 }
        return r.toString().replace(/\n$/, '').length
      }

      function engSetCaret(el, off) {
        var walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        var n, acc = 0
        while ((n = walk.nextNode())) {
          if (acc + n.length >= off) {
            var r = document.createRange(); r.setStart(n, off - acc); r.collapse(true)
            var s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
            return
          }
          acc += n.length
        }
        var r2 = document.createRange(); r2.selectNodeContents(el); r2.collapse(false)
        var s2 = window.getSelection(); s2.removeAllRanges(); s2.addRange(r2)
      }

      function engVisibleToRaw(i, vOff) {
        var e = eng()
        var m = e.maps[i]
        if (!m || !m.length) return vOff
        if (vOff >= m.length) return e.lines[i].length
        return m[vOff]
      }

      /* Chromium 编辑位置缓存对齐（坑③：插入后按预期重建文本节点，节点保活） */
      function engSyncPipeline(el, srcLine, rOff) {
        var e = eng()
        e.syncing = true
        try { document.execCommand('insertText', false, '\u200B') } catch (_) {}
        e.syncing = false
        e.lines[e.rawLine] = srcLine
        var expect = srcLine.slice(0, rOff) + '\u200B' + srcLine.slice(rOff)
        var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        var n = walker.nextNode()
        if (n) {
          n.data = expect
          engSetCaret(el, rOff + 1)
        }
      }

      function engResyncFromDOM() {
        var e = eng()
        var host = engHostRef.current
        if (!e || !host) return
        var next = []
        var blocks = host.querySelectorAll('.dr-block')
        for (var k = 0; k < blocks.length; k++) {
          var blk = blocks[k]
          var tls = blk.querySelectorAll('.tl')
          if (tls.length) {
            for (var t = 0; t < tls.length; t++) {
              var el = tls[t]
              if (el.getAttribute('data-mode') === 'raw') next.push(el.textContent.replace(/[\u00a0]/g, ' ').replace(/\u200B/g, ''))
              else {
                var old = Number(el.getAttribute('data-ls')) - 1
                next.push(e.lines[old] != null ? e.lines[old] : el.textContent)
              }
            }
          } else {
            var s0 = Number(blk.getAttribute('data-ls')), e0 = Number(blk.getAttribute('data-le'))
            for (var l = s0; l <= e0; l++) next.push(e.lines[l - 1])
          }
        }
        e.lines = next
      }

      function engConvertLine(i) {
        var e = eng()
        var el = engLineAt(i)
        if (!el || el.getAttribute('data-mode') === 'raw') return
        var wasBlank = el.classList.contains('tl-blank')
        el.setAttribute('data-mode', 'raw')
        el.className = 'tl tl-raw' + engRawCls(i) + (wasBlank ? ' tl-blank' : '')
        el.innerHTML = e.lines[i] ? escHtml(e.lines[i]) : '<br>'
        e.maps[i] = null
      }

      function engRepaintLine(i, raw) {
        var el = engLineAt(i)
        if (!el) return null
        var tmp = document.createElement('div')
        tmp.innerHTML = engLineHTMLInner(i, raw)
        var fresh = tmp.firstChild
        el.replaceWith(fresh)
        return fresh
      }

      /* 释放旧的 raw 行（光标去了 newLine，可为 null＝彻底离开）：
       * 旧行在「已展开的表格块」里且新行不在同一块 → 关闭 tableOpen，整块重渲染回真表格。 */
      function engReleaseOldRaw(newLine) {
        var e = eng()
        if (!e || e.rawLine < 0) return
        var old = e.rawLine
        var host = engHostRef.current
        if (host && e.tableOpen) {
          var oldEl = host.querySelector('.tl[data-ls="' + (old + 1) + '"]')
          var wrapper = oldEl ? oldEl.closest('.dr-block') : null
          var bi = wrapper ? wrapper.getAttribute('data-bi') : null
          if (bi != null && e.tableOpen[bi]) {
            var inSameBlock = false
            if (newLine != null) {
              var newEl = host.querySelector('.tl[data-ls="' + (newLine + 1) + '"]')
              inSameBlock = !!(newEl && newEl.closest('.dr-block') === wrapper)
            }
            if (!inSameBlock) {
              delete e.tableOpen[bi]
              e.rawLine = -1
              engRenderAll()
              return
            }
          }
        }
        engRepaintLine(old, false)
      }

      /* 光标落在渲染行 → 转 raw + 映射光标 + 管线同步（延后宏任务里调） */
      function engEnsureRawAtCaret() {
        var e = eng()
        if (!e) return
        var s0 = window.getSelection()
        if (s0 && !s0.isCollapsed) return
        var el = engCaretEl()
        if (!el || el.getAttribute('data-mode') !== 'r') return
        var i = Number(el.getAttribute('data-ls')) - 1
        var rOff = engVisibleToRaw(i, engCaretOffsetIn(el))
        if (e.rawLine >= 0 && e.rawLine !== i) engReleaseOldRaw(i)
        e.rawLine = i
        el = engLineAt(i) || el
        var wasBlank = el.classList.contains('tl-blank')
        el.setAttribute('data-mode', 'raw')
        el.className = 'tl tl-raw' + engRawCls(i) + (wasBlank ? ' tl-blank' : '')
        el.innerHTML = e.lines[i] ? escHtml(e.lines[i]) : '<br>'
        e.maps[i] = null
        engSetCaret(el, rOff)
        engSyncPipeline(el, e.lines[i], rOff)
      }

      function engLeaveRawLine() {
        var e = eng()
        if (!e || e.rawLine < 0) return
        engReleaseOldRaw(null)
        e.rawLine = -1
      }

      function engSnapshot() {
        var e = eng()
        e.undo.push({ lines: e.lines.slice(), li: e.rawLine, off: engCaretEl() ? engCaretOffsetIn(engCaretEl()) : 0 })
        if (e.undo.length > 200) e.undo.shift()
      }

      function engUndo() {
        var e = eng()
        var s = e.undo.pop()
        if (!s) return
        e.lines = s.lines.slice(); e.rawLine = s.li
        engRenderAll()
        var el = engLineAt(e.rawLine)
        if (el) { engSetCaret(el, s.off); engSyncPipeline(el, e.lines[e.rawLine] || '', s.off) }
        engScheduleSave()
      }

      /* 落盘：600ms 防抖 → /doc-write → 重锚批注并回写（既有链路） */
      function engScheduleSave() {
        var e = eng()
        if (!e) return
        setSaveState('保存中…')
        clearTimeout(engSaveTimer.current)
        engSaveTimer.current = setTimeout(engFlushSave, 600)
      }

      function engFlushSave() {
        var e = eng()
        var curDoc = latestDocRef.current
        if (!e || !curDoc) return
        var newContent = e.lines.join('\n')
        var oldContent = String(curDoc.content || '')
        if (newContent === oldContent) { setSaveState('已保存 ' + nowStamp().slice(11)); return }
        var oldComments = (curDoc.review && curDoc.review.comments) || []
        apiPost(API.docWrite, {
          path: curDoc.path, content: newContent, baseHash: curDoc.hash, sessionId: currentSessionId(),
        }).then(function (r) {
          if (!r || !r.ok) {
            setSaveState('保存失败')
            setErr((r && r.error) || '保存失败')
            if (r && r.code === 'conflict') setMsg('文档已被外部修改，本次改动未写入；点工具条刷新后对照最新正文重改。')
            return
          }
          setSaveState('已保存 ' + nowStamp().slice(11))
          var after = reanchorAll(oldComments, newContent)
          setDoc(function (cur) {
            return (cur && cur.path === curDoc.path)
              ? Object.assign({}, cur, { content: newContent, hash: r.hash, mtimeMs: r.mtimeMs, review: Object.assign({}, cur.review, { docHash: r.hash, docMtimeMs: r.mtimeMs }) })
              : cur
          })
          persistAnchors(curDoc.path, after)
        }).catch(function (err2) {
          setSaveState('保存失败'); setErr('保存失败：' + err2.message)
        })
      }

      /* 引擎事件绑定（init 时挂一次；正文容器 contenteditable） */
      function engInit() {
        var host = engHostRef.current
        var curDoc = latestDocRef.current
        if (!host || !curDoc) return null
        host.setAttribute('contenteditable', 'true')
        host.setAttribute('spellcheck', 'false')
        var e = {
          lines: String(curDoc.content || '').split(/\r?\n/),
          maps: [], rawLine: -1, undo: [], burstOpen: false, syncing: false,
          tableOpen: {}, host: host,
          convertTimer: 0, burstTimer: 0, mouseDown: false, pendingAfterMouse: false,
          disposers: [],
        }
        engRef.current = e
        engRenderAll()

        function on(sel, ev, fn, cap) {
          (sel === 'host' ? host : document).addEventListener(ev, fn, !!cap)
          e.disposers.push(function () { (sel === 'host' ? host : document).removeEventListener(ev, fn, !!cap) })
        }

        /* 失焦（点到工具条/右栏/外面）→ raw 行渲染回去，正文回到纯阅读外观 */
        on('host', 'blur', function () { engLeaveRawLine() })

        /* 坑②：不在 mousedown 里换内容；转换统一延后，浏览器先自己落点。
         * 例外——表格块：点入时整块转成 raw 行（Typora 也无行级表格），转换后手动落点。 */
        on('doc', 'mousedown', function (ev2) {
          if (!host.contains(ev2.target)) return
          e.mouseDown = true
          var tbl = ev2.target && ev2.target.closest ? ev2.target.closest('.tl-table') : null
          if (!tbl) return
          ev2.preventDefault()
          ev2.stopPropagation()
          var bi = Number(tbl.getAttribute('data-bi'))
          e.tableOpen[bi] = true
          engRenderAll()
          var el = null
          try {
            var r = document.caretRangeFromPoint(ev2.clientX, ev2.clientY)
            if (r) {
              var nd = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode
              el = nd && nd.closest ? nd.closest('.tl') : null
              if (el) {
                r.collapse(true)
                var s2 = window.getSelection(); s2.removeAllRanges(); s2.addRange(r)
              }
            }
          } catch (_) {}
          if (el) {
            var i2 = Number(el.getAttribute('data-ls')) - 1
            /* 先取落点偏移再 collapse（collapse 后 toString 长度恒为 0） */
            var rOff2 = 0
            try {
              var rClone = document.createRange()
              rClone.selectNodeContents(el)
              rClone.setEnd(r.startContainer, r.startOffset)
              rOff2 = rClone.toString().length
            } catch (_) {}
            rOff2 = Math.min(rOff2, (e.lines[i2] || '').length)
            if (e.rawLine >= 0 && e.rawLine !== i2) engReleaseOldRaw(i2)
            e.rawLine = i2
            engConvertLine(i2)
            el = engLineAt(i2)
            if (el) {
              engSetCaret(el, rOff2)
              engSyncPipeline(el, e.lines[i2] || '', rOff2)
            }
          }
        }, true)
        on('doc', 'mouseup', function (ev2) {
          if (!e.mouseDown) return
          e.mouseDown = false
          if (!e.pendingAfterMouse) return
          e.pendingAfterMouse = false
          var s = window.getSelection()
          if (!s || !s.rangeCount || !s.isCollapsed) return
          if (document.activeElement !== host) return
          clearTimeout(e.convertTimer)
          e.convertTimer = setTimeout(engEnsureRawAtCaret, 0)
        }, true)
        on('doc', 'selectionchange', function () {
          if (!document.activeElement || document.activeElement !== host) {
            if (e.rawLine >= 0 && !engSelectionInDoc()) engLeaveRawLine()
            return
          }
          var s = window.getSelection()
          if (!s || !s.rangeCount || !s.isCollapsed) return
          var el = engCaretEl()
          if (!el) return
          var mode = el.getAttribute('data-mode')
          var i = Number(el.getAttribute('data-ls')) - 1
          if (mode === 'r') {
            if (e.mouseDown) { e.pendingAfterMouse = true; return }
            clearTimeout(e.convertTimer)
            e.convertTimer = setTimeout(engEnsureRawAtCaret, 0)
          } else if (mode === 'raw' && e.rawLine >= 0 && e.rawLine !== i) {
            engReleaseOldRaw(i)
            e.rawLine = i
          }
        })
        function engSelectionInDoc() {
          var s = window.getSelection()
          if (!s || !s.rangeCount) return false
          var n = s.getRangeAt(0).startContainer
          return host.contains(n.nodeType === 1 ? n : n.parentNode)
        }

        /* 打字只回写源码，不重建 DOM；undo 快照按打字爆发记 */
        on('host', 'input', function () { if (!e.syncing) { engResyncFromDOM(); engScheduleSave() } })
        on('host', 'beforeinput', function (ev2) {
          var s = window.getSelection()
          if (!s || !s.rangeCount) return
          if (e.syncing) return
          var it = ev2.inputType || ''
          if (it === 'insertText' || it === 'deleteContentBackward' || it === 'insertLineBreak') {
            clearTimeout(e.burstTimer)
            if (!e.burstOpen) { engSnapshot(); e.burstOpen = true }
            e.burstTimer = setTimeout(function () { e.burstOpen = false }, 800)
          }
          /* 带选区打字：先把涉及行转 raw，防语法被摧毁 */
          var r = s.getRangeAt(0)
          var a = (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode)
          a = a && a.closest ? a.closest('.tl') : null
          var b = (r.endContainer.nodeType === 1 ? r.endContainer : r.endContainer.parentNode)
          b = b && b.closest ? b.closest('.tl') : null
          if (a && a.getAttribute('data-mode') === 'r') { var ai = Number(a.getAttribute('data-ls')) - 1; engConvertLine(ai); e.rawLine = ai }
          if (b && b !== a && b.getAttribute('data-mode') === 'r') { var bi2 = Number(b.getAttribute('data-ls')) - 1; engConvertLine(bi2); e.rawLine = bi2 }
        })

        on('host', 'keydown', function (ev2) {
          if ((ev2.metaKey || ev2.ctrlKey) && (ev2.key === 'z' || ev2.key === 'Z')) { ev2.preventDefault(); engUndo(); return }
          var el = engCaretEl()
          if (!el) return
          var i = Number(el.getAttribute('data-ls')) - 1
          var mode = el.getAttribute('data-mode')
          var off = engCaretOffsetIn(el)

          if (ev2.key === 'ArrowDown' || ev2.key === 'ArrowUp') {
            var j = ev2.key === 'ArrowDown' ? i + 1 : i - 1
            if (j < 0 || j >= e.lines.length) return
            var target = engLineAt(j)
            if (target && target.getAttribute('data-mode') === 'r') engConvertLine(j)
            return
          }
          if (ev2.key === 'ArrowLeft' && mode === 'raw' && off === 0 && i > 0) {
            ev2.preventDefault()
            engConvertLine(i - 1); e.rawLine = i - 1
            engRepaintLine(i, false)
            var prev = engLineAt(i - 1)
            if (prev) { var pOff = (e.lines[i - 1] || '').length; engSetCaret(prev, pOff); engSyncPipeline(prev, e.lines[i - 1] || '', pOff) }
            return
          }
          if (ev2.key === 'ArrowRight' && mode === 'raw' && off >= el.textContent.replace(/\u200B/g, '').length && i < e.lines.length - 1) {
            ev2.preventDefault()
            engConvertLine(i + 1); e.rawLine = i + 1
            engRepaintLine(i, false)
            var next = engLineAt(i + 1)
            if (next) { engSetCaret(next, 0); engSyncPipeline(next, e.lines[i + 1] || '', 0) }
            return
          }
          if (ev2.key !== 'Enter' && ev2.key !== 'Backspace') return
          if (mode !== 'raw') return

          if (ev2.key === 'Enter') {
            ev2.preventDefault()
            engSnapshot()
            var text = el.textContent.replace(/\u200B/g, '')
            var head = text.slice(0, off), tail = text.slice(off)
            var c = lineKind(text)
            var prefix = ''
            if (c.t === 'uli') prefix = c.indent + c.marker + ' '
            else if (c.t === 'oli') prefix = c.indent + (parseInt(c.marker, 10) + 1) + (c.marker.indexOf(')') >= 0 ? ')' : '.') + ' '
            else if (c.t === 'quote') prefix = '> '
            if ((c.t === 'uli' || c.t === 'oli' || c.t === 'quote') && !tail.trim() && !head.replace(/^(>|[-*+]|\d+[.)]|\s)+/, '').trim()) {
              e.lines.splice(i, 1)
              if (c.t !== 'quote') e.lines.splice(i, 0, '')
              e.rawLine = Math.min(i, e.lines.length - 1)
              engRenderAll()
              var ne = engLineAt(e.rawLine)
              if (ne) { engSetCaret(ne, 0); engSyncPipeline(ne, e.lines[e.rawLine] || '', 0) }
              engScheduleSave(); return
            }
            e.lines[i] = head
            e.lines.splice(i + 1, 0, prefix + tail)
            e.rawLine = i + 1
            engRenderAll()
            var el2 = engLineAt(i + 1)
            if (el2) { engSetCaret(el2, prefix.length); engSyncPipeline(el2, e.lines[i + 1], prefix.length) }
            engScheduleSave(); return
          }
          if (ev2.key === 'Backspace' && off === 0) {
            if (i === 0) return
            ev2.preventDefault()
            engSnapshot()
            var cur = el.textContent.replace(/\u200B/g, '')
            var prevLen = (e.lines[i - 1] || '').length
            e.lines[i - 1] = (e.lines[i - 1] || '') + cur
            e.lines.splice(i, 1)
            e.rawLine = i - 1
            engRenderAll()
            var el3 = engLineAt(i - 1)
            if (el3) { engSetCaret(el3, prevLen); engSyncPipeline(el3, e.lines[i - 1], prevLen) }
            engScheduleSave(); return
          }
        })

        on('host', 'paste', function (ev2) {
          ev2.preventDefault()
          var text = (ev2.clipboardData && ev2.clipboardData.getData('text/plain')) || ''
          try { document.execCommand('insertText', false, text) } catch (_) {}
        })

        /* 行末批注钮 / 徽标 / 提案按钮：事件委托（它们在引擎渲染的 innerHTML 里） */
        on('host', 'click', function (ev2) {
          var btn = ev2.target && ev2.target.closest ? ev2.target.closest('[data-act]') : null
          if (!btn) return
          ev2.stopPropagation()
          var act = btn.getAttribute('data-act')
          if (act === 'lineadd') {
            engLineAddClick(btn)
          } else if (act === 'mark') {
            activate(btn.getAttribute('data-cid'), 'doc')
          } else if (act === 'prop-accept') {
            propDecide('accept', [btn.getAttribute('data-id')])
          } else if (act === 'prop-reject') {
            propDecide('reject', [btn.getAttribute('data-id')])
          }
        }, true)

        /* 行末批注钮的视觉行吸附：mousemove 时取指针所在视觉行（caretRangeFromPoint 的
         * 插入符矩形），把钮挪到那一行的行末并点亮；指针离开块即熄灭。
         * 一个源码行可折成多个视觉行，这正是 CSS top:50% 做不到的定位粒度。 */
        var floatBtn = null
        on('host', 'mousemove', function (ev2) {
          var blk = ev2.target && ev2.target.closest ? ev2.target.closest('.dr-block') : null
          if (blk) {
            /* 指针落在钮自己身上时不重算（保持可点） */
            if (floatBtn && ev2.target.closest && ev2.target.closest('.dr-lineadd')) { return }
            var btn = blk.querySelector(':scope > .dr-lineadd')
            if (btn) {
              var rect = null
              if (document.caretRangeFromPoint) {
                var rg = document.caretRangeFromPoint(ev2.clientX, ev2.clientY)
                if (rg) { var rs = rg.getClientRects(); rect = rs && rs.length ? rs[0] : rg.getBoundingClientRect() }
              } else if (document.caretPositionFromPoint) {
                var cp = document.caretPositionFromPoint(ev2.clientX, ev2.clientY)
                if (cp) {
                  var rg2 = document.createRange()
                  rg2.setStart(cp.offsetNode, cp.offset); rg2.setEnd(cp.offsetNode, cp.offset)
                  var rs2 = rg2.getClientRects(); rect = rs2 && rs2.length ? rs2[0] : null
                }
              }
              if (rect && rect.height) {
                var br = blk.getBoundingClientRect()
                btn.style.top = (rect.top + rect.height / 2 - br.top) + 'px'
                btn.classList.add('on')
                floatBtn = btn
                return
              }
            }
          }
          if (floatBtn) { floatBtn.classList.remove('on'); floatBtn = null }
        })
        on('host', 'mouseleave', function () {
          if (floatBtn) { floatBtn.classList.remove('on'); floatBtn = null }
        })

        return e
      }

      function engLineAddClick(btn) {
        var sc2 = docRef.current
        if (!sc2) return
        var ls = Number(btn.getAttribute('data-ls')), le = Number(btn.getAttribute('data-le'))
        var blk = btn.closest('.dr-block')
        if (!blk) return
        var text = String(blk.textContent || '').replace(/\s+/g, ' ').trim()
        if (!text) return
        var r = blk.getBoundingClientRect()
        var dH2 = Math.max(1, sc2.scrollHeight)
        var t02 = sc2.getBoundingClientRect().top - sc2.scrollTop
        var dTop = Math.min(1, Math.max(0, (r.top - t02) / dH2)) * dH2
        var blockRange = document.createRange()
        try { blockRange.selectNodeContents(blk) } catch (_) {}
        setSel({
          quote: text.length > 1200 ? text.slice(0, 1200) : text,
          ls: ls, le: le, left: 0, above: false,
          top: r.top, bottom: r.bottom, rect: r,
          anchorX: null, anchorY: null, docTop: dTop, range: blockRange,
        })
        setDraft('')
        setNotesCollapsed(false)
        setDocStage('open')
      }

      function engDispose() {
        var e = eng()
        if (!e) return
        clearTimeout(e.convertTimer); clearTimeout(e.burstTimer)
        for (var k = 0; k < e.disposers.length; k++) { try { e.disposers[k]() } catch (_) {} }
        engRef.current = null
      }

      function addComment(quote, ls, le, note) {
        var c = {
          id: newId(), createdAt: nowStamp(), updatedAt: nowStamp(), author: author,
          lineStart: ls || 0, lineEnd: le || ls || 0, quote: quote || '', note: note || '',
          status: 'pending', reply: '', resolvedAt: null,
        }
        persist(comments.concat([c]), true)
        return c
      }

      function patchComment(id, patch, immediate) {
        persist(comments.map(function (c) { return c.id === id ? Object.assign({}, c, patch, { updatedAt: nowStamp() }) : c }), immediate)
      }

      function removeComment(id) {
        if (activeRef.current === id) setActiveId(null)
        persist(comments.filter(function (c) { return c.id !== id }), true)
      }

      /* ── Reply thread / in-place edit ── */
      function addReply(c) {
        var text = String(replyDrafts[c.id] || '').trim()
        if (!text) return
        // Seed with the visible thread so a legacy single `reply` is not hidden by the first new reply.
        var base = threadOf(c).slice()
        var r = { id: 'r_' + newId().slice(2), author: author || '我', role: 'user', text: text, createdAt: nowStamp() }
        patchComment(c.id, { replies: base.concat([r]) }, true)
        setReplyDrafts(function (cur) { var n = Object.assign({}, cur); delete n[c.id]; return n })
      }

      function saveEdit() {
        if (!editing) return
        var text = String(editing.text || '').trim()
        if (!text) return
        patchComment(editing.id, { note: text }, true)
        setEditing(null)
      }

      function saveReplyEdit(parent, replyId, text) {
        text = String(text || '').trim()
        if (!text) return
        patchComment(parent.id, { replies: threadOf(parent).map(function (r) { return r.id === replyId ? Object.assign({}, r, { text: text, updatedAt: nowStamp() }) : r }) }, true)
        setReplyEditing(null)
      }

      /* ── Anchors: precise highlight, hover, flash, rail markers ── */
      function paintAnchors() {
        if (!hlSupported()) return
        try {
          var base = [], hot = []
          var map = rangesRef.current
          var fl = flashRef.current
          Object.keys(map).forEach(function (id) {
            var r = map[id]
            if (fl && fl.id === id) { (fl.on ? hot : base).push(r); return }
            if (id === activeRef.current || id === hoverRef.current) hot.push(r)
            else base.push(r)
          })
          var hb = new Highlight(); base.forEach(function (r) { hb.add(r) })
          var hh = new Highlight(); hot.forEach(function (r) { hh.add(r) })
          hh.priority = 1
          CSS.highlights.set('dr-anchor', hb)
          CSS.highlights.set('dr-anchor-active', hh)
        } catch (e) {}
      }

      function clearAnchors() {
        try { if (window.CSS && CSS.highlights) { CSS.highlights.delete('dr-anchor'); CSS.highlights.delete('dr-anchor-active') } } catch (e) {}
      }

      /** 评论面板与正文同步滚动（飞书式：卡片高度对应选中的文本行）。 */
      function syncNotesScroll() {
        var dc = docRef.current, nc = notesRef.current
        if (!dc || !nc) return
        nc.scrollTop = dc.scrollTop
      }

      function measureMarkers() {
        var sc = docRef.current
        if (!sc) { setMarkers(function (cur) { return cur.length ? [] : cur }); return }
        var top0 = sc.getBoundingClientRect().top - sc.scrollTop
        var H = Math.max(1, sc.scrollHeight)
        var next = []
        comments.forEach(function (c, i) {
          var r = rangesRef.current[c.id]
          if (!r) return
          var rc = r.getBoundingClientRect()
          if (!rc || (!rc.width && !rc.height)) return
          next.push({ id: c.id, n: i + 1, top: Math.min(1, Math.max(0, (rc.top - top0) / H)), title: markTitle(c, i + 1) })
        })
        setMarkers(function (cur) {
          var same = cur.length === next.length && cur.every(function (m, k) { return m.id === next[k].id && Math.abs(m.top - next[k].top) < 0.002 && m.title === next[k].title })
          return same ? cur : next
        })
      }

      // Rebuild quote ranges after every content/comment change (pending + anchored only).
      function rebuildRanges() {
        var root = docRef.current
        var map = {}
        if (root) {
          comments.forEach(function (c) {
            if ((c.status || 'pending') !== 'pending' || c.anchored === false) return
            var r = null
            try { r = rangeForQuote(root, c) } catch (e) { r = null }
            if (r) map[c.id] = r
          })
        }
        rangesRef.current = map
        paintAnchors()
        measureMarkers()
      }
      useEffect(rebuildRanges, [doc && doc.path, doc && doc.content, comments, propPending.length])

      /* Typora 行级引擎生命周期：打开/刷新文档时重建；卸载时解绑。
       * 依赖只有 path + loadRev——保存回包更新 doc.content/hash 不会重建引擎（打字中不能丢光标）。 */
      useEffect(function () {
        if (!doc || !doc.path || !engHostRef.current) { engDispose(); return undefined }
        engDispose()
        engInit()
        rebuildRanges()   // 本 effect 晚于 ranges effect（首次挂载时正文还没建出来）
        return function () { engDispose() }
      }, [doc && doc.path, loadRev])

      /* 批注/提案/折叠变化 → 软刷新块结构（徽标、行末钮、提案卡）；raw 行与光标不动。
       * 块 DOM 重建后锚点 Range 会失效，软刷新完再重建一次 ranges。 */
      useEffect(function () {
        if (engRef.current && engHostRef.current) { engSoftRefresh(); rebuildRanges() }
      }, [comments, propPending.length, notesCollapsed])

      useEffect(function () { paintAnchors() }, [activeId])

      // Keep rail markers honest when the column resizes (window resize, sidebar fold).
      useEffect(function () {
        var sc = docRef.current
        if (!sc || typeof ResizeObserver === 'undefined') return undefined
        var ro = new ResizeObserver(function () { measureMarkers() })
        ro.observe(sc)
        return function () { ro.disconnect() }
      }, [doc && doc.path, comments])

      /* 锚定项测量：重排必须用卡片真实高度。必须在 layout 阶段、每次渲染后都跑——
       * 依赖数组猜不准挂载时机（doc 加载不在旧依赖里），漏跑一次卡片就永远 opacity:0。
       * 每帧量 + 视未测项为透明；layout effect 里 setState 会在 paint 前同步重渲染，
       * 所以浏览器画出来的那一帧就已经带真实高度：既不闪重叠、也不会消失。
       * ResizeObserver 另行覆盖后续尺寸变化（窄屏换行、回复展开）。 */
      useLayoutEffect(function () {
        var keys = Object.keys(anchorEls.current)
        var changed = false
        function measure(el, key) {
          var m = el ? el.offsetHeight : 0
          if ((anchorHeights.current[key] || 0) === m) return false
          anchorHeights.current[key] = m
          return true
        }
        keys.forEach(function (k) { if (measure(anchorEls.current[k], k)) changed = true })
        if (changed) setAnchorTick(function (t) { return t + 1 })
      })
      useEffect(function () {
        var keys = Object.keys(anchorEls.current)
        var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(function (entries) {
          var resized = false
          entries.forEach(function (entry) {
            var key = entry.target.getAttribute('data-anchor-key')
            if (key && measureRo(entry.target, key)) resized = true
          })
          if (resized) setAnchorTick(function (t) { return t + 1 })
        }) : null
        function measureRo(el, key) {
          var m = el ? el.offsetHeight : 0
          if ((anchorHeights.current[key] || 0) === m) return false
          anchorHeights.current[key] = m
          return true
        }
        if (ro) keys.forEach(function (k) { if (anchorEls.current[k]) ro.observe(anchorEls.current[k]) })
        return function () { if (ro) ro.disconnect() }
      }, [comments, filterMode, showResolved, sel, docStage, editing, replyDrafts, activeId, anchorTick])

      useEffect(function () {
        return function () {
          clearAnchors()
          if (flashTimer.current) clearTimeout(flashTimer.current)
          if (hoverRaf.current) cancelAnimationFrame(hoverRaf.current)
        }
      }, [])

      function hitAnchor(x, y) {
        var map = rangesRef.current
        var ids = Object.keys(map)
        if (activeRef.current && map[activeRef.current]) ids.unshift(activeRef.current)
        for (var i = 0; i < ids.length; i++) {
          var rects = map[ids[i]].getClientRects()
          for (var k = 0; k < rects.length; k++) {
            var b = rects[k]
            if (x >= b.left - 1 && x <= b.right + 1 && y >= b.top - 1 && y <= b.bottom + 1) return ids[i]
          }
        }
        return null
      }

      function setHover(id) {
        if (hoverRef.current === id) return
        hoverRef.current = id
        var sc = docRef.current
        if (sc) sc.classList.toggle('dr-doc-hot', !!id && !!rangesRef.current[id])
        paintAnchors()
      }

      function onDocMouseMove(e) {
        var x = e.clientX, y = e.clientY
        if (hoverRaf.current) return
        hoverRaf.current = requestAnimationFrame(function () {
          hoverRaf.current = 0
          setHover(hitAnchor(x, y))
        })
      }

      function onDocClick(e) {
        var s = window.getSelection && window.getSelection()
        if (s && !s.isCollapsed) return               // a drag-select, not a click
        if (e.target && e.target.closest && e.target.closest('button,a,.dr-inline-prop')) return
        // Typora 行级编辑：点正文文本 = 放光标编辑（引擎负责）；锚点激活只走徽标/卡片。
        if (e.target && e.target.closest && e.target.closest('.tl')) return
        var id = hitAnchor(e.clientX, e.clientY)
        if (id) activate(id, 'doc')
        else if (activeRef.current) setActiveId(null)
      }

      function flashAnchor(id) {
        if (flashTimer.current) clearTimeout(flashTimer.current)
        flashRef.current = null
        if (reducedMotion() || !rangesRef.current[id]) { paintAnchors(); return }
        var steps = [false, true, false, true]
        var i = 0
        var tick = function () {
          if (i >= steps.length) { flashRef.current = null; flashTimer.current = null; paintAnchors(); return }
          flashRef.current = { id: id, on: steps[i++] }
          paintAnchors()
          flashTimer.current = setTimeout(tick, 150)
        }
        flashTimer.current = setTimeout(tick, 220)    // let the smooth scroll land first
      }

      /** Activate a comment from the doc body, its card, or the rail; align card and anchor (best effort). */
      function activate(id, from) {
        setNotesCollapsed(false)
        setActiveId(id)
        activeRef.current = id
        paintAnchors()
        var c = null
        for (var k = 0; k < comments.length; k++) if (comments[k].id === id) c = comments[k]
        if (c && (c.status || 'pending') !== 'pending') setShowResolved(true)
        /* 等激活态样式与碰撞防重叠的实测高度完成重排，再按最新几何位置同步两栏。
         * 单帧计算会读到旧卡片 top，结果就是正文锚点已选中、右侧卡片却没跟上。 */
        requestAnimationFrame(function () { requestAnimationFrame(function () {
          try {
            var sc = docRef.current, ns = notesRef.current
            var card = ns ? ns.querySelector('[data-cid="' + id + '"]') : null
            var range = rangesRef.current[id]
            var behavior = scrollBehavior()
            if (!range) {
              if (from !== 'doc' && c && c.anchored !== false) scrollToLine(c.lineStart)
              /* 卡片箭头（from==='card'）发起的跳转也必须把目标卡滚进右栏视野；
                 此前的 from !== 'card' 门槛把这条路挡死了——正文滚了、卡片列表纹丝不动。 */
              if (card) card.scrollIntoView({ block: 'nearest', behavior: behavior })
              return
            }
            var a = range.getBoundingClientRect()
            var D = sc.getBoundingClientRect()
            var cr = card ? card.getBoundingClientRect() : null
            var N = ns ? ns.getBoundingClientRect() : null
            var anchorTop = a.top
            if (from !== 'doc') {
              var want = (from === 'card' && cr) ? cr.top : D.top + D.height / 3
              var dd = alignDelta(a.top, a.height, want, D.top, D.bottom)
              if (Math.abs(dd) > 1) sc.scrollBy({ top: dd, behavior: behavior })
              anchorTop = a.top - dd
              flashAnchor(id)
            }
            if (from !== 'card' && cr && N) {
              var cd = alignDelta(cr.top, cr.height, anchorTop, N.top, N.bottom)
              if (Math.abs(cd) > 1) ns.scrollBy({ top: cd, behavior: behavior })
            }
            /* from==='card'：正文滚动会经 syncNotesScroll 带动右栏锚定卡片；但卡片可能
               因防重叠位移而在正文滚完后仍落在视野外——按滚动后的预估位置兜底补一滚。 */
            if (from === 'card' && cr && N) {
              var after = cr.top - (dd || 0)
              if (after < N.top + 8 || after + cr.height > N.bottom - 8) {
                var fix = alignDelta(after, cr.height, N.top + Math.max(8, (N.height - cr.height) / 2), N.top, N.bottom)
                if (Math.abs(fix) > 1) ns.scrollBy({ top: fix, behavior: behavior })
              }
            }
          } catch (e) {}
        }) })
      }

      /* 划词 → 记录选区并映射源码行。飞书式：先浮出小工具条（批注 / 复制），点「批注」再展开输入框。
       * Typora 行级编辑里单击 = 编辑光标（引擎负责），这里只处理「拖出了选区」的批注流程。 */
      function onMouseUp(e) {
        try {
          var s = window.getSelection()
          var collapsed = !s || s.isCollapsed
          var text = collapsed ? '' : String(s.toString() || '').trim()
          // composer 已打开且选区为空：这是 pill「批注」按钮 mousedown 后，右栏 textarea
          // autoFocus 抢走 document 焦点导致页面选区折叠，而 mouseup 又因 pill 卸载、
          // 事件落到文档区冒泡上来——此时不能据此关掉 composer。composer 打开时用户若
          // 再划一段新词，选区非空，会正常走下面的分支切回 pill。
          if (docStage === 'open' && collapsed && !text) return
          if (collapsed) { setSel(null); setDocStage(null); return }
          if (!text) { setSel(null); setDocStage(null); return }
          var range = s.getRangeAt(0)
          var el1 = blockOf(range.startContainer)
          var el2 = blockOf(range.endContainer) || el1
          if (!el1) { setSel(null); setDocStage(null); return }
          var ls = Number(el1.getAttribute('data-ls')) || 0
          var le = Number((el2 || el1).getAttribute('data-le')) || ls
          var rect = range.getBoundingClientRect()
          /* 原生选区还在亮着，这里不能叠加 dr-pending 高亮（会出现两套选中样式）；
             把 range 存进 sel，等真正展开输入框（原生选区被焦点折叠）时再钉住。 */
          /* 视口 rect 会随正文滚动过期；换成文档坐标存下，右栏锚定永远跟着这一行走。 */
          var docTop = null
          var scSel = docRef.current
          if (scSel) {
            var dHSel = Math.max(1, scSel.scrollHeight)
            var t0Sel = scSel.getBoundingClientRect().top - scSel.scrollTop
            docTop = Math.min(1, Math.max(0, (rect.top - t0Sel) / dHSel)) * dHSel
          }
          var place = floatPlacement(rect, window.innerWidth || 900, window.innerHeight || 700)
          // 工具条锚点优先记鼠标松开的位置（用户松手处）；键盘 Shift 选段没有鼠标事件时置空，退回选区几何中心。
          var anchorX = (e && typeof e.clientX === 'number' && (e.clientX || e.clientX === 0)) ? e.clientX : null
          var anchorY = (e && typeof e.clientY === 'number' && (e.clientY || e.clientY === 0)) ? e.clientY : null
          setSel({
            quote: text.length > 1200 ? text.slice(0, 1200) : text,
            ls: ls, le: le, left: place.left, above: place.above, top: place.top, bottom: place.bottom,
            rect: rect, anchorX: anchorX, anchorY: anchorY, docTop: docTop, range: range,
          })
          setDocStage('pill')
          setDraft('')
        } catch (err) { if (docStage !== 'open') { setSel(null); setDocStage(null) } }
      }

      function blockOf(node) {
        var el = node && node.nodeType === 3 ? node.parentNode : node
        while (el && el.getAttribute) {
          if (el.getAttribute('data-ls') !== null) return el
          el = el.parentNode
        }
        return null
      }

      /* 待批注的选区高亮：弹框抢走焦点后浏览器原生选区会变淡，用 CSS Custom Highlight 把它钉住，
         这样"我到底选了哪段"始终看得见（Chrome 105+，拿不到就静默跳过）。 */
      var HL_NAME = 'dr-pending'
      function tapHighlight(range) {
        try {
          if (typeof Highlight === 'undefined' || !window.CSS || !CSS.highlights) return
          CSS.highlights.set(HL_NAME, new Highlight(range.cloneRange()))
        } catch (e) {}
      }
      function dropHighlight() {
        try { if (window.CSS && CSS.highlights) CSS.highlights.delete(HL_NAME) } catch (e) {}
      }

      function commitSelection() {
        if (!sel || !draft.trim()) return
        addComment(sel.quote, sel.ls, sel.le, draft.trim())
        setSel(null)
        setDraft('')
        setDocStage(null)
      }

      function buildAgentPrompt() {
        if (!doc) return ''
        var L = []
        L.push('请按批注改这份文档：' + doc.path)
        L.push('批注文件：' + reviewPathOf(doc.path) + '（也可调用 doc_review_list 工具，doc 传上面的路径）')
        L.push('待处理批注 ' + pending.length + ' 条：')
        pending.forEach(function (c, i) {
          var head = c.lineStart ? ('L' + c.lineStart + (c.lineEnd && c.lineEnd !== c.lineStart ? '–L' + c.lineEnd : '')) : '全文'
          L.push((i + 1) + '. [' + c.id + '] ' + head + ' 意见：' + (c.note || '（空）'))
          if (c.quote) L.push('   原文：' + c.quote.replace(/\s+/g, ' ').slice(0, 140))
        })
        if (globalNote.trim()) L.push('整篇意见：' + globalNote.trim())
        L.push('要求：只改批注指向的位置，其余内容不动，保持一次成型的写法；改完调用 doc_review_resolve 把对应 id 标记为已处理，reply 里一句话说明改了什么。')
        L.push('处理完后额外做一件事：调 doc_review_mine_candidates 看最近批注有没有反复出现 ≥3 次 / ≥2 篇文档的共性模式；若有，列前 2-3 条候选规则告诉用户是否固化到规则库（/doc-review 技能里 doc_review_rules_add）。没有就不要打扰。')
        return L.join('\n')
      }

      function currentSessionId() {
        try {
          if (!sessions || !sessions.list) return ''
          var snap = sessions.list.getSnapshot()
          if (!snap) return ''
          if (snap.current) return String(snap.current)
          var ids = (snap.ids && snap.ids.length) ? snap.ids : Object.keys(snap.byId || {})
          var best = '', bestAt = -1
          for (var i = 0; i < ids.length; i++) {
            var row = snap.byId && snap.byId[ids[i]]
            if (!row || !row.retainedBy || !(row.retainedBy.mainView > 0)) continue
            var at = Number(row.updatedAt) || 0
            if (at > bestAt) { bestAt = at; best = String(ids[i]) }
          }
          return best
        } catch (e) { return '' }
      }

      function sendToAgent() {
        var prompt = buildAgentPrompt()
        if (!prompt) return
        var sid = currentSessionId()
        if (!remoteFace || !remoteFace.session || typeof remoteFace.session.prompt !== 'function' || !sid) {
          copyToClipboard(prompt)
          setMsg('当前会话 id 或 remote 面不可用，已把指令复制到剪贴板，粘到输入框发送即可。')
          return
        }
        remoteFace.session.prompt({
          requestId: uuid(), sessionId: sid, mode: 'queue',
          content: [{ type: 'text', text: prompt }], clientTimeZone: tz(),
        }).then(function () {
          setMsg('已发给 AI（' + pending.length + ' 条批注）。切到对话页看它逐条改，改完这里会自动变「已处理」。')
        }).catch(function (e) {
          copyToClipboard(prompt)
          setMsg('发送失败（' + ((e && e.message) || e) + '），已复制到剪贴板。')
        })
      }

      function copyToClipboard(text) {
        try { navigator.clipboard.writeText(text) } catch (e) {}
      }

      /* Line → pending comment index. Only used as a fallback block tint when the
         CSS Custom Highlight API is missing; resolved / lost anchors never tint. */
      var HL_OK = hlSupported()
      var byLine = useMemo(function () {
        var map = {}
        /* 不再因 HL_OK 清空：侧栏折叠时的行末评论数徽标（dr-mark-count）也靠这张表，
           Highlight API 只接管正文划线，接管不了「这行有几条评论」的入口。 */
        comments.forEach(function (c, i) {
          if (!c.lineStart || c.anchored === false) return
          if ((c.status || 'pending') !== 'pending') return
          for (var l = c.lineStart; l <= (c.lineEnd || c.lineStart); l++) {
            if (!map[l]) map[l] = []
            map[l].push(i)
          }
        })
        return map
      }, [doc && doc.path, comments, HL_OK])

      /** 左栏可见顺序：默认最近产出在前；切到「待处理」时待处理条数优先，再看时间 */
      var visibleDocs = useMemo(function () {
        // 分层优先：本会话产出的文档永远排在前面，本项目其它会话碰过的排后面；层内才按时间/待处理排。
        // 层内时间用 host 给的 seenMs（会话里最后一次动它的时间）优先，没有才用文件 mtime。
        var rank = function (d) { return d.tier === 'project' ? 1 : 0 }
        // 第一层用「会话里最后一次动它的时间」，第二层用文件改动时间——与显示的、与 host 的口径一致
        var when = function (d) { return d.tier === 'project' ? d.mtimeMs : (d.seenMs || d.mtimeMs) }
        var arr = docs.slice()
        arr.sort(function (a, b) {
          var r = rank(a) - rank(b)
          if (r) return r
          if (sortMode === 'pending') return ((b.pending || 0) - (a.pending || 0)) || (when(b) - when(a))
          return when(b) - when(a)
        })
        return arr
      }, [docs, sortMode])

      var tierCounts = useMemo(function () {
        var s = 0, p = 0
        visibleDocs.forEach(function (d) { if (d.tier === 'project') p++; else s++ })
        return { session: s, project: p }
      }, [visibleDocs])

      /* 目录树：把文档按它相对根目录的文件夹归拢，像文件管理器那样折叠。
       *
       * 关键决定：树的节点按「目录前缀」建，而不是按「文档所属目录」建。
       * 后者只会得到一层扁平的 dir → files，`docs/a.md` 和 `docs/sub/b.md` 会各起一行
       * 「docs」与「docs/sub」，缩进是算出来的、不是嵌套出来的——看起来像树，实际是列表。
       * 这里改用前缀表：`docs` 是 `docs/sub` 的父亲，子目录挂在父目录下，缩进由深度决定。
       *
       * 「本会话 / 本项目」不再是分组标题，而是每行的一枚标签——同一份文档只属于一条路径，
       * 按层级分组才符合找文件的手感；而它是不是本会话碰过的，是这一行的属性，不是它的位置。
       * 折叠状态落 localStorage，跟排序、范围两个偏好一个待遇。
       * 算不出相对路径（root 缺失、或文件在根之外）的文档归到一个「根目录」节点，不假装它在别处。 */
      // 列表视图：tree＝按目录层级｜flat＝按「本会话 / 本项目」分组平铺。
      // 两者互补：树回答「它在哪个文件夹」，平铺回答「谁动过它」。
      // 本机偏好，与排序、范围同一个待遇。
      var viewPair = useState(function () {
        try { return localStorage.getItem('dsh-doc-review.view') === 'flat' ? 'flat' : 'tree' } catch (eV) { return 'tree' }
      })
      var listView = viewPair[0], setListView = viewPair[1]
      var collPair = useState(function () {
        try { return JSON.parse(localStorage.getItem('dsh-doc-review.collapsed') || '{}') || {} } catch (eC) { return {} }
      })
      var collapsed = collPair[0], setCollapsed = collPair[1]
      var toggleCollapsed = function (dir) {
        setCollapsed(function (cur) {
          var next = Object.assign({}, cur)
          if (next[dir]) delete next[dir]; else next[dir] = 1
          try { localStorage.setItem('dsh-doc-review.collapsed', JSON.stringify(next)) } catch (eC) {}
          return next
        })
      }

      var snotesFoldPair = useState(function () {
        try { return localStorage.getItem('dsh-doc-review.snotes') === 'open' } catch (eS) { return false }
      })
      var snotesOpen = snotesFoldPair[0], setSnotesOpen = snotesFoldPair[1]
      var toggleSnotes = function () {
        setSnotesOpen(function (cur) {
          var next = !cur
          try { localStorage.setItem('dsh-doc-review.snotes', next ? 'open' : 'folded') } catch (eS) {}
          return next
        })
      }

      /** 相对根目录的目录名（'' 表示就在根里）。返回 null 表示算不出来。 */
      function dirOfDoc(d, baseRoot) {
        var p = String(d.path || '').replace(/\\/g, '/')
        var r = String(baseRoot || '').replace(/\\/g, '/').replace(/\/+$/, '')
        if (!r) return null
        if (p.toLowerCase().indexOf(r.toLowerCase() + '/') !== 0) return null
        var rest = p.slice(r.length + 1)
        var cut = rest.lastIndexOf('/')
        return cut < 0 ? '' : rest.slice(0, cut)
      }

      /**
       * 按目录前缀建层级。每个节点是 { name, path, depth, dirs:[], files:[] }，
       * 子目录按名字排序、文件保持 visibleDocs 的既有顺序，所以「按最近/按待处理」
       * 这个排序偏好在每个文件夹内部依然生效。
       */
      function buildTree(docs, baseRoot) {
        var root = { name: '', dir: '', depth: 0, dirs: new Map(), files: [] }
        var ensure = function (dirPath) {
          var node = root
          if (!dirPath) return node
          var parts = dirPath.split('/')
          var acc = ''
          for (var i = 0; i < parts.length; i++) {
            acc = acc ? acc + '/' + parts[i] : parts[i]
            var next = node.dirs.get(parts[i])
            if (!next) {
              next = { name: parts[i], dir: acc, depth: i + 1, dirs: new Map(), files: [] }
              node.dirs.set(parts[i], next)
            }
            node = next
          }
          return node
        }
        docs.forEach(function (d) {
          var dir = dirOfDoc(d, baseRoot)
          ensure(dir === null ? '' : dir).files.push(d)
        })
        return root
      }

      var docTree = useMemo(function () {
        return buildTree(visibleDocs, (meta && meta.root) || '')
      }, [visibleDocs, meta && meta.root])

      /** 一个目录下（含子目录）一共有多少篇。目录行已不显示计数（用户要求移除），
       *  仅保留在展开逻辑可能用到时；当前无调用方。 */
      function countIn(node) {
        var n = node.files.length
        node.dirs.forEach(function (child) { n += countIn(child) })
        return n
      }

      /**
       * 把树铺成扁平的渲染序列，折叠的子树整段跳过。
       * 返回 [{node, depth, kind:'dir'|'file', doc}]，缩进直接取 depth，不再靠父目录推断。
       *
       * 顺序按文件管理器的惯例：本层文件在前，子目录在后。
       * 反过来的话，根目录的文件会被整棵子目录树推到很下面——「刚改过的 README」
       * 反而要滚到底才能看到，而这恰恰是这份列表最常被用来找的东西。
       */
      function flattenTree(node, out) {
        node.files.forEach(function (d) { out.push({ kind: 'file', node: node, depth: node.depth, doc: d }) })
        var names = [...node.dirs.keys()].sort(function (a, b) { return a.localeCompare(b, 'zh') })
        names.forEach(function (name) {
          var child = node.dirs.get(name)
          out.push({ kind: 'dir', node: child, depth: child.depth })
          if (!collapsed[child.dir]) flattenTree(child, out)
        })
        return out
      }

      /**
       * 一行文件的内部结构：文档图标 + 名字，时间与标签在第二行。
       * 目录树与平铺两种视图共用它，所以两种视图里同一份文档长得一模一样——
       * 切换视图时变的只有位置，不是这一行的身份。
       */
      /**
       * 一行文件：图标 + 文件名，时间贴在行的最右端。
       *
       * 曾经这里是两行——名字一行，下面一行挤着时间、产出/编辑/读过、批注数。
       * 那些都是「关于这份文件的事」，不是文件本身：一棵目录树要做的是让人一眼扫过
       * 有哪些文件、在哪个文件夹里，第二行只是把每行撑高一倍、把名字挤窄。
       * 时间有用且短，所以留在行内最右侧；其余标签移进 tooltip，悬停时仍然拿得到。
       */
      function fileRow(d) {
        var when = relTime(d.tier === 'project' ? d.mtimeMs : (d.seenMs || d.mtimeMs)) || d.updatedAt || ''
        var detail = []
        if (d.tier === 'project') detail.push('本项目其它会话碰过')
        else if (d.via === 'write' || d.via === 'edit') detail.push('本会话' + (d.via === 'write' ? '产出' : '编辑') + ' ' + (d.hits || 1) + ' 次')
        else if (d.via === 'read') detail.push('本会话读过')
        if (d.total) detail.push('批注 ' + d.total + (d.pending ? '（待处理 ' + d.pending + '）' : ''))
        return [
          h('span', { className: 'dr-slot dr-slot-doc', key: 'i' }, pmIcon('doc')),
          h('span', {
            key: 'n',
            className: 'dr-item-name',
            title: d.path + '\n' + new Date(d.mtimeMs).toLocaleString('zh-CN') + (detail.length ? '\n' + detail.join(' · ') : ''),
          }, d.name),
          when ? h('span', { key: 'w', className: 'dr-item-when', title: d.tier === 'project' ? '文件修改时间' : '会话最后一次操作时间' }, when) : null ]
      }

      /**
       * 一份文档在平铺视图里的行。平铺仍然按「本会话 / 本项目」分组——
       * 那正是树视图不表达的信息（树里它是每行的标签），所以两种视图互补而非重复。
       */
      function flatRow(d, indent) {
        return h('div', {
          key: d.path,
          className: 'dr-item dr-item-flat' + (doc && doc.path === d.path ? ' dr-item-on' : ''),
          role: 'treeitem',
          style: { '--dr-indent': indent + 'px' },
          title: d.path
            + (d.fromSessions ? '（来自 ' + d.fromSessions + ' 个会话）' : '')
            + (d.seenMs ? '\n会话最后动它：' + new Date(d.seenMs).toLocaleString('zh-CN') : '')
            + '\n文件修改时间：' + new Date(d.mtimeMs).toLocaleString('zh-CN'),
          onClick: function () { void openDoc(d.path) },
          tabIndex: 0,
          onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openDoc(d.path) } },
        }, fileRow(d))
      }

      var treeRows = useMemo(function () {
        return flattenTree(docTree, [])
      }, [docTree, collapsed])

      function stopKeys(e) { return !!(e.nativeEvent && e.nativeEvent.isComposing) }

      function renderCard(c, i) {
        var head = c.lineStart ? ('L' + c.lineStart + (c.lineEnd && c.lineEnd !== c.lineStart ? '–L' + c.lineEnd : '')) : '全文'
        var st = c.status || 'pending'
        var isEditing = editing && editing.id === c.id
        var thread = threadOf(c)
        var rd = replyDrafts[c.id] || ''
        var done = st !== 'pending'
        /* 上/下一个批注按右栏真实显示顺序走（范围筛选 + 锚点位置排序），
         * 不按 comments 创建顺序——两者不一致时箭头方向体感会反过来。 */
        function visibleCardIds() {
          var list = comments.filter(function (x) {
            var st = x.status || 'pending'
            if (filterMode === 'pending') return st === 'pending'
            if (filterMode === 'resolved') return st === 'resolved'
            return st === 'pending' || (showResolved && st === 'resolved')
          })
          var anchored = [], tail = []
          list.forEach(function (x) {
            var t = null
            var r = rangesRef.current[x.id]
            if (r) { try { var rc = r.getBoundingClientRect(); if (rc && (rc.width || rc.height)) t = rc.top } catch (eR) {} }
            if (t == null) tail.push(x.id); else anchored.push([t, x.id])
          })
          anchored.sort(function (a, b) { return a[0] - b[0] })
          return anchored.map(function (p) { return p[1] }).concat(tail)
        }
        function stepCard(id, dir) {
          var ids = visibleCardIds()
          if (!ids.length) return
          var j = ids.indexOf(id)
          if (j < 0) j = dir > 0 ? -1 : 0
          activate(ids[(j + dir + ids.length) % ids.length], 'card')
        }
        function iconBtn(icon, label, onClick, extra) {
          return h('button', {
            type: 'button', className: 'dr-icon-btn' + (extra ? ' ' + extra : ''), title: label, 'aria-label': label,
            onClick: function (e) { e.stopPropagation(); onClick() },
          }, pmIcon(icon))
        }
        return h('div', {
          key: c.id, 'data-cid': c.id,
          className: 'dr-card dr-card-' + st + (activeId === c.id ? ' dr-card-active' : ''),
          onClick: function (e) {
            if (e.target && e.target.closest && e.target.closest('button,input,textarea,a')) return
            activate(c.id, 'card')
          },
        },
          /* 顶部引用区（飞书式）：引用原文一行，hover 露出操作图标 */
          h('div', { className: 'dr-card-head' },
            h('div', {
              className: 'dr-card-quote', title: c.quote,
              onClick: function (e) { e.stopPropagation(); if (c.quote) activate(c.id, 'card') },
            }, c.quote || h('span', { className: 'dr-hint' }, '（整篇级意见）')),
            h('div', { className: 'dr-card-head-ops' },
              iconBtn('prev', '上一个批注', function () { stepCard(c.id, -1) }),
              iconBtn('next', '下一个批注', function () { stepCard(c.id, 1) }),
              done
                ? iconBtn('undo', '退回待处理', function () { patchComment(c.id, { status: 'pending', resolvedAt: null }, true) })
                : iconBtn('check', '确认解决', function () { patchComment(c.id, { status: 'resolved', resolvedAt: nowStamp() }, true) }))),
          /* 评论主体 */
          h('div', { className: 'dr-card-body' },
            h('div', { className: 'dr-card-meta' },
              avatarNode(c.author, 22),
              h('span', { className: 'dr-card-name' }, c.author || '匿名'),
              h('span', { className: 'dr-card-time' }, timeAgo(Date.parse(c.createdAt) || 0) || whenText(c.createdAt)),
              c.anchored === false ? h('span', { className: 'dr-status dr-status-orphan', title: '这段原文在文档里已经找不到（被改掉或删掉）。批注按规范保留不删，请人工确认。' }, '已失锚') : null,
              done ? h('span', { className: 'dr-status dr-status-resolved' }, '已解决') : null,
              h('span', { className: 'dr-spacer' }),
              h('div', { className: 'dr-card-meta-ops', onBlur: function (e) { if (!e.currentTarget.contains(e.relatedTarget)) setCardMenuId(null) } },
                h('button', {
                  type: 'button', className: 'dr-icon-btn dr-card-more', title: '更多操作', 'aria-label': '更多操作',
                  'aria-haspopup': 'menu', 'aria-expanded': cardMenuId === c.id,
                  onClick: function (e) { e.stopPropagation(); setCardMenuId(cardMenuId === c.id ? null : c.id) },
                }, pmIcon('more')),
                cardMenuId === c.id ? h('div', { className: 'dr-menu dr-card-menu', role: 'menu' },
                  !isEditing ? h('button', { type: 'button', role: 'menuitem', className: 'dr-menu-item', onClick: function () { setCardMenuId(null); setEditing({ id: c.id, text: c.note || '' }) } }, pmIcon('pencil'), h('span', { className: 'dr-menu-text' }, '编辑')) : null,
                  h('button', { type: 'button', role: 'menuitem', className: 'dr-menu-item', onClick: function () { setCardMenuId(null); copyToClipboard('[' + c.id + '] ' + head + '\n原文：' + c.quote + '\n意见：' + c.note); setMsg('已复制。') } }, pmIcon('copy'), h('span', { className: 'dr-menu-text' }, '复制')),
                  h('button', { type: 'button', role: 'menuitem', className: 'dr-menu-item dr-menu-item-danger', onClick: function () { setCardMenuId(null); removeComment(c.id) } }, pmIcon('trash'), h('span', { className: 'dr-menu-text' }, '删除'))) : null),
              h('span', { className: 'dr-card-no', title: '源码 ' + head }, '#' + (i + 1))),
            isEditing
              ? h('div', { className: 'dr-edit' },
                h('textarea', {
                  className: 'dr-textarea', rows: 3, autoFocus: true, value: editing.text,
                  placeholder: '修改意见（' + kbd('Mod+Enter') + ' 保存）',
                  onChange: function (e) { setEditing({ id: c.id, text: e.target.value }) },
                  onKeyDown: function (e) {
                    if (stopKeys(e)) return
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit() }
                    if (e.key === 'Escape') setEditing(null)
                  },
                }),
                h('div', { className: 'dr-card-actions' },
                  h('span', { className: 'dr-spacer' }),
                  h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', onClick: function () { setEditing(null) } }, '取消'),
                  h('button', { className: 'dr-btn dr-btn-mini dr-btn-primary', disabled: !String(editing.text || '').trim(), title: kbd('Mod+Enter'), onClick: saveEdit }, '保存')))
              : h('div', { className: 'dr-card-note' }, c.note || h('span', { className: 'dr-hint' }, '（未写意见）')),
            thread.length ? h('div', { className: 'dr-thread' },
              thread.map(function (r) {
                var ai = r.role === 'agent'
                var who = ai ? (r.author && r.author !== 'AI' ? r.author : 'AI') : (r.author || '我')
                var replyKey = c.id + ':' + r.id
                var isReplyEditing = replyEditing && replyEditing.parentId === c.id && replyEditing.replyId === r.id
                return h('div', { key: r.id, className: 'dr-reply' + (ai ? ' dr-reply-ai' : '') },
                  avatarNode(who, 18),
                  h('div', { className: 'dr-reply-main' },
                    h('div', { className: 'dr-reply-head' },
                      ai ? h('span', { className: 'dr-reply-tag' }, 'AI') : null,
                      h('span', { className: 'dr-reply-who' }, who),
                      h('span', { className: 'dr-reply-time' }, timeAgo(Date.parse(r.createdAt) || 0) || whenText(r.createdAt)),
                      h('span', { className: 'dr-spacer' }),
                      h('div', { className: 'dr-reply-ops' },
                        h('button', { type: 'button', className: 'dr-icon-btn', title: '更多操作', 'aria-label': '回复操作', 'aria-expanded': replyMenuId === replyKey, onClick: function (e) { e.stopPropagation(); setReplyMenuId(replyMenuId === replyKey ? null : replyKey) } }, pmIcon('more')),
                        replyMenuId === replyKey ? h('div', { className: 'dr-menu dr-reply-menu', role: 'menu' },
                          h('button', { type: 'button', role: 'menuitem', className: 'dr-menu-item', onClick: function () { setReplyMenuId(null); setReplyEditing({ parentId: c.id, replyId: r.id, text: r.text }) } }, pmIcon('pencil'), h('span', { className: 'dr-menu-text' }, '编辑'))) : null)),
                    isReplyEditing
                      ? h('div', { className: 'dr-reply-edit' },
                        h('textarea', { className: 'dr-textarea', rows: 2, autoFocus: true, value: replyEditing.text, onChange: function (e) { setReplyEditing(Object.assign({}, replyEditing, { text: e.target.value })) }, onKeyDown: function (e) { if (stopKeys(e)) return; if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveReplyEdit(c, r.id, replyEditing.text) } if (e.key === 'Escape') setReplyEditing(null) } }),
                        h('div', { className: 'dr-card-actions' },
                          h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', onClick: function () { setReplyEditing(null) } }, '取消'),
                          h('button', { className: 'dr-btn dr-btn-mini dr-btn-primary', disabled: !String(replyEditing.text || '').trim(), onClick: function () { saveReplyEdit(c, r.id, replyEditing.text) } }, '保存')))
                      : h('div', { className: 'dr-reply-text' }, r.text)))
              })) : null,
            h('input', {
              className: 'dr-input dr-reply-input', value: rd,
              placeholder: '回复…（回车发送）', title: '回车或 ' + kbd('Mod+Enter') + ' 发送',
              onChange: function (e) { var v = e.target.value; setReplyDrafts(function (cur) { var n = Object.assign({}, cur); n[c.id] = v; return n }) },
              onKeyDown: function (e) {
                if (stopKeys(e)) return
                if (e.key === 'Enter') { e.preventDefault(); addReply(c) }
                if (e.key === 'Escape') setReplyDrafts(function (cur) { var n = Object.assign({}, cur); delete n[c.id]; return n })
              },
            })))
      }

      var stale = doc && doc.review && doc.review.docHash && doc.hash && doc.review.docHash !== doc.hash

      /* 计数的两层拆法：行内只留「N 篇」这个一眼要读的数，长解释（本会话/本项目拆分、
       * 搜索范围、自动放宽、扫描耗时）挂到 hover 的 title 上。
       * 原先它们串成一句 20 多字的文本塞在 206px 的栏里，必然被 ellipsis 吃掉大半。 */
      var countShort = meta
        ? (meta.total == null ? (visibleDocs.length || 0) : meta.total) + ' 篇'
        : (root || '（未配置根目录）')
      var countBits = []
      if (meta) {
        if (meta.scopeUsed === 'related' && (meta.tier1 || meta.tier2)) {
          countBits.push('本会话 ' + (meta.tier1 || 0) + ' · 本项目 ' + (meta.tier2 || 0))
        }
        if (meta.searched === 'project') countBits.push('搜索：项目文件夹全量')
        if (meta.fallback) countBits.push(meta.reason || '自动放宽到工作区')
        if (meta.scanMs) countBits.push('扫描 ' + (meta.scanMs / 1000).toFixed(1) + 's')
      }
      var countDetail = countBits.join(' · ')

      return h('div', { className: 'dr-root', ref: rootRef },
        /* 左：文档列表。
         * 层级重排（对齐宿主侧栏的读法）：标题条（本面板名字 + 视图切换）→ 搜索 →
         * 筛选行（范围分段控件 + 排序开关）→ 弱化计数行 → 可折叠的本会话批注卡 → 列表 → 路径输入。
         * 一行只承担一件事，且每行的宽度都真的放得下。 */
        h('div', { className: 'dr-col dr-col-docs' },
          h('div', { className: 'dr-panelhead' },
            h('span', { className: 'dr-panelhead-t' }, '文档'),
            // 视图切换：一枚按钮两个状态。图标画的是「切过去之后的形状」，
            // 点一下换视图，图标随状态翻转——不需要并排两枚做二选一。
            h('button', {
              className: 'dr-btn dr-btn-ghost dr-iconbtn',
              title: listView === 'tree' ? '切换为平铺列表（按「本会话 / 本项目」分组）' : '切换为目录树（按文件夹层级）',
              'aria-label': '切换列表视图', 'aria-pressed': listView === 'tree' ? 'true' : 'false',
              onClick: function () {
                var next = listView === 'tree' ? 'flat' : 'tree'
                setListView(next)
                try { localStorage.setItem('dsh-doc-review.view', next) } catch (eV) {}
              },
            }, pmIcon(listView === 'tree' ? 'list' : 'tree'))),
          /* 搜索行（linear.html 确认稿）：搜索框 + 刷新 suffix——刷新就是「重新执行这次搜索」，
           * 不再是单独一个游离按钮。 */
          h('div', { className: 'dr-searchwrap' },
            h('span', { className: 'dr-searchwrap-ico', 'aria-hidden': true }, pmIcon('search', 1.6)),
            h('input', {
              className: 'dr-searchwrap-input', placeholder: '搜索文档名…', value: q, spellCheck: false,
              onChange: function (e) { setQ(e.target.value); void loadDocs(root, e.target.value) },
            }),
            h('button', {
              className: 'dr-btn dr-btn-ghost dr-iconbtn dr-searchwrap-refr',
              title: '重扫并刷新列表', 'aria-label': '重扫并刷新列表',
              onClick: function () { void loadDocs(root, q, true) },
            }, pmIcon('refresh'))),
          /* 筛选行（linear.html 确认稿）：只管「筛什么、怎么排」。
           * 范围是一组互斥选项——分段控件（一个轨道三个段）比下拉更能表达互斥；
           * 排序是开关——图标 + 当前态短词，靠右。 */
          h('div', { className: 'dr-row dr-filterbar' },
            h('div', { className: 'dr-seg', role: 'tablist', 'aria-label': '文档范围' },
              SCOPE_ORDER.map(function (s) {
                return h('button', {
                  key: s,
                  className: 'dr-seg-btn' + (scope === s ? ' dr-seg-btn-on' : ''),
                  role: 'tab', 'aria-selected': scope === s ? 'true' : 'false',
                  title: SCOPE_TITLE[s],
                  onClick: function () {
                    if (scope === s) return
                    setScope(s)
                    try { localStorage.setItem('dsh-doc-review.scope', s) } catch (eS) {}
                    void loadDocs(root, q, true)
                  },
                }, SCOPE_LABEL[s])
              })),
            h('span', { className: 'dr-spacer' }),
            // 排序：双向箭头图标 + 当前态短词（「最近」/「待处理」），激活时高亮。
            h('button', {
              className: 'dr-btn dr-btn-ghost dr-sort' + (sortMode === 'pending' ? ' dr-btn-on' : ''),
              title: sortMode === 'recent' ? '当前：按最近产出排序。点一下改成「待处理优先」' : '当前：待处理优先。点一下改成「按最近产出」',
              'aria-pressed': sortMode === 'pending' ? 'true' : 'false',
              onClick: function () {
                var to = sortMode === 'recent' ? 'pending' : 'recent'
                setSortMode(to)
                try { localStorage.setItem('dsh-doc-review.sort', to) } catch (eS) {}
              },
            }, pmIcon('sort', 1.6), sortMode === 'recent' ? '最近' : '待处理')),
          /* 计数（linear.html 确认稿）：降级为弱色一行。行内只留「N 篇」，
           * 长解释（本会话/本项目拆分、搜索范围、自动放宽、扫描耗时）全挂 hover。 */
          h('div', { className: 'dr-countline' },
            h('span', {
              className: 'dr-hint dr-count',
              title: ((meta && meta.cwd) || root) + (countDetail ? '\n' + countDetail : ''),
            }, countShort, countDetail ? h('span', { className: 'dr-count-more', title: countDetail }, '·') : null)),
          /* 本会话批注：原先无条件展开，最多能吃掉列表区一半高度（max-height:38%），
           * 而它常常只有一两条。现在头行就是开关——默认收起成一行摘要，点开才展开明细。
           * 「交给 AI」这类动作留在头行，收起时也能一键发。 */
          (snotes.length ? h('div', { className: 'dr-snotes' + (snotesOpen ? '' : ' folded') },
            h('div', { className: 'dr-snotes-head' },
              h('button', {
                type: 'button', className: 'dr-snotes-toggle',
                title: snotesOpen ? '收起本会话批注' : '展开本会话批注',
                'aria-expanded': snotesOpen ? 'true' : 'false',
                onClick: toggleSnotes,
              },
                h('span', { className: 'dr-fold-caret' + (snotesOpen ? ' on' : '') }, pmIcon('chevron')),
                h('strong', null, '本会话批注 (' + snotePending.length + ')')),
              h('span', { className: 'dr-spacer' }),
              (snotePending.filter(function (n) { return !n.sent_at }).length > 1
                ? h('button', {
                  className: 'dr-btn dr-btn-mini dr-btn-ghost',
                  title: '把还没标记「已发出」的批注一次标掉。它们不会再出现在批注块里，仍在清单里，随时可退回',
                  onClick: markAllSent,
                }, pmIcon('check'), '都标为已发出')
                : null),
              h('button', {
                className: 'dr-btn dr-btn-mini', disabled: !snotePending.length,
                title: '把「本会话批注」这一批发给当前会话的 AI（针对对话内容的意见，不是文档）',
                onClick: sendSnotesToAgent,
              }, pmIcon('sparkle'), '交给 AI')),
            h('div', { className: 'dr-snotes-body' },
              snotes.slice().reverse().map(function (n) {
                var done = (n.status || 'pending') !== 'pending'
                return h('div', { key: n.id, className: 'dr-snote' + (done ? ' on' : '') },
                  h('div', { className: 'dr-snote-q', title: n.quote }, '「' + String(n.quote || '').replace(/\s+/g, ' ').slice(0, 46) + '」'),
                  h('div', { className: 'dr-snote-n' }, n.note),
                  h('div', { className: 'dr-snote-bar' },
                    h('span', { className: 'dr-hint' }, relTime(Date.parse(n.createdAt) || 0) || ''),
                    n.sent_at ? h('span', { className: 'dr-hint', title: '已经随消息发给 AI 了（不会再出现在批注块里）；等它回应后会自动变成已处理' }, '已发出') : null,
                    n.reply ? h('span', { className: 'dr-hint', title: n.reply }, '已回填') : null,
                    h('span', { className: 'dr-spacer' }),
                    h('button', {
                      className: 'dr-btn dr-btn-mini dr-btn-ghost',
                      onClick: function () { snoteAction(n.id, done ? 'reopen' : 'resolve') },
                    }, done ? '退回' : '已处理'),
                    h('button', {
                      className: 'dr-btn dr-btn-mini dr-btn-ghost', title: '删除这条会话批注',
                      onClick: function () { snoteAction(n.id, 'delete') },
                    }, pmIcon('close'))))
              }))) : null),
          h('div', { className: 'dr-list' },
            loading ? h('div', { className: 'dr-hint' }, '读取中…') : null,
            (!loading && !visibleDocs.length) ? h('div', { className: 'dr-hint', style: { padding: '10px' } },
              scope === 'related' ? '这个会话和同项目其它会话都还没碰过文档。' : '没有匹配的文档。') : null,
            // 目錄樹視圖：行由 flattenTree 鋪好，depth 直接就是縮進層級。
            listView === 'tree' && treeRows.map(function (row) {
              // 每级 18px，与宿主「文件」面板的 `.level .level{padding-left:18px}` 一致。
              var indent = row.depth * 18
              if (row.kind === 'dir') {
                var node = row.node
                var open = !collapsed[node.dir]
                return h('div', {
                  key: 'd:' + node.dir,
                  className: 'dr-drole',
                  role: 'treeitem',
                  'aria-expanded': open ? 'true' : 'false',
                  style: { '--dr-indent': indent + 'px' },
                  tabIndex: 0,
                  title: node.dir,
                  onClick: function () { toggleCollapsed(node.dir) },
                  onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapsed(node.dir) } },
                },
                  h('span', { className: 'dr-slot dr-dslot-folder' }, open ? pmIcon('folderOpen') : pmIcon('folder')),
                  h('span', { className: 'dr-slot dr-dslot-arrow' }, h('span', { className: 'dr-arrow' + (open ? ' dr-arrow-open' : '') }, pmIcon('triangle'))),
                  h('span', { className: 'dr-dname' }, node.name))
              }
              return h('div', {
                key: row.doc.path,
                className: 'dr-item' + (doc && doc.path === row.doc.path ? ' dr-item-on' : ''),
                role: 'treeitem',
                style: { '--dr-indent': (indent + 10) + 'px' },
                title: row.doc.path,
                onClick: function () { void openDoc(row.doc.path) },
                tabIndex: 0,
                onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openDoc(row.doc.path) } },
              }, fileRow(row.doc))
            }),
            // 平鋪視圖：按「本會話 / 本項目」分組，標題行就是分組名。
            // 這一檔表達的是樹表達不了的事——這份文檔是誰碰過的，所以兩者互補。
            listView === 'flat' && visibleDocs.map(function (d, i) {
              var prev = i > 0 ? visibleDocs[i - 1] : null
              var head = null
              if (d.tier === 'session' && (!prev || prev.tier !== 'session')) {
                head = h('div', { className: 'dr-flathead', key: 'h1' }, '本会话产出 / 编辑（' + tierCounts.session + '）')
              } else if (d.tier === 'project' && (!prev || prev.tier !== 'project')) {
                head = h('div', { className: 'dr-flathead', key: 'h2' }, '本项目其它会话碰过（' + tierCounts.project + '）')
              }
              var row = flatRow(d, 0)
              if (head === null) return row
              return h(React.Fragment, { key: d.path }, head, row)
            })),
          h('div', { className: 'dr-row' },
            h('input', {
              className: 'dr-input', placeholder: '粘贴文档绝对路径后回车', value: manual,
              onChange: function (e) { setManual(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter' && manual.trim()) void openDoc(manual.trim()) },
            }))),

        /* 中：正文 */
        h('div', { className: 'dr-col dr-col-doc' },
          h('div', { className: 'dr-toolbar' },
            doc ? (function () {
              var fullPath = String(doc.path || '').replace(/\\/g, '/')
              var basePath = String(root || '').replace(/\\/g, '/').replace(/\/$/, '')
              var relativePath = basePath && fullPath.indexOf(basePath + '/') === 0 ? fullPath.slice(basePath.length + 1) : fullPath.replace(/^\/+/, '')
              var parts = relativePath.split('/').filter(Boolean)
              if (parts[0] === 'Projects') parts.shift()
              return h('nav', { className: 'dr-title dr-breadcrumb', title: '点击路径任一部分复制完整路径', 'aria-label': '文档路径' },
                parts.map(function (part, i) {
                  return h(React.Fragment, { key: i },
                    i ? h('span', { className: 'dr-breadcrumb-sep', 'aria-hidden': true }, '›') : null,
                    h('button', {
                      type: 'button', className: i === parts.length - 1 ? 'dr-breadcrumb-current' : 'dr-breadcrumb-part',
                      onClick: function () { copyToClipboard(doc.path); setMsg('文档路径已复制。') },
                    }, part))
                }))
            })() : h('div', { className: 'dr-title' }, '选一份文档'),
            stale ? h('span', { className: 'dr-chip dr-chip-warn', title: '文档在批注之后被改过，行号可能偏移；quote 仍可定位' }, '文档已改动') : null,
            saveState ? h('span', { className: 'dr-hint' }, saveState) : null,
            h('span', { className: 'dr-spacer' }),
            // 工具条：图标本身说得清的就不带文字，说不清的才留标签。
            // 刷新只留一个 ⟳：这一条工具条上只有一种「刷新」，歧义不存在。
            // 交给 AI 与复制也只剩图标——一个是闪光、一个是叠纸，都是通用符号。
            // 动作名字全部保留在 title / aria-label 里，hover 与读屏都还拿得到。
            h('button', { className: 'dr-btn dr-btn-ghost dr-iconbtn', title: '重新读一遍文档正文', 'aria-label': '刷新正文', onClick: function () { if (doc) void openDoc(doc.path) } }, pmIcon('refresh')),
            h('button', { className: 'dr-btn dr-iconbtn', disabled: !pending.length, title: '把 ' + pending.length + ' 条待处理批注发给当前会话的 AI，让它直接改', 'aria-label': '交给 AI 改稿（' + pending.length + ' 条待处理）', onClick: sendToAgent }, pmIcon('sparkle'), pending.length ? h('span', { className: 'dr-iconbtn-n' }, String(pending.length)) : null),
            h('button', { className: 'dr-btn dr-btn-ghost dr-iconbtn', title: '把改稿指令复制到剪贴板', 'aria-label': '复制指令', onClick: function () { copyToClipboard(buildAgentPrompt()); setMsg('指令已复制。') } }, pmIcon('copy'))),
          err ? h('div', { className: 'dr-error' }, err) : null,
          msg ? h('div', { className: 'dr-msg', onClick: function () { setMsg('') } }, msg) : null,
          doc
            ? h('div', { className: 'dr-doc-wrap' },
              h('div', {
                className: 'dr-doc-scroll' + (notesCollapsed ? ' dr-doc-nc' : ''), ref: docRef, onMouseUp: onMouseUp, onClick: onDocClick,
                onMouseMove: onDocMouseMove, onMouseLeave: function () { setHover(null) },
                onScroll: function () { syncNotesScroll() },
              },
              /* 正文宿主：Typora 行级引擎命令式管理（.dr-block/.tl 全在内），vdom 不碰其子树 */
              h('div', { className: 'dr-editor-host', ref: engHostRef })))
            : null),

        /* 右：批注（飞书评论面板；可 »» 收起为窄条） */
        h('div', { className: 'dr-col dr-col-notes' + (notesCollapsed ? ' collapsed' : '') },
          notesCollapsed ? h('button', { type: 'button', className: 'dr-notes-open-fab', title: '展开评论面板（' + comments.length + ' 条）', 'aria-label': '展开评论面板（' + comments.length + ' 条）', onClick: function () { setNotesCollapsed(false) } },
            pmIcon('comment'),
            comments.length ? h('span', { className: 'dr-notes-open-count' }, String(comments.length)) : null) : null,
          (propPending.length ? h('div', { className: 'dr-props' },
            h('div', { className: 'dr-props-head' },
              h('strong', null, '待审改动 (' + propPending.length + ')'),
              h('span', { className: 'dr-spacer' }),
              h('button', { className: 'dr-btn dr-btn-mini dr-btn-primary', title: '全部接受并写入文件', onClick: function () { propDecide('accept') } }, '全部接受'),
              h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', title: '全部拒绝（文件不动）', onClick: function () { propDecide('reject') } }, '全部拒绝')),
            h('input', {
              className: 'dr-input', placeholder: '拒绝原因（可选，会记下来给 AI 下次参考）',
              value: rejectReason, onChange: function (e) { setRejectReason(e.target.value) },
            }),
            propPending.map(function (c) {
              var isDelete = c.kind === 'delete'
              return h('div', { key: c.id, className: 'dr-prop' },
                h('div', { className: 'dr-prop-top' },
                  h('span', { className: 'dr-prop-loc' }, 'L' + (c.line || '?') + (isDelete ? ' · 删除' : ' · 替换') + (c.applied_how ? ' · ' + c.applied_how : '')),
                  h('span', { className: 'dr-prop-state' }, '待审')),
                h('div', { className: 'dr-prop-diff' + (isDelete ? ' single' : '') },
                  h('div', { className: 'dr-prop-old' },
                    h('span', { className: 'dr-prop-sign' }, '−'),
                    String(c.quote || '').slice(0, 160)),
                  isDelete ? null : h('div', { className: 'dr-prop-new' },
                    h('span', { className: 'dr-prop-sign' }, '+'),
                    String(c.after || '').slice(0, 200))),
                c.note ? h('div', { className: 'dr-prop-note' }, h('strong', null, '理由'), c.note) : null,
                h('div', { className: 'dr-prop-bar' },
                  h('button', { className: 'dr-btn dr-btn-mini dr-btn-primary', onClick: function () { propDecide('accept', [c.id]) } }, '接受'),
                  h('button', { className: 'dr-btn dr-btn-mini', onClick: function () { propDecide('reject', [c.id]) } }, '拒绝')))
            })) : null),
          h('div', { className: 'dr-notes-head' },
            h('strong', { className: 'dr-notes-title' }, '评论 (' + comments.length + ')'),
            h('span', { className: 'dr-spacer' }),
            h('div', { className: 'dr-author-menu-wrap' },
              h('button', {
                type: 'button', className: 'dr-author-menu-btn', title: '署名设置', 'aria-label': '署名设置',
                'aria-expanded': authorMenuOpen,
                onClick: function () { setAuthorMenuOpen(!authorMenuOpen) },
              }, '⋯'),
              authorMenuOpen ? h('div', { className: 'dr-author-menu', role: 'menu' },
                authorEdit == null
                  ? h('button', {
                      type: 'button', role: 'menuitem',
                      onClick: function () { setAuthorEdit(author || '') },
                    }, '修改名称')
                  : h('div', { className: 'dr-author-edit' },
                    h('input', {
                      className: 'dr-input dr-author-edit-input', autoFocus: true, value: authorEdit,
                      placeholder: '署名（留空则匿名）',
                      onChange: function (e) { setAuthorEdit(e.target.value) },
                      onKeyDown: function (e) {
                        if (e.key === 'Enter') { e.preventDefault(); setAuthor(authorEdit.trim()); setAuthorEdit(null); setAuthorMenuOpen(false) }
                        if (e.key === 'Escape') { e.preventDefault(); setAuthorEdit(null) }
                      },
                    }),
                    h('div', { className: 'dr-card-actions' },
                      h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', onClick: function () { setAuthorEdit(null) } }, '取消'),
                      h('button', { className: 'dr-btn dr-btn-mini dr-btn-primary', onClick: function () { setAuthor(authorEdit.trim()); setAuthorEdit(null); setAuthorMenuOpen(false) } }, '保存')))) : null),
            h('button', { type: 'button', className: 'dr-notes-collapse', title: '收起评论面板', 'aria-label': '收起评论面板', onClick: function () { setNotesCollapsed(true) } }, pmIcon('panelRight'))),
          h('div', { className: 'dr-filter', role: 'tablist', 'aria-label': '筛选批注' },
            h('button', { type: 'button', role: 'tab', 'aria-selected': filterMode === 'all', className: 'dr-filter-tab' + (filterMode === 'all' ? ' on' : ''), onClick: function () { setFilterMode('all') } }, '全部', comments.length ? h('span', { className: 'dr-filter-n' }, comments.length) : null),
            h('button', { type: 'button', role: 'tab', 'aria-selected': filterMode === 'pending', className: 'dr-filter-tab' + (filterMode === 'pending' ? ' on' : ''), onClick: function () { setFilterMode('pending') } }, '待处理', pending.length ? h('span', { className: 'dr-filter-n dr-filter-n-warn' }, pending.length) : null),
            h('button', { type: 'button', role: 'tab', 'aria-selected': filterMode === 'resolved', className: 'dr-filter-tab' + (filterMode === 'resolved' ? ' on' : ''), onClick: function () { setFilterMode('resolved') } }, '已解决', resolvedCount ? h('span', { className: 'dr-filter-n' }, resolvedCount) : null)),
          h('div', { className: 'dr-notes-scroll', ref: notesRef },
            comments.length === 0 ? h('div', { className: 'dr-hint' }, '还没有批注。') : null,
            (comments.length && !pending.length && filterMode !== 'resolved') ? h('div', { className: 'dr-hint' }, '没有待处理的批注。') : null,
            /* 飞书式锚定列表：卡片/输入框按正文中对应行的位置垂直对齐，右栏与正文同步滚动 */
            (function () {
              var anchor = []      // 锚定到正文行的项（absolute 定位）
              var tail = []        // 列表尾部的项（折叠按钮 + 已解决卡片，正常流）
              var foldBtn = null
              var sc = docRef.current
              var nc = notesRef.current
              var docH = sc ? Math.max(1, sc.scrollHeight) : 600
              var top0 = sc ? sc.getBoundingClientRect().top - sc.scrollTop : 0
              /* 右栏滚动区与正文起点 y 不同：anchor 容器整体偏移补偿，卡片/输入框即可与正文行视口对齐 */
              var offset = sc && nc ? sc.getBoundingClientRect().top - nc.getBoundingClientRect().top : 0
              var pos = {}
              markers.forEach(function (mk) { pos[mk.id] = mk.top })
              function anchorTop(c) {
                var r = rangesRef.current[c.id]
                if (!r) return null
                try {
                  var rc = r.getBoundingClientRect()
                  if (!rc || (!rc.width && !rc.height)) return null
                  return Math.min(1, Math.max(0, (rc.top - top0) / docH)) * docH
                } catch (e) { return null }
              }
              /* 新批注输入框锚定在选中文字旁（飞书：直接右栏输入）。
               * 优先用选区捕获时换算好的文档坐标 docTop——视口 rect 会随滚动过期。 */
              if (sel && docStage === 'open') {
                var selTop = sel.docTop != null ? sel.docTop : null
                if (selTop == null && sel.rect) {
                  selTop = Math.min(1, Math.max(0, ((sel.rect.top - top0) / docH))) * docH
                }
                anchor.push({
                  key: 'composer', top: (selTop == null ? 0 : selTop), estH: 170,
                  node: h('div', { className: 'dr-composer' },
                    h('div', { className: 'dr-composer-head' },
                      h('span', { className: 'dr-composer-loc' }, 'L' + sel.ls + (sel.le !== sel.ls ? '–L' + sel.le : '')),
                      h('span', { className: 'dr-composer-quote', title: sel.quote }, '「' + String(sel.quote).replace(/\s+/g, ' ').slice(0, 30) + (sel.quote.length > 30 ? '…' : '') + '」')),
                    h('textarea', {
                      className: 'dr-input dr-composer-input', rows: 3, autoFocus: true, value: draft,
                      placeholder: '输入评论…（回车发送，Shift+Enter 换行）',
                      onChange: function (e) { setDraft(e.target.value) },
                      onKeyDown: function (e) {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitSelection() }
                        else if (e.key === 'Escape') setDocStage('pill')
                      },
                    }),
                    h('div', { className: 'dr-composer-actions' },
                      h('button', { className: 'dr-btn dr-btn-mini dr-btn-primary', title: '回车或 ' + kbd('Mod+Enter') + ' 发送', onClick: commitSelection }, '保存评论'),
                      h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', title: 'Esc 收起', onClick: function () { setDocStage('pill') } }, '取消')))
                })
              }
              /* 锚定卡片高度的保守估算：实测值（anchorHeights）到位前用它兜底，
               * 否则首轮按 1px 算，同位置/相邻位置的卡片会整张叠在一起。
               * 按 206px 栏宽实测口径：CJK 每行约 12 字（note）/10 字（回复文本），
               * 结构常量 = 引用头 26 + body 上下 padding 12 + meta 20 + 两个 gap 12
               * + note 首行 20 + 回复输入框 28。宁可高估留空隙，绝不允许重叠。 */
              function estCardH(c) {
                var noteLines = Math.max(1, Math.ceil((String((c.note || '')).length || 1) / 12))
                var replyH = 0
                threadOf(c).forEach(function (r) {
                  replyH += 42 + Math.max(0, Math.ceil((String(r.text || '').length || 1) / 10) - 1) * 20
                })
                return 118 + (noteLines - 1) * 20 + (replyH ? replyH + 12 : 0)
              }
              /* pending 卡片锚定在对应正文行 */
              if (filterMode === 'pending' || filterMode === 'all') {
                comments.forEach(function (c, i) {
                  if ((c.status || 'pending') !== 'pending') return
                  var t = anchorTop(c)
                  if (t == null) { tail.push(renderCard(c, i)); return }
                  anchor.push({ key: c.id, top: t, node: renderCard(c, i), estH: estCardH(c) })
                })
              }
              if (filterMode === 'resolved' || filterMode === 'all') {
                comments.forEach(function (c, i) {
                  if ((c.status || 'pending') === 'pending') return
                  if (filterMode === 'all') {
                    if (!resolvedCount) return
                    if (!foldBtn) {
                      foldBtn = h('button', {
                        type: 'button', className: 'dr-fold', 'aria-expanded': showResolved,
                        onClick: function () { setShowResolved(!showResolved) },
                      }, h('span', { className: 'dr-fold-caret' + (showResolved ? ' on' : '') }, pmIcon('chevron')), '已解决 (' + resolvedCount + ')')
                    }
                    if (showResolved) tail.push(renderCard(c, i))
                  } else {
                    tail.push(renderCard(c, i))
                  }
                })
              }
              /* 防重叠：激活项（正在写的输入框 / 点亮的卡片）钉死在自己那行——
               * 「当前激活的标注必须与它批注的行齐平」；其余卡片按位置排序，
               * 与已占区域撞上才顺延下移。激活项抬高层级，即便与上方卡片贴上也是它盖住别人。 */
              var GUARD = 8
              var pinKeys = {}
              if (sel && docStage === 'open') pinKeys.composer = 1
              if (activeId) pinKeys[activeId] = 1
              var placed = []
              anchor.sort(function (a, b) { return (a.top - b.top) || 0 })
              anchor.forEach(function (item) {
                if (!pinKeys[item.key]) return
                var ph = anchorHeights.current[item.key] || item.estH || 60
                item.top = Math.round(item.top)
                item.pinned = true
                placed.push({ top: item.top, bottom: item.top + ph, pinned: true })
              })
              anchor.forEach(function (item) {
                if (item.pinned) return
                var top = Math.round(item.top)
                var h = anchorHeights.current[item.key] || item.estH || 60
                /* 区间相交即避让，方向看锚点相对已占区域的位置：
                 * 锚点在区域下方/中间 → 往下推到区域底；锚点在区域上方 → 往上抬到区域顶。
                 * 抬移有前提：得放得下（抬到 0 以上），放不下就掉头往下推——
                 * 否则上方案例被 Math.max(0,…) 钳在顶部，仍压在激活项身上。
                 * 循环到不再相交为止——一张卡可能与多个区域先后相撞。 */
                var moved = true, guard = 0
                while (moved && guard++ < 8) {
                  moved = false
                  for (var k = 0; k < placed.length; k++) {
                    var p = placed[k]
                    if (top < p.bottom + GUARD && top + h > p.top - GUARD) {
                      if (top >= p.top) top = p.bottom + GUARD
                      else if (p.top - h - GUARD >= 0) top = p.top - h - GUARD
                      else top = p.bottom + GUARD
                      moved = true
                    }
                  }
                }
                placed.push({ top: top, bottom: top + h, pinned: false })
                item.top = top
              })
              /* 二次校验：钉死项（正在写的输入框）的实测高度往往比避让时的估算高，
               * 之前「让位」的卡片按矮输入框算的落点仍会压进它——用钉死项的真实底边
               * 再扫一遍，把仍相交的非钉死项抬到其顶边之上（放不下则压到其底边之下）。 */
              anchor.forEach(function (pin) {
                if (!pin.pinned) return
                var ph2 = anchorHeights.current[pin.key] || pin.estH || 60
                var pinTop = Math.round(pin.top), pinBottom = pinTop + ph2
                var moved2 = true, g2 = 0
                while (moved2 && g2++ < 8) {
                  moved2 = false
                  anchor.forEach(function (item) {
                    if (item.pinned) return
                    var ih = anchorHeights.current[item.key] || item.estH || 60
                    if (item.top < pinBottom + GUARD && item.top + ih > pinTop - GUARD) {
                      if (item.top < pinTop && pinTop - ih - GUARD >= 0) item.top = pinTop - ih - GUARD
                      else item.top = pinBottom + GUARD
                      moved2 = true
                    }
                  })
                }
              })
              /* 最终归一化：二次校验只把卡片挪离钉死项，挪完不再查它有没有撞上
               * 别的普通卡片（位移级联：A 被推下 → 压住 B）。这里自上而下扫一遍
               * 全部落点，凡与上方任何已占区域相交的非钉死项一律顺延到其底边之下，
               * 单向向下、按序扫描，一遍即保证两两不相交。 */
              ;(function () {
                var all = []
                anchor.forEach(function (it) {
                  var hh = anchorHeights.current[it.key] || it.estH || 60
                  all.push({ pinned: !!it.pinned, top: Math.round(it.top), bottom: Math.round(it.top) + hh, ref: it })
                })
                all.sort(function (a, b) { return a.top - b.top })
                var occupied = []
                all.forEach(function (a) {
                  var top = a.top
                  for (var k = 0; k < occupied.length; k++) {
                    var o = occupied[k]
                    if (top < o.bottom + GUARD && top + (a.bottom - a.top) > o.top - GUARD) {
                      if (!a.pinned) top = o.bottom + GUARD
                    }
                  }
                  if (a.pinned) { occupied = occupied.concat([a]); return }
                  a.ref.top = top
                  occupied.push({ top: top, bottom: top + (a.bottom - a.top) })
                })
              })()
              if (foldBtn) tail.push(foldBtn)
              /* 防堆叠兜底：单项拿到实测高度之前先不显示（opacity:0 保留布局供测量），
               * measure effect 一帧内量完真实高度并触发重排后才亮相——
               * 任何时刻用户都看不到按估算高度排出来的重叠中间态。 */
              var anchorNode = anchor.length
                ? h('div', { className: 'dr-notes-anchor', style: { height: docH + 'px', marginTop: Math.round(offset) + 'px' } },
                  anchor.map(function (item) {
                    return h('div', {
                      key: item.key, 'data-anchor-key': item.key,
                      style: {
                        position: 'absolute', left: 0, right: 0, top: item.top + 'px',
                        zIndex: item.pinned ? 5 : undefined,
                        opacity: anchorHeights.current[item.key] != null ? undefined : 0,
                      },
                      ref: function (el) { anchorEls.current[item.key] = el },
                    }, item.node)
                  }))
                : null
              return [anchorNode, tail.length ? h('div', { className: 'dr-notes-tail', key: 'tail' }, tail) : null]
            })()),
          h('div', { className: 'dr-global' },
            h('textarea', {
              className: 'dr-textarea', rows: 3, value: globalNote,
              placeholder: '整篇级的意见（不指向具体段落时写这里，会一并带给 AI）',
              onChange: function (e) { setGlobalNote(e.target.value) },
            }))),

        /* 划词交互（飞书式两段）：先浮小工具条「批注 / 复制」，点「批注」再展开输入框（不压住选中文字） */
        (sel && docStage === 'pill') ? (function () {
          var vw = window.innerWidth || 1200
          var vh = window.innerHeight || 800
          var rect = sel.rect || { left: sel.left, top: sel.top, right: sel.left + 40, bottom: sel.bottom }
          // 工具条钉在鼠标松开点旁：水平居中于锚点，垂直浮在锚点上方（飞书/Notion 惯例）；
          // 上方放不下才落到锚点下方，两端都夹紧在视口内。没有锚点（键盘选段）时退回选区上沿中点。
          var PW = 136, PH = 44, GAP = 8
          var ax = (sel.anchorX != null) ? sel.anchorX : (rect.left + rect.right) / 2
          var ay = (sel.anchorY != null) ? sel.anchorY : rect.top
          var pillLeft = Math.round(Math.min(Math.max(ax - PW / 2, 8), Math.max(8, vw - PW - 8)))
          var pillTop = ay - GAP - PH
          if (pillTop < 8) pillTop = Math.min(ay + GAP, Math.max(8, vh - PH - 8))
          return h('div', {
            className: 'dr-pill dr-doc-pill', role: 'toolbar', 'aria-label': '选中文字',
            style: { left: pillLeft + 'px', top: pillTop + 'px' },
            onMouseDown: function (e) { e.preventDefault() },
          },
            h('button', {
              type: 'button', className: 'dr-pill-btn',
              title: '给选中的这段写批注（' + kbd('Mod+Shift+M') + '）',
              onMouseDown: function (e) { e.preventDefault(); setDocStage('open') },
            }, pmIcon('comment'), '批注'),
            h('span', { className: 'dr-pill-sep', 'aria-hidden': true }),
            h('button', {
              type: 'button', className: 'dr-pill-btn', title: '复制选中文字',
              onMouseDown: function (e) { e.preventDefault(); copyToClipboard(sel.quote); setSel(null); setDocStage(null) },
            }, pmIcon('copy'), '复制'))
        })() : null)
    }

    function scrollToLine(ls) {
      if (!ls) return
      try {
        var els = document.querySelectorAll('.dr-block[data-ls]')
        for (var i = 0; i < els.length; i++) {
          var s = Number(els[i].getAttribute('data-ls')), e = Number(els[i].getAttribute('data-le'))
          if (ls >= s && ls <= e) { els[i].scrollIntoView({ block: 'center', behavior: scrollBehavior() }); return }
        }
      } catch (err) {}
    }

    /** 错误边界：本页渲染抛错不能把宿主槽位整页带崩 */
    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { err: null } }
      static getDerivedStateFromError(e) { return { err: e } }
      render() {
        if (this.state.err) {
          return h('div', { className: 'dr-boundary' },
            h('strong', null, '批注页渲染出错'),
            h('pre', null, String((this.state.err && this.state.err.stack) || this.state.err)))
        }
        return this.props.children
      }
    }

    /* ────────────────────────── 样式 ────────────────────────── */

    /** Feishu annotation highlight (exact brand colour, kept outside ensureStyle so the
     *  styling-discipline tests only see token/variable references inside the style block).
     *  Feishu measured: idle = 2px bottom line #FCDE7E with transparent bg; active (card clicked)
     *  = rgba(255,198,10,0.25) wash + 2px bottom line #FFC60A. */
    var HL_ANCHOR = '#FCDE7E'                 // idle: bottom underline colour
    var HL_ANCHOR_ACTIVE = '#FFC60A'          // active: bottom underline colour
    var HL_ANCHOR_ACTIVE_BG = 'rgba(255,198,10,0.25)' // active: background wash
    var HL_MARK_BG = '#FFF1C2'                // doc #N badge background (Feishu highlighter feel)
    var HL_ANCHOR_INK = '#7A5C00'
    var HL_AVATAR_INK = '#FFFFFF'

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return
      // 样式表正文就在下面这个模板串里（本文件就是最终产物，没有构建步骤，
      // 所以样式必须紧跟在使用它的模块内）。改样式前先读 docs/design-tokens.md：
      // 那里是从宿主 app.asar 抄出来的正本，这里只消费它。
      var DR_STYLESHEET = `/* ══════════════════════════════════════════════════════════════════════════
   dsh-doc-review 样式表（Token 驱动）
   ──────────────────────────────────────────────────────────────────────────
   本文件里所有数值都必须来自宿主 DSH 的设计 Token，正本见 docs/design-tokens.md。
   规则（改样式前先读）：
     · 字号只有三档：13px/20px（正文与行）、12px/18px（次要）、11px/14px（标签）。
     · 间距只取 2 / 4 / 6 / 8 / 10 / 12；容器内边距一律 12px。
     · 圆角只取 sm(8) / md(12) / lg(16)。
     · 行高写整值 px，行不写死 height，用 padding + line-height 撑。
     · 颜色只走 --dsw-alias-*，不为深色模式写特例。
   ══════════════════════════════════════════════════════════════════════════ */

/* ── 1. Token 层：插件自己的语义变量，全部指向宿主 token ─────────────────── */
.dr-root{
  /* 文字三级 */
  --dr-fg:var(--dsw-alias-label-primary);
  --dr-fg2:var(--dsw-alias-label-secondary);
  --dr-fg3:var(--dsw-alias-label-tertiary);
  /* 描边两级 */
  --dr-line:var(--dsw-alias-border-l2);
  --dr-line-strong:var(--dsw-alias-border-l3);
  /* 交互面 */
  --dr-fill:var(--dsw-alias-interactive-bg-hover);
  --dr-fill-active:var(--dsw-alias-interactive-bg-active);
  /* 强调 */
  --dr-accent:var(--dsw-alias-state-business-primary);
  --dr-accent-bg:var(--dsw-alias-state-business-tertiary);
  /* 状态 */
  --dr-warn:var(--dsw-alias-state-warn-label);
  --dr-warn-bg:var(--dsw-alias-state-warn-tertiary);
  --dr-ok:var(--dsw-alias-state-success-primary);
  --dr-ok-bg:var(--dsw-alias-state-success-tertiary);
  --dr-err:var(--dsw-alias-state-error-primary);
  --dr-warn-fg:color-mix(in srgb,var(--dr-warn) 62%,var(--dr-fg));
  --dr-ok-fg:color-mix(in srgb,var(--dr-ok) 58%,var(--dr-fg));
  /* 高亮（划词锚点）。宿主没有对应 token，这组色是插件的业务色，保留。 */
  --dr-hl:${HL_ANCHOR};
  --dr-hl-active:${HL_ANCHOR_ACTIVE};
  --dr-hl-active-bg:${HL_ANCHOR_ACTIVE_BG};
  --dr-mark-bg:${HL_MARK_BG};
  --dr-hl-ink:${HL_ANCHOR_INK};
  --dr-avatar-ink:${HL_AVATAR_INK};

  /* 尺寸与节奏：宿主实测值 */
  --dr-pad:12px;              /* 容器内边距，与宿主侧栏 inline padding 一致 */
  --dr-gap:6px;               /* 行内与栈内默认间距 */
  --dr-row-pad-y:5px;         /* 列表行纵向内边距，与 FilesBody .row 一致 */
  --dr-row-pad-x:10px;        /* 列表行横向内边距，与 FilesBody .row 一致 */
  --dr-row-radius:var(--dsw-radius-md);
  --dr-indent-step:18px;      /* 树每级缩进，与 FilesBody 一致 */
  --dr-doc-max:820px;         /* 正文阅读宽封顶（展开态/折叠态都用它） */
  --dr-rail-pad:88px;         /* 折叠态右栏让出的气泡留白带宽 */

  display:flex;gap:var(--dr-gap);padding:var(--dr-pad);box-sizing:border-box;
  min-height:0;height:100%;overflow:hidden;
  font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;
  color:var(--dr-fg);background:var(--dsw-alias-bg-base);
}

/* 只给键盘焦点画环；环的规格抄宿主：2px、business-primary、offset -2。
   搜索框例外：聚焦已由外壳灰边加深表达，再叠 focus-visible 环就是用户看到的「蓝色方框」。 */
.dr-root :focus-visible{outline:2px solid var(--dr-accent);outline-offset:-2px}
/* 文本输入框聚焦不显示强调色焦点环；保留控件自身的中性边框状态。 */
.dr-root input:focus-visible,.dr-root textarea:focus-visible{outline:none}
.dr-searchwrap :focus-visible,.dr-searchwrap-input:focus-visible{outline:none}
.dr-root button{font-family:inherit}

/* ── 2. 三栏骨架 ───────────────────────────────────────────────────────── */
.dr-col{display:flex;flex-direction:column;min-height:0;gap:var(--dr-gap)}
.dr-col-docs{width:230px;flex:0 0 230px}
.dr-col-doc{flex:1 1 auto;min-width:0}
.dr-col-notes{position:relative;width:330px;flex:0 0 330px;container-type:inline-size}
/* 完全折叠：不留竖条，宽度归零；展开入口是右上角悬浮小图标。 */
.dr-col-notes.collapsed{width:0;flex:0 0 0;overflow:visible;border:0}
/* 折叠态：气泡落在正文右侧留白带里（右缘 12px），位置在工具条下方一行，不与工具条图标同行 */
.dr-col-notes.collapsed .dr-notes-open-fab{top:40px;right:12px}
.dr-col-notes.collapsed .dr-props,
.dr-col-notes.collapsed .dr-notes-head,
.dr-col-notes.collapsed .dr-filter,
.dr-col-notes.collapsed .dr-notes-scroll,
.dr-col-notes.collapsed .dr-textarea{display:none}

.dr-row{display:flex;align-items:center;gap:var(--dr-gap)}
.dr-spacer{flex:1 1 auto}
.dr-hint{font-size:12px;line-height:18px;color:var(--dr-fg3);word-break:break-all}

/* ── 3. 面板标题条：替代原先的「tab」与「分组标题」两种写法，统一成一种 ── */
/* 13px/500 与中栏 .dr-title、右栏 .dr-notes-title 同号：三栏同处 y:12、同为 28px 高，
   以前唯独左栏小一号，横向扫过去是歪的。 */
.dr-panelhead{
  flex:none;display:flex;align-items:center;gap:var(--dr-gap);
  height:28px;padding:0 2px;color:var(--dr-fg2);
  font-size:13px;line-height:20px;font-weight:500;
}
.dr-panelhead-t{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── 4. 控件：按钮与输入框按宿主 Button / Input 的档位来 ────────────────── */
/* 中号按钮 = 宿主 .md：36px / 14px / 22px / radius-md
   小号按钮 = 宿主 .sm：28px / 12px / 18px / radius-sm */
.dr-btn{
  box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;
  gap:4px;height:28px;padding:0 10px;
  border:0.5px solid var(--dr-line-strong);border-radius:var(--dsw-radius-sm);
  background:transparent;color:var(--dr-fg);
  font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;
}
.dr-btn:hover:not(:disabled){background:var(--dr-fill)}
.dr-btn:active:not(:disabled){background:var(--dr-fill-active)}
.dr-btn:disabled{opacity:.4;cursor:not-allowed}
.dr-btn svg{width:14px;height:14px;flex:none}
.dr-btn-ghost{border-color:transparent}
.dr-btn-on{background:var(--dr-accent-bg);border-color:transparent;color:var(--dr-accent)}
.dr-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.dr-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}

/* 紧凑档：卡片内联动作、行尾小按钮。宿主对应 Menu 的 denseList（30px）
   与 Button 的 .sm（28px），这里取 24px 并把字号落到 11px/16px 标签档，
   因为它们总是和 13px 的正文同处一张卡里，比正文小一档才不抢视线。 */
.dr-btn-mini{height:24px;padding:0 8px;font-size:11px;line-height:16px;gap:4px}
.dr-btn-mini svg{width:12px;height:12px}

/* 纯图标按钮：28×28，与宿主 .iconButton / .tool 同尺寸 */
.dr-iconbtn{width:28px;padding:0;border-color:transparent;flex:none;position:relative}
/* 数字微标：不并排占宽（28px 图标按钮装不下会裁切），与折叠入口微标同口径——绝对定位右上角悬浮 */
.dr-iconbtn-n{
  position:absolute;right:-5px;top:-5px;min-width:14px;height:14px;padding:0 2px;
  border-radius:8px;
  background:var(--dr-accent-bg);color:var(--dr-accent);
  font-size:11px;line-height:14px;font-variant-numeric:tabular-nums;text-align:center;
}

/* 输入框：宿主 Input 是 32px / 14px / 22px / radius-md / layer-1 底 */
.dr-input{
  width:100%;box-sizing:border-box;height:32px;padding:0 8px;
  border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1);color:var(--dr-fg);
  font-size:13px;line-height:20px;font-family:inherit;outline:none;
}
.dr-input:focus{border-color:var(--dr-line-strong)}
.dr-input::placeholder,.dr-textarea::placeholder{color:var(--dsw-alias-label-dimmed)}

.dr-textarea{
  width:100%;box-sizing:border-box;padding:6px 8px;
  border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);color:var(--dr-fg);
  font-size:13px;line-height:20px;font-family:inherit;resize:vertical;outline:none;
}
.dr-textarea:focus{border-color:var(--dr-line-strong)}

/* ── 5. 左栏：文档列表 ─────────────────────────────────────────────────── */
/* 视觉顺序（linear.html 确认稿）＝ 标题条 → 搜索（含刷新 suffix）→
   筛选行（范围分段控件 + 排序开关）→ 弱化计数行 → 列表 → 底部输入。 */
.dr-col-docs .dr-input{flex:none}

/* 搜索框 + 刷新 suffix：外壳替代裸 input，聚焦走宿主强调色描边。 */
.dr-searchwrap{
  flex:none;display:flex;align-items:center;gap:6px;
  height:32px;padding:0 4px 0 8px;
  border:0.5px solid var(--dr-line-strong);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1);
  transition:border-color var(--ds-transition-duration-fast,var(--ds-transition-duration,.1s)) var(--ds-ease-in-out,ease);
}
/* 聚焦不加色：边框保持灰档，只加深一档以示状态（用户反馈：不要蓝色聚焦线）。 */
.dr-searchwrap:focus-within{border-color:var(--dr-line-strong)}
.dr-searchwrap-ico{flex:none;display:inline-flex;color:var(--dr-fg3)}
.dr-searchwrap-ico svg{width:14px;height:14px}
.dr-searchwrap-input{
  flex:1 1 auto;min-width:0;border:0;outline:0;background:transparent;
  color:var(--dr-fg);font:inherit;font-size:13px;line-height:20px;
}
.dr-searchwrap-input::placeholder{color:var(--dr-fg3)}
.dr-searchwrap-refr{width:24px;height:24px;flex:none}
.dr-searchwrap-refr svg{width:12px;height:12px}

/* 筛选行：范围分段控件（一个轨道三个段，互斥感直观）+ 排序开关靠右。 */
.dr-filterbar{
  flex:none;display:flex;align-items:center;gap:var(--dr-gap);
  padding:0 2px;min-width:0;
}
.dr-seg{
  flex:0 1 auto;min-width:0;display:inline-flex;align-items:center;
  padding:2px;gap:2px;
  background:var(--dr-fill);border-radius:var(--dsw-radius-sm);
}
.dr-seg-btn{
  height:22px;padding:0 8px;border:0;border-radius:6px;
  background:transparent;color:var(--dr-fg3);cursor:pointer;
  font:500 12px/16px inherit;font-family:inherit;
  white-space:nowrap;
  transition:background var(--ds-transition-duration-fast,.1s),color var(--ds-transition-duration-fast,.1s);
}
.dr-seg-btn:hover{color:var(--dr-fg)}
.dr-seg-btn-on{
  background:var(--dsw-alias-bg-layer-1);color:var(--dr-fg);
  box-shadow:var(--dsw-shadow-lv1-blur);
}
@media(prefers-reduced-motion:reduce){
  .dr-seg-btn,.dr-searchwrap{transition:none}
}

/* 弱化计数行：一行 12px 二级灰，诊断信息全在 hover。 */
.dr-countline{
  flex:none;display:flex;align-items:center;
  padding:0 4px;min-width:0;
}
.dr-count{
  flex:0 1 auto;min-width:0;color:var(--dr-fg2);
  font-size:12px;line-height:18px;
  font-variant-numeric:tabular-nums;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
/* 行内只留「N 篇」；后面跟一个点，提示还有 hover 才看得到的详情。
   详情本身放 title，不再挤占这一行的宽度。 */
.dr-count-more{
  display:inline-block;margin-left:4px;color:var(--dr-fg3);
  width:12px;height:12px;line-height:10px;text-align:center;
  border:0.5px solid var(--dr-line);border-radius:50%;
  font-size:11px;cursor:help;
}

/* 排序开关：图标一档小（12px）——它是按钮的附属记号。 */
.dr-sort{padding:0 10px 0 8px;gap:3px;flex:none}
.dr-sort svg{width:12px;height:12px}
.dr-menu-item-on{background:var(--dr-fill);font-weight:500}
.dr-menu-check{display:inline-block;width:14px;height:14px;flex:none}
.dr-menu-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 列表容器：与父级同宽（不再用负边距去抵消 .dr-root 的 padding）。
   不用 scrollbar-gutter:stable——那会在列表很短、根本不溢出时也常驻一条 8px 空轨，
   看起来像第三条滚动条。改成溢出才出滚动条（thin + 透明轨，见下方 .dr-list 滚动条规则）。 */
.dr-list{
  flex:1 1 auto;overflow:auto;overscroll-behavior:contain;min-height:120px;
  padding:0;margin:0;
}
.dr-list>*+*{margin-top:2px} /* 行间留缝，避免相邻圆角贴成一块 */

/* 列表行：padding + line-height 撑高，不写死 height */
.dr-drole,.dr-item{
  display:flex;align-items:center;gap:var(--dr-gap);
  box-sizing:border-box;width:100%;min-width:0;
  padding:var(--dr-row-pad-y) var(--dr-row-pad-x);
  padding-left:calc(var(--dr-row-pad-x) + var(--dr-indent,0px));
  border:0;border-radius:var(--dr-row-radius);
  background:0 0;color:inherit;font:inherit;
  font-size:13px;line-height:20px;
  text-align:left;cursor:pointer;user-select:none;
}
.dr-drole:hover,.dr-item:hover{background:var(--dr-fill)}
.dr-item-on{background:var(--dr-fill)}

/* 行内三件：图标格 15px（与宿主 FileTypeIcon 同尺寸）、名字吃掉剩余宽、尾巴定量 */
.dr-slot{flex:none;display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;color:var(--dr-fg3)}
.dr-slot svg{width:15px;height:15px;display:block}
.dr-slot-doc{color:var(--dr-fg3)}
.dr-dslot-arrow{display:none;color:var(--dsw-alias-label-caption,var(--dr-fg3))}
.dr-drole:hover .dr-dslot-folder{display:none}
.dr-drole:hover .dr-dslot-arrow{display:inline-flex}
.dr-arrow{display:inline-flex;transition:transform .12s var(--ds-ease-in-out)}
.dr-arrow-open{transform:rotate(90deg)}

/* 名字与尾巴共用一套字号：13px / 20px。原先 13px+18px 与 12px+16px 两种行高
   挤在同一 flex 行里，基线因此对不齐。 */
.dr-dname,.dr-item-name{
  flex:1 1 auto;min-width:0;
  font-size:13px;line-height:20px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.dr-item-when{
  flex:none;color:var(--dr-fg3);
  font-size:12px;line-height:20px;
  font-variant-numeric:tabular-nums;
}

/* 平铺视图的分组标题：与面板标题条同一套字号，但要缩进到行文字的位置。
   首个标题不额外压缩上边距：压了之后它距上方卡片 6px、距下一个标题 12px，
   层级感反过来（次级分组看着比顶级分组更疏）。统一 12px 起步。 */
.dr-flathead{
  padding:var(--dr-pad) var(--dr-row-pad-x) 4px;
  color:var(--dr-fg2);font-size:12px;line-height:18px;font-weight:500;
}

/* 本会话批注：一张可折叠的卡。
   以前它无条件展开、max-height:38%，能吃掉列表区近一半高度，而常常只有一两条；
   现在头行是开关，默认收起，只占一行摘要。 */
.dr-snotes{
  flex:none;max-height:38%;overflow:auto;box-sizing:border-box;
  border:0.5px solid var(--dr-line);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1);
  transition:border-color var(--ds-transition-duration-fast,.1s),background var(--ds-transition-duration-fast,.1s);
}
.dr-snotes.folded{max-height:none;overflow:visible}
.dr-snotes.folded:hover{border-color:var(--dr-line-strong);background:color-mix(in srgb,var(--dr-fill) 24%,var(--dsw-alias-bg-layer-1))}
.dr-snotes-head{
  position:sticky;top:0;z-index:1;box-sizing:border-box;min-height:40px;
  display:flex;align-items:center;gap:var(--dr-gap);
  padding:6px var(--dr-row-pad-x);
  background:transparent;
  border-bottom:0.5px solid var(--dr-line);
}
.dr-snotes.folded .dr-snotes-head{border-bottom:0}
.dr-snotes-head strong{font-size:12px;line-height:18px;font-weight:500;color:var(--dr-fg2)}
/* 头行整块可点：caret + 标题连成一个按钮，收起时也看得见有内容。 */
.dr-snotes-toggle{
  display:flex;align-items:center;gap:var(--dr-gap);
  padding:0;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;
}
.dr-snotes-toggle:hover strong{color:var(--dr-fg)}
.dr-snotes .dr-fold-caret{margin-left:0}
.dr-snotes.folded .dr-snotes-body{display:none}
.dr-snote{padding:6px var(--dr-row-pad-x);cursor:default}
.dr-snote+.dr-snote{border-top:0.5px solid var(--dr-line)}
.dr-snote-q{font-size:12px;line-height:18px;color:var(--dr-fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dr-snote-n{font-size:13px;line-height:20px;margin-top:2px;word-break:break-word}
.dr-snote-bar{display:flex;gap:var(--dr-gap);align-items:center;margin-top:4px}
.dr-snote.on .dr-snote-n{text-decoration:line-through;color:var(--dr-fg3)}

/* ── 6. 中栏：正文 ─────────────────────────────────────────────────────── */
.dr-toolbar{
  flex:none;display:flex;align-items:center;gap:var(--dr-gap);
  height:28px;min-width:0;
}
.dr-title{
  flex:0 1 auto;min-width:0;
  font-size:13px;line-height:20px;font-weight:500;color:var(--dr-fg);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.dr-breadcrumb{display:flex;align-items:center;gap:7px}
.dr-breadcrumb button{flex:none;max-width:100%;padding:0;border:0;background:transparent;font:inherit;cursor:pointer}
.dr-breadcrumb button:hover{text-decoration:underline;text-underline-offset:2px}
.dr-breadcrumb-part{color:var(--dr-fg3);font-weight:400}
.dr-breadcrumb-sep{color:var(--dr-fg3);font-weight:400}
.dr-breadcrumb-current{color:var(--dr-fg);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-chip{
  flex:none;font-size:11px;line-height:16px;padding:0 6px;border-radius:8px;
  background:var(--dr-fill);color:var(--dr-fg2);font-variant-numeric:tabular-nums;
}
.dr-chip-hi{background:var(--dr-warn-bg);color:var(--dr-warn-fg);font-weight:600}
.dr-chip-warn{background:color-mix(in srgb,var(--dr-err) 16%,transparent);color:var(--dr-err)}

.dr-error{flex:none;font-size:12px;line-height:18px;color:var(--dr-err)}
.dr-msg{
  flex:none;font-size:12px;line-height:18px;color:var(--dr-ok-fg);
  background:var(--dr-ok-bg);border-radius:var(--dsw-radius-sm);
  padding:4px 8px;cursor:pointer;
}

.dr-doc-wrap{flex:1 1 auto;min-height:0;display:flex;gap:4px}
.dr-doc-scroll{
  flex:1 1 auto;min-width:0;overflow:auto;overscroll-behavior:contain;
  /* 正文阅读宽封顶 --dr-doc-max；flex-grow 不会顶破 max-width，多余宽度留白 */
  max-width:var(--dr-doc-max);margin:0 auto;
  padding:var(--dr-pad) 16px 48px;
  border:0;border-radius:var(--dsw-radius-lg);
  background:var(--dsw-alias-bg-layer-1);
  font-size:var(--dsh-content-font-size,14px);
  line-height:calc(24px + var(--dsh-content-font-delta,0px));
}
.dr-doc-hot{cursor:pointer}
/* 批注栏折叠（飞书形态）：文档区右侧让出一条留白带（--dr-rail-pad），气泡按钮悬浮在里面，
   独立于工具条、也不压正文。padding-right 内缩，正文有效宽仍是 --dr-doc-max，
   max-width 用 calc 补回这段宽，保证 margin:auto 居中后正文视觉位置不变。
   未来右栏改宽度只改 --dr-rail-pad 一处，不再出现 820+88=908 这类手工算出来的魔数。 */
.dr-doc-nc{max-width:calc(var(--dr-doc-max) + var(--dr-rail-pad));padding-right:var(--dr-rail-pad)}

/* 正文块：块间距交给 Markdown 元素自己的 margin，这里只留热区与圆角；
   右侧预留行末评论图标的宽度，正文文本在图标之外收住，不与它同排。 */
.dr-block{position:relative;border-radius:var(--dsw-radius-sm);padding:1px 30px 1px 4px}
/* 行末悬停评论图标（视觉行级）：每块一个，平时隐身；engLineFloatMove 把它吸附到
   指针所在视觉行的行末并加 .on 点亮。点击＝对所在块写批注（免划词）。 */
.dr-lineadd{
  position:absolute;right:4px;top:50%;transform:translateY(-50%);z-index:6;
  display:inline-flex;align-items:center;justify-content:center;
  width:22px;height:22px;padding:0;border:0;border-radius:var(--dsw-radius-xs,4px);
  background:var(--dsw-alias-bg-layer-1);color:var(--dr-fg3);cursor:pointer;
  opacity:0;transition:opacity .1s var(--ds-ease-in-out,ease);
  pointer-events:none;
}
.dr-lineadd.on{opacity:1;pointer-events:auto}
.dr-lineadd svg{width:13px;height:13px}
.dr-lineadd:hover{background:var(--dr-fill);color:var(--dr-fg)}
.dr-block-hl{background:color-mix(in srgb,var(--dr-hl) 60%,transparent)}
.dr-block-pending{outline:1px dashed color-mix(in srgb,var(--dr-accent) 60%,transparent);outline-offset:1px}
/* Typora 式行级编辑：编辑态零视觉提示——光标行显示源码、其余行渲染，
 * 全程无框、无底色、无按钮；.tl 是源码行（data-ls 1 基）。 */
.dr-editor-host{outline:none}
.dr-editor-host:focus,.dr-editor-host:focus-visible{outline:none;box-shadow:none;background:transparent}
.dr-block .tl{min-height:1.7em;padding:0 2px;border-radius:var(--dsw-radius-xs,4px)}
.dr-block .tl-blank{height:.6em;min-height:.6em}
.tl-h1,.tl-h2,.tl-h3{font-weight:600;line-height:1.35}
.tl-h1{font-size:1.5em;margin:.6em 0 .3em}
.tl-h2{font-size:1.3em;margin:.6em 0 .3em}
.tl-h3{font-size:1.14em;margin:.5em 0 .25em}
.tl-quote{border-left:3px solid var(--dr-line-strong);color:var(--dr-fg2);padding-left:.9em;margin:.3em 0}
.dr-block .tl-li{padding-left:1.35em;text-indent:-1.35em}
.dr-block .tl-oli{padding-left:1.9em;text-indent:-1.9em}
.tl-code{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:19px;
  background:var(--dsw-alias-markdown-code-block,var(--dr-fill));white-space:pre-wrap}
.tl-fence{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;color:var(--dr-fg3)}
.dr-block .tl-hr{border-top:0.5px solid var(--dr-line);height:0;min-height:0;margin:1em 0}
.tl code{background:var(--dsw-alias-markdown-inline-code,var(--dr-fill));border-radius:4px;padding:0 4px;font-size:.92em}
.tl a{color:var(--dsw-alias-link)}

/* Markdown 元素：字号以中栏基准的 em 派生，不另立档位 */
.dr-h{font-weight:600;margin:.75em 0 .35em;line-height:1.35}
.dr-h1{font-size:1.5em}
.dr-h2{font-size:1.3em}
.dr-h3{font-size:1.14em}
.dr-h4,.dr-h5,.dr-h6{font-size:1em}
.dr-p{margin:.42em 0}
.dr-ul{margin:.35em 0 .35em 1.2em;padding:0}
.dr-quote{margin:.45em 0;padding:.2em .8em;border-left:3px solid var(--dr-line-strong);color:var(--dr-fg2)}
.dr-pre{
  margin:.5em 0;padding:8px 10px;border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-markdown-code-block,var(--dr-fill));
  overflow:auto;font-size:12px;line-height:19px;
  font-family:var(--ds-font-family-code,ui-monospace,monospace);
}
.dr-root code{background:var(--dsw-alias-markdown-inline-code,var(--dr-fill));border-radius:4px;padding:0 4px;font-size:.92em}
.dr-root a{color:var(--dsw-alias-link)}
.dr-table{border-collapse:collapse;margin:.5em 0;font-size:12px;line-height:19px}
.dr-table th,.dr-table td{border:0.5px solid var(--dr-line-strong);padding:3px 7px;text-align:left}
.dr-hr{border:0;border-top:0.5px solid var(--dr-line);margin:1em 0}

/* 批注锚点：闲置＝下划线，激活＝淡底 + 下划线 */
.dr-mark{
  float:right;margin-left:6px;border:0;cursor:pointer;
  font-family:inherit;font-size:11px;line-height:16px;font-weight:600;
  color:var(--dr-hl-ink);background:var(--dr-mark-bg);
  border-radius:999px;padding:0 6px;
}
.dr-mark-count{min-width:20px;height:20px;padding:0 6px;border-radius:6px;background:var(--dr-warn-bg);color:var(--dr-warn-fg);font-size:12px;line-height:20px;text-align:center}
.dr-mark:hover{filter:brightness(.96)}
.dr-mark-done{
  color:var(--dr-ok);background:color-mix(in srgb,var(--dr-ok) 14%,transparent);
  border-radius:8px;padding:0 3px;
  border-bottom:1px dashed color-mix(in srgb,var(--dr-ok) 55%,transparent);
}
::highlight(dr-anchor){
  background-color:transparent;text-decoration:underline;
  text-decoration-color:var(--dr-hl);text-decoration-thickness:2px;text-underline-offset:1px;
}
::highlight(dr-anchor-active){
  background-color:var(--dr-hl-active-bg);text-decoration:underline;
  text-decoration-color:var(--dr-hl-active);text-decoration-thickness:2px;text-underline-offset:1px;
}
::highlight(dr-pending){background:var(--dsw-alias-bg-document-selection,color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent))}

/* 建议模式：就地提案块 */
.dr-inline-prop{
  margin:4px 0;padding:4px 8px;
  border-left:3px solid color-mix(in srgb,var(--dr-accent) 70%,transparent);
  background:color-mix(in srgb,var(--dr-accent) 8%,transparent);
  border-radius:0 var(--dsw-radius-sm) var(--dsw-radius-sm) 0;
  font-size:12px;line-height:18px;display:flex;flex-direction:column;gap:4px;
}
.dr-inline-prop-t{display:flex;gap:4px;flex-wrap:wrap;align-items:baseline}

.dr-props{
  border:0.5px solid color-mix(in srgb,var(--dr-accent) 45%,transparent);
  background:color-mix(in srgb,var(--dr-accent) 8%,transparent);
  border-radius:var(--dsw-radius-md);padding:8px;margin-bottom:8px;
  display:flex;flex-direction:column;gap:6px;
}
.dr-props-head{display:flex;gap:var(--dr-gap);align-items:center}
.dr-prop{
  background:var(--dr-bg,transparent);border:0.5px solid var(--dr-line);
  border-radius:var(--dsw-radius-sm);padding:8px;
  font-size:12px;line-height:18px;display:flex;flex-direction:column;gap:6px;
}
.dr-prop-top{display:flex;align-items:center;gap:8px}
.dr-prop-loc{
  font-size:11px;line-height:16px;font-weight:600;color:var(--dr-fg2);
  font-family:var(--ds-font-family-code,ui-monospace,monospace);
}
.dr-prop-state{
  margin-left:auto;font-size:11px;line-height:16px;font-weight:600;padding:0 6px;border-radius:4px;
  color:var(--dr-warn-fg);background:color-mix(in srgb,var(--dr-warn) 14%,transparent);
}
.dr-prop-diff{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.dr-prop-diff.single{grid-template-columns:1fr}
.dr-prop-old,.dr-prop-new{border-radius:4px;padding:6px 8px;word-break:break-word;font-size:12px;line-height:19px}
.dr-prop-old{
  background:var(--dsw-alias-file-diff-deleted-bg,color-mix(in srgb,var(--dr-err) 14%,transparent));
  color:var(--dsw-alias-file-diff-deleted-marker,var(--dr-err));
  text-decoration:line-through;text-decoration-thickness:1px;
}
.dr-prop-new{
  background:var(--dsw-alias-file-diff-added-bg,color-mix(in srgb,var(--dr-ok) 16%,transparent));
  color:var(--dsw-alias-file-diff-added-marker,var(--dr-ok));
}
.dr-prop-sign{font-family:var(--ds-font-family-code,ui-monospace,monospace);opacity:.7;margin-right:4px}
.dr-prop-note{font-size:11px;line-height:16px;color:var(--dr-fg3)}
.dr-prop-note strong{color:var(--dr-fg2);font-weight:600;margin-right:6px}
.dr-prop-bar{display:flex;gap:var(--dr-gap);align-items:center;margin-top:2px}
@container (max-width:360px){.dr-prop-diff{grid-template-columns:1fr}}

.dr-empty{
  flex:1 1 auto;display:flex;align-items:center;justify-content:center;
  color:var(--dr-fg3);font-size:13px;line-height:20px;padding:40px;text-align:center;
}

/* ── 7. 右栏：批注 ─────────────────────────────────────────────────────── */
/* position+z-index：让头部行（含 ⋯ 弹出的署名菜单）整体浮在下方筛选行之上，
   否则后渲染的 .dr-filter（不透明底）会把菜单盖住。 */
.dr-notes-head{display:flex;align-items:center;gap:var(--dr-gap);height:28px;flex:none;position:relative;z-index:5}
.dr-notes-title{font-size:13px;line-height:20px;font-weight:500}
.dr-author-menu-wrap{position:relative;flex:none}
.dr-author-menu-btn{width:28px;height:28px;border:0;border-radius:4px;background:transparent;color:var(--dr-fg3);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
.dr-author-menu-btn:hover{background:var(--dr-fill);color:var(--dr-fg)}
.dr-author-menu{position:absolute;z-index:20;right:0;top:calc(100% + 4px);min-width:132px;padding:4px;border:1px solid var(--dr-border);border-radius:6px;background:var(--dr-bg);box-shadow:var(--dr-shadow-popover,0 4px 14px color-mix(in srgb,var(--dr-fg) 14%,transparent))}
.dr-author-edit{display:flex;flex-direction:column;gap:6px;padding:2px}
.dr-author-edit .dr-card-actions{margin-top:0}
.dr-author-edit .dr-btn{width:auto}
.dr-author-edit-input{width:160px}
.dr-author-menu button{width:100%;border:0;border-radius:4px;padding:7px 9px;text-align:left;background:transparent;color:var(--dr-fg);font:inherit;font-size:12px;cursor:pointer}
.dr-author-menu button:hover{background:var(--dr-fill)}
.dr-notes-collapse{
  flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:24px;height:24px;border:0;background:transparent;color:var(--dr-fg3);
  cursor:pointer;padding:0;border-radius:var(--dsw-radius-xs,4px);
}
.dr-notes-collapse svg{width:14px;height:14px}
.dr-notes-collapse:hover{background:var(--dr-fill);color:var(--dr-fg)}
/* 折叠态展开入口：右上角悬浮小图标按钮（不占布局空间），带数字微标。 */
.dr-notes-open-fab{
  position:absolute;right:8px;top:8px;z-index:30;  display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;margin:0;flex:none;border:0.5px solid var(--dr-line);
  border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);color:var(--dr-fg3);cursor:pointer;
}
.dr-notes-open-fab:hover{background:var(--dr-fill);color:var(--dr-fg)}
.dr-notes-open-fab svg{width:15px;height:15px}
.dr-notes-open-count{
  position:absolute;right:-5px;top:-5px;min-width:14px;height:14px;padding:0 2px;
  border-radius:8px;background:var(--dr-warn-bg);color:var(--dr-warn-fg);
  font-size:11px;line-height:14px;text-align:center;font-variant-numeric:tabular-nums;
}

/* 过滤器：宿主 SegmentedControl 的做法——一层淡底 + 选中项浮起 */
.dr-filter{
  flex:none;display:flex;align-items:center;gap:2px;padding:2px;
  border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);
}
.dr-filter-tab{
  display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 9px;
  border:0;border-radius:var(--dsw-radius-sm);background:transparent;
  color:var(--dr-fg2);font:inherit;font-size:12px;line-height:18px;
  cursor:pointer;white-space:nowrap;
}
.dr-filter-tab:hover{color:var(--dr-fg)}
.dr-filter-tab.on{background:var(--dsw-alias-bg-base);color:var(--dr-fg);box-shadow:var(--dsw-shadow-lv1)}
.dr-filter-n{font-size:11px;line-height:16px;color:var(--dr-fg3);font-variant-numeric:tabular-nums}
.dr-filter-n-warn{color:var(--dr-warn-fg);font-weight:600}

.dr-notes-scroll{flex:1 1 auto;overflow:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:6px;padding-right:2px}
/* 滚动条归属（修正版）：三栏里只有两个是「真控件」——
   · .dr-doc-scroll（正文）：用户真正滚的对象，唯一主滚动条。
   · .dr-list（文档列表）：与正文无关的独立滚动区。
   第三个 .dr-notes-scroll（批注栏）不是独立控件：它是正文的 1:1 镜像——
   syncNotesScroll() 每次正文滚动都把 nc.scrollTop = dc.scrollTop（见 1318），
   卡片按正文行位置绝对定位（anchorTop 用 docH 缩放）。所以它的滚动条只是
   正文滚动位置的重复读数，和正文那条永远同步、显示同一个位置＝视觉冗余。
   飞书评论栏本身也没有独立滚动条。处理：批注栏滚动条整条隐藏（overflow 仍 auto，
   同步与滚轮行为不变，只是不再画那条镜像滑块）；正文/列表两条对齐宿主 token 收窄。 */
.dr-list,.dr-doc-scroll{
  scrollbar-width:thin;
  scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.22)) transparent;
}
.dr-list::-webkit-scrollbar,.dr-doc-scroll::-webkit-scrollbar{width:8px;height:8px}
.dr-list::-webkit-scrollbar-track,.dr-doc-scroll::-webkit-scrollbar-track{background:transparent}
.dr-list::-webkit-scrollbar-corner,.dr-doc-scroll::-webkit-scrollbar-corner{background:transparent}
.dr-list::-webkit-scrollbar-thumb,.dr-doc-scroll::-webkit-scrollbar-thumb{
  background:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.22));
  border-radius:8px;border:2px solid transparent;background-clip:content-box;
}
.dr-list::-webkit-scrollbar-thumb:hover,.dr-doc-scroll::-webkit-scrollbar-thumb:hover{
  background:var(--dsw-alias-scrollbar-bg-l3,rgba(0,0,0,.4));background-clip:content-box;
}
/* 批注栏＝正文镜像，不画自己的滚动条（Chromium 走 display:none，Firefox 走 width:none）。 */
.dr-notes-scroll{scrollbar-width:none}
.dr-notes-scroll::-webkit-scrollbar{width:0;height:0;display:none}
.dr-notes-anchor{position:relative;flex:none;min-height:1px}
.dr-notes-tail{display:flex;flex-direction:column;gap:8px;flex:none}
.dr-composer{box-sizing:border-box;width:100%;padding:12px;border:1px solid var(--dr-line);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.dr-composer-head{display:flex;align-items:center;gap:8px;min-width:0;margin-bottom:8px}
.dr-composer-loc{flex:none;font-size:12px;line-height:18px;color:var(--dr-fg3)}
.dr-composer-quote{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dr-fg2)}
.dr-composer-input{display:block;min-height:64px}
.dr-composer-actions{display:flex;align-items:center;gap:8px;margin-top:8px}

/* 批注卡（Linear 卡片规格）：radius 8px、半透明底、发丝边——不实底不投影，
   层级靠透明度阶梯而不是色块。 */
.dr-card{
  border:0.5px solid var(--dr-line);border-radius:var(--dsw-radius-sm);
  display:flex;flex-direction:column;overflow:visible;
  background:color-mix(in srgb,var(--dr-fill) 45%,transparent);
  cursor:default;transition:border-color .12s var(--ds-ease-in-out);
}
/* 激活态：比普通卡片更清晰的强调色边界 + 轻底色；不靠大投影，避免压过正文。 */
.dr-card-active{
  border:1px solid var(--dr-accent);
  background:color-mix(in srgb,var(--dr-accent) 8%,var(--dsw-alias-bg-layer-1));
  box-shadow:0 0 0 1px color-mix(in srgb,var(--dr-accent) 28%,transparent);
}
.dr-card-active .dr-card-quote{color:var(--dr-accent);font-weight:500}
.dr-card-resolved{background:color-mix(in srgb,var(--dr-fill) 25%,transparent)}
.dr-card-head{display:flex;align-items:center;gap:var(--dr-gap);padding:8px var(--dr-row-pad-x) 0;min-width:0}
.dr-card-quote{
  flex:1 1 auto;min-width:0;
  font-size:12px;line-height:18px;color:var(--dr-fg2);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;
}
.dr-card-head-ops{flex:none;display:flex;align-items:center;gap:2px}
.dr-card-meta-ops{position:relative;display:flex;align-items:center;gap:2px;opacity:0;pointer-events:none;transition:opacity .12s var(--ds-ease-in-out)}
.dr-card:hover .dr-card-meta-ops,
.dr-card:focus-within .dr-card-meta-ops{opacity:1;pointer-events:auto}
/* 覆盖通用 fixed 菜单定位：评论的更多菜单必须贴着省略号锚点展开。 */
.dr-card-meta-ops .dr-card-menu{position:absolute;top:26px;right:0;z-index:2}
.dr-menu-item-danger{color:var(--dr-err)}
.dr-card-head-ops .dr-icon-btn{width:26px;height:26px}
.dr-card-body{display:flex;flex-direction:column;gap:6px;padding:4px var(--dr-row-pad-x) 8px;min-width:0}
.dr-card-meta{display:flex;align-items:center;gap:var(--dr-gap);min-width:0}
.dr-card-name{
  font-size:13px;line-height:20px;font-weight:500;color:var(--dr-fg);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;
}
.dr-card-time{flex:none;font-size:12px;line-height:20px;color:var(--dr-fg3)}
.dr-card-no{flex:none;font-size:11px;line-height:16px;color:var(--dr-fg3);cursor:help}
.dr-card-note{font-size:13px;line-height:20px;color:var(--dr-fg);white-space:pre-wrap;word-break:break-word}
.dr-card-resolved .dr-card-note,.dr-card-resolved .dr-card-quote,
.dr-card-wontfix .dr-card-note,.dr-card-wontfix .dr-card-quote{color:var(--dr-fg3)}

.dr-avatar{
  flex:none;display:inline-flex;align-items:center;justify-content:center;
  border-radius:50%;color:var(--dr-avatar-ink);font-weight:600;line-height:1;
  user-select:none;-webkit-user-select:none;
}

/* 卡片内的小图标按钮：22×22、4px 微圆角（Linear 小工具按钮口径），命中区仍够 */
.dr-icon-btn{
  flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:22px;height:22px;padding:0;border:0;border-radius:var(--dsw-radius-xs,4px);
  background:transparent;color:var(--dr-fg3);cursor:pointer;
}
.dr-icon-btn:hover{background:var(--dr-fill);color:var(--dr-fg)}
.dr-icon-btn-danger:hover{background:color-mix(in srgb,var(--dr-err) 12%,transparent);color:var(--dr-err)}
.dr-icon-btn svg{width:14px;height:14px}

.dr-edit{display:flex;flex-direction:column;gap:6px}
.dr-thread{
  display:flex;flex-direction:column;gap:var(--dr-gap);
  border-top:0.5px solid var(--dr-line);padding-top:var(--dr-gap);
}
.dr-reply{display:flex;gap:var(--dr-gap);font-size:13px;line-height:20px;min-width:0}
.dr-reply-ai{align-items:flex-start}
.dr-reply-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.dr-reply-head{display:flex;align-items:center;gap:4px;font-size:12px;line-height:18px;color:var(--dr-fg2)}
.dr-reply-who{font-weight:500;color:var(--dr-fg)}
.dr-reply-time{color:var(--dr-fg3)}
.dr-reply-ops{position:relative;display:flex;align-items:center;opacity:0;pointer-events:none;transition:opacity .12s var(--ds-ease-in-out)}
.dr-reply:hover .dr-reply-ops,.dr-reply:focus-within .dr-reply-ops{opacity:1;pointer-events:auto}
.dr-reply-ops .dr-reply-menu{position:absolute;top:26px;right:0;z-index:5}
.dr-reply-edit{display:flex;flex-direction:column;gap:6px}
.dr-reply-edit .dr-card-actions{justify-content:flex-end}
.dr-reply-tag{
  font-size:11px;line-height:16px;padding:0 4px;border-radius:4px;font-weight:600;
  background:var(--dr-accent-bg);color:var(--dr-accent);
}
.dr-reply-text{white-space:pre-wrap;word-break:break-word;color:var(--dr-fg)}

/* 折叠已解决 */
.dr-fold{
  display:flex;align-items:center;gap:4px;margin-top:4px;padding:4px 2px;
  border:0;background:transparent;color:var(--dr-fg2);
  font:inherit;font-size:12px;line-height:18px;cursor:pointer;text-align:left;
}
.dr-fold:hover{color:var(--dr-fg)}
.dr-fold-caret{
  display:inline-flex;align-items:center;justify-content:center;
  width:14px;height:14px;transition:transform .12s var(--ds-ease-in-out);
}
.dr-fold-caret svg{width:12px;height:12px;display:block}
.dr-fold-caret.on{transform:rotate(90deg)}

/* 状态标签（Linear subtle badge）：4px 微圆角、500 字重，不做全圆角 pill */
.dr-status{
  flex:none;font-size:11px;line-height:16px;padding:0 5px;border-radius:var(--dsw-radius-xs,4px);
  background:var(--dr-fill);color:var(--dr-fg2);font-weight:500;
}
.dr-status-resolved{background:var(--dr-ok-bg);color:var(--dr-ok-fg)}
.dr-status-orphan{background:color-mix(in srgb,var(--dr-err) 16%,transparent);color:var(--dr-err)}
.dr-card-actions{display:flex;align-items:center;gap:var(--dr-gap);margin-top:2px}
/* 回复输入（Linear button-style input）：8px 圆角、半透明底、聚焦只加深灰边，
   与左栏搜索框同一口径——不要强调色描边。 */
.dr-reply-input{
  height:28px;border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);
  border-color:var(--dr-line);
}
.dr-reply-input:hover{border-color:var(--dr-line-strong)}
.dr-reply-input:focus{border-color:var(--dr-line-strong);background:var(--dsw-alias-bg-layer-2)}

/* 右栏底部新建批注：与列表用同一条发丝线分开，不再靠 margin-top:auto 硬顶 */
.dr-global{flex:none;border-top:0.5px solid var(--dr-line);padding-top:8px}

/* ── 8. 浮层：与宿主 Menu / Toast 同材质同尺寸 ─────────────────────────── */
/* 宿主 Menu .list：4px padding / radius-lg / 13px 行 / l1 描边的 prominent 高度 */
.dr-menu{
  position:fixed;z-index:10001;box-sizing:border-box;
  min-width:168px;max-width:280px;max-height:60vh;overflow-y:auto;
  display:flex;flex-direction:column;padding:4px;
  border:0;border-radius:var(--dsw-radius-lg);
  color:var(--dsw-alias-label-primary);
  background:linear-gradient(var(--dsw-menu-surface-fill,transparent),var(--dsw-menu-surface-fill,transparent)),var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-2));
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-prominent);
  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);
  font-size:13px;line-height:20px;font-family:inherit;
  user-select:none;-webkit-user-select:none;
}
.dr-menu-label{padding:6px 8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);flex:none}
.dr-menu-item{
  display:flex;align-items:center;gap:var(--dr-gap);
  width:100%;min-height:34px;box-sizing:border-box;padding:6px 8px;
  border:0;border-radius:var(--dsw-radius-md);
  background:transparent;color:inherit;font:inherit;
  font-size:13px;line-height:20px;text-align:left;cursor:pointer;flex:none;
}
.dr-menu-item:hover,.dr-menu-item:focus-visible{background:var(--dr-fill);outline:none}
.dr-menu svg{width:14px;height:14px;flex:none;color:var(--dsw-alias-menu-icon,var(--dr-fg2))}

/* 划词工具条：36px 高的浮条，内嵌 28px 的图标按钮 */
.dr-pill{
  position:fixed;z-index:10000;box-sizing:border-box;border:0;
  display:inline-flex;align-items:center;gap:2px;
  height:36px;padding:4px;border-radius:var(--dsw-radius-md);
  width:max-content;white-space:nowrap;
  color:var(--dsw-alias-label-primary);
  background:linear-gradient(var(--dsw-menu-surface-fill,transparent),var(--dsw-menu-surface-fill,transparent)),var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-2));
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-prominent);
  font-size:13px;line-height:20px;font-family:inherit;
  user-select:none;-webkit-user-select:none;
}
.dr-pill-btn{
  display:inline-flex;align-items:center;flex:none;white-space:nowrap;gap:var(--dr-gap);
  height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);
  background:transparent;color:inherit;font:inherit;cursor:pointer;
}
/* 划词工具条挂载在 shell.overlay（.dr-root 之外），--dr-* 变量取不到——
   hover/分隔线必须在用点直接写宿主 token 并带值回退，主题翻转交给宿主自己。 */
.dr-pill-btn:hover,.dr-pill-btn:focus-visible,.dr-pill-btn-on{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));outline:none}
.dr-pill-btn:active{background:var(--dsw-alias-interactive-bg-active,rgba(38,49,72,.1))}
.dr-pill-sep{width:0.5px;height:16px;margin:0 2px;background:var(--dsw-alias-border-l2,rgba(38,49,72,.12));flex:none}
.dr-pill-more{width:28px;padding:0;justify-content:center}
.dr-pill svg{width:14px;height:14px;flex:none;color:var(--dsw-alias-menu-icon,var(--dsw-alias-label-secondary))}

/* 就地输入浮卡：与 Menu 同材质 */
.dr-float{
  position:fixed;z-index:9999;width:min(430px,calc(100vw - 32px));height:40px;box-sizing:border-box;
  display:flex;align-items:center;gap:8px;padding:4px 8px 4px 20px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  border:0.5px solid var(--dsw-alias-border-l2,rgba(38,49,72,.12));border-radius:999px;
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-prominent);
}
.dr-float-head{display:flex;gap:var(--dr-gap);align-items:baseline;min-width:0}
.dr-float-quote{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.dr-float-loc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);flex:none}
.dr-float-input{
  flex:1 1 auto;min-width:0;height:28px;box-sizing:border-box;padding:4px 0;
  border:0;background:transparent;color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:20px;font-family:inherit;resize:none;outline:none;
}
.dr-float-input:focus{border:0}
.dr-float-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.dr-float-send{
  flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;padding:0;border:0;border-radius:50%;
  background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);
  cursor:pointer;transition:background var(--ds-transition-duration-fast,.1s),opacity var(--ds-transition-duration-fast,.1s);
}
.dr-float-send:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dr-float-send:disabled{opacity:.45;cursor:default}
.dr-float-send svg{width:16px;height:16px}
@media(prefers-reduced-motion:reduce){.dr-float-send{transition:none}}

/* 划词提示词管理窗：模态弹层，与 Menu / Toast 同材质。JSX 里的 dr-pm-* 类名
   必须都能在这里找到对应规则——此前整套缺失，弹出来是一堆裸控件。 */
.dr-pm-backdrop{
  position:fixed;inset:0;z-index:10002;
  display:flex;align-items:center;justify-content:center;
  background:var(--dsw-alias-scrim,var(--dsw-alias-bg-scrim,rgba(0,0,0,.4)));
}
.dr-pm{
  box-sizing:border-box;display:flex;flex-direction:column;gap:8px;
  width:min(480px,calc(100vw - 32px));max-height:min(640px,calc(100vh - 48px));
  padding:12px;border-radius:var(--dsw-radius-lg);
  color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-2);
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-prominent);
  font-size:13px;line-height:20px;font-family:inherit;
}
.dr-pm-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none}
.dr-pm-title{margin:0;font-size:13px;line-height:20px;font-weight:600;color:inherit}
.dr-sent-reference{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.dr-sent-reference-bubble{max-width:min(calc(var(--dsh-chat-content-width,748px)*0.702),82%);padding:10px 16px;border-radius:var(--dsw-radius-xl);background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));white-space:pre-wrap;overflow-wrap:anywhere}
.dr-sent-reference-chip{display:inline-block;max-width:100%;vertical-align:baseline;white-space:normal}
.dr-sent-reference-chip[open]{display:block;margin:4px 0}
.dr-sent-reference-chip summary{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:2px 8px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-business-primary);cursor:pointer;list-style:none;overflow-wrap:anywhere}
.dr-sent-reference-chip summary::-webkit-details-marker{display:none}
.dr-sent-reference-chip summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.dr-sent-reference-chip summary svg{width:1em;height:1em;flex:none}
.dr-sent-reference-source{margin:4px 0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px)}
.dr-sent-reference-chip blockquote{margin:0;padding-left:12px;border-left:2px solid var(--dsw-alias-state-business-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.dr-sent-reference-file{display:flex;align-items:center;gap:6px;margin-top:6px}
.dr-sent-reference-actions{display:flex;align-items:center;gap:12px;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px)}
.dr-sent-reference-actions button{border:0;padding:4px;background:transparent;color:inherit;cursor:pointer;border-radius:4px}
.dr-sent-reference-actions button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dr-sent-reference-actions svg{width:16px;height:16px}
.dr-pm-desc{margin:0;font-size:12px;line-height:18px;color:var(--dr-fg2);flex:none}
.dr-pm-desc code{font-family:inherit;background:var(--dr-fill);border-radius:4px;padding:0 4px}
.dr-pm-list{display:flex;flex-direction:column;gap:8px;min-height:0;overflow-y:auto;flex:1 1 auto}
/* 行不再铺底色：输入框自身是 layer-1 填充，行再铺 layer-1 会把输入框吃回去。
   行与行之间靠间距分组，输入框自带边框承担「可编辑」的可辨识性。 */
.dr-pm-row{display:flex;flex-direction:column;gap:4px;padding:8px;border-radius:var(--dsw-radius-md)}
.dr-pm-row-top{display:flex;align-items:center;gap:6px;min-width:0}
.dr-pm-tag{flex:none;width:22px;font-size:11px;line-height:14px;color:var(--dr-fg3)}
.dr-pm-field{
  box-sizing:border-box;min-width:0;padding:4px 6px;
  /* 宿主 Input 规格（docs/design-tokens.md #209）：l4 描边 + layer-1 底。
     此前 transparent 底 + l2 细边在白卡上完全融掉，看不出可输入区域。 */
  border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;line-height:18px;outline:none;resize:vertical;
}
.dr-pm-field:focus{border-color:var(--dr-line-strong);background:var(--dsw-alias-bg-layer-2)}
.dr-pm-field::placeholder{color:var(--dsw-alias-label-dimmed)}
.dr-pm-label{flex:1 1 auto}
.dr-pm-tpl{margin:0}
.dr-pm-ops{display:flex;gap:2px;flex:none}
.dr-pm-icon{
  display:inline-flex;align-items:center;justify-content:center;
  width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm);
  background:transparent;color:var(--dr-fg2);cursor:pointer;
}
.dr-pm-icon:hover:not(:disabled){background:var(--dr-fill);color:var(--dr-fg)}
.dr-pm-icon:disabled{opacity:.35;cursor:not-allowed}
.dr-pm-icon svg{width:14px;height:14px}
.dr-pm-icon-danger:hover:not(:disabled){color:var(--dr-err)}
.dr-pm-row-body{display:flex;gap:6px;align-items:flex-start}
.dr-pm-row-body .dr-pm-tag{padding-top:5px}
.dr-pm-row-body .dr-pm-tpl{flex:1 1 auto}
.dr-pm-send{display:flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dr-fg2);cursor:pointer;user-select:none;-webkit-user-select:none}
/* 占位与标签同宽，把勾选框推到与名称输入框/内容 textarea 同一左缘 */
.dr-pm-send-tag{flex:none;width:22px}
.dr-pm-send input{margin:0;accent-color:var(--dr-accent)}
.dr-pm-empty{padding:16px 8px;text-align:center;color:var(--dr-fg3);font-size:12px;line-height:18px}
.dr-pm-warn{display:flex;align-items:center;gap:6px;margin:0;font-size:12px;line-height:18px;color:var(--dr-warn-fg);flex:none}
.dr-pm-warn svg{width:14px;height:14px;flex:none}
.dr-pm-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none}
.dr-pm-actions-left,.dr-pm-actions-right{display:flex;gap:6px}
.dr-pm-btn{
  box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;
  height:28px;padding:0 10px;border:0.5px solid var(--dr-line-strong);border-radius:var(--dsw-radius-sm);
  background:transparent;color:var(--dr-fg);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;
}
.dr-pm-btn:hover:not(:disabled){background:var(--dr-fill)}
.dr-pm-btn:active:not(:disabled){background:var(--dr-fill-active)}
.dr-pm-btn svg{width:14px;height:14px;flex:none}
.dr-pm-btn-quiet{border-color:transparent;color:var(--dr-fg2)}
.dr-pm-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.dr-pm-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}

/* Toast：宿主 Toast 是 12px 16px / radius-lg / 深底不随主题翻转 */
.dr-toast{
  position:fixed;top:40px;left:50%;transform:translateX(-50%);z-index:10003;
  pointer-events:none;width:max-content;max-width:min(640px,calc(100vw - 48px));
  padding:12px 16px;border-radius:var(--dsw-radius-lg);
  background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);
  font-size:13px;line-height:20px;box-shadow:var(--dsw-shadow-lv3);
  animation:dr-toast-in .16s var(--ds-ease-in-out);
}

/* 崩溃兜底 */
.dr-boundary{padding:24px;color:var(--dr-err);font-size:13px;line-height:20px;overflow:auto}

/* ── 9. 动效兜底 ───────────────────────────────────────────────────────── */
@media (prefers-reduced-motion:reduce){
  .dr-root *{transition:none !important;animation:none !important}
}
@media (prefers-color-scheme:dark){
  ::highlight(dr-anchor){background-color:transparent;text-decoration-color:color-mix(in srgb,var(--dr-hl) 78%,transparent)}
  ::highlight(dr-anchor-active){background-color:color-mix(in srgb,var(--dr-hl-active) 20%,transparent);text-decoration-color:color-mix(in srgb,var(--dr-hl-active) 86%,transparent)}
  .dr-mark{color:var(--dr-hl-active);background:color-mix(in srgb,var(--dr-mark-bg) 30%,transparent)}
}
`
      var el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = DR_STYLESHEET
      document.head.appendChild(el)
    }

    /* ────────── 选中文字 → 自定义提示词（翻译 / 解读 …）──────────
     * 划词小菜单里除了「批注 / 复制」，还列出用户自己配置的提示词；点一下就把
     * 「提示词 + 选中文字」插进当前会话的聊天输入框（先只插入、不自动发送）。
     * 提示词是本机偏好，存 localStorage；{{text}} 代表选中的文字，模板里没写就附在末尾。 */
    var PROMPTS_KEY = 'dsh-doc-review.prompts'
    var PROMPTS_INLINE = 3
    var DEFAULT_PROMPTS = [
      { id: 'p_explain', label: '解读', template: '帮我再解读一下这段：讲清它在说什么、为什么这么说，必要时举个例子。\n\n「{{text}}」', send: false },
      { id: 'p_dig', label: '深挖', template: '顺着这段再挖一层：背后的原理或机制是什么？作者没明说的前提或假设是什么？\n\n「{{text}}」', send: false },
      { id: 'p_critique', label: '挑刺', template: '帮我挑这段的刺：哪里站不住脚、哪里含糊、哪里过于乐观、作者绕开了什么？按严重程度列 3 条以内，别客气。\n\n「{{text}}」', send: false },
    ]

    /** Clean a stored prompt list: drop blank rows, trim labels, de-duplicate ids, cap the count.
     *  Anything that is not an array means "never configured" → defaults. An empty array is kept. */
    function normalizePrompts(raw) {
      if (!Array.isArray(raw)) return DEFAULT_PROMPTS.map(function (p) { return { id: p.id, label: p.label, template: p.template, send: false } })
      var seen = {}, out = []
      for (var i = 0; i < raw.length && out.length < 30; i++) {
        var p = raw[i]
        if (!p || typeof p !== 'object') continue
        var label = String(p.label || '').trim().slice(0, 16)
        var template = String(p.template || '')
        if (!label || !template.trim()) continue
        var id = String(p.id || '') || ('p_' + i)
        while (seen[id]) id = id + '_'
        seen[id] = true
        out.push({ id: id, label: label, template: template, send: p.send === true })
      }
      return out
    }

    /** Template + selection → the text inserted into the chat box. */
    function fillPrompt(template, text) {
      var t = String(template || ''), s = String(text || '')
      if (t.indexOf('{{text}}') >= 0) return t.split('{{text}}').join(s)
      t = t.replace(/\s+$/, '')
      return t ? t + '\n\n「' + s + '」' : s
    }

    /** Append to whatever the user already typed (annotation block included), one blank line apart. */
    function joinDraft(draft, text) {
      var d = String(draft == null ? '' : draft).replace(/\s+$/, '')
      return d ? d + '\n\n' + text : String(text)
    }

    function loadPrompts() {
      try {
        var s = localStorage.getItem(PROMPTS_KEY)
        return normalizePrompts(s == null ? null : JSON.parse(s))
      } catch (e) { return normalizePrompts(null) }
    }

    function storePrompts(list) {
      var clean = normalizePrompts(list)
      try { localStorage.setItem(PROMPTS_KEY, JSON.stringify(clean)) } catch (e) {}
      return clean
    }

    /** Rough pill width so the toolbar can be clamped inside the viewport before it renders. */
    function pillWidth(labels) {
      var w = 8 + 103 + 64 + 64 + 10 + 8                   // padding + 添加到对话 / 编辑 / 复制 (icon+text) + separators + gaps
      for (var i = 0; i < labels.length; i++) w += 2 + 16 + String(labels[i]).length * 13
      return w + (labels.length ? 7 : 0) + 30                  // separator + ⋯
    }

    /** Stroke glyphs shared by the selection toolbar, its menu and the prompt manager (24-unit box). */
    var PM_ICON = {
      comment: [['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }]],
      copy: [['rect', { x: 9, y: 9, width: 13, height: 13, rx: 2 }], ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }]],
      more: [['circle', { cx: 5, cy: 12, r: 1 }], ['circle', { cx: 12, cy: 12, r: 1 }], ['circle', { cx: 19, cy: 12, r: 1 }]],
      prompt: [['path', { d: 'M4 6h16M4 12h10M4 18h7' }]],
      settings: [['path', { d: 'M4 7h10M18 7h2M4 17h4M12 17h8' }], ['circle', { cx: 16, cy: 7, r: 2 }], ['circle', { cx: 10, cy: 17, r: 2 }]],
      up: [['path', { d: 'M12 19V5M6 11l6-6 6 6' }]],
      down: [['path', { d: 'M12 5v14M6 13l6 6 6-6' }]],
      trash: [['path', { d: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3' }]],
      close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
      more: [['circle', { cx: 5, cy: 12, r: 1 }], ['circle', { cx: 12, cy: 12, r: 1 }], ['circle', { cx: 19, cy: 12, r: 1 }]],
      plus: [['path', { d: 'M12 5v14M5 12h14' }]],
      check: [['path', { d: 'M5 13l4 4L19 7' }]],
      comment: [['path', { d: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.7 8.7 0 0 1-4-.95L3 21l1.95-5.5A8.7 8.7 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3h.5a8.5 8.5 0 0 1 8 8.5Z' }]],
      // 收起评论面板：侧栏滑向右侧的双箭头（语义＝把面板推到右边收起）。
      panelRight: [['path', { d: 'm9 18 6-6-6-6' }], ['path', { d: 'm3 18 6-6-6-6' }]],
      // 上一个/下一个批注：批注在右栏是垂直排列，用上下箭头，不用左右。
      prev: [['path', { d: 'm18 15-6-6-6 6' }]],
      next: [['path', { d: 'm6 9 6 6 6-6' }]],
      pencil: [['path', { d: 'M12 20h9' }], ['path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z' }]],
      refresh: [['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }], ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }], ['path', { d: 'M8 16H3v5' }]],
      undo: [['path', { d: 'M3 7v6h6' }], ['path', { d: 'M21 17a9 9 0 0 0-15-6.7L3 13' }]],
      alert: [['path', { d: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z' }], ['path', { d: 'M12 9v4M12 17h.01' }]],
      // 工具条与列表动作要用的几个。口径与上面一致：24 网格、描边、currentColor；
      // 尺寸与颜色都不写死，由 .dr-btn svg 统一给。
      sparkle: [['path', { d: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z' }], ['path', { d: 'M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9Z' }]],
      revert: [['path', { d: 'M9 14 4 9l5-5' }], ['path', { d: 'M4 9h10a6 6 0 0 1 0 12h-3' }]],
      // 折叠三角。以前用文本字形（▸ ›）凑，字号和基线都跟旁边的文字绑在一起，
      // 结果尺寸随行高漂移、跟别处的图标对不齐；换成和 PM_ICON 同一套的描边图标，
      // 尺寸由容器给，旋转只用 transform。
      chevron: [['path', { d: 'M9 6l6 6-6 6' }]],
      // 文件树用的两枚。口径对齐宿主自己的侧栏（dsh-client-ui-workspace）：
      // 文件夹用「开/关」两个形状，折叠箭头是实心三角，跟文件夹图标同一格位置切换。
      folder: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z' }]],
      folderOpen: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1' }], ['path', { d: 'M3 9h17l-2 9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z' }]],
      triangle: [['path', { d: 'M9 6l8 6-8 6Z', fill: 'currentColor', stroke: 'none' }]],
      doc: [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z' }], ['path', { d: 'M14 3v5h5' }]],
      // 视图切换一枚两态：一个层级缩进，一个平均分行，按钮按当前态换用。
      tree: [['path', { d: 'M4 6h4M4 12h4M4 18h4' }], ['path', { d: 'M12 6h8M12 12h8M12 18h8' }]],
      list: [['path', { d: 'M4 6h16M4 12h16M4 18h16' }]],
      // 排序开关：双向箭头，本身就在说「上下来回切」。
      sort: [['path', { d: 'M8 9l4-4 4 4' }], ['path', { d: 'M8 15l4 4 4-4' }]],
      // 搜索：放大镜。
      search: [['circle', { cx: 11, cy: 11, r: 6 }], ['path', { d: 'm20 20-4.2-4.2' }]],
    }
    function pmIcon(name, sw) {
      return h.apply(null, ['svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: sw || 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }]
        .concat(PM_ICON[name].map(function (e, i) { var a = { key: i }; for (var k in e[1]) a[k] = e[1][k]; return h(e[0], a) })))
    }

    /** 提示词管理：增删改、排序、恢复默认。保存后立即出现在划词菜单里。 */
    function PromptManager(props) {
      var rowsPair = useState(function () { return props.prompts.map(function (p) { return { id: p.id, label: p.label, template: p.template, send: p.send === true } }) })
      var rows = rowsPair[0], setRows = rowsPair[1]
      var listRef = useRef(null)
      var focusLast = useRef(false)

      useEffect(function () {
        function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); props.onClose() } }
        document.addEventListener('keydown', onKey, true)
        return function () { document.removeEventListener('keydown', onKey, true) }
      }, [])
      useEffect(function () {
        if (!focusLast.current || !listRef.current) return
        focusLast.current = false
        var inputs = listRef.current.querySelectorAll('.dr-pm-label')
        var last = inputs[inputs.length - 1]
        if (last) { last.focus(); last.scrollIntoView({ block: 'nearest' }) }
      }, [rows.length])

      function patch(i, k, v) {
        setRows(rows.map(function (r, j) { if (j !== i) return r; var n = { id: r.id, label: r.label, template: r.template, send: r.send === true }; n[k] = v; return n }))
      }
      function move(i, d) {
        var j = i + d
        if (j < 0 || j >= rows.length) return
        var next = rows.slice(); var t = next[i]; next[i] = next[j]; next[j] = t
        setRows(next)
      }
      function remove(i) { setRows(rows.filter(function (_, j) { return j !== i })) }
      function add() { focusLast.current = true; setRows(rows.concat([{ id: 'p_' + Date.now().toString(36), label: '', template: '{{text}}' }])) }

      var dropped = rows.filter(function (r) { return !String(r.label).trim() || !String(r.template).trim() }).length
      function iconBtn(icon, label, onClick, disabled, extra) {
        return h('button', { type: 'button', className: 'dr-pm-icon' + (extra ? ' ' + extra : ''), disabled: disabled, title: label, 'aria-label': label, onClick: onClick }, pmIcon(icon))
      }

      return h('div', { className: 'dr-pm-backdrop', onMouseDown: function (e) { if (e.target === e.currentTarget) props.onClose() } },
        h('div', { className: 'dr-pm', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'dr-pm-title' },
          h('div', { className: 'dr-pm-head' },
            h('h2', { className: 'dr-pm-title', id: 'dr-pm-title' }, '划词提示词'),
            iconBtn('close', '关闭', props.onClose)),
          h('p', { className: 'dr-pm-desc' },
            '点一下把「提示词 + 选中文字」插入输入框；用 ', h('code', null, '{{text}}'),
            ' 指代选中文字，不写则附在末尾；前 ' + PROMPTS_INLINE + ' 个直接显示，其余收进「更多」。'),
          h('div', { className: 'dr-pm-list', ref: listRef },
            rows.length ? rows.map(function (r, i) {
              return h('div', { key: r.id, className: 'dr-pm-row' },
                h('div', { className: 'dr-pm-row-top' },
                  h('span', { className: 'dr-pm-tag' }, '名称'),
                  h('input', {
                    className: 'dr-pm-field dr-pm-label', value: r.label, maxLength: 16, placeholder: '如「翻译」',
                    'aria-label': '提示词名称', onChange: function (e) { patch(i, 'label', e.target.value) },
                  }),
                  h('div', { className: 'dr-pm-ops' },
                    iconBtn('up', '上移', function () { move(i, -1) }, i === 0),
                    iconBtn('down', '下移', function () { move(i, 1) }, i === rows.length - 1),
                    iconBtn('trash', '删除', function () { remove(i) }, false, 'dr-pm-icon-danger'))),
                h('div', { className: 'dr-pm-row-body' },
                  h('span', { className: 'dr-pm-tag' }, '内容'),
                  h('textarea', {
                    className: 'dr-pm-field dr-pm-tpl', rows: 4, value: r.template, placeholder: '{{text}} 处换成选中的文字',
                    'aria-label': '提示词内容', onChange: function (e) { patch(i, 'template', e.target.value) },
                  })),
                h('label', { className: 'dr-pm-send' },
                  h('span', { className: 'dr-pm-send-tag', 'aria-hidden': true }),
                  h('input', { type: 'checkbox', checked: r.send === true, onChange: function (e) { patch(i, 'send', e.target.checked) } }),
                  '点击后直接发送（仅输入框为空时）'))
            }) : h('div', { className: 'dr-pm-empty' }, '还没有提示词')),
          dropped ? h('p', { className: 'dr-pm-warn' }, pmIcon('alert'), dropped + ' 条缺名称或内容，保存时会忽略') : null,
          h('div', { className: 'dr-pm-actions' },
            h('div', { className: 'dr-pm-actions-left' },
              h('button', { type: 'button', className: 'dr-pm-btn dr-pm-btn-outline', onClick: add }, pmIcon('plus'), '新增'),
              h('button', { type: 'button', className: 'dr-pm-btn dr-pm-btn-quiet', onClick: function () { setRows(normalizePrompts(null)) } }, '恢复默认')),
            h('div', { className: 'dr-pm-actions-right' },
              h('button', { type: 'button', className: 'dr-pm-btn dr-pm-btn-outline', onClick: props.onClose }, '取消'),
              h('button', { type: 'button', className: 'dr-pm-btn dr-pm-btn-primary', onClick: function () { props.onSave(rows) } }, '保存')))))
    }

    /* ────────── 会话批注：在对话消息上划词写意见（全局浮层，和文档批注同款用法）──────────
     * 文档视口内由 DocReviewView 自己处理；视口外（也就是正常对话界面）由这里接管：
     * 划词 → 选区旁出现一个小「批注」按钮 → 点开写意见 → 存到该会话的批注文件。
     * 不在划词时直接弹输入框，是为了不干扰你选中文字复制。 */
    function inDocView(node) {
      try {
        var el = node && node.nodeType === 3 ? node.parentNode : node
        while (el && el.classList) {
          if (el.classList.contains('dr-root')) return true
          el = el.parentNode
        }
      } catch (e) {}
      return false
    }

    function readSelection() {
      try {
        var s = window.getSelection()
        if (!s || s.isCollapsed) return null
        var text = String(s.toString() || '').trim()
        if (text.length < 2) return null
        var range = s.getRangeAt(0)
        var r = range.getBoundingClientRect()
        if (!r || (!r.width && !r.height)) return null
        var prefix = ''
        try {
          var probe = range.cloneRange()
          probe.setStart(range.startContainer, Math.max(0, (range.startOffset || 0) - 40))
          prefix = String(probe.toString() || '').slice(-40)
        } catch (e0) {}
        return {
          text: text.length > 2000 ? text.slice(0, 2000) : text,
          prefix: prefix,
          node: range.startContainer,
          rect: { left: r.left, top: r.top, bottom: r.bottom, right: r.right, width: r.width, height: r.height },
        }
      } catch (e) { return null }
    }

    function ChatAnnotator() {
      var selPair = useState(null)
      var sel = selPair[0], setSel = selPair[1]
      var openPair = useState(false)
      var open = openPair[0], setOpen = openPair[1]
      var draftPair = useState('')
      var draft = draftPair[0], setDraft = draftPair[1]
      var toastPair = useState('')
      var toast = toastPair[0], setToast = toastPair[1]

      var promptsPair = useState(loadPrompts)
      var prompts = promptsPair[0], setPrompts = promptsPair[1]
      var morePair = useState(false)
      var moreOpen = morePair[0], setMoreOpen = morePair[1]
      var pmPair = useState(false)
      var pmOpen = pmPair[0], setPmOpen = pmPair[1]

      var selTextRef = useRef('')
      var openRef = useRef(false)
      openRef.current = open || pmOpen
      var pmRef = useRef(false)
      pmRef.current = pmOpen

      // Selection gone → the overflow menu goes with it.
      useEffect(function () { if (!sel) setMoreOpen(false) }, [sel])

      function applyPrompt(p) {
        if (!sel) return
        var text = fillPrompt(p.template, sel.text)
        var shell = composerShell()
        var done = false, sent = false
        if (shell && shell.state && typeof shell.setDraft === 'function') {
          try {
            var draft = (shell.state.getSnapshot() || {}).draft || ''
            if (p.send === true && !String(draft).trim() && typeof shell.submit === 'function') {
              shell.setDraft(text)
              try { shell.submit(); done = true; sent = true } catch (_) {
                try { if (typeof shell.focus === 'function') shell.focus() } catch (_) {}
                done = true
              }
            } else {
              shell.setDraft(joinDraft(draft, text))
              try { if (typeof shell.focus === 'function') shell.focus() } catch (_) {}
              done = true
            }
          } catch (_) { done = false }
        }
        setSel(null); setMoreOpen(false); selTextRef.current = ''
        try { var ws = window.getSelection(); if (ws) ws.removeAllRanges() } catch (_) {}
        if (done) {
          if (sent) { setToast('已发送：' + p.label); return }
          setToast(p.send === true ? '已插入草稿：输入框已有内容或当前宿主暂不可发送，请确认后回车' : '已插入输入框：' + p.label + ' · 确认后回车发送')
          return
        }
        // No chat box reachable (e.g. no active session): fall back to the clipboard so nothing is lost.
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
              function () { setToast('没找到聊天输入框，已把「' + p.label + '」提示词复制到剪贴板') },
              function () { setToast('没找到聊天输入框，插入失败') })
            return
          }
        } catch (_) {}
        setToast('没找到聊天输入框，插入失败')
      }

      function openManager() {
        setMoreOpen(false); setSel(null); selTextRef.current = ''
        setPmOpen(true)
      }

      var managerNode = pmOpen ? h(PromptManager, {
        prompts: prompts,
        onClose: function () { setPmOpen(false) },
        onSave: function (rows) { setPrompts(storePrompts(rows)); setPmOpen(false); setToast('提示词已保存') },
      }) : null

      useEffect(function () {
        if (!open) return undefined
        function onOutsidePointer(e) {
          if (e.target && e.target.closest && e.target.closest('.dr-float')) return
          setOpen(false); setSel(null); setDraft(''); selTextRef.current = ''
        }
        document.addEventListener('pointerdown', onOutsidePointer, true)
        return function () { document.removeEventListener('pointerdown', onOutsidePointer, true) }
      }, [open])

      useEffect(function () {
        // The pill belongs to a live selection: once the selection collapses (click elsewhere,
        // Esc, keyboard) or the page scrolls, drop it. An open composer keeps its own lifetime
        // because focusing its textarea collapses the page selection.
        function onSelChange() {
          if (openRef.current) return
          var s = window.getSelection()
          if (!s || s.isCollapsed || String(s.toString() || '').trim().length < 2) setSel(null)
        }
        function onScroll() { if (!openRef.current) setSel(null) }
        document.addEventListener('selectionchange', onSelChange)
        window.addEventListener('scroll', onScroll, true)
        return function () {
          document.removeEventListener('selectionchange', onSelChange)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [])

      useEffect(function () {
        function onUp(e) {
          if (pmRef.current) return                      // 提示词管理窗里的划选不算划词
          // A click on our own toolbar / menu is not a new selection: the button already acted on mousedown.
          try { if (e && e.target && e.target.closest && e.target.closest('.dr-pill,.dr-menu')) return } catch (_) {}
          var q = readSelection()
          if (!q) { if (!openRef.current) setSel(null); return }
          if (inDocView(q.node)) { setSel(null); setOpen(false); selTextRef.current = ''; return }   // 文档视口里走它自己的流程
          // 换了另一段文字就把上一段没保存的意见清掉，免得"上一条批注又出现在框里"
          if (selTextRef.current !== q.text) { setDraft(''); selTextRef.current = q.text }
          setSel(q)
          setOpen(false)
        }
        document.addEventListener('mouseup', onUp, true)
        return function () { document.removeEventListener('mouseup', onUp, true) }
      }, [])

      useEffect(function () {
        if (!sel) return undefined
        function onKey(e) {
          if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return
          if (String(e.key || '').toLowerCase() !== 'm') return
          e.preventDefault()
          setOpen(true)
          setTimeout(function () {
            var ta = document.querySelector('.dr-float-input')
            if (ta) { try { ta.focus() } catch (_) {} }
          }, 0)
        }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [sel])

      useEffect(function () {
        if (!toast) return
        var t = setTimeout(function () { setToast('') }, 4200)
        return function () { clearTimeout(t) }
      }, [toast])

      function save() {
        if (!sel || !draft.trim()) return
        var sid = currentSessionId()
        if (!sid) { setToast('拿不到会话 id，无法保存'); return }
        apiPost(API.snote, { sessionId: sid, quote: sel.text, prefix: sel.prefix, note: draft.trim() }).then(function (r) {
          if (!r || !r.ok) { setToast('保存失败：' + ((r && r.error) || '未知错误')); return }
          var how = syncDraftToComposer(r.notes || [])
          var n = (r.notes || []).filter(function (x) { return (x.status || 'pending') === 'pending' }).length
          if (how === 'ok') setToast('已写进输入框（第 ' + n + ' 条）· 继续划词加批注，攒够了一次发送')
          else if (how === 'command') setToast('输入框里是命令，没动它 · 批注已存在清单（待处理 ' + (r.pending || 0) + '）')
          else setToast('已记 1 条会话批注（待处理 ' + (r.pending || 0) + '）· 回「批注」页可查看或交给 AI')
          setSel(null); setOpen(false); setDraft(''); selTextRef.current = ''
          try { window.dispatchEvent(new CustomEvent('dsh-doc-review:snotes')) } catch (e) {}
        }).catch(function (e) { setToast('保存失败：' + ((e && e.message) || e)) })
      }

      var toastNode = toast ? h('div', { className: 'dr-toast', role: 'status' }, toast) : null
      if (!sel) return (managerNode || toastNode) ? h('div', null, managerNode, toastNode) : null

      var vw = window.innerWidth || 1200
      var vh = window.innerHeight || 800
      var inline = prompts.slice(0, PROMPTS_INLINE)
      var overflow = prompts.slice(PROMPTS_INLINE)
      var BAR_W = pillWidth(inline.map(function (p) { return p.label }))
      var pillLeft = Math.min(Math.max(sel.rect.right + 6, 8), Math.max(8, vw - BAR_W - 8))
      var pillTop = Math.min(Math.max(sel.rect.top - 8, 8), Math.max(8, vh - 44))

      function addSelectionToConversation() {
        if (!sel) return
        var ref = selectionReference(sel.text, currentSessionId())
        var shell = composerShell()
        var inserted = false
        try {
          if (ref && shell && shell.actions && typeof shell.actions.captureInsertion === 'function' && typeof shell.insertReference === 'function') {
            var span = shell.actions.captureInsertion()
            var draft = String((shell.state.getSnapshot() || {}).draft || '')
            // “添加到对话”保持原有追加语义：徽章插到草稿末尾，而不是覆盖用户正在编辑的内容。
            span = { start: draft.length, end: draft.length, draftRev: span.draftRev }
            inserted = shell.insertReference(ref, span) === true
            if (inserted && typeof shell.focus === 'function') shell.focus()
          }
        } catch (_) { inserted = false }
        if (inserted) {
          setSel(null); setMoreOpen(false); selTextRef.current = ''
          try { var ws = window.getSelection(); if (ws) ws.removeAllRanges() } catch (_) {}
          setToast('已添加对话引用：确认后回车发送')
          return
        }
        // 旧版宿主没有结构化引用 API 时保持兼容，不丢失选中文字。
        applyPrompt({ template: '{{text}}', send: false, label: '选中文字' })
      }

      function copySel() {
        var text = sel.text
        var done = function () { setToast('已复制'); setSel(null); selTextRef.current = '' }
        var fail = function () { setToast('复制失败') }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail)
          else fail()
        } catch (e) { fail() }
      }

      // Small toolbar next to the selection: add the quote to chat, or edit it as a comment.
      var pillNode = open ? null : h('div', {
        className: 'dr-pill', role: 'toolbar', 'aria-label': '选中文字',
        style: { left: pillLeft + 'px', top: pillTop + 'px' },
        onMouseDown: function (e) { e.preventDefault() },
      },
        h('button', {
          type: 'button', className: 'dr-pill-btn',
          title: '把选中文字直接添加到当前对话输入框',
          onMouseDown: function (e) { e.preventDefault(); addSelectionToConversation() },
        },
          pmIcon('comment'), '添加到对话'),
        h('span', { className: 'dr-pill-sep', 'aria-hidden': true }),
        h('button', {
          type: 'button', className: 'dr-pill-btn',
          title: '编辑这段选中文字的批注（' + kbd('Mod+Shift+M') + '）',
          onMouseDown: function (e) { e.preventDefault(); setOpen(true) },
        }, pmIcon('pencil'), '编辑'),
        h('span', { className: 'dr-pill-sep', 'aria-hidden': true }),
        h('button', {
          type: 'button', className: 'dr-pill-btn', title: '复制选中文字',
          onMouseDown: function (e) { e.preventDefault(); copySel() },
        },
          pmIcon('copy'), '复制'),
        inline.length ? h('span', { className: 'dr-pill-sep', 'aria-hidden': true }) : null,
        inline.map(function (p) {
          return h('button', {
            key: p.id, type: 'button', className: 'dr-pill-btn',
            title: (p.send === true ? '点击后直接发送「' : '把「') + p.label + '」提示词连同选中文字' + (p.send === true ? '（仅输入框为空时）' : '插入聊天输入框'),
            onMouseDown: function (e) { e.preventDefault(); applyPrompt(p) },
          }, p.label)
        }),
        // Nothing to overflow → no menu: the last button opens the prompt manager in one click.
        overflow.length
          ? h('button', {
            type: 'button', className: 'dr-pill-btn dr-pill-more' + (moreOpen ? ' dr-pill-btn-on' : ''),
            title: '更多提示词 / 管理提示词', 'aria-label': '更多', 'aria-haspopup': 'menu', 'aria-expanded': moreOpen,
            onMouseDown: function (e) { e.preventDefault(); setMoreOpen(!moreOpen) },
          },
            pmIcon('more', 2))
          : h('button', {
            type: 'button', className: 'dr-pill-btn dr-pill-more dr-pill-manage',
            title: prompts.length ? '编辑提示词' : '添加提示词', 'aria-label': prompts.length ? '编辑提示词' : '添加提示词',
            onMouseDown: function (e) { e.preventDefault(); openManager() },
          },
            pmIcon('settings')))

      var moreNode = null
      if (moreOpen && !open && overflow.length) {
        var MENU_W = 200
        var menuLeft = Math.min(Math.max(pillLeft + BAR_W - MENU_W, 8), Math.max(8, vw - MENU_W - 8))
        var menuH = 8 + (overflow.length ? 27 + overflow.length * 34 + 7 : 0) + 34
        var below = pillTop + 40
        var menuStyle = (below + menuH + 8 > vh)
          ? { left: menuLeft + 'px', bottom: Math.max(8, vh - pillTop + 4) + 'px' }
          : { left: menuLeft + 'px', top: below + 'px' }
        moreNode = h('div', { className: 'dr-menu', role: 'menu', style: menuStyle, onMouseDown: function (e) { e.preventDefault() } },
          overflow.length ? h('div', { className: 'dr-menu-label' }, '更多提示词') : null,
          overflow.map(function (p) {
            return h('button', {
              key: p.id, type: 'button', role: 'menuitem', className: 'dr-menu-item', title: p.template,
              onMouseDown: function (e) { e.preventDefault(); applyPrompt(p) },
            }, pmIcon('prompt'), h('span', { className: 'dr-menu-text' }, p.label))
          }),
          overflow.length ? h('div', { className: 'dr-menu-sep', role: 'separator' }) : null,
          h('button', {
            type: 'button', role: 'menuitem', className: 'dr-menu-item',
            onMouseDown: function (e) { e.preventDefault(); openManager() },
          }, pmIcon('settings'), h('span', { className: 'dr-menu-text' }, prompts.length ? '管理提示词…' : '添加提示词…')))
      }

      var composer = null
      if (open) {
        var place = floatPlacement(sel.rect, vw, vh)
        composer = h('div', {
          className: 'dr-float',
          style: place.above ? { left: place.left + 'px', bottom: place.bottom + 'px' } : { left: place.left + 'px', top: place.top + 'px' },
        },
          h('textarea', {
            className: 'dr-float-input', rows: 1, autoFocus: true, value: draft,
            placeholder: '描述编辑内容…', 'aria-label': '描述编辑内容',
            onChange: function (e) { setDraft(e.target.value) },
            onKeyDown: function (e) {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save() }
              if (e.key === 'Escape') { setOpen(false); setSel(null) }
            },
          }),
          h('button', {
            type: 'button', className: 'dr-float-send', disabled: !draft.trim(),
            title: '添加批注（回车发送）', 'aria-label': '添加批注', onClick: save,
          }, pmIcon('up', 2)))
      }

      return h('div', null, pillNode, moreNode, composer, managerNode, toastNode)
    }

    /* ────────────────────────── 插件入口 ────────────────────────── */

    function apply(ctx) {
      try { ensureStyle() } catch (e) { console.warn('[dsh-doc-review] style inject failed', e) }
      ctx.effect(function () {
        return function () { var el = document.getElementById(STYLE_ID); if (el) el.remove() }
      }, 'dsh-doc-review: styles')

      var slots = ctx.slots
      if (!slots) { console.warn('[dsh-doc-review] slots service unavailable'); return }
      sessions = ctx.sessions || null
      try { remoteFace = ctx.remote || null } catch (e) { remoteFace = null }
      ctxRef = ctx || null
      // 输入框 facade（可选）：拿到就支持"批注直接写进聊天输入框"，拿不到就只落盘。
      // 这里取不到不算失败——composerShell() 每次用之前会惰性重取一次。
      try {
        convFace = (typeof ctx.get === 'function') ? (ctx.get('conversation') || null) : (ctx.conversation || null)
      } catch (e) { convFace = null }
      if (!convFace) console.log('[dsh-doc-review] conversation 服务此刻不可用：稍后保存批注时会再试一次')

      apiPost(API.hello, { sessionId: currentSessionId() }).catch(function () {})

      var disposers = []
      if (typeof slots.entries === 'function' && typeof slots.subscribe === 'function') {
        try { disposers.push(registerSelectionMessages(slots)) }
        catch (e) { console.warn('[dsh-doc-review] sent reference renderer registration failed', e) }
      }
      try {
        disposers.push(slots.inject('conversation.view', function () {
          return slots.register(
            { name: 'conversation.view', id: 'dsh-doc-review-view', order: 82, label: function () { return '批注' } },
            function () { return h(Boundary, null, h(DocReviewView)) },
          )
        }))
      } catch (e) {
        console.warn('[dsh-doc-review] slot registration failed', e)
      }
      // 对话界面上的划词批注（全局浮层，独立于「批注」页）
      try {
        disposers.push(slots.inject('shell.overlay', function () {
          return slots.register(
            { name: 'shell.overlay', id: 'dsh-doc-review-annotator', order: 82 },
            function () { return h(Boundary, null, h(ChatAnnotator)) },
          )
        }))
      } catch (e) {
        console.warn('[dsh-doc-review] overlay slot registration failed', e)
      }
      ctx.effect(function () {
        return function () { for (var i = 0; i < disposers.length; i++) { try { disposers[i]() } catch (e) {} } }
      }, 'dsh-doc-review: slots')

      // 注册 DSH 原生 composer reference codec：引用在输入框里显示为徽章，发送时再序列化为带来源的引用文本。
      try {
        var inputTriggers = (typeof ctx.get === 'function') ? ctx.get('inputTriggers') : ctx.inputTriggers
        if (inputTriggers && typeof inputTriggers.registerSource === 'function') {
          var unregisterSelectionReference = inputTriggers.registerSource({
            trigger: '@', name: SELECTION_REF_SOURCE, showGroupTitle: false,
            candidates: function () { return Promise.resolve([]) },
            onPick: function () { return undefined },
            codec: {
              clipboardText: function (ref) { var value = decodeSelectionReference(ref); return value ? value.text : '' },
              serialize: serializeSelectionReference,
            },
          })
          ctx.effect(function () { return unregisterSelectionReference }, 'dsh-doc-review: selection reference codec')
        } else {
          console.warn('[dsh-doc-review] inputTriggers unavailable; selection will use plain-text fallback')
        }
      } catch (e) {
        console.warn('[dsh-doc-review] selection reference codec registration failed', e)
      }

      console.log('[dsh-doc-review] client ready: conversation.view = 批注')
    }

    exports.inject = ['slots', 'sessions', 'remote', 'remote.session']
    exports.apply = apply
    return module.exports
  },
})
