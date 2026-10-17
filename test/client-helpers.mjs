/**
 * Pure helpers behind the Feishu-style comment UI, pulled straight out of lib/client.js
 * (no browser): quote location, text-node offset mapping, card/anchor alignment,
 * reply thread fallback, platform shortcut labels.
 */
import { promises as fsp } from 'node:fs'

const src = await fsp.readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

let pass = 0, fail = 0
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n) } else { fail++; console.log('  FAIL ' + n + (x ? ' :: ' + x : '')) } }

function grab(name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('client.js missing function: ' + name)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced braces: ' + name)
}

const names = ['relTime', 'isMacPlatform', 'shortcutLabel', 'squeeze', 'plainQuote', 'locateQuote', 'historyParagraphAt', 'offsetInNodes', 'alignDelta', 'threadOf', 'whenText']
const H = new Function(names.map(grab).join('\n') + '\nreturn {' + names.join(',') + '}')()

console.log('[1] shortcutLabel / isMacPlatform')
ok('Mac: Mod+Enter → ⌘Enter', H.shortcutLabel('Mod+Enter', true) === '⌘Enter', H.shortcutLabel('Mod+Enter', true))
ok('Mac: Mod+Shift+M → ⇧⌘M (Apple order)', H.shortcutLabel('Mod+Shift+M', true) === '⇧⌘M', H.shortcutLabel('Mod+Shift+M', true))
ok('Win: Mod+Shift+M → Ctrl+Shift+M', H.shortcutLabel('Mod+Shift+M', false) === 'Ctrl+Shift+M')
ok('Win: Mod+Enter → Ctrl+Enter', H.shortcutLabel('Mod+Enter', false) === 'Ctrl+Enter')
ok('platform MacIntel → mac', H.isMacPlatform({ platform: 'MacIntel' }) === true)
ok('userAgentData macOS → mac', H.isMacPlatform({ userAgentData: { platform: 'macOS' } }) === true)
ok('Win32 → not mac', H.isMacPlatform({ platform: 'Win32' }) === false)
ok('Linux UA → not mac', H.isMacPlatform({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }) === false)
ok('no navigator → not mac', H.isMacPlatform(null) === false)

console.log('[2] locateQuote')
const text = '第一段说明。这里是需要修改的句子，后面还有内容。'
let r = H.locateQuote(text, '需要修改的句子')
ok('exact hit', r && text.slice(r.start, r.end) === '需要修改的句子', JSON.stringify(r))
const wrapped = 'alpha beta gamma delta'
r = H.locateQuote(wrapped, 'beta\n  gamma')
ok('whitespace-insensitive (selection crossed a line break)', r && wrapped.slice(r.start, r.end) === 'beta gamma', JSON.stringify(r))
const rendered = '这是加粗的话和一个链接文字结束'
r = H.locateQuote(rendered, '**加粗的话**和一个[链接文字](http://x.y)')
ok('markdown-source quote maps to rendered text', r && rendered.slice(r.start, r.end) === '加粗的话和一个链接文字', JSON.stringify(r))
r = H.locateQuote('- 列表项内容', '- 列表项内容')
ok('exact wins before stripping', r && r.start === 0)
r = H.locateQuote('项目一 项目二', '- 项目二')
ok('list marker stripped', r && '项目一 项目二'.slice(r.start, r.end) === '项目二', JSON.stringify(r))
ok('not found → null (lost anchor, no guessing)', H.locateQuote(text, '完全不存在') === null)
ok('blank quote → null', H.locateQuote(text, '   ') === null)
ok('empty text → null', H.locateQuote('', 'x') === null)

console.log('[2b] 历史消息 hover 批注目标')
const paragraph = { innerText: '历史记录里的一个段落。' }
const message = { contains: (node) => node === paragraph }
const historyTarget = {
  nodeType: 1,
  closest(selector) {
    if (selector.startsWith('.dr-root')) return null
    if (selector === '[data-message-client-id]') return message
    if (selector.startsWith('p,li')) return paragraph
    return null
  },
}
const historyHit = H.historyParagraphAt(historyTarget)
ok('消息段落解析为可批注目标', historyHit && historyHit.block === paragraph && historyHit.text === paragraph.innerText)
const outsideTarget = { nodeType: 1, closest: () => null }
ok('非历史消息不显示入口', H.historyParagraphAt(outsideTarget) === null)
paragraph.innerText = 'x'
ok('单字符内容不显示入口', H.historyParagraphAt(historyTarget) === null)

