/**
 * @caihua/dsh-doc-review — 宿主半边（host process）
 *
 * 三件事：
 *   ① /api/dsh-doc-review/* 回环路由：列文档 / 读文档 / 读写批注
 *   ② 三个 agent 工具：doc_review_list / doc_review_resolve / doc_review_reopen
 *   ③ 心跳文件（诊断用：证明宿主半边真的挂上了、浏览器半边真的加载了）
 *
 * 批注落盘位置（跟着文档走，Obsidian 不索引点开头目录）：
 *   <文档目录>/.dsh-review/<文件名>.review.json   —— 结构化真源
 *   <文档目录>/.dsh-review/<文件名>.review.md     —— 人读 / 别的工具读的导出
 *
 * 批注锚点 = 行号区间 + 原文引用 + 上下文，三者同时存，
 * 文档改动后靠 quote 兜底重新定位（见客户端 stale 判定）。
 */
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

export const name = '@caihua/dsh-doc-review'
export const inject = ['webServer', 'tools']

const REVIEW_DIR = '.dsh-review'
// 运行时目录可用环境变量顶掉（烟测用，避免测试写坏用户真实配置）
const HOME_DIR = process.env.DSH_DOC_REVIEW_HOME
  ? path.resolve(process.env.DSH_DOC_REVIEW_HOME)
  : path.join(os.homedir(), '.dsh', 'doc-review')
const CONFIG_PATH = path.join(HOME_DIR, 'config.json')
const HEARTBEAT_PATH = path.join(HOME_DIR, 'heartbeat.json')
const STATE_PATH = path.join(HOME_DIR, 'state.json')

const API = {
  hello: '/api/dsh-doc-review/hello',
  state: '/api/dsh-doc-review/state',
  docs: '/api/dsh-doc-review/docs',
  doc: '/api/dsh-doc-review/doc',
  save: '/api/dsh-doc-review/save',
  ping: '/api/dsh-doc-review/ping',
  snotes: '/api/dsh-doc-review/snotes',
  snote: '/api/dsh-doc-review/snote',
  props: '/api/dsh-doc-review/props',
  prop: '/api/dsh-doc-review/prop',
}

const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', '.obsidian', '.venv', 'venv', '__pycache__',
  'ppt-master', '_参考资料文本缓存', '_删除备份_20260927', '_工具遗留', '_doctools',
])
const SKIP_REL_PREFIXES = ['系统/tools', '系统/ppt-master']

let CLIENT_HELLO_AT = null
let CLIENT_HELLO_COUNT = 0
let CLIENT_HELLO_UA = ''

/* ────────────────────────────── 基础设施 ────────────────────────────── */

function writeJson(res, code, obj) {
  try {
    const body = Buffer.from(JSON.stringify(obj), 'utf8')
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' })
    res.end(body)
  } catch (e) {
    try { console.error('[dsh-doc-review] writeJson failed:', (e && e.message) || e) } catch (_) {}
    try { res.end() } catch (_) {}
  }
}

function isLoopback(req) {
  const a = String((req.socket && req.socket.remoteAddress) || '')
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' || a === 'localhost' || a === ''
}

function readJsonBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { try { req.destroy() } catch (_) {} ; resolve({}) ; return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}) } catch (_) { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function absOf(p) { return path.resolve(String(p || '')) }

/* ────────── 跨平台路径规则（纯函数，platform 可注入，见 test/path-utils.mjs）──────────
 * 这个插件最早只在 Windows 上开发：只认盘符路径、一律 toLowerCase。在 macOS/Linux 上
 * 会话转写里的 POSIX 路径全部被丢掉，而 Linux 文件系统区分大小写，不能拿小写当身份。 */
const WIN_ABS_RE = /^[A-Za-z]:[\\/]/

function pathModOf(platform) { return platform === 'win32' ? path.win32 : path.posix }

/** win32 与 darwin 的默认文件系统不区分大小写；其它（Linux 等）区分 */
function caseInsensitiveFs(platform = process.platform) { return platform === 'win32' || platform === 'darwin' }

/** 会话转写里的一个字符串是不是本平台的绝对路径：win32 认盘符，其它平台认 / 开头（排除 // 协议相对 URL） */
function isAbsDocPath(s, platform = process.platform) {
  const t = String(s || '')
  if (platform === 'win32') return WIN_ABS_RE.test(t)
  return t.startsWith('/') && !t.startsWith('//')
}

/** 统一分隔符：win32 把 / 换成 \\（保持旧行为）；POSIX 上反斜杠是合法文件名字符，原样保留 */
function normDocPath(s, platform = process.platform) {
  const t = String(s || '')
  return platform === 'win32' ? t.replace(/\//g, '\\') : t
}

/** 去重 / 比较用的路径身份：先 resolve，只在大小写不敏感的平台上转小写 */
function pathKey(p, platform = process.platform) {
  const r = pathModOf(platform).resolve(String(p || ''))
  return caseInsensitiveFs(platform) ? r.toLowerCase() : r
}

/** 未配置时的作者本机 vault：只在 Windows 上有，其它平台没有（交给 getConfig 退到主目录） */
function defaultVault(platform = process.platform) { return platform === 'win32' ? 'C:\\业务' : '' }

/** 仅 win32 把 \\ 换成 /（POSIX 上 \\ 是文件名字符，不动） */
function toFwd(p, platform = process.platform) {
  const t = String(p || '')
  return platform === 'win32' ? t.replace(/\\/g, '/') : t
}

/** 正斜杠形式的路径是否落在 SKIP_REL_PREFIXES 里（按末尾匹配；大小写按平台） */
function isSkippedRel(fwdPath, platform = process.platform) {
  const ci = caseInsensitiveFs(platform)
  const s = ci ? String(fwdPath || '').toLowerCase() : String(fwdPath || '')
  return SKIP_REL_PREFIXES.some((p) => s.endsWith(ci ? p.toLowerCase() : p))
}

function isUnder(target, root, platform = process.platform) {
  const sep = pathModOf(platform).sep
  const t = pathKey(target, platform)
  const r = pathKey(root, platform)
  if (t === r) return true
  return t.startsWith(r.endsWith(sep) ? r : r + sep)
}

function isUnderAny(target, roots) {
  return roots.some((r) => isUnder(target, r))
}

async function readJsonFile(p, fallback) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')) } catch (_) { return fallback }
}

async function writeAtomic(p, text) {
  await fsp.mkdir(path.dirname(p), { recursive: true })
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now()
  await fsp.writeFile(tmp, text, 'utf8')
  await fsp.rename(tmp, p)
}

function nowIso() {
  const d = new Date()
  const off = -d.getTimezoneOffset()
  const s = off >= 0 ? '+' : '-'
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')
  const mm = String(Math.abs(off) % 60).padStart(2, '0')
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
    'T' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0') + s + hh + ':' + mm
}

function stamp() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
    ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

function sha1(s) { return crypto.createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 12) }

/* ────────────────────────────── 配置 ────────────────────────────── */

let CONFIG = null

// 批注署名默认值：用本机用户名，别人装上不需要改配置就有名字
function defaultAuthor() {
  try {
    return (os.userInfo().username || '').trim() || 'me'
  } catch (_) {
    return 'me'
  }
}

async function getConfig() {
  if (CONFIG) return CONFIG
  const fallbackRoots = []
  // 根目录：优先环境变量，其次作者本机的 vault（存在才用），最后退到用户主目录。
  const vault = process.env.DSH_DOC_REVIEW_VAULT || defaultVault()
  if (vault && existsSync(vault)) fallbackRoots.push(vault)
  if (!fallbackRoots.length) fallbackRoots.push(os.homedir())
  const cfg = { roots: fallbackRoots, maxDocs: 60000, maxDepth: 20, projectSessions: 15, author: defaultAuthor() }
  const disk = await readJsonFile(CONFIG_PATH, null)
  if (disk && Array.isArray(disk.roots) && disk.roots.length) cfg.roots = disk.roots.map(String)
  // ★ 曾经这里写死 Math.min(..., 5000)，把配置里的 60000 悄悄压成 5000，导致全库只扫到约三分之一
  if (disk && Number(disk.maxDocs) > 0) cfg.maxDocs = Math.min(Number(disk.maxDocs), 200000)
  if (disk && Number(disk.maxDepth) > 0) cfg.maxDepth = Math.min(Number(disk.maxDepth), 64)
  if (disk && Number(disk.projectSessions) > 0) cfg.projectSessions = Math.min(Number(disk.projectSessions), 60)
  if (disk && disk.author) cfg.author = String(disk.author)
  CONFIG = cfg
  if (!disk) { try { await writeAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2)) } catch (_) {} }
  return cfg
}

/* ────────────────────────────── 批注读写 ────────────────────────────── */

function reviewJsonOf(doc) { return path.join(path.dirname(doc), REVIEW_DIR, path.basename(doc) + '.review.json') }
function reviewMdOf(doc) { return path.join(path.dirname(doc), REVIEW_DIR, path.basename(doc) + '.review.md') }

function emptyReview(doc) {
  return { v: 1, doc: doc, docHash: '', docMtimeMs: 0, updatedAt: nowIso(), comments: [] }
}

