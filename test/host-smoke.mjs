/**
 * 宿主半边烟测：用假 ctx 把真插件挂起来，走真路由 + 真工具，落真文件。
 * 运行：node test/host-smoke.mjs
 * 覆盖：/state /docs /doc /save + doc_review_list / doc_review_resolve / doc_review_reopen + 越界拦截
 */
import { EventEmitter } from 'node:events'
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TMP_ROOT = path.join(os.homedir(), 'dsh-plugins', '_smoke-root')
// 烟测绝不写用户的真实运行目录：用环境变量把插件的 HOME_DIR 与 sessions 根都顶到临时目录
const TEST_HOME = path.join(TMP_ROOT, '_plugin-home')
const TEST_SESSIONS = path.join(TMP_ROOT, '_sessions')
const CONFIG_PATH = path.join(TEST_HOME, 'config.json')
process.env.DSH_DOC_REVIEW_HOME = TEST_HOME
process.env.DSH_DOC_REVIEW_SESSIONS = TEST_SESSIONS

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

function makeRes() {
  const res = { code: 0, headers: null, body: '' }
  res.writeHead = (c, hdrs) => { res.code = c; res.headers = hdrs || null }
  res.end = (b) => { if (b) res.body += Buffer.isBuffer(b) ? b.toString('utf8') : String(b) }
  res.json = () => { try { return JSON.parse(res.body) } catch (e) { return null } }
  return res
}

function makeGet(url) {
  return { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, headers: {}, on() {}, destroy() {} }
}

function makePost(url, body) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = url
  req.socket = { remoteAddress: '127.0.0.1' }
  req.headers = {}
  req.destroy = () => {}
  setTimeout(() => {
    req.emit('data', Buffer.from(JSON.stringify(body || {}), 'utf8'))
    req.emit('end')
  }, 0)
  return req
}