console.log('[3] offsetInNodes')
const lens = [3, 4, 2]           // "abc" "defg" "hi"
let o = H.offsetInNodes(lens, 0, false)
ok('start of first node', o.index === 0 && o.offset === 0)
o = H.offsetInNodes(lens, 3, false)
ok('boundary as start → next node', o.index === 1 && o.offset === 0, JSON.stringify(o))
o = H.offsetInNodes(lens, 3, true)
ok('boundary as end → stays in previous node', o.index === 0 && o.offset === 3, JSON.stringify(o))
o = H.offsetInNodes(lens, 8, false)
ok('middle of last node', o.index === 2 && o.offset === 1)
o = H.offsetInNodes(lens, 9, true)
ok('end of text', o.index === 2 && o.offset === 2)
ok('no nodes → null', H.offsetInNodes([], 0, false) === null)

console.log('[4] alignDelta')
ok('item below target → positive (scroll down)', H.alignDelta(500, 40, 200, 100, 800) === 300)
ok('item above target → negative', H.alignDelta(150, 40, 300, 100, 800) === -150)
ok('target clamped to view top + pad', H.alignDelta(400, 40, 20, 100, 800) === 400 - 108)
ok('tall item clamped so its top stays visible', H.alignDelta(400, 1000, 700, 100, 800) === 400 - 108)
ok('target near bottom keeps item inside', H.alignDelta(400, 100, 790, 100, 800) === 400 - 692)

console.log('[5] threadOf')
const replies = [{ id: 'r1', author: 'AI', role: 'agent', text: '已改', createdAt: '2026-10-12 10:00' }, { id: 'r2', author: '豆', role: 'user', text: '好', createdAt: '2026-10-12 10:01' }]
ok('replies take precedence over legacy reply', H.threadOf({ replies, reply: '旧' }).length === 2)
let t = H.threadOf({ replies: [], reply: '旧结论' })
ok('legacy reply only when replies empty', t.length === 1 && t[0].role === 'agent' && t[0].text === '旧结论')
ok('blank replies filtered → legacy fallback', H.threadOf({ replies: [{ id: 'x', role: 'user', text: '  ' }], reply: 'r' })[0].text === 'r')
ok('nothing → empty', H.threadOf({}).length === 0 && H.threadOf(null).length === 0)

console.log('[6] whenText')
const now = new Date()
const p = (n) => String(n).padStart(2, '0')
const stamp = now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate()) + ' 09:05'
ok('nowStamp format → 相对时间', /^(刚刚|\d+分钟|\d+小时)$/.test(H.whenText(stamp)), H.whenText(stamp))
ok('garbage passes through', H.whenText('昨天傍晚') === '昨天傍晚')
ok('empty → empty', H.whenText('') === '')

console.log('[7] styling discipline')
const cssStart = src.indexOf('function ensureStyle(')
const cssEnd = src.indexOf('function inDocView(')
const css = src.slice(cssStart, cssEnd)
ok('no hard-coded #hex colours in styles', !/#[0-9a-fA-F]{3,8}\b/.test(css), (css.match(/#[0-9a-fA-F]{3,8}\b/) || [])[0])
ok('no rgb()/rgba()/hsl() literals in styles', !/\b(rgba?|hsla?)\(/.test(css))
ok('highlight names dr-anchor / dr-anchor-active styled', css.includes('::highlight(dr-anchor)') && css.includes('::highlight(dr-anchor-active)'))
ok('历史消息 hover 批注图标有独立样式', css.includes('.dr-history-comment:hover') && css.includes('position:fixed'))
ok('reduced-motion respected', css.includes('prefers-reduced-motion'))
ok('no hard-coded Ctrl+ in UI strings outside helpers', !/['"][^'"\n]*Ctrl\+[^'"\n]*['"]/.test(src.replace(grab('shortcutLabel'), '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')))

console.log('\n结果：pass=' + pass + ' fail=' + fail)
process.exitCode = fail ? 1 : 0