function sha256hex(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex') }

/**
 * 落盘格式对齐 MRSF / Sidemark（Markdown Review Sidecar Format v1.0 Draft，sidemark.org）。
 * 为什么不自创：MRSF 已有 @mrsf/mcp、@mrsf/cli、VS Code 扩展等消费方，字段语义也写死了重锚规则。
 * 磁盘字段（MRSF 核心）：id / author / timestamp / text / resolved / line / end_line /
 *   selected_text / selected_text_hash / anchored_text / reply_to
 * 本插件私有状态走 x_ 前缀：x_status / x_reply / x_resolved_at / x_updated_at / x_created_at
 * 内部运行时仍用扁平名（lineStart/quote/note/status），存取时双向映射，UI 代码不必认识 MRSF。
 */
function toMrsf(c) {
  const quote = String(c.quote || '')
  return {
    id: c.id,
    author: c.author || '',
    timestamp: c.createdAt,
    text: c.note || '',
    resolved: c.status !== 'pending',
    line: Number(c.lineStart) || 0,
    end_line: Number(c.lineEnd) || Number(c.lineStart) || 0,
    selected_text: quote,
    selected_text_hash: quote ? 'sha256:' + sha256hex(quote) : '',
    anchored_text: c.anchored === false ? '' : quote,
    reply_to: null,
    x_status: c.status,
    x_reply: c.reply || '',
    x_resolved_at: c.resolvedAt || null,
    x_created_at: c.createdAt,
    x_updated_at: c.updatedAt,
  }
}

function fromMrsf(m) {
  const status = (m.x_status === 'resolved' || m.x_status === 'wontfix' || m.x_status === 'pending')
    ? m.x_status
    : (m.resolved ? 'resolved' : 'pending')
  return {
    id: String(m.id || ('c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6))),
    createdAt: String(m.x_created_at || m.timestamp || nowIso()),
    updatedAt: String(m.x_updated_at || m.timestamp || nowIso()),
    author: String(m.author || ''),
    lineStart: Number(m.line) || 0,
    lineEnd: Number(m.end_line) || Number(m.line) || 0,
    quote: String(m.selected_text || ''),
    note: String(m.text || ''),
    status: status,
    reply: m.x_reply ? String(m.x_reply) : '',
    resolvedAt: m.x_resolved_at ? String(m.x_resolved_at) : null,
    anchored: m.anchored_text === undefined ? true : String(m.anchored_text || '') !== '',
  }
}

/** 兼容旧版扁平字段（v0.1 落盘过的话能直接读回来） */
function normComment(c) {
  if (c && (c.selected_text !== undefined || c.line !== undefined || c.timestamp !== undefined)) return fromMrsf(c)
  return {
    id: String(c.id || ('c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6))),
    createdAt: String(c.createdAt || nowIso()),
    updatedAt: String(c.updatedAt || c.createdAt || nowIso()),
    author: String(c.author || ''),
    lineStart: Number(c.lineStart) || 0,
    lineEnd: Number(c.lineEnd) || Number(c.lineStart) || 0,
    quote: String(c.quote || ''),
    note: String(c.note || ''),
    status: (c.status === 'resolved' || c.status === 'wontfix') ? c.status : 'pending',
    reply: c.reply ? String(c.reply) : '',
    resolvedAt: c.resolvedAt ? String(c.resolvedAt) : null,
    anchored: c.anchored === undefined ? true : !!c.anchored,
  }
}

async function readReview(doc) {
  const j = await readJsonFile(reviewJsonOf(doc), null)
  if (!j || !Array.isArray(j.comments)) return emptyReview(doc)
  return {
    v: 1,
    doc: doc,
    docHash: String(j.docHash || j.document_hash || ''),
    docMtimeMs: Number(j.docMtimeMs) || 0,
    updatedAt: String(j.updatedAt || nowIso()),
    comments: j.comments.map(normComment),
  }
}

async function writeReview(doc, review) {
  const internal = {
    v: 1,
    doc: doc,
    docHash: String(review.docHash || ''),
    docMtimeMs: Number(review.docMtimeMs) || 0,
    updatedAt: nowIso(),
    comments: (review.comments || []).map(normComment),
  }
  const mrsf = {
    mrsf: '1.0',
    document: doc,
    document_hash: internal.docHash,
    updated_at: internal.updatedAt,
    generator: '@caihua/dsh-doc-review',
    comments: internal.comments.map(toMrsf),
  }
  await writeAtomic(reviewJsonOf(doc), JSON.stringify(mrsf, null, 2))
  await writeAtomic(reviewMdOf(doc), renderReviewMd(internal))
  return internal
}

function renderReviewMd(r) {
  const pending = r.comments.filter((c) => c.status === 'pending')
  const L = []
  L.push('# 审阅意见 · ' + path.basename(r.doc))
  L.push('')
  L.push('- 文档：`' + r.doc + '`')
  L.push('- 文档指纹：`' + (r.docHash || '（未记录）') + '`')
  L.push('- 待处理：' + pending.length + ' 条 / 共 ' + r.comments.length + ' 条')
  L.push('- 生成时间：' + r.updatedAt)
  L.push('')
  L.push('> 改稿规则：只改批注指向的位置，其余内容不动；改完用 `doc_review_resolve` 工具标记已处理并回填一句说明。')
  L.push('')
  const ordered = r.comments.slice().sort((a, b) => (a.lineStart || 0) - (b.lineStart || 0))
  ordered.forEach((c, i) => {
    const head = c.lineStart ? 'L' + c.lineStart + (c.lineEnd && c.lineEnd !== c.lineStart ? '–L' + c.lineEnd : '') : '全文'
    const flag = c.status === 'pending' ? '待处理' : (c.status === 'resolved' ? '已处理' : '不改')
    L.push('## [' + (i + 1) + '] ' + flag + ' · ' + head)
    if (c.quote) {
      L.push('')
      L.push('**原文**：')
      L.push('')
      L.push('> ' + c.quote.replace(/\n+/g, ' ').slice(0, 500))
    }
    L.push('')
    L.push('**意见**：' + (c.note || '（空）'))
    if (c.reply) { L.push(''); L.push('**处理说明**：' + c.reply) }
    L.push('')
  })
  return L.join('\n')
}

/* ────────────────────────────── 文档扫描 ────────────────────────────── */

/** 每个根目录一份扫描缓存（全量扫描约 3 秒，实测 24582 篇 md / C:\业务，故缓存 5 分钟） */
const docCache = new Map()

async function scanRoot(root, cfg, force) {
  const key = absOf(root)
  const now = Date.now()
  const hit = docCache.get(key)
  if (!force && hit && now - hit.at < 300000) return hit
  const t0 = Date.now()
  const docs = await scanDocs(key, cfg)
  const rec = { at: now, docs, scanMs: Date.now() - t0, scanned: docs.length }
  docCache.set(key, rec)
  return rec
}

function filterQ(docs, q) {
  const needle = String(q || '').trim().toLowerCase()
  if (!needle) return docs
  return docs.filter((d) => d.rel.toLowerCase().includes(needle) || d.name.toLowerCase().includes(needle))
}

/* ────────────────── 会话范围：这个会话到底碰过哪些文档 ──────────────────
 * DSH 把每个会话写成 ~/.dsh/sessions/<工作区编码>/<sessionId>/session*.jsonl.zstd，
 * 而且是**多帧追加**的 zstd（一帧一条记录，实测一个会话 404 帧）；Node 的 zstdDecompressSync
 * 只吃第一帧，所以这里按 frame magic 切开逐帧解压（3MB/26ms）。
 * tool/call 的 data.arguments 是内层 JSON 字符串，JSON.parse 之后读 file_path，
 * 就能拿到 agent 真正 read / write / edit 过的文件——这就是「本会话涉及到的文档」。
 */

const SESS_ROOT = process.env.DSH_DOC_REVIEW_SESSIONS
  ? path.resolve(process.env.DSH_DOC_REVIEW_SESSIONS)
  : path.join(os.homedir(), '.dsh', 'sessions')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const DOC_EXT_RE = /\.(md|markdown)$/i
const NOISE_PATH_RE = /[\\/](node_modules|\.dsh[\\/]profiles|\.dsh[\\/]memory[\\/]workspaces|\.git|\.obsidian)[\\/]/i
// 只认这三类记录里的路径：tool/call（agent 真读写）、deliverables/presented（交付给用户的文件）、
// agent/inbox/spliced（子代理的活动，子代理写的文档只会出现在这里）；user/message 里是注入的
// 记忆快照，全是噪音，必须排除。
const PATH_RECORD_TYPES = new Set(['tool/call', 'deliverables/presented', 'agent/inbox/spliced'])

/** 深度遍历一条记录里的所有字符串，收集「看起来是绝对路径的 md」。
 *  不用正则扫原始 JSON：转义层级（内层 JSON 字符串再被外层 JSON 转义）会让反斜杠数量对不上。 */
function collectDocPaths(node, out, depth) {
  if (depth > 8 || node === null || node === undefined) return
  if (typeof node === 'string') {
    const t = node.trim()
    if ((t.startsWith('{') || t.startsWith('[')) && t.length < 400000) {
      try { collectDocPaths(JSON.parse(t), out, depth + 1); return } catch (_) {}
    }
    if (t.length < 300 && isAbsDocPath(t) && DOC_EXT_RE.test(t)) out.push(normDocPath(t))
    return
  }
  if (Array.isArray(node)) { for (const v of node) collectDocPaths(v, out, depth + 1); return }
  if (typeof node === 'object') { for (const k of Object.keys(node)) collectDocPaths(node[k], out, depth + 1) }
}

function decodeSessionFrames(buf) {
  if (typeof zlib.zstdDecompressSync !== 'function') return null
  const idx = []
  let i = buf.indexOf(ZSTD_MAGIC, 0)
  while (i >= 0) { idx.push(i); i = buf.indexOf(ZSTD_MAGIC, i + 4) }
  if (!idx.length) return null
  const out = []
  for (let k = 0; k < idx.length; k++) {
    const start = idx[k]
    const end = k + 1 < idx.length ? idx[k + 1] : buf.length
    try { out.push(zlib.zstdDecompressSync(buf.subarray(start, end))) } catch (_) { /* magic 撞车：丢这一帧，不影响其它 */ }
  }
  return Buffer.concat(out).toString('utf8')
}

/** 一个会话目录里可能有**多份**转写（session.jsonl / session.v3 / session.v4…），
 *  旧版本文件按字母序排在前面。曾经这里 `files.find()` 直接取第一个 ⇒ 读到的是几个月前的旧转写，
 *  会话最近做的事全都看不到（实测 session-7c58dbd2：v3=9/23 的旧稿、v4=今天的现场）。
 *  现在返回全部转写（按修改时间倒序），由调用方合并。 */
async function findSessionFiles(sessionId) {
  if (!/^[A-Za-z0-9_-]{4,90}$/.test(String(sessionId || ''))) return null
  let dirs = []
  try { dirs = await fsp.readdir(SESS_ROOT, { withFileTypes: true }) } catch (_) { return null }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const base = path.join(SESS_ROOT, d.name, sessionId)
    let names = []
    try { names = await fsp.readdir(base) } catch (_) { continue }
    const zst = names.filter((x) => /^session.*\.jsonl\.zstd$/.test(x))
    const plain = names.filter((x) => /^session.*\.jsonl$/.test(x))
    const list = []
    for (const f of (zst.length ? zst : plain)) {
      const fp = path.join(base, f)
      const st = await fsp.stat(fp).catch(() => null)
      if (st) list.push({ name: f, fp, zstd: /\.zstd$/.test(f), mtimeMs: st.mtimeMs, size: st.size })
    }
    if (list.length) {
      list.sort((a, b) => b.mtimeMs - a.mtimeMs)
      return { dir: base, wsDir: d.name, files: list }
    }
  }
  return null
}

/** 兼容旧调用：取最新的那一份 */
async function findSessionFile(sessionId) {
  const r = await findSessionFiles(sessionId)
  return r ? { fp: r.files[0].fp, zstd: r.files[0].zstd, wsDir: r.wsDir } : null
}

/** 从一份会话转写里抽「碰过的文档」：tool/call + deliverables/presented + agent/inbox/spliced */
function extractTouched(text) {
  const hits = new Map()
  let cwd = ''
  for (const line of text.split('\n')) {
    if (!line) continue
    let j = null
    try { j = JSON.parse(line) } catch (_) { continue }
    if (j.type === 'session' && j.cwd && !cwd) cwd = String(j.cwd)
    if (!PATH_RECORD_TYPES.has(j.type)) continue
    const name = j.type === 'tool/call'
      ? String((j.data && j.data.name) || '')
      : (j.type === 'deliverables/presented' ? 'deliverable' : 'subagent')
    const cand = []
    collectDocPaths(j.type === 'tool/call' ? (j.data && j.data.arguments) : j.data, cand, 0)
    const t = Number(j.time) || 0
    for (const p of cand) {
      if (!DOC_EXT_RE.test(p) || NOISE_PATH_RE.test(p)) continue
      // 用 pathKey 做键：不同会话里同一文件可能写成不同大小写/斜杠；只在大小写不敏感的平台上折叠大小写
      const norm = path.resolve(p)
      const key = pathKey(norm)
      const rec = hits.get(key) || { path: norm, hits: 0, via: name, seenMs: 0 }
      rec.hits++
      if (t > rec.seenMs) rec.seenMs = t          // 会话里最后一次动这篇文档的时间
      if (name === 'write' || name === 'edit' || name === 'deliverable') rec.via = name
      hits.set(key, rec)
    }
  }
  return { cwd, hits }
}

/** 多份转写的命中合并（同一路径累加次数、取较晚的 seenMs） */
function mergeHits(target, extra) {
  for (const [k, rec] of extra) {
    const prev = target.get(k)
    if (!prev) { target.set(k, { ...rec }); continue }
    prev.hits += rec.hits
    if ((rec.seenMs || 0) > (prev.seenMs || 0)) prev.seenMs = rec.seenMs
    if (rec.via === 'write' || rec.via === 'edit' || rec.via === 'deliverable') prev.via = rec.via
    if (rec.fromSessions) prev.fromSessions = (prev.fromSessions || 0) + rec.fromSessions
  }
}

async function hitsToDocs(hits) {
  const docs = []
  for (const rec of hits.values()) {
    let st = null
    try { st = await fsp.stat(rec.path) } catch (_) { st = null }
    if (!st || !st.isFile()) continue
    docs.push({
      path: rec.path, rel: rec.path, name: path.basename(rec.path), size: st.size,
      mtimeMs: st.mtimeMs, updatedAt: stamp2(st.mtimeMs), pending: 0, total: 0,
      via: rec.via, hits: rec.hits, fromSessions: rec.fromSessions || 0, seenMs: rec.seenMs || 0,
    })
  }
  docs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return docs
}

const sessionCache = new Map()

async function sessionTouchedDocs(sessionId, force) {
  const key = String(sessionId || '')
  const now = Date.now()
  const cached = sessionCache.get(key)
  // 转写在会话进行中一直在长，所以只缓存 20 秒
  if (!force && cached && now - cached.at < 20000) return cached
  const out = { at: now, cwd: '', wsDir: '', docs: [], found: false, reason: '', files: 0 }
  const hit = await findSessionFiles(key)
  if (!hit) { out.reason = '没找到会话转写文件'; sessionCache.set(key, out); return out }
  out.found = true
  out.wsDir = hit.wsDir
  out.files = hit.files.length

  const merged = new Map()
  let any = false
  for (const f of hit.files) {
    let text = ''
    try {
      const buf = await fsp.readFile(f.fp)
      text = f.zstd ? decodeSessionFrames(buf) : buf.toString('utf8')
    } catch (_) { text = '' }
    if (!text) continue
    any = true
    const { cwd, hits } = extractTouched(text)
    if (cwd && !out.cwd) out.cwd = cwd
    mergeHits(merged, hits)
  }
  if (!any) { out.reason = '转写解压失败或为空'; sessionCache.set(key, out); return out }

  out.docs = await hitsToDocs(merged)
  // 第一层按「会话里最后一次动这篇文档的时间」排——比文件 mtime 更贴近「会话里最新的那篇」
  out.docs.sort((a, b) => (b.seenMs || b.mtimeMs) - (a.seenMs || a.mtimeMs))
  sessionCache.set(key, out)
  return out
}

/* 本项目（同一工作区）其它会话碰过的文档。
 * 一个项目可能有几百个会话、上百 MB 转写，全解不可能：只取**最近 N 个会话**并设字节预算，
 * 结果按工作区缓存 10 分钟。这是「项目文件夹里被工作过的文档」，不是文件夹全量。 */
const projectCache = new Map()

async function projectTouchedDocs(wsDir, excludeSessionId, cfg, force) {
  const key = String(wsDir || '')
  if (!key) return { at: Date.now(), docs: [], sessions: 0, reason: '未知工作区' }
  const now = Date.now()
  const cached = projectCache.get(key)
  if (!force && cached && now - cached.at < 600000) return cached

  const base = path.join(SESS_ROOT, key)
  let sessDirs = []
  try { sessDirs = await fsp.readdir(base, { withFileTypes: true }) } catch (_) { return { at: now, docs: [], sessions: 0, reason: '读不到工作区会话目录' } }

  const cands = []
  for (const d of sessDirs) {
    if (!d.isDirectory() || d.name === excludeSessionId) continue
    const dir = path.join(base, d.name)
    let files = []
    try { files = await fsp.readdir(dir) } catch (_) { continue }
    // 一个会话可能有多份转写，tier2 只取最新的那份（够用且省时间）
    const all = []
    for (const f of files) {
      if (!/^session.*\.jsonl(\.zstd)?$/.test(f)) continue
      const fp = path.join(dir, f)
      const st = await fsp.stat(fp).catch(() => null)
      if (st) all.push({ fp, zstd: /\.zstd$/.test(f), mtimeMs: st.mtimeMs, size: st.size })
    }
    if (!all.length) continue
    all.sort((a, b) => b.mtimeMs - a.mtimeMs)
    cands.push(all[0])
  }
  cands.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const maxSessions = Math.min(Math.max(Number(cfg.projectSessions) || 15, 1), 60)
  const byteBudget = 25 * 1024 * 1024
  const merged = new Map()
  let used = 0
  let read = 0
  for (const c of cands) {
    if (read >= maxSessions || used > byteBudget) break
    used += c.size
    read++
    let text = ''
    try {
      const buf = await fsp.readFile(c.fp)
      text = c.zstd ? decodeSessionFrames(buf) : buf.toString('utf8')
    } catch (_) { continue }
    if (!text) continue
    const { hits } = extractTouched(text)
    for (const [p, rec] of hits) {
      const prev = merged.get(p)
      if (!prev) { merged.set(p, { ...rec, fromSessions: 1 }) }
      else { prev.hits += rec.hits; prev.fromSessions++; if (rec.via === 'write' || rec.via === 'edit') prev.via = rec.via }
    }
  }
  const docs = await hitsToDocs(merged)
  const out = { at: now, docs, sessions: read, candidates: cands.length, capped: cands.length > read }
  projectCache.set(key, out)
  return out
}

/** 这个文档是不是本会话碰过的（用来放行根目录之外的文档：会话读写过就允许打开与写批注） */
async function inSessionDocs(sessionId, doc) {
  if (!sessionId) return false
  const s = await sessionTouchedDocs(sessionId, false)
  const k = pathKey(doc)
  return s.docs.some((d) => pathKey(d.path) === k)
}

/** 给一批文档补批注数：按目录批量读 .dsh-review，不逐个 stat */
async function attachReviewCounts(docs) {
  const byDir = new Map()
  for (const d of docs) {
    const dir = path.dirname(d.path)
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir).push(d)
  }
  for (const [dir, list] of byDir) {
    let files = []
    try { files = await fsp.readdir(path.join(dir, REVIEW_DIR)) } catch (_) { continue }
    for (const f of files) {
      if (!f.endsWith('.review.json')) continue
      const base = f.slice(0, -'.review.json'.length)
      const target = list.find((d) => d.name === base)
      if (!target) continue
      const r = await readJsonFile(path.join(dir, REVIEW_DIR, f), null)
      if (!r || !Array.isArray(r.comments)) continue
      const cs = r.comments.map(normComment)
      target.total = cs.length
      target.pending = cs.filter((c) => c.status === 'pending').length
    }
  }
  return docs
}

async function listDocsByScope({ scope, sessionId, ws, q, force }, cfg) {
  const want = ['related', 'session', 'workspace', 'vault'].includes(scope) ? scope : 'related'
  // 批注数只挂在最终返回的那一页上（≤400 篇）—— 全量数组上逐个目录读 .dsh-review 会白白多花几秒
  const page = async (docs, extra) => {
    const view = filterQ(docs, q)
    const out = view.slice(0, 400)
    await attachReviewCounts(out)
    return { total: view.length, ...extra, docs: out }
  }

  if (want === 'related' || want === 'session') {
    const s = await sessionTouchedDocs(sessionId, force)

    // 有搜索词时改在项目文件夹里全量找——否则只搜得到「已经碰过」的那几篇
    if (q && s.cwd && existsSync(s.cwd)) {
      const rec = await scanRoot(s.cwd, cfg, force)
      const view = filterQ(rec.docs, q)
      const out = view.slice(0, 400)
      await attachReviewCounts(out)
      return {
        scopeUsed: want, searched: 'project', cwd: s.cwd, root: absOf(s.cwd),
        total: view.length, scanned: rec.scanned, scanMs: rec.scanMs, tier1: 0, tier2: 0, docs: out,
      }
    }

    const tier1 = s.docs.map((d) => ({ ...d, tier: 'session' }))
    let tier2 = []
    if (want === 'related' && s.wsDir) {
      const p = await projectTouchedDocs(s.wsDir, sessionId, cfg, force)
      const seen = new Set(tier1.map((d) => pathKey(d.path)))
      tier2 = p.docs.filter((d) => !seen.has(pathKey(d.path))).map((d) => ({ ...d, tier: 'project' }))
    }
    const all = tier1.concat(tier2)

    if (all.length) {
      const out = all.slice(0, 400)
      await attachReviewCounts(out)
      return {
        scopeUsed: want, cwd: s.cwd, tier1: tier1.length, tier2: tier2.length,
        total: all.length, scanned: all.length, files: s.files || 0, scanMs: 0, docs: out,
      }
    }

    // 两层都空 → 退到工作目录全量，并说明原因
    const fallbackRoot = (s.cwd && existsSync(s.cwd)) ? s.cwd : (ws || cfg.roots[0])
    const rec = await scanRoot(fallbackRoot, cfg, force)
    return {
      scopeUsed: 'workspace', fallback: true, reason: s.reason || '本会话与同项目其它会话都还没碰过文档',
      cwd: s.cwd, root: rec.docs.length ? absOf(fallbackRoot) : '', scanned: rec.scanned, scanMs: rec.scanMs,
      tier1: 0, tier2: 0,
      ...(await page(rec.docs, {})),
    }
  }

  if (want === 'workspace') {
    const s = await sessionTouchedDocs(sessionId, false)
    const root = (s.cwd && existsSync(s.cwd)) ? s.cwd : (ws || cfg.roots[0])
    const rec = await scanRoot(root, cfg, force)
    return { scopeUsed: 'workspace', cwd: s.cwd, root: absOf(root), scanned: rec.scanned, scanMs: rec.scanMs, ...(await page(rec.docs, {})) }
  }

  const rec = await scanRoot(ws || cfg.roots[0], cfg, force)
  return { scopeUsed: 'vault', root: absOf(ws || cfg.roots[0]), scanned: rec.scanned, scanMs: rec.scanMs, ...(await page(rec.docs, {})) }
}

async function scanDocs(ws, cfg) {
  const root = ws || cfg.roots[0]
  const docs = []
  // 用「根目录 + 相对路径」的正斜杠形式匹配 SKIP_REL_PREFIXES（旧行为：根本身落在「系统」里时 tools 也跳过）
  const rootFwd = toFwd(absOf(root))
  let visited = 0

  async function walk(dir, rel, depth) {
    if (docs.length >= cfg.maxDocs || depth > cfg.maxDepth || visited > 300000) return
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch (_) { return }
    for (const e of entries) {
      visited++
      // 点开头的目录/文件一律不进（.dsh-review / .git / .obsidian…）；批注数在下面按目录单独读
      if (e.name.startsWith('.')) continue
      const relChild = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name)) continue
        if (isSkippedRel(rootFwd + '/' + relChild)) continue
        if (e.name === REVIEW_DIR) continue
        await walk(path.join(dir, e.name), relChild, depth + 1)
      } else if (/\.(md|markdown|txt)$/i.test(e.name)) {
        let st = null
        try { st = await fsp.stat(path.join(dir, e.name)) } catch (_) { st = null }
        docs.push({
          path: path.join(dir, e.name),
          rel: relChild,
          name: e.name,
          size: st ? st.size : 0,
          mtimeMs: st ? st.mtimeMs : 0,
          updatedAt: st ? stamp2(st.mtimeMs) : '',
          pending: 0,
          total: 0,
        })
      }
    }
  }

  await walk(root, '', 0)
  // 默认按「最近产出」排：客户端还要按待处理数排的话，它自己再排一次
  docs.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.rel.localeCompare(b.rel, 'zh'))
  return docs
}