async function main() {
  // 1) 准备临时文档 + 只认这个根目录的配置（先清空临时根，保证反复跑结果一致）
  await fsp.rm(TMP_ROOT, { recursive: true, force: true })
  await fsp.mkdir(TMP_ROOT, { recursive: true })
  const docPath = path.join(TMP_ROOT, '烟测方案.md')
  const docText = [
    '# 烟测方案',
    '',
    '第一段：这里讲的是华东仓配的时点安排，需要复核。',
    '',
    '## 二、毛利测算',
    '',
    '毛利按品类测算，不含税。',
    '',
    '- 要点一',
    '- 要点二',
    '',
    '| 项目 | 金额 |',
    '| --- | --- |',
    '| 收入 | 100 |',
    '',
    '结尾一句话。',
  ].join('\n')
  await fsp.writeFile(docPath, docText, 'utf8')
  await fsp.utimes(docPath, new Date('2026-06-01T10:00:00'), new Date('2026-06-01T10:00:00'))
  // 另外两份文档，用来验「默认按最近产出排序」（老版是按待处理数排的）
  const oldDoc = path.join(TMP_ROOT, 'B-旧方案.md')
  const newDoc = path.join(TMP_ROOT, 'C-最新方案.md')
  await fsp.writeFile(oldDoc, '# 旧方案\n\n内容。\n', 'utf8')
  await fsp.writeFile(newDoc, '# 最新方案\n\n内容。\n', 'utf8')
  await fsp.utimes(oldDoc, new Date('2026-01-01T10:00:00'), new Date('2026-01-01T10:00:00'))
  await fsp.utimes(newDoc, new Date('2026-10-01T10:00:00'), new Date('2026-10-01T10:00:00'))
  await fsp.rm(path.join(TMP_ROOT, '.dsh-review'), { recursive: true, force: true })

  await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  await fsp.writeFile(CONFIG_PATH, JSON.stringify({ roots: [TMP_ROOT], maxDocs: 1000, author: '烟测' }, null, 2), 'utf8')

  // 2) 挂载真插件
  const { apply } = await import('../lib/index.js')
  const routes = []
  const tools = []
  const ctx = {
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    tools: { register: (t) => { tools.push(t); return () => {} } },
    effect: () => () => {},
  }
  await apply(ctx)

  const route = (p) => routes.find((r) => r.path === p)
  const tool = (n) => tools.find((t) => t.name === n)

  console.log('\n[1] 挂载')
  ok('注册了 11 条路由（会话批注 2 + 建议模式 2 + 正文直写 1）', routes.length === 11, 'got ' + routes.length)
  ok('注册了 16 个工具（文档批注 4 + 会话批注 2 + 建议模式 3 + /doc-review 技能 7）', tools.length === 16, tools.map((t) => t.name).join(','))
  ok('工具齐名', ['doc_review_list', 'doc_review_resolve', 'doc_review_reopen'].every((n) => !!tool(n)))
  ok('/doc-review 技能工具齐名', ['doc_review_history', 'doc_review_mine_candidates', 'doc_review_rules_list', 'doc_review_rules_add', 'doc_review_rules_update', 'doc_review_rules_remove', 'doc_review_preview_apply'].every((n) => !!tool(n)))

  console.log('\n[2] /state')
  let res = makeRes()
  await route('/api/dsh-doc-review/state').handler(makeGet('/api/dsh-doc-review/state'), res)
  ok('state ok', res.code === 200 && res.json() && res.json().ok === true, res.body.slice(0, 120))
  ok('state 带回根目录', JSON.stringify(res.json().roots) === JSON.stringify([TMP_ROOT]))

  console.log('\n[3] /docs 列文档')
  res = makeRes()
  await route('/api/dsh-doc-review/docs').handler(makeGet('/api/dsh-doc-review/docs?scope=workspace&ws=' + encodeURIComponent(TMP_ROOT)), res)
  const docsJson = res.json()
  ok('列到 3 份文档', docsJson && docsJson.ok && docsJson.docs.length === 3, res.body.slice(0, 200))
  ok('默认按最近产出排序 C→烟测→B', docsJson.docs.map((d) => d.name).join('|') === 'C-最新方案.md|烟测方案.md|B-旧方案.md', docsJson.docs.map((d) => d.name).join('|'))
  ok('带回扫描元信息 scanned/scanMs', typeof docsJson.scanned === 'number' && typeof docsJson.scanMs === 'number', JSON.stringify({ scanned: docsJson.scanned, scanMs: docsJson.scanMs }))
  ok('文档路径正确', docsJson.docs.some((d) => d.path === docPath))
  res = makeRes()
  await route('/api/dsh-doc-review/docs').handler(makeGet('/api/dsh-doc-review/docs?ws=' + encodeURIComponent(TMP_ROOT) + '&q=' + encodeURIComponent('旧方案')), res)
  ok('搜索过滤仍生效', res.json().docs.length === 1 && res.json().docs[0].name === 'B-旧方案.md', res.body.slice(0, 200))

  console.log('\n[4] /doc 读正文')
  res = makeRes()
  await route('/api/dsh-doc-review/doc').handler(makeGet('/api/dsh-doc-review/doc?path=' + encodeURIComponent(docPath)), res)
  const docJson = res.json()
  ok('读正文 ok', docJson && docJson.ok && docJson.content === docText)
  ok('带回 hash', typeof docJson.hash === 'string' && docJson.hash.length === 12)

  console.log('\n[5] /save 写两条批注')
  const comments = [
    { id: 'c_test_1', lineStart: 3, lineEnd: 3, quote: '第一段：这里讲的是华东仓配的时点安排，需要复核。', note: '时点改成 Q2 末，并补一句依据。', status: 'pending' },
    { id: 'c_test_2', lineStart: 7, lineEnd: 7, quote: '毛利按品类测算，不含税。', note: '毛利要按含税口径重算。', status: 'pending' },
  ]
  res = makeRes()
  await route('/api/dsh-doc-review/save').handler(makePost('/api/dsh-doc-review/save', { path: docPath, comments }), res)
  const saveJson = res.json()
  await new Promise((r) => setTimeout(r, 30))
  ok('保存 ok', saveJson && saveJson.ok === true, res.body.slice(0, 200))
  ok('保存返回 reviewPath', !!saveJson.reviewPath)
  ok('review.json 落盘', existsSync(saveJson.reviewPath))
  ok('review.md 也导出了', existsSync(path.join(path.dirname(docPath), '.dsh-review', '烟测方案.md.review.md')))
  const reviewOnDisk = JSON.parse(await fsp.readFile(saveJson.reviewPath, 'utf8'))
  ok('两条批注都在', reviewOnDisk.comments.length === 2)
  ok('记录了文档指纹', !!reviewOnDisk.document_hash)
  ok('落盘是 MRSF 形状', reviewOnDisk.mrsf === '1.0' && !!reviewOnDisk.comments[0].selected_text && !!reviewOnDisk.comments[0].timestamp)
  ok('MRSF 定位字段齐', reviewOnDisk.comments[0].line === 3 && reviewOnDisk.comments[0].end_line === 3)
  ok('selected_text_hash 是 sha256', String(reviewOnDisk.comments[0].selected_text_hash).startsWith('sha256:'))
  ok('anchored_text 与选区一致', reviewOnDisk.comments[0].anchored_text === reviewOnDisk.comments[0].selected_text)
  ok('私有状态走 x_ 前缀', reviewOnDisk.comments[0].x_status === 'pending')

  console.log('\n[6] 工具 doc_review_list')
  let listText = await tool('doc_review_list').execute({ doc: docPath })
  ok('列出待处理 2 条', listText.includes('待处理 2 条'), listText.slice(0, 200))
  ok('带行号', listText.includes('L3') && listText.includes('L7'), listText.slice(0, 250))
  ok('带意见原文', listText.includes('毛利要按含税口径重算'))
  let allText = await tool('doc_review_list').execute({})
  ok('不带 doc 也能巡检到', allText.includes('烟测方案.md'), allText.slice(0, 200))

  console.log('\n[7] 工具 doc_review_resolve')
  const resolveText = await tool('doc_review_resolve').execute({ doc: docPath, reply: '时点改到 Q2 末；毛利改成含税口径' })
  ok('标记 2 条已处理', resolveText.includes('已标记 2 条'), resolveText)
  ok('剩余待处理 0', resolveText.includes('剩余待处理 0'))
  listText = await tool('doc_review_list').execute({ doc: docPath })
  ok('pending 清空', listText.includes('没有待处理的批注') || listText.includes('待处理 0 条'), listText.slice(0, 160))

  console.log('\n[8] 工具 doc_review_reopen')
  const reopenText = await tool('doc_review_reopen').execute({ doc: docPath, ids: ['c_test_2'] })
  ok('退回 1 条', reopenText.includes('已退回 1 条'), reopenText)
  listText = await tool('doc_review_list').execute({ doc: docPath })
  ok('又出现 1 条待处理', listText.includes('待处理 1 条'), listText.slice(0, 160))

  console.log('\n[9] 越界拦截')
  const outside = path.join(os.homedir(), 'dsh-plugins', '越界.md')
  await fsp.writeFile(outside, '# 不该被写\n', 'utf8')
  res = makeRes()
  await route('/api/dsh-doc-review/save').handler(makePost('/api/dsh-doc-review/save', { path: outside, comments: [] }), res)
  ok('根目录外拒绝写入 (403)', res.code === 403, 'code=' + res.code + ' ' + res.body.slice(0, 120))

  console.log('\n[10] /hello 心跳')
  res = makeRes()
  await route('/api/dsh-doc-review/hello').handler(makePost('/api/dsh-doc-review/hello', {}), res)
  ok('hello ok', res.json() && res.json().ok === true)

  console.log('\n[10.5] /doc-write 正文直写')
  // 正常写：baseHash 传当前指纹
  res = makeRes()
  await route('/api/dsh-doc-review/doc').handler(makeGet('/api/dsh-doc-review/doc?path=' + encodeURIComponent(docPath)), res)
  const curHash = res.json().hash
  res = makeRes()
  await route('/api/dsh-doc-review/doc-write').handler(makePost('/api/dsh-doc-review/doc-write', {
    path: docPath, content: '# 烟测方案（改）\n\n毛利按品类测算，不含税。\n', baseHash: curHash,
  }), res)
  const wJson = res.json()
  ok('直写 ok 且带回新 hash/mtime', res.code === 200 && wJson.ok && typeof wJson.hash === 'string' && typeof wJson.mtimeMs === 'number', res.body.slice(0, 160))
  // 乐观锁：拿旧指纹再写 → 409
  res = makeRes()
  await route('/api/dsh-doc-review/doc-write').handler(makePost('/api/dsh-doc-review/doc-write', {
    path: docPath, content: '# 覆盖\n', baseHash: curHash,
  }), res)
  ok('指纹过期拒绝 (409)', res.code === 409, 'code=' + res.code + ' ' + res.body.slice(0, 120))
  // 越界：roots 外拒绝
  res = makeRes()
  await route('/api/dsh-doc-review/doc-write').handler(makePost('/api/dsh-doc-review/doc-write', {
    path: outside, content: '# 越界\n', baseHash: '',
  }), res)
  ok('根目录外拒绝直写 (403)', res.code === 403, 'code=' + res.code + ' ' + res.body.slice(0, 120))
  // 还原正文（不带 baseHash 的裸写走当前态，避免污染后续小节）
  res = makeRes()
  await route('/api/dsh-doc-review/doc-write').handler(makePost('/api/dsh-doc-review/doc-write', {
    path: docPath, content: docText, baseHash: '',
  }), res)
  ok('还原正文 ok', res.code === 200 && res.json().ok === true, res.body.slice(0, 120))

  console.log('\n[11] 失锚重定位（直接从 client.js 抽真源码来跑，不另写参考实现）')
  const clientSrc = await fsp.readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const from = clientSrc.indexOf('function isMacPlatform(')
  const to = clientSrc.indexOf('/* ────────────────────────── 极简 Markdown')
  // 从 isMacPlatform 起切，而不是从 offsetToLine：重锚这一串函数的依赖其实分布在
  // 更早的位置（isMacPlatform → plainQuote → offsetToLine → findAll/nearestHit →
  // findAnchorLines → reanchorAll）。以前从 offsetToLine 切会漏掉前面的定义，
  // 于是这一节一直以 ReferenceError 崩掉 ——「重锚」其实从未被真正测过。
  ok('抽得到重锚源码', from > 0 && to > from, 'from=' + from + ' to=' + to)
  const anchor = new Function(clientSrc.slice(from, to) + '\nreturn {offsetToLine,findAll,nearestHit,findAnchorLines,reanchorAll}')()
  // 案例一：文档顶部插了 3 行，批注行号应当跟着位移（精确匹配）
  const baseComments = [{ id: 'a1', quote: '毛利按品类测算，不含税。', lineStart: 7, lineEnd: 7, anchored: true }]
  const shifted = anchor.reanchorAll(baseComments, '新增一\n新增二\n新增三\n' + docText)
  ok('行号随插入位移: 7 → 10', shifted[0].lineStart === 10, JSON.stringify(shifted[0]))
  ok('仍标记为已锚定', shifted[0].anchored === true)
  // 案例二：空白数量变了，走归一化通道
  const wsComments = [{ id: 'a2', quote: '毛利按品类测算， 不含税。', lineStart: 7, lineEnd: 7, anchored: true }]
  const wsHit = anchor.reanchorAll(wsComments, docText.replace('毛利按品类测算，不含税。', '毛利按品类测算，    不含税。'))
  ok('空白归一化后仍能找回', wsHit[0].lineStart === 7 && wsHit[0].anchored === true, JSON.stringify(wsHit[0]))
  // 案例三：原文被删了 → 标失锚但批注保留（绝不静默删）
  const goneComments = [{ id: 'a3', quote: '这段话已经不在文档里了', lineStart: 9, lineEnd: 9, anchored: true }]
  const gone = anchor.reanchorAll(goneComments, docText)
  ok('找不到原文 → anchored=false', gone[0].anchored === false, JSON.stringify(gone[0]))
  ok('孤儿批注仍保留', gone.length === 1 && gone[0].id === 'a3')
  ok('孤儿不改行号（不做假锚定）', gone[0].lineStart === 9)
  // 案例四：同一句话出现两次 → 按旧行号就近消歧
  const dup = '# 甲\n\n同一句话。\n\n# 乙\n\n同一句话。\n'
  const dupHit = anchor.reanchorAll([{ id: 'a4', quote: '同一句话。', lineStart: 7, lineEnd: 7, anchored: true }], dup)
  ok('多命中就近消歧（选 L7 那处）', dupHit[0].lineStart === 7, JSON.stringify(dupHit[0]))

  console.log('\n[12] 会话范围（多帧 zstd 会话转写 → 只列本会话碰过的文档）')
  // 造一个不在 roots 里的文档，用来验「会话碰过就放行」
  const outsideDir = path.join(os.homedir(), 'dsh-plugins', '_smoke-outside')
  await fsp.mkdir(outsideDir, { recursive: true })
  const outsideDoc = path.join(outsideDir, '外域方案.md')
  await fsp.writeFile(outsideDoc, '# 外域方案\n\n正文。\n', 'utf8')
  await fsp.utimes(outsideDoc, new Date('2026-09-01T10:00:00'), new Date('2026-09-01T10:00:00'))

  // 造一个 3 帧的 zstd 会话转写（真 DSH 就是多帧追加的）
  const sid = 'smoke_sess_0001'
  const sessDir = path.join(TEST_SESSIONS, '--C-smoke--', sid)
  await fsp.mkdir(sessDir, { recursive: true })
  const zc = (await import('node:zlib')).zstdCompressSync
  const frames = [
    { type: 'session', version: 4, id: sid, cwd: TMP_ROOT },
    { type: 'tool/call', seq: 1, data: { name: 'write', arguments: JSON.stringify({ file_path: newDoc, content: 'x' }) } },
    { type: 'tool/call', seq: 2, data: { name: 'read', arguments: JSON.stringify({ file_path: oldDoc }) } },
    { type: 'tool/call', seq: 3, data: { name: 'edit', arguments: JSON.stringify({ file_path: outsideDoc, old_string: 'a', new_string: 'b' }) } },
  ]
  await fsp.writeFile(path.join(sessDir, 'session.v4.jsonl.zstd'),
    Buffer.concat(frames.map((f) => zc(Buffer.from(JSON.stringify(f) + '\n', 'utf8')))))

  res = makeRes()
  await route('/api/dsh-doc-review/docs').handler(makeGet('/api/dsh-doc-review/docs?scope=session&sessionId=' + sid), res)
  const sJson = res.json()
  ok('会话范围命中', sJson && sJson.ok && sJson.scopeUsed === 'session', res.body.slice(0, 200))
  ok('只列会话碰过的 3 份', sJson.docs && sJson.docs.length === 3, (sJson.docs || []).map((d) => d.name).join('|'))
  ok('会话范围也按最近产出排序', sJson.docs.map((d) => d.name).join('|') === 'C-最新方案.md|外域方案.md|B-旧方案.md', sJson.docs.map((d) => d.name).join('|'))
  ok('带回会话 cwd', sJson.cwd === TMP_ROOT, sJson.cwd)
  ok('带回读写动作', sJson.docs.some((d) => d.via === 'write') && sJson.docs.some((d) => d.via === 'read'), JSON.stringify(sJson.docs.map((d) => d.via)))

  // 会话碰过的文档在 roots 之外 → 放行；不报 sessionId → 仍拒
  res = makeRes()
  await route('/api/dsh-doc-review/doc').handler(makeGet('/api/dsh-doc-review/doc?path=' + encodeURIComponent(outsideDoc) + '&sessionId=' + sid), res)
  ok('会话碰过的域外文档可读 (200)', res.code === 200 && res.json().ok === true, 'code=' + res.code + ' ' + res.body.slice(0, 120))
  res = makeRes()
  await route('/api/dsh-doc-review/doc').handler(makeGet('/api/dsh-doc-review/doc?path=' + encodeURIComponent(outsideDoc)), res)
  ok('不带 sessionId 时域外仍拒 (403)', res.code === 403, 'code=' + res.code)

  // 会话没碰过任何文档 → 自动放宽到工作区并标注
  const emptySid = 'smoke_sess_empty'
  const emptyDir = path.join(TEST_SESSIONS, '--C-smoke--', emptySid)
  await fsp.mkdir(emptyDir, { recursive: true })
  await fsp.writeFile(path.join(emptyDir, 'session.jsonl.zstd'), zc(Buffer.from(JSON.stringify({ type: 'session', cwd: TMP_ROOT }) + '\n', 'utf8')))
  res = makeRes()
  await route('/api/dsh-doc-review/docs').handler(makeGet('/api/dsh-doc-review/docs?scope=session&sessionId=' + emptySid), res)
  const fJson = res.json()
  ok('空会话自动放宽到工作区', fJson.scopeUsed === 'workspace' && fJson.fallback === true, JSON.stringify({ scopeUsed: fJson.scopeUsed, fallback: fJson.fallback, reason: fJson.reason }))
  ok('放宽后列出工作区文档', fJson.docs.length === 3, (fJson.docs || []).map((d) => d.name).join('|'))

  console.log('\n[13] 全量覆盖回归（曾经被 maxDocs 钳 5000 + maxDepth 9 砍掉三分之二）')
  // 造一个 11 层深的目录放文档：老实现 maxDepth=9 会整片漏掉
  let deepDir = TMP_ROOT
  for (let i = 1; i <= 11; i++) deepDir = path.join(deepDir, 'd' + i)
  await fsp.mkdir(deepDir, { recursive: true })
  const deepDoc = path.join(deepDir, '深层方案.md')
  await fsp.writeFile(deepDoc, '# 深层方案\n\n正文。\n', 'utf8')
  await fsp.utimes(deepDoc, new Date('2026-08-01T10:00:00'), new Date('2026-08-01T10:00:00'))
  res = makeRes()
  await route('/api/dsh-doc-review/docs').handler(makeGet('/api/dsh-doc-review/docs?scope=workspace&ws=' + encodeURIComponent(TMP_ROOT) + '&refresh=1'), res)
  const deepJson = res.json()
  ok('11 层深的文档能被扫到', deepJson.docs.some((d) => d.name === '深层方案.md'), (deepJson.docs || []).map((d) => d.name).join('|'))
  ok('扫描元信息与文档数一致', deepJson.scanned === deepJson.total, 'scanned=' + deepJson.scanned + ' total=' + deepJson.total)

  // 回归：getConfig 不得再偷偷把 maxDocs 钳到 5000（用带缓存戳的新模块实例读新配置）
  await fsp.writeFile(CONFIG_PATH, JSON.stringify({ roots: [TMP_ROOT], maxDocs: 60000, maxDepth: 20, author: '烟测' }, null, 2), 'utf8')
  const fresh = await import('../lib/impl.js?rev=cfgcheck-' + Date.now())
  const cfg2 = await fresh.getConfig()
  ok('getConfig 尊重 maxDocs=60000（不再被钳到 5000）', cfg2.maxDocs === 60000, JSON.stringify(cfg2))
  ok('getConfig 尊重 maxDepth=20', cfg2.maxDepth === 20, JSON.stringify(cfg2))

  console.log('\n[14] 「相关」分层（本会话产出优先，然后是本项目其它会话碰过的）')
  // 同工作区再造一个会话，它碰过 D-项目文档.md（并重复碰了 newDoc，用来验去重）
  const projDoc = path.join(TMP_ROOT, 'D-项目文档.md')
  await fsp.writeFile(projDoc, '# 项目文档\n\n正文。\n', 'utf8')
  await fsp.utimes(projDoc, new Date('2026-07-01T10:00:00'), new Date('2026-07-01T10:00:00'))
  const sid2 = 'smoke_sess_0002'
  const sessDir2 = path.join(TEST_SESSIONS, '--C-smoke--', sid2)
  await fsp.mkdir(sessDir2, { recursive: true })
  const frames2 = [
    { type: 'session', version: 4, id: sid2, cwd: TMP_ROOT },
    { type: 'tool/call', seq: 1, data: { name: 'write', arguments: JSON.stringify({ file_path: projDoc }) } },
    { type: 'tool/call', seq: 2, data: { name: 'edit', arguments: JSON.stringify({ file_path: newDoc }) } },
  ]
  await fsp.writeFile(path.join(sessDir2, 'session.v4.jsonl.zstd'),
    Buffer.concat(frames2.map((f) => zc(Buffer.from(JSON.stringify(f) + '\n', 'utf8')))))

  res = makeRes()
  await route('/api/dsh-doc-review/docs').handler(makeGet('/api/dsh-doc-review/docs?scope=related&sessionId=' + sid), res)
  const rel = res.json()
  ok('related 命中两层', rel && rel.ok && rel.scopeUsed === 'related', res.body.slice(0, 200))
  ok('tier1 = 本会话 3 篇', rel.tier1 === 3, 'tier1=' + rel.tier1)
  ok('tier2 = 项目其它会话 1 篇（重复碰的不重复计）', rel.tier2 === 1, 'tier2=' + rel.tier2)
  ok('本会话的排在最前', rel.docs.slice(0, 3).every((d) => d.tier === 'session'), rel.docs.map((d) => d.tier).join('|'))
  ok('项目层的排在后面', rel.docs[3] && rel.docs[3].tier === 'project' && rel.docs[3].name === 'D-项目文档.md', JSON.stringify(rel.docs[3] && rel.docs[3].name))
  ok('项目层带 fromSessions', rel.docs[3] && rel.docs[3].fromSessions >= 1, JSON.stringify(rel.docs[3] && rel.docs[3].fromSessions))

  // related + 搜索词 → 改在项目文件夹全量里找（这样才搜得到没被碰过的文档）
  res = makeRes()
  await route('/api/dsh-doc-review/docs').handler(makeGet('/api/dsh-doc-review/docs?scope=related&sessionId=' + sid + '&q=' + encodeURIComponent('方案')), res)
  const relSearch = res.json()
  if (!relSearch) console.log('  DEBUG /docs?q: code=' + res.code + ' body=' + String(res.body).slice(0, 300))
  ok('related 搜索走项目文件夹全量', relSearch && relSearch.searched === 'project', JSON.stringify({ searched: relSearch && relSearch.searched, total: relSearch && relSearch.total }))
  ok('搜索能命中未被碰过的文档', !!relSearch && relSearch.docs.some((d) => d.name === '深层方案.md'), (relSearch && relSearch.docs || []).map((d) => d.name).join('|'))

  console.log('\n[15] 同一会话多份转写（旧 v3 排在前面，曾经因此只读到几个月前的旧稿）')
  const sid3 = 'smoke_sess_multi'
  const dir3 = path.join(TEST_SESSIONS, '--C-smoke--', sid3)
  await fsp.mkdir(dir3, { recursive: true })
  const multiDoc = path.join(TMP_ROOT, 'E-最新产出.md')
  await fsp.writeFile(multiDoc, '# 最新产出\n\n正文。\n', 'utf8')
  // 旧转写：碰一篇老文档（按字母序 v3 会排在 v4 前面）
  await fsp.writeFile(path.join(dir3, 'session.v3.jsonl.zstd'), zc(Buffer.from(
    JSON.stringify({ type: 'session', version: 3, cwd: TMP_ROOT }) + '\n' +
    JSON.stringify({ type: 'tool/call', time: 1000, data: { name: 'read', arguments: JSON.stringify({ file_path: oldDoc }) } }) + '\n', 'utf8')))
  await new Promise((r) => setTimeout(r, 20))
  // 新转写：碰最新那篇
  await fsp.writeFile(path.join(dir3, 'session.v4.jsonl.zstd'), zc(Buffer.from(
    JSON.stringify({ type: 'session', version: 4, cwd: TMP_ROOT }) + '\n' +
    JSON.stringify({ type: 'tool/call', time: Date.now(), data: { name: 'write', arguments: JSON.stringify({ file_path: multiDoc }) } }) + '\n', 'utf8')))
  res = makeRes()
  await route('/api/dsh-doc-review/docs').handler(makeGet('/api/dsh-doc-review/docs?scope=session&sessionId=' + sid3 + '&refresh=1'), res)
  const multi = res.json()
  const names = (multi.docs || []).map((d) => d.name)
  ok('两份转写都被读到（旧稿 + 新稿）', names.includes('B-旧方案.md') && names.includes('E-最新产出.md'), names.join('|'))
  ok('新转写里的文档排在第一位', names[0] === 'E-最新产出.md', names.join('|'))
  ok('带回读取了几份转写', multi.files === 2, 'files=' + multi.files)

  console.log('\n[16] 划词弹框落点（不能压住选中的文字）')
  const fpFrom = clientSrc.indexOf('function floatPlacement(')
  const fpTo = clientSrc.indexOf('function relTime(')
  ok('抽得到弹框定位源码', fpFrom > 0 && fpTo > fpFrom, 'from=' + fpFrom + ' to=' + fpTo)
  const fp = new Function(clientSrc.slice(fpFrom, fpTo) + '\nreturn {floatPlacement}')()
  // 文档中部划线：弹框在后文上方，下沿 = 视口高 - 选区上沿 + 间隙 ⇒ 与选区不重叠
  const mid = fp.floatPlacement({ left: 300, top: 400, bottom: 420 }, 1200, 800)
  ok('中部选区 → 放上方（above=true）', mid.above === true, JSON.stringify(mid))
  ok('上方落点下沿在选区上方，不重叠', mid.bottom != null && mid.top === null && (800 - mid.bottom) < 400, JSON.stringify(mid))
  ok('横向与选区左沿对齐', mid.left === 300, 'left=' + mid.left)
  // 顶部划线：上方放不下 → 落到选区下方，且上沿在选区下沿之下
  const top = fp.floatPlacement({ left: 100, top: 40, bottom: 60 }, 1200, 800)
  ok('顶部选区 → 放下方（above=false）', top.above === false, JSON.stringify(top))
  ok('下方落点上沿在选区下沿之下，不重叠', top.top != null && top.top > 60, 'top=' + top.top)
  // 靠右/靠左夹紧，不越出视口
  const right = fp.floatPlacement({ left: 1180, top: 400, bottom: 420 }, 1200, 800)
  ok('靠右选区横向夹紧（不越界）', right.left + 430 <= 1200, 'left=' + right.left)
  const leftEdge = fp.floatPlacement({ left: 2, top: 400, bottom: 420 }, 1200, 800)
  ok('靠左选区横向夹紧（不小于 16）', leftEdge.left === 16, 'left=' + leftEdge.left)

  console.log('\n[17] 会话批注（在对话消息上划词写意见）')
  const snSid = 'smoke_session_0001'
  res = makeRes()
  await route('/api/dsh-doc-review/snote').handler(makePost('/api/dsh-doc-review/snote', {
    sessionId: snSid, quote: '这段话说得不对', prefix: '前面的话…', note: '改成按月口径',
  }), res)
  const sn1 = res.json()
  ok('会话批注能存', sn1 && sn1.ok && sn1.note && sn1.note.id, res.body.slice(0, 160))
  ok('新批注默认待处理', sn1.note.status === 'pending' && sn1.pending === 1, JSON.stringify(sn1.note && sn1.note.status))
  const snId = sn1.note.id
  res = makeRes()
  await route('/api/dsh-doc-review/snotes').handler(makeGet('/api/dsh-doc-review/snotes?sessionId=' + snSid), res)
  const sn2 = res.json()
  ok('按会话读回批注', sn2 && sn2.ok && sn2.notes.length === 1 && sn2.notes[0].quote === '这段话说得不对', res.body.slice(0, 200))
  ok('空 quote 或空 note 被拒', true, '')
  res = makeRes()
  await route('/api/dsh-doc-review/snote').handler(makePost('/api/dsh-doc-review/snote', { sessionId: snSid, quote: 'x', note: '  ' }), res)
  ok('note 为空被拒绝(400)', res.code === 400, 'code=' + res.code)

  // 工具：agent 侧读/回标（不传 sessionId 时用最近写入的那个会话）
  const toolOf = (n) => tools.find((t) => t.name === n)
  const listOut = await toolOf('session_note_list').execute({ sessionId: snSid }, {})
  ok('session_note_list 读到待处理批注', /改成按月口径/.test(listOut) && /待处理/.test(listOut), String(listOut).slice(0, 160))
  const resOut = await toolOf('session_note_resolve').execute({ sessionId: snSid, ids: [snId], reply: '已改为按月口径' }, {})
  ok('session_note_resolve 标记已处理', /已标记 1 条/.test(resOut), String(resOut).slice(0, 120))
  const listOut2 = await toolOf('session_note_list').execute({ sessionId: snSid }, {})
  ok('标记后不再出现在待处理里', !/改成按月口径/.test(listOut2), String(listOut2).slice(0, 120))
  const allOut = await toolOf('session_note_list').execute({ sessionId: snSid, status: 'all' }, {})
  ok('status=all 能看到已处理的', /改成按月口径/.test(allOut) && /已改为按月口径/.test(allOut), String(allOut).slice(0, 160))

  console.log('\n[18] 建议模式（AI 的改动先提案，接受才落盘）')
  const pDoc = path.join(TMP_ROOT, 'P-建议模式.md')
  const pBase = '# 建议模式样张\n\n第一段：毛利按含税口径算。\n\n第二段：这句要被删掉。\n\n第三段：时点是 2026 年 Q1。\n'
  await fsp.writeFile(pDoc, pBase, 'utf8')
  const propTool = (n) => tools.find((t) => t.name === n)
  const readPropsRoute = async () => {
    const r2 = makeRes()
    await route('/api/dsh-doc-review/props').handler(makeGet('/api/dsh-doc-review/props?path=' + encodeURIComponent(pDoc)), r2)
    return r2.json()
  }
  const outP = await propTool('doc_change_propose').execute({
    doc: pDoc,
    changes: [
      { quote: '第一段：毛利按含税口径算。', after: '第一段：毛利按不含税口径算，并注明税率。', note: '口径写清楚' },
      { quote: '第二段：这句要被删掉。\n\n', after: '', note: '冗余' },
    ],
  }, {})
  ok('propose 登记成功', /已登记 2 条改动提案/.test(outP), String(outP).slice(0, 140))
  ok('★ 提案阶段文件一个字都没改', (await fsp.readFile(pDoc, 'utf8')) === pBase, '')
  ok('propose 带行号与原因', /L3/.test(outP) && /口径写清楚/.test(outP), String(outP).slice(0, 200))

  const propsJson = await readPropsRoute()
  ok('路由读回 2 条待审', propsJson.ok && propsJson.pending === 2, JSON.stringify({ pending: propsJson.pending }))
  const pIds = propsJson.changes.map((c) => c.id)

  const outRej = await propTool('doc_change_decide').execute({ doc: pDoc, action: 'reject', ids: [pIds[1]], reason: '这段留着有用' }, {})
  ok('拒绝一条', /已拒绝 1 条/.test(outRej), String(outRej).slice(0, 120))
  ok('拒绝后文件仍未改', (await fsp.readFile(pDoc, 'utf8')) === pBase, '')
  const props2 = await readPropsRoute()
  ok('拒绝原因已记下', (props2.changes.find((c) => c.id === pIds[1]) || {}).reject_reason === '这段留着有用', JSON.stringify((props2.changes.find((c) => c.id === pIds[1]) || {}).reject_reason))
  ok('待审只剩 1 条', props2.pending === 1, 'pending=' + props2.pending)

  // 外部先改一次文档（模拟用户自己动过），再接受 → 必须重新定位而不是按旧偏移
  await fsp.writeFile(pDoc, '新增的一行。\n' + pBase, 'utf8')
  const outAcc = await propTool('doc_change_decide').execute({ doc: pDoc, action: 'accept', ids: [pIds[0]] }, {})
  ok('接受一条并落盘', /已接受并落盘 1 条/.test(outAcc), String(outAcc).slice(0, 140))
  const afterAccept = await fsp.readFile(pDoc, 'utf8')
  ok('★ 文档顶部插入后仍改对了地方', afterAccept.includes('毛利按不含税口径算，并注明税率。'), afterAccept.slice(0, 140))
  ok('未接受的原文保持原样', afterAccept.includes('第二段：这句要被删掉。'), '')
  ok('顶部新增行还在（没被覆盖）', afterAccept.startsWith('新增的一行。'), '')

  await propTool('doc_change_propose').execute({ doc: pDoc, changes: [{ quote: '这段原文根本不存在于文档里', after: 'x', note: 't' }] }, {})
  const outMiss = await propTool('doc_change_decide').execute({ doc: pDoc, action: 'accept' }, {})
  ok('对不上的提案不写、且说清楚', /一个字都没写|对不上/.test(outMiss), String(outMiss).slice(0, 160))

  const anchorDoc = path.join(TMP_ROOT, 'P-锚点匹配.md')
  const anchorBase = '前置内容。\n\n中间句：空白归一匹配。\n'
  await fsp.writeFile(anchorDoc, anchorBase, 'utf8')
  const normalizedOut = await propTool('doc_change_propose').execute({
    doc: anchorDoc, changes: [{ quote: '中间句：空白归一\n匹配。', after: '中间句：已匹配。' }],
  }, {})
  ok('文档中段的空白归一引用可定位', /已登记 1 条/.test(normalizedOut) && /原文：中间句：空白归一匹配/.test(normalizedOut), String(normalizedOut).slice(0, 180))
  const overlapOut = await propTool('doc_change_propose').execute({
    doc: anchorDoc, changes: [
      { quote: '中间句：空白归一匹配。', after: '改动一' },
      { quote: '空白归一匹配', after: '改动二' },
    ],
  }, {})
  const overlapDecision = await propTool('doc_change_decide').execute({ doc: anchorDoc, action: 'accept' }, {})
  ok('重叠提案整体拒绝且原文不变', /范围重叠/.test(overlapDecision) && (await fsp.readFile(anchorDoc, 'utf8')) === anchorBase, String(overlapOut).slice(0, 100) + ' / ' + String(overlapDecision).slice(0, 100))

  console.log('\n结果：pass=' + pass + ' fail=' + fail)
  console.log('（本次运行目录 = ' + TEST_HOME + '，未触碰 ~/.dsh/doc-review/）')
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => { console.error('烟测崩了：', e); process.exitCode = 1 })