function stamp2(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
    ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

async function listDocs(ws, q, cfg, force) {
  const rec = await scanRoot(ws || cfg.roots[0], cfg, force)
  const view = filterQ(rec.docs, q)
  return { root: absOf(ws || cfg.roots[0]), total: view.length, scanned: rec.scanned, scanMs: rec.scanMs, cachedAt: rec.at, docs: view.slice(0, 400) }
}

/** 在全库找 <dir>/.dsh-review 目录（给不带 doc 参数的巡检用） */async function findReviewDirs(root, limit = 60) {
  const hits = []
  let visited = 0
  async function walk(dir, depth) {
    if (hits.length >= limit || depth > 8 || visited > 40000) return
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch (_) { return }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === REVIEW_DIR) { hits.push(path.join(dir, e.name)); continue }
        if (e.name.startsWith('.') || SKIP_DIR_NAMES.has(e.name)) continue
        visited++
        await walk(path.join(dir, e.name), depth + 1)
      }
    }
  }
  await walk(root, 0)
  return hits
}

/* ────────────────────────────── 工具输出格式 ────────────────────────────── */

function formatOneDoc(doc, review) {
  const cs = review.comments.slice().sort((a, b) => (a.lineStart || 0) - (b.lineStart || 0))
  const pending = cs.filter((c) => c.status === 'pending')
  const L = []
  L.push('文档：' + doc)
  L.push('批注：待处理 ' + pending.length + ' 条 / 共 ' + cs.length + ' 条')
  if (review.docHash) L.push('批注时的文档指纹：' + review.docHash)
  if (!cs.length) return L.join('\n')
  for (const c of cs) {
    if (c.status !== 'pending') continue
    const head = c.lineStart ? 'L' + c.lineStart + (c.lineEnd && c.lineEnd !== c.lineStart ? '–L' + c.lineEnd : '') : '全文'
    L.push('')
    L.push('【' + c.id + '】' + head + (c.author ? '（' + c.author + '）' : ''))
    if (c.quote) L.push('  原文：' + c.quote.replace(/\s+/g, ' ').slice(0, 240))
    L.push('  意见：' + (c.note || '（空）'))
  }
  return L.join('\n')
}

/* ─────────────────── 会话批注：在对话消息上划词写意见 ───────────────────
 * 和文档批注同一套用法，只是锚点从「文件 + 行号」换成「会话 + 原文片段」。
 * 存 ~/.dsh/doc-review/session-notes/<sessionId>.json；agent 用 session_note_list 读。 */
const SESS_NOTE_DIR = path.join(HOME_DIR, 'session-notes')
let lastClientSessionId = ''    // 客户端 /hello 带上来的当前会话 id

function sessNotePath(sessionId) {
  return path.join(SESS_NOTE_DIR, String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_') + '.json')
}

async function readSessNotes(sessionId) {
  const j = await readJsonFile(sessNotePath(sessionId), null)
  return (j && Array.isArray(j.notes)) ? j.notes : []
}

async function writeSessNotes(sessionId, notes) {
  await fsp.mkdir(SESS_NOTE_DIR, { recursive: true })
  await fsp.writeFile(sessNotePath(sessionId), JSON.stringify({
    mrsf: '1.0', kind: 'session-notes', session: String(sessionId || ''), updated_at: nowIso(),
    generator: '@caihua/dsh-doc-review', notes,
  }, null, 2), 'utf8')
  return notes
}

function newNoteId() { return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6) }

/** 没给 sessionId 时用最近写入的那个：用户刚在哪儿批注，文件就是最新的 */
async function latestSessNoteFile() {
  let files = []
  try { files = await fsp.readdir(SESS_NOTE_DIR) } catch (_) { return null }
  let best = null
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    const st = await fsp.stat(path.join(SESS_NOTE_DIR, f)).catch(() => null)
    if (st && (!best || st.mtimeMs > best.mtimeMs)) best = { sessionId: f.replace(/\.json$/, ''), mtimeMs: st.mtimeMs }
  }
  return best
}

function fmtSessNotes(sessionId, notes) {
  if (!notes.length) return '会话 ' + sessionId + ' 没有批注。'
  const L = ['会话批注：' + sessionId + '（共 ' + notes.length + ' 条）']
  notes.forEach((n, i) => {
    L.push('')
    L.push('## [' + (i + 1) + '] ' + (n.status === 'pending' ? '待处理' : n.status) + ' · ' + (n.createdAt || ''))
    L.push('')
    L.push('**我原文说过**：')
    L.push('')
    L.push('> ' + String(n.quote || '').replace(/\n+/g, ' ').slice(0, 400))
    L.push('')
    L.push('**你的意见**：' + (n.note || '（空）'))
    if (n.reply) { L.push(''); L.push('**处理说明**：' + n.reply) }
    L.push('')
    L.push('（id: ' + n.id + '）')
  })
  return L.join('\n')
}

/* ────────── 建议模式：AI 的改动先变成「提案」，人工逐条接受/拒绝后才落盘 ──────────
 * 动机：返工里最大一块是「我让你改的你没改 / 你改回旧版了」。所以 AI 改稿不再直接写文件，
 * 而是先提交提案：每条给出「原文 quote → 新文 after + 为什么这么改」。用户在批注页逐条
 * 接受/拒绝，**接受那一刻才按 quote 重新定位并改写文件**（提案生成后文档可能又被改过，必须重锚）。
 * 存 <文档目录>/.dsh-review/<文件名>.proposals.json。 */
const PROP_SUFFIX = '.proposals.json'

function propJsonOf(doc) {
  const d = absOf(doc)
  return path.join(path.dirname(d), REVIEW_DIR, path.basename(d) + PROP_SUFFIX)
}

function newPropId() { return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6) }

async function readProps(doc) {
  const j = await readJsonFile(propJsonOf(doc), null)
  if (!j || !Array.isArray(j.changes)) return { v: 1, doc: absOf(doc), docHash: '', baseHash: '', updatedAt: '', changes: [] }
  return {
    v: 1, doc: absOf(doc), docHash: String(j.document_hash || ''), baseHash: String(j.base_hash || ''),
    updatedAt: String(j.updated_at || ''), changes: j.changes,
  }
}

async function writeProps(doc, props) {
  const p = propJsonOf(doc)
  await fsp.mkdir(path.dirname(p), { recursive: true })
  await writeAtomic(p, JSON.stringify({
    mrsf: '1.0', kind: 'change-proposals', document: absOf(doc),
    document_hash: props.docHash || '', base_hash: props.baseHash || '',
    updated_at: nowIso(), generator: '@caihua/dsh-doc-review', changes: props.changes || [],
  }, null, 2))
  return props
}

/** 在文本里定位原文：精确 → 去空白归一 → 行号整行兜底。返回 {start,end,how} 或 null */
function locateSpan(text, quote, lineHint) {
  const q = String(quote || '')
  if (!q) return null
  const i = text.indexOf(q)
  if (i >= 0) return { start: i, end: i + q.length, how: 'exact' }
  const flat = q.replace(/\s+/g, '')
  if (flat) {
    let n = 0, start = -1, end = -1
    for (let k = 0; k < text.length; k++) {
      if (!/\s/.test(text[k])) {
        if (n === 0 && start < 0) start = k
        if (n === flat.length - 1) { end = k + 1; break }
        n++
      }
    }
    if (start >= 0 && end > start && text.slice(start, end).replace(/\s+/g, '') === flat) {
      return { start, end, how: 'whitespace' }
    }
  }
  const ln = Number(lineHint) || 0
  if (ln > 0) {
    const lines = text.split('\n')
    if (ln <= lines.length) {
      let off = 0
      for (let k = 0; k < ln - 1; k++) off += lines[k].length + 1
      return { start: off, end: off + lines[ln - 1].length, how: 'line' }
    }
  }
  return null
}

function lineOfIndex(text, idx) {
  let ln = 1
  const n = Math.min(Number(idx) || 0, text.length)
  for (let k = 0; k < n; k++) if (text[k] === '\n') ln++
  return ln
}

/** 应用一组已定位改动：按位置倒序替换，避免前面的改动冲掉后面的偏移 */
function applySpans(text, items) {
  const sorted = items.slice().sort((a, b) => b.start - a.start)
  let out = text
  for (const it of sorted) out = out.slice(0, it.start) + String(it.after == null ? '' : it.after) + out.slice(it.end)
  return out
}

function fmtProps(doc, props, status) {
  const want = String(status || 'pending')
  const list = props.changes.filter((c) => (c.status || 'pending') === want)
  if (!list.length) return '文档：' + absOf(doc) + '\n没有' + (want === 'pending' ? '待审' : want) + '的改动提案。'
  const L = ['待审改动提案：' + absOf(doc) + '（' + list.length + ' 条' + (want === 'pending' ? '' : ' · ' + want) + '）', '']
  list.forEach((c, i) => {
    L.push('[' + (i + 1) + '] ' + (c.status || 'pending') + ' · ' + (c.kind === 'delete' ? '删除' : '替换') + ' · L' + (c.line || '?'))
    L.push('    原文：' + String(c.quote || '').replace(/\n+/g, ' ').slice(0, 200))
    if (c.kind !== 'delete') L.push('    改成：' + String(c.after == null ? '' : c.after).replace(/\n+/g, ' ').slice(0, 200))
    if (c.note) L.push('    为什么：' + c.note)
    if (c.reject_reason) L.push('    拒绝原因：' + c.reject_reason)
    L.push('    （id: ' + c.id + '）')
    L.push('')
  })
  L.push('用户在「批注」页逐条接受/拒绝；也可以让我调 doc_change_decide。')
  return L.join('\n')
}

/** 接受 / 拒绝（工具与路由共用） */
async function decideProps(doc, opts) {
  const action = String((opts && opts.action) || 'accept')
  const ids = Array.isArray(opts && opts.ids) ? opts.ids.map(String) : []
  const reason = opts && opts.reason ? String(opts.reason) : ''
  const props = await readProps(doc)
  if (!props.changes.length) return { ok: false, error: '这篇文档没有待审改动提案' }
  const pick = (c) => !ids.length || ids.includes(c.id)

  if (action === 'reject') {
    let n = 0
    for (const c of props.changes) {
      if (!pick(c) || (c.status || 'pending') !== 'pending') continue
      c.status = 'rejected'; c.rejectedAt = nowIso(); if (reason) c.reject_reason = reason
      n++
    }
    await writeProps(doc, props)
    return { ok: true, rejected: n, changes: props.changes }
  }

  if (action === 'reset') {   // 把已拒绝/已接受的提案退回待审（不改文件）
    let n = 0
    for (const c of props.changes) {
      if (!pick(c)) continue
      c.status = 'pending'; delete c.rejectedAt; delete c.acceptedAt; delete c.reject_reason
      n++
    }
    await writeProps(doc, props)
    return { ok: true, reset: n, changes: props.changes }
  }

  if (!existsSync(doc)) return { ok: false, error: '文档不存在：' + absOf(doc) }
  const text = await fspReadDoc(doc)
  const todo = props.changes.filter((c) => pick(c) && (c.status || 'pending') === 'pending')
  const located = []
  const missed = []
  for (const c of todo) {
    const span = locateSpan(text, c.quote, c.line)
    if (!span) { missed.push({ id: c.id, quote: String(c.quote || '').slice(0, 60) }); continue }
    located.push({ start: span.start, end: span.end, how: span.how, id: c.id, after: c.after })
  }
  if (!located.length) {
    await writeProps(doc, props)
    return { ok: false, error: '这些改动在文档里已经找不到对应原文（可能被别处改过），一个字都没写', missed }
  }
  const next = applySpans(text, located)
  await writeAtomic(doc, next)
  const howOf = {}
  for (const x of located) howOf[x.id] = x.how
  for (const c of props.changes) {
    if (!howOf[c.id]) continue
    c.status = 'accepted'; c.acceptedAt = nowIso(); c.applied_how = howOf[c.id]
  }
  props.docHash = sha1(next)
  props.baseHash = props.baseHash || props.docHash
  await writeProps(doc, props)
  return { ok: true, accepted: located.length, missed, changes: props.changes, docHash: props.docHash }
}

/* ────────────────────────────── 插件主体 ────────────────────────────── */

function defineTool(name, description, parameters, execute) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters || {})) {
    const prop = { type: spec.type || 'string', description: spec.description || '' }
    if (spec.enum) prop.enum = spec.enum
    if (spec.items) prop.items = spec.items
    properties[key] = prop
    if (spec.required) required.push(key)
  }
  return {
    name,
    description,
    parameters: { type: 'object', properties, required },
    output: {
      schema: { type: 'string' },
      render(_args, value) { return [{ type: 'text', text: String(value) }] },
    },
    async execute(args, exec) {
      try { return await execute(args, exec) } catch (e) { return 'doc-review 工具出错：' + ((e && e.message) || String(e)) }
    },
  }
}

/** 导出卫生：给烟测/回归直接调用（不改运行时行为） */
export { decodeSessionFrames, findSessionFile, findSessionFiles, sessionTouchedDocs, listDocsByScope, getConfig, scanDocs }
// 跨平台路径规则（纯函数，供 test/path-utils.mjs 断言）
export { isAbsDocPath, normDocPath, pathKey, isUnder, caseInsensitiveFs, defaultVault, toFwd, isSkippedRel, collectDocPaths, NOISE_PATH_RE }

export async function apply(ctx) {
  const cfg = await getConfig()
  const disposers = []

  try {
    /* ---- 工具：给 agent 读批注 / 回标状态 ---- */
    const tools = [
      defineTool(
        'doc_review_list',
        '读取方案文档上的批注（用户在 DSH「批注」页里划词写的修改意见）。不传 doc 时巡检配置根目录下所有带批注的文档。改稿前先调这个工具拿到行号区间与意见。',
        {
          doc: { type: 'string', description: '文档绝对路径。用户在批注页点「交给 AI 改稿」时会把路径带进来。' },
          status: { type: 'string', description: '按状态过滤，缺省只看 pending。', enum: ['pending', 'resolved', 'wontfix', 'all'] },
          limit: { type: 'integer', description: '不带 doc 时最多列几个文档，缺省 8。' },
        },
        async (args) => {
          const status = String(args.status || 'pending')
          if (args.doc) {
            const doc = absOf(args.doc)
            if (!existsSync(doc)) return '文档不存在：' + doc
            const review = await readReview(doc)
            const filtered = status === 'all' ? review : { ...review, comments: review.comments.filter((c) => c.status === status) }
            if (!filtered.comments.length) return '文档：' + doc + '\n没有' + (status === 'pending' ? '待处理' : status) + '的批注。'
            return formatOneDoc(doc, filtered)
          }
          const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 30)
          const found = []
          for (const root of cfg.roots) {
            const dirs = await findReviewDirs(root, 40)
            for (const d of dirs) {
              let files = []
              try { files = await fsp.readdir(d) } catch (_) { continue }
              for (const f of files) {
                if (!f.endsWith('.review.json')) continue
                const r = await readJsonFile(path.join(d, f), null)
                if (!r || !Array.isArray(r.comments)) continue
                const all = r.comments.map(normComment)   // 磁盘是 MRSF 形状，先映射回内部形状再过滤
                const cs = status === 'all' ? all : all.filter((c) => c.status === status)
                if (!cs.length) continue
                const docPath = r.document || r.doc || path.join(path.dirname(d), f.slice(0, -'.review.json'.length))
                found.push({ doc: docPath, review: { ...r, comments: cs } })
              }
              if (found.length >= limit) break
            }
            if (found.length >= limit) break
          }
          if (!found.length) return '没有找到带' + (status === 'pending' ? '待处理' : status) + '批注的文档。'
          return found.slice(0, limit).map((x) => formatOneDoc(x.doc, x.review)).join('\n\n' + '─'.repeat(40) + '\n\n')
        },
      ),
      defineTool(
        'doc_review_resolve',
        '把批注标记为已处理（改完稿后调用，客户端批注页会实时变成「已处理」）。同时可回填一句「改了什么」，用户和同事都能看到。',
        {
          doc: { type: 'string', description: '文档绝对路径。', required: true },
          ids: { type: 'array', description: '批注 id 数组；不传则把所有待处理批注标为已处理。', items: { type: 'string' } },
          reply: { type: 'string', description: '一句话说明这条/这些批注怎么改的。' },
        },
        async (args) => {
          const doc = absOf(args.doc)
          if (!existsSync(doc)) return '文档不存在：' + doc
          const review = await readReview(doc)
          if (!review.comments.length) return '文档上还没有批注：' + doc
          if (args.reply) {
            const replyText = String(args.reply)
            const up = await fspReadDoc(doc)
            review.docHash = sha1(up)
            review.docMtimeMs = (await fsp.stat(doc)).mtimeMs
            review.comments.forEach((c) => { if (c.status === 'pending') c.reply = replyText })
          }
          const ids = Array.isArray(args.ids) ? args.ids.map(String) : []
          let n = 0
          for (const c of review.comments) {
            if (c.status !== 'pending') continue
            if (ids.length && !ids.includes(c.id)) continue
            c.status = 'resolved'
            c.resolvedAt = nowIso()
            c.updatedAt = nowIso()
            n++
          }
          const out = await writeReview(doc, review)
          return '已标记 ' + n + ' 条批注为已处理（' + doc + '）。剩余待处理 ' + out.comments.filter((c) => c.status === 'pending').length + ' 条。'
        },
      ),
      defineTool(
        'doc_review_reopen',
        '把已处理的批注退回待处理（改得不满意时用）。',
        {
          doc: { type: 'string', description: '文档绝对路径。', required: true },
          ids: { type: 'array', description: '批注 id 数组；不传则全部退回。', items: { type: 'string' } },
        },
        async (args) => {
          const doc = absOf(args.doc)
          if (!existsSync(doc)) return '文档不存在：' + doc
          const review = await readReview(doc)
          const ids = Array.isArray(args.ids) ? args.ids.map(String) : []
          let n = 0
          for (const c of review.comments) {
            if (ids.length && !ids.includes(c.id)) continue
            if (c.status === 'pending') continue
            c.status = 'pending'
            c.resolvedAt = null
            c.updatedAt = nowIso()
            n++
          }
          const out = await writeReview(doc, review)
          return '已退回 ' + n + ' 条批注为待处理。当前待处理 ' + out.comments.filter((c) => c.status === 'pending').length + ' 条。'
        },
      ),
      defineTool(
        'session_note_list',
        '读取「会话批注」：用户在对话消息上划词写的意见（不是在文档上）。用户在对话里说「按批注改」「看我在会话里的批注」时调这个。不传 sessionId 时自动用最近在批注的那个会话。',
        {
          sessionId: { type: 'string', description: '会话 id。不确定就别传，工具会用最近写入批注的那个会话。' },
          status: { type: 'string', description: '按状态过滤，缺省只看 pending。', enum: ['pending', 'resolved', 'all'] },
        },
        async (args) => {
          let sid = String(args.sessionId || '').trim()
          if (!sid) {
            if (lastClientSessionId) sid = lastClientSessionId
            else {
              const latest = await latestSessNoteFile()
              if (!latest) return '还没有任何会话批注（用户还没在对话里划过词）。'
              sid = latest.sessionId
            }
          }
          const all = await readSessNotes(sid)
          const status = String(args.status || 'pending')
          const notes = status === 'all' ? all : all.filter((n) => (n.status || 'pending') === status)
          return fmtSessNotes(sid, notes)
        },
      ),
      defineTool(
        'session_note_resolve',
        '把「会话批注」标记为已处理（按用户的会话批注改完后调用）。可回填一句改了什么。',
        {
          sessionId: { type: 'string', description: '会话 id。不确定就别传。' },
          ids: { type: 'array', description: '要处理的批注 id 数组；不传则处理所有待处理。', items: { type: 'string' } },
          reply: { type: 'string', description: '一句话说明怎么处理的。' },
          action: { type: 'string', description: 'resolve=标记已处理（默认）；reopen=退回待处理；delete=删除。', enum: ['resolve', 'reopen', 'delete'] },
        },
        async (args) => {
          let sid = String(args.sessionId || '').trim() || lastClientSessionId
          if (!sid) {
            const latest = await latestSessNoteFile()
            if (!latest) return '还没有任何会话批注。'
            sid = latest.sessionId
          }
          const action = String(args.action || 'resolve')
          const ids = Array.isArray(args.ids) ? args.ids.map(String) : []
          let notes = await readSessNotes(sid)
          if (!notes.length) return '会话 ' + sid + ' 没有批注。'
          if (action === 'delete') {
            const before = notes.length
            notes = notes.filter((n) => !(ids.length ? ids.includes(n.id) : true))
            await writeSessNotes(sid, notes)
            return '已删除 ' + (before - notes.length) + ' 条会话批注，剩余 ' + notes.length + ' 条。'
          }
          let n = 0
          for (const note of notes) {
            if (ids.length && !ids.includes(note.id)) continue
            if (action === 'resolve') {
              if ((note.status || 'pending') !== 'pending') continue
              note.status = 'resolved'
              note.resolvedAt = nowIso()
              if (args.reply) note.reply = String(args.reply)
            } else {
              if ((note.status || 'pending') === 'pending') continue
              note.status = 'pending'
              note.resolvedAt = null
              note.sent_at = ''
            }
            note.updatedAt = nowIso()
            n++
          }
          await writeSessNotes(sid, notes)
          const left = notes.filter((x) => (x.status || 'pending') === 'pending').length
          return (action === 'resolve' ? '已标记 ' + n + ' 条会话批注为已处理' : '已退回 ' + n + ' 条') + '，剩余待处理 ' + left + ' 条。'
        },
      ),
      defineTool(
        'doc_change_propose',
        '【建议模式】改文档前必须先用它提交改动提案：不动文件，只登记「原文 → 改成什么 + 为什么」。用户在批注页逐条接受/拒绝，接受那一刻才真正落盘。改稿一律走这条路，不要直接改文件。',
        {
          doc: { type: 'string', description: '文档绝对路径。', required: true },
          changes: {
            type: 'array',
            required: true,
            description: '改动数组。每项：quote=要替换的原文（必须与文档里的一字不差，含标点）、after=改成什么（传空字符串表示删除这段）、note=为什么这么改（一句话）、line=可选行号（原文对不上时用它整行替换）。',
            items: { type: 'object' },
          },
        },
        async (args) => {
          const doc = absOf(args.doc)
          if (!existsSync(doc)) return '文档不存在：' + doc
          const incoming = Array.isArray(args.changes) ? args.changes : []
          if (!incoming.length) return 'changes 不能为空：至少要给一条 {quote, after}。'
          const text = await fspReadDoc(doc)
          const props = await readProps(doc)
          const added = []
          const bad = []
          for (const raw of incoming) {
            const quote = String((raw && raw.quote) || '')
            if (!quote) { bad.push('（缺 quote）'); continue }
            const span = locateSpan(text, quote, raw && raw.line)
            if (!span) { bad.push(quote.slice(0, 60)); continue }
            const item = {
              id: newPropId(), kind: (raw.after == null || String(raw.after) === '') ? 'delete' : 'replace',
              quote: quote, before: text.slice(span.start, span.end),
              after: raw.after == null ? '' : String(raw.after),
              note: String((raw && raw.note) || ''), line: Number((raw && raw.line) || 0) || lineOfIndex(text, span.start),
              anchor_how: span.how, status: 'pending', createdAt: nowIso(),
            }
            props.changes.push(item)
            added.push(item)
          }
          props.baseHash = props.baseHash || sha1(text)
          props.docHash = sha1(text)
          await writeProps(doc, props)
          const L = ['已登记 ' + added.length + ' 条改动提案（文件未改动）：' + doc, '']
          added.forEach((c, i) => {
            L.push('[' + (i + 1) + '] L' + c.line + ' · ' + (c.kind === 'delete' ? '删除' : '替换'))
            L.push('    原文：' + String(c.before).replace(/\n+/g, ' ').slice(0, 160))
            if (c.kind !== 'delete') L.push('    改成：' + String(c.after).replace(/\n+/g, ' ').slice(0, 160))
            if (c.note) L.push('    为什么：' + c.note)
          })
          if (bad.length) {
            L.push('')
            L.push('⚠️ 有 ' + bad.length + ' 条在文档里找不到对应原文，已跳过（原文必须与文档完全一致）：')
            bad.forEach((b) => L.push('    ' + b))
          }
          L.push('')
          L.push('等用户在批注页接受，或让我调 doc_change_decide 处理。')
          return L.join('\n')
        },
      ),
      defineTool(
        'doc_change_list',
        '查看待审改动提案（建议模式）。不传 doc 时巡检配置根目录下所有带提案的文档。',
        {
          doc: { type: 'string', description: '文档绝对路径；不传则巡检所有。' },
          status: { type: 'string', description: '缺省只看 pending。', enum: ['pending', 'accepted', 'rejected', 'all'] },
          limit: { type: 'integer', description: '不带 doc 时最多列几个文档，缺省 8。' },
        },
        async (args) => {
          const status = String(args.status || 'pending')
          const keep = (c) => status === 'all' || (c.status || 'pending') === status
          if (args.doc) {
            const doc = absOf(args.doc)
            const props = await readProps(doc)
            const view = { ...props, changes: props.changes.filter(keep) }
            return fmtProps(doc, view, status === 'all' ? 'pending' : status)
          }
          const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 30)
          const found = []
          for (const root of cfg.roots) {
            const dirs = await findReviewDirs(root, 40)
            for (const d of dirs) {
              let files = []
              try { files = await fsp.readdir(d) } catch (_) { continue }
              for (const f of files) {
                if (!f.endsWith(PROP_SUFFIX)) continue
                const j = await readJsonFile(path.join(d, f), null)
                if (!j || !Array.isArray(j.changes)) continue
                const cs = j.changes.filter(keep)
                if (!cs.length) continue
                const docPath = j.document || path.join(path.dirname(d), f.slice(0, -PROP_SUFFIX.length))
                found.push({ doc: docPath, changes: cs })
                if (found.length >= limit) break
              }
              if (found.length >= limit) break
            }
            if (found.length >= limit) break
          }
          if (!found.length) return '没有找到带' + (status === 'pending' ? '待审' : status) + '改动提案的文档。'
          return found.slice(0, limit).map((x) => fmtProps(x.doc, { changes: x.changes }, status === 'all' ? 'pending' : status)).join('\n\n' + '─'.repeat(40) + '\n\n')
        },
      ),
      defineTool(
        'doc_change_decide',
        '接受或拒绝改动提案（建议模式）。接受时才真正改写文档，并按原文重新定位（提案生成后文档被改过也能对上）。用户拒绝时把原因带回来。',
        {
          doc: { type: 'string', description: '文档绝对路径。', required: true },
          action: { type: 'string', description: 'accept=接受并落盘（默认）；reject=拒绝；reset=退回待审。', enum: ['accept', 'reject', 'reset'] },
          ids: { type: 'array', description: '指定提案 id；不传则处理该文档所有待审提案。', items: { type: 'string' } },
          reason: { type: 'string', description: '拒绝原因（action=reject 时用，会记下来供后续参考）。' },
        },
        async (args) => {
          const doc = absOf(args.doc)
          const r = await decideProps(doc, { action: args.action || 'accept', ids: args.ids, reason: args.reason })
          if (!r.ok) {
            let s = '没处理：' + r.error
            if (r.missed && r.missed.length) s += '\n对不上的 ' + r.missed.length + ' 条：' + r.missed.map((m) => m.quote).join(' / ')
            return s
          }
          if (r.rejected != null) return '已拒绝 ' + r.rejected + ' 条提案（文件未动）。'
          if (r.reset != null) return '已把 ' + r.reset + ' 条提案退回待审。'
          let s = '已接受并落盘 ' + r.accepted + ' 条改动：' + doc
          if (r.missed && r.missed.length) s += '\n有 ' + r.missed.length + ' 条原文对不上、没写：' + r.missed.map((m) => m.quote).join(' / ')
          return s
        },
      ),
    ]
    for (const t of tools) disposers.push(ctx.tools.register(t))

    /* ---- 路由 ---- */
    const routes = [
      {
        kind: 'exact', path: API.ping,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          writeJson(res, 200, { ok: true, plugin: name, at: nowIso() })
        },
      },
      {
        kind: 'exact', path: API.hello,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          CLIENT_HELLO_AT = nowIso()
          CLIENT_HELLO_COUNT++
          try { CLIENT_HELLO_UA = String((req.headers && req.headers['user-agent']) || '').slice(0, 160) } catch (_) {}
          // 客户端把当前会话 id 带上来：agent 调 session_note_list 不传 sessionId 时就用它
          try {
            const b = await readJsonBody(req)
            const sid = b && b.sessionId ? String(b.sessionId).slice(0, 120) : ''
            if (sid) lastClientSessionId = sid
          } catch (_) {}
          const hb = await readJsonFile(HEARTBEAT_PATH, {}) || {}
          await writeAtomic(HEARTBEAT_PATH, JSON.stringify({ ...hb, clientHelloAt: CLIENT_HELLO_AT, clientHelloCount: CLIENT_HELLO_COUNT, clientHelloUA: CLIENT_HELLO_UA, clientSessionId: lastClientSessionId }, null, 2)).catch(() => {})
          writeJson(res, 200, { ok: true })
        },
      },
      {
        kind: 'exact', path: API.props,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const doc = absOf(url.searchParams.get('path') || '')
          if (!doc || !existsSync(doc)) return writeJson(res, 404, { error: '文档不存在', path: doc })
          const sid = url.searchParams.get('sessionId') || ''
          if (!isUnderAny(doc, cfg.roots) && !(await inSessionDocs(sid, doc))) {
            return writeJson(res, 403, { error: '越界：只允许配置根目录下、或本会话碰过的文档', roots: cfg.roots })
          }
          const props = await readProps(doc)
          const pending = props.changes.filter((c) => (c.status || 'pending') === 'pending').length
          writeJson(res, 200, { ok: true, doc, pending, changes: props.changes, updatedAt: props.updatedAt })
        },
      },
      {
        kind: 'exact', path: API.prop,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          let body = null
          try { body = await readJsonBody(req) } catch (e) { return writeJson(res, 400, { error: 'bad body: ' + ((e && e.message) || e) }) }
          const doc = absOf(body.path || body.doc || '')
          if (!doc || !existsSync(doc)) return writeJson(res, 404, { error: '文档不存在', path: doc })
          const sid = String(body.sessionId || '')
          if (!isUnderAny(doc, cfg.roots) && !(await inSessionDocs(sid, doc))) {
            return writeJson(res, 403, { error: '越界：只允许配置根目录下、或本会话碰过的文档', roots: cfg.roots })
          }
          const r = await decideProps(doc, { action: body.action || 'accept', ids: body.ids, reason: body.reason })
          if (!r.ok) return writeJson(res, 409, { ok: false, error: r.error, missed: r.missed || [] })
          const props = await readProps(doc)
          writeJson(res, 200, {
            ok: true, accepted: r.accepted || 0, rejected: r.rejected || 0, reset: r.reset || 0,
            missed: r.missed || [], changes: props.changes,
            pending: props.changes.filter((c) => (c.status || 'pending') === 'pending').length,
          })
        },
      },
      {
        kind: 'exact', path: API.snotes,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const sid = url.searchParams.get('sessionId') || lastClientSessionId
          if (!sid) return writeJson(res, 200, { ok: true, sessionId: '', notes: [], pending: 0 })
          const notes = await readSessNotes(sid)
          writeJson(res, 200, { ok: true, sessionId: sid, notes, pending: notes.filter((n) => (n.status || 'pending') === 'pending').length })
        },
      },
      {
        kind: 'exact', path: API.snote,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          let body = null
          try { body = await readJsonBody(req) } catch (e) { return writeJson(res, 400, { error: 'bad body: ' + ((e && e.message) || e) }) }
          const sid = String((body && body.sessionId) || lastClientSessionId || '').trim()
          if (!sid) return writeJson(res, 400, { error: 'missing sessionId' })
          const notes = await readSessNotes(sid)
          const action = String((body && body.action) || 'save')
          if (action === 'delete') {
            const keep = notes.filter((n) => n.id !== body.id)
            await writeSessNotes(sid, keep)
            return writeJson(res, 200, { ok: true, sessionId: sid, notes: keep })
          }
          if (action === 'sent') {
            // 用户在输入框里把这批批注发出去了：标 sent_at，之后不再进批注块（但仍是待处理，等 AI 回应）
            const ids = Array.isArray(body.ids) ? body.ids.map(String) : (body.id ? [String(body.id)] : [])
            let nSent = 0
            for (const x of notes) {
              if (ids.length && !ids.includes(x.id)) continue
              if (x.sent_at) continue
              x.sent_at = nowIso(); x.updatedAt = x.sent_at; nSent++
            }
            if (nSent) await writeSessNotes(sid, notes)
            return writeJson(res, 200, { ok: true, sessionId: sid, marked: nSent, notes })
          }
          if (action === 'resolve' || action === 'reopen') {
            const ids = Array.isArray(body.ids) ? body.ids.map(String) : (body.id ? [String(body.id)] : [])
            for (const n of notes) {
              if (ids.length && !ids.includes(n.id)) continue
              n.status = action === 'resolve' ? 'resolved' : 'pending'
              n.resolvedAt = action === 'resolve' ? nowIso() : null
              // 退回待处理 = 重新参与批注块，所以要抹掉"已发出"标记
              if (action === 'reopen') n.sent_at = ''
              if (body.reply) n.reply = String(body.reply)
              n.updatedAt = nowIso()
            }
            await writeSessNotes(sid, notes)
            return writeJson(res, 200, { ok: true, sessionId: sid, notes })
          }
          const quote = String((body && body.quote) || '').trim()
          const note = String((body && body.note) || '').trim()
          if (!quote || !note) return writeJson(res, 400, { error: 'quote 与 note 都不能为空' })
          const item = {
            id: newNoteId(), sessionId: sid, quote: quote.slice(0, 2000),
            prefix: String((body && body.prefix) || '').slice(0, 200),
            note: note.slice(0, 4000),
            author: String((body && body.author) || cfg.author || ''),
            status: 'pending', reply: '', createdAt: nowIso(), resolvedAt: null, updatedAt: nowIso(),
          }
          notes.push(item)
          await writeSessNotes(sid, notes)
          writeJson(res, 200, { ok: true, sessionId: sid, note: item, notes, pending: notes.filter((n) => (n.status || 'pending') === 'pending').length })
        },
      },
      {
        kind: 'exact', path: API.state,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          const state = await readJsonFile(STATE_PATH, {}) || {}
          writeJson(res, 200, {
            ok: true,
            roots: cfg.roots,
            author: cfg.author,
            reviewDir: REVIEW_DIR,
            lastDoc: state.lastDoc || '',
            clientHelloAt: CLIENT_HELLO_AT,
          })
        },
      },
      {
        kind: 'exact', path: API.docs,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const ws = url.searchParams.get('ws') || ''
          const q = url.searchParams.get('q') || ''
          const force = url.searchParams.get('refresh') === '1'
          const scope = url.searchParams.get('scope') || 'vault'
          const sessionId = url.searchParams.get('sessionId') || ''
          try {
            const out = await listDocsByScope({ scope, sessionId, ws, q, force }, cfg)
            writeJson(res, 200, { ok: true, ...out })
          } catch (e) {
            writeJson(res, 500, { error: String((e && e.message) || e) })
          }
        },
      },
      {
        kind: 'exact', path: API.doc,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const doc = absOf(url.searchParams.get('path') || '')
          if (!doc || !existsSync(doc)) return writeJson(res, 404, { error: '文档不存在', path: doc })
          const sid = url.searchParams.get('sessionId') || ''
          if (!isUnderAny(doc, cfg.roots) && !(await inSessionDocs(sid, doc))) {
            return writeJson(res, 403, { error: '越界：只允许配置根目录下、或本会话碰过的文档', roots: cfg.roots })
          }
          try {
            const content = await fspReadDoc(doc)
            const st = await fsp.stat(doc)
            const review = await readReview(doc)
            const state = await readJsonFile(STATE_PATH, {}) || {}
            await writeAtomic(STATE_PATH, JSON.stringify({ ...state, lastDoc: doc, lastAt: nowIso() }, null, 2)).catch(() => {})
            writeJson(res, 200, {
              ok: true,
              path: doc,
              name: path.basename(doc),
              content,
              mtimeMs: st.mtimeMs,
              hash: sha1(content),
              review,
            })
          } catch (e) {
            writeJson(res, 500, { error: String((e && e.message) || e) })
          }
        },
      },
      {
        kind: 'exact', path: API.save,
        handler: async (req, res) => {
          if (!isLoopback(req)) return writeJson(res, 403, { error: 'forbidden: loopback-only' })
          const body = await readJsonBody(req)
          const doc = absOf(body.path || '')
          if (!doc || !existsSync(doc)) return writeJson(res, 404, { error: '文档不存在', path: doc })
          const sid = String(body.sessionId || '')
          if (!isUnderAny(doc, cfg.roots) && !(await inSessionDocs(sid, doc))) {
            return writeJson(res, 403, { error: '越界：只允许写配置根目录下、或本会话碰过的文档的批注', roots: cfg.roots })
          }
          try {
            const content = await fspReadDoc(doc)
            const st = await fsp.stat(doc)
            const incoming = Array.isArray(body.comments) ? body.comments : []
            const prev = await readReview(doc)
            const prevById = {}
            prev.comments.forEach((c) => { prevById[c.id] = c })
            const merged = incoming.map((c) => {
              const old = c && c.id ? prevById[c.id] : null
              const base = normComment(c)
              if (old) {
                base.createdAt = old.createdAt
                base.resolvedAt = old.resolvedAt || base.resolvedAt
                if (!base.reply && old.reply) base.reply = old.reply
              }
              base.updatedAt = nowIso()
              return base
            })
            const out = await writeReview(doc, { ...prev, docHash: sha1(content), docMtimeMs: st.mtimeMs, comments: merged })
            writeJson(res, 200, { ok: true, review: out, hash: sha1(content), mtimeMs: st.mtimeMs, reviewPath: reviewJsonOf(doc) })
          } catch (e) {
            writeJson(res, 500, { error: String((e && e.message) || e) })
          }
        },
      },
    ]
    for (const r of routes) disposers.push(ctx.webServer.register(r))

    /* ---- 心跳：证明宿主半边挂上了 ---- */
    const hb = {
      plugin: name,
      version: '0.6.0',
      at: nowIso(),
      pid: process.pid,
      roots: cfg.roots,
      routes: Object.values(API),
      tools: tools.map((t) => t.name),
      clientHelloAt: CLIENT_HELLO_AT,
      clientHelloCount: CLIENT_HELLO_COUNT,
      clientHelloUA: CLIENT_HELLO_UA,
    }
    await writeAtomic(HEARTBEAT_PATH, JSON.stringify(hb, null, 2)).catch(() => {})

    ctx.effect(() => () => {
      for (const d of disposers) { try { d() } catch (_) {} }
    }, 'dsh-doc-review: surfaces')

    console.log('[dsh-doc-review] ready: ' + tools.length + ' tools + ' + routes.length + ' routes (roots: ' + cfg.roots.join(', ') + ')')
  } catch (error) {
    for (const d of disposers) { try { d() } catch (_) {} }
    throw error
  }
}

async function fspReadDoc(p) {
  const buf = await fsp.readFile(p)
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  return text
}
