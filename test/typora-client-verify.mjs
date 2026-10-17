/* 真实 lib/client.js 的 Typora 引擎端到端验收（G1-G9，走 harness + 假后端）。
 * 与 test/typora-verify.mjs（原型）同一口径，但目标是被移植后的真实代码。
 * 用法：node test/typora-client-verify.mjs（需 http.server :4311 已起）
 * 全绿 exit 0；失败 exit 1。 */
import { chromium } from 'playwright'
import fs from 'node:fs'

let pass = 0, fail = 0
const fails = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; fails.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', e => { fail++; fails.push('pageerror: ' + e.message); console.log('  FAIL pageerror :: ' + e.message.slice(0, 200)) })
await page.goto('http://localhost:4311/playground/typora-harness.html')
await page.waitForSelector('.dr-editor-host .tl', { timeout: 8000 })
await page.waitForTimeout(400)

const lineEl = (i) => page.locator(`.dr-editor-host .tl[data-ls="${i}"]`)
const modeOf = async (i) => (await lineEl(i).getAttribute('data-mode'))
const dbMd = async () => page.evaluate(() => window.__db.docContent['/tmp/烟测方案.md'])
const findLine = async (text) => page.evaluate((t) => {
  const els = [...document.querySelectorAll('.dr-editor-host .tl')]
  for (const el of els) if ((el.textContent || '').replace(/\u200B/g, '').includes(t)) return Number(el.getAttribute('data-ls'))
  return -1
}, text)
async function clickInto(i, frac = 0.5) {
  const box = await lineEl(i).boundingBox()
  await page.mouse.click(box.x + box.width * frac, box.y + box.height / 2)
  await page.waitForTimeout(150)
}

/* 样例行号：1=h2 3=判断2(粗体) 5-7=列表 9=引用 11-12=有序 14-16=表格 18=hr 20/21=段落 */

console.log('\n[G1] 单击渲染态文字 → 该行变源码、光标落点击处、零视觉提示')
await clickInto(3, 0.3)
ok('G1a 光标行(3)变 raw', (await modeOf(3)) === 'raw', 'mode=' + await modeOf(3))
ok('G1b raw 内容含 ** 源码', (await lineEl(3).textContent()).includes('**判断 2'))
const g1 = await page.evaluate(() => {
  const el = document.querySelector('.tl[data-ls="3"]')
  const s = getSelection()
  const r = document.createRange(); r.selectNodeContents(el)
  r.setEnd(s.getRangeAt(0).startContainer, s.getRangeAt(0).startOffset)
  const cs = getComputedStyle(el)
  return { off: r.toString().length, len: el.textContent.length, bw: cs.borderTopWidth, bs: cs.borderTopStyle, bg: cs.backgroundColor }
})
ok('G1c 光标在点击处(0<off<len)', g1.off > 0 && g1.off < g1.len, JSON.stringify(g1))
ok('G1d raw 行无框无底', g1.bw === '0px' && g1.bs === 'none' && g1.bg === 'rgba(0, 0, 0, 0)', JSON.stringify(g1))
await page.screenshot({ path: '.artifacts/client-g1.png' })

console.log('\n[G2] 其余行保持渲染态')
ok('G2a 标题行无 ##', !((await lineEl(1).textContent()).includes('##')))
ok('G2b 列表行渲染(• 开头)', (await lineEl(5).textContent()).trim().startsWith('•'))
ok('G2c 引用行无 >', !((await lineEl(9).textContent()).startsWith('>')))
ok('G2d 只有一行 raw', (await page.locator('.tl-raw').count()) === 1)

console.log('\n[G4] 点别的行 → 旧行渲染回去、新行就地编辑（纯文本段保持渲染态）')
await clickInto(5, 0.5)
ok('G4a 行3渲染回去(有 strong)', (await page.locator('.tl[data-ls="3"] strong').count()) >= 1)
ok('G4b 行5保持渲染态(• 开头)', (await modeOf(5)) === 'r' && (await lineEl(5).textContent()).trim().startsWith('•'))
ok('G4c 零 raw 行（live 就地编辑）', (await page.locator('.tl-raw').count()) === 0)

console.log('\n[G5] 打 **新词** 离开 → 渲染成粗体；落盘是标准 Markdown')
await clickInto(5, 0.95)
await page.keyboard.type(' **新')
ok('G5a 输入中间态可见未闭合 **', (await lineEl(5).textContent()).includes('**新'))
await page.keyboard.type('词**')
ok('G5a2 闭合后行内即时渲染粗体', (await page.locator('.tl[data-ls="5"] strong').count()) === 1)
await clickInto(1, 0.5)
ok('G5b 离开后渲染 <strong>新词</strong>', (await page.locator('.tl[data-ls="5"] strong').count()) === 1)
await page.waitForTimeout(900)   // 等 600ms 防抖落盘
const saved5 = await dbMd()
ok('G5c 后端收到标准 Markdown', saved5.includes('- 《Inspired》/《Empowered》Marty Cagan —— 原理层 **新词**'), JSON.stringify(saved5.split('\n')[4]))

console.log('\n[G6] Enter 续列表 / Backspace 并行')
await clickInto(6, 0.95)
await page.keyboard.press('Enter')
ok('G6a 新行续出 "- "', (await lineEl(7).textContent()).startsWith('- '))
await page.keyboard.type('新增一项')
await page.keyboard.press('Enter')  // 空项 → 退出列表
const liB = await findLine('普通段落乙')
await page.waitForTimeout(900)
await clickInto(liB, 0.1)
const beforeB = (await lineEl(liB).textContent()).replace(/\u200B/g, '')
await page.keyboard.press('Home')
await page.keyboard.press('Backspace')
await page.waitForTimeout(900)
ok('G6b 行首 Backspace 并入上一行', (await dbMd()).includes('普通段落甲。' + beforeB), JSON.stringify((await dbMd()).match(/普通段落.*/)))

console.log('\n[G8] 无编辑态切换感（始终可编、无按钮）')
ok('G8a 宿主始终 contenteditable', (await page.locator('.dr-editor-host').getAttribute('contenteditable')) === 'true')
ok('G8b 无编辑按钮', (await page.locator('.dr-editor-host [data-act="edit"], .dr-editor-host .dr-block-edit').count()) === 0)

console.log('\n[G7] 拖选跨行可复制、期间不转 raw')
await page.evaluate(() => document.querySelector('.dr-editor-host').blur())
await page.waitForTimeout(200)
ok('G7-0 失焦后无 raw', (await page.locator('.tl-raw').count()) === 0)
const b3 = await lineEl(3).boundingBox()
const b5 = await lineEl(5).boundingBox()
await page.mouse.move(b3.x + 10, b3.y + b5.height / 2)
await page.mouse.down()
await page.mouse.move(b5.x + 60, b5.y + b5.height / 2, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(150)
const g7 = await page.evaluate(() => ({ sel: getSelection().toString(), raw: document.querySelectorAll('.tl-raw').length }))
ok('G7a 跨行拖选拿到文本', g7.sel.length > 10, JSON.stringify(g7.sel.slice(0, 40)))
ok('G7b 拖选期间无 raw', g7.raw === 0, 'raw=' + g7.raw)

console.log('\n[G9] 划词批注流程不坏（pill → 批注落盘）')
const selText = g7.sel
await page.keyboard.press('Escape')
await page.mouse.click(b3.x + 10, b3.y + b3.height / 2)  // 重新拖选（点一下会转 raw——先失焦再来）
await page.waitForTimeout(150)
await page.mouse.move(b3.x + 10, b3.y + b3.height / 2)
await page.mouse.down()
await page.mouse.move(b5.x + 100, b5.y + b5.height / 2, { steps: 10 })
await page.mouse.up()
await page.waitForTimeout(200)
const pillVisible = await page.locator('.dr-pill, .dr-doc-pill').count()
ok('G9a 拖选浮出批注工具条', pillVisible >= 1, 'pill=' + pillVisible)
if (pillVisible) {
  await page.locator('.dr-pill button, .dr-doc-pill button').first().click()
  await page.waitForTimeout(200)
  const ta = page.locator('textarea.dr-composer-input')
  if (await ta.count()) {
    await ta.first().click()
    await page.keyboard.type('验收批注：这段要改。')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(600)
    const cmts = await page.evaluate(() => window.__db.reviews['/tmp/烟测方案.md'].comments.length)
    ok('G9b 批注落盘到后端', cmts >= 1, 'comments=' + cmts)
    ok('G9c 右栏出现批注卡', (await page.locator('.dr-card, [data-cid]').count()) >= 1)
  } else ok('G9b 批注输入框出现', false, 'no textarea')
}

console.log('\n[G3] 全程零视觉提示（编辑中复查；live 渲染行同样无框无底）')
await clickInto(20, 0.5)
const g3 = await page.evaluate(() => {
  const el = document.querySelector('.tl-raw') || document.querySelector('.dr-editor-host .tl:hover') || (document.activeElement && document.activeElement.querySelector('.tl[data-mode]'))
  const host = document.querySelector('.dr-editor-host')
  if (!el || !host) return null
  const cs = getComputedStyle(el), hs = getComputedStyle(host)
  return { bw: cs.borderTopWidth, bg: cs.backgroundColor, box: cs.boxShadow, hostOutline: hs.outlineWidth, hostBox: hs.boxShadow }
})
ok('G3a 编辑行/宿主无框无底', g3 && g3.bw === '0px' && g3.bg === 'rgba(0, 0, 0, 0)' && g3.hostOutline === '0px' && g3.hostBox === 'none', JSON.stringify(g3))
await page.screenshot({ path: '.artifacts/client-g3.png' })

console.log('\n[Gh] 标题/引用行编辑态保持原视觉（Typora 口径）')
await page.evaluate(() => document.querySelector('.dr-editor-host').blur())
await page.waitForTimeout(200)
const hBefore = await page.evaluate(() => {
  const el = document.querySelector('.tl[data-ls="1"]')
  const cs = getComputedStyle(el)
  return { size: cs.fontSize, weight: cs.fontWeight }
})
await clickInto(1, 0.5)
const hAfter = await page.evaluate(() => {
  const el = document.querySelector('.tl[data-ls="1"]')
  const cs = getComputedStyle(el)
  return { size: cs.fontSize, weight: cs.fontWeight, cls: el.className, text: el.textContent.slice(0, 10) }
})
ok('Gh1 标题编辑态保持字号', hBefore.size === hAfter.size, JSON.stringify({ hBefore, hAfter }))
ok('Gh2 标题编辑态保持字重', hBefore.weight === hAfter.weight)
ok('Gh3 标题编辑态保持渲染（无 ##、保留标题类）', hAfter.cls.includes('tl-h') && !hAfter.text.includes('##'), hAfter.cls)
await clickInto(3, 0.5)
await page.waitForTimeout(250)
const liQ = await findLine('如果你只有五分钟')
await clickInto(liQ, 0.4)
ok('Gh4 引用行编辑态保留 tl-quote 类', (await page.evaluate((li) => document.querySelector('.tl[data-ls="' + li + '"]').className, liQ)).includes('tl-quote'))
await page.evaluate(() => document.querySelector('.dr-editor-host').blur())
await page.waitForTimeout(200)

console.log('\n[G+] 方向键跨行 + 表格点入')
await clickInto(20, 0.5)
await page.keyboard.press('ArrowUp')
await page.waitForTimeout(200)
ok('G+d 方向键进入上一行转 raw', (await modeOf(19)) === 'raw' || (await modeOf(18)) === 'raw')
const tbl = await page.locator('.tl-table').first()
if (await tbl.count()) {
  // 点左上（表头行）——落分隔行会把它改坏，表格语法失效就不是表格了
  const tb = await tbl.boundingBox()
  await page.mouse.click(tb.x + 20, tb.y + tb.height * 0.25)
  await page.waitForTimeout(250)
  const tLines = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.dr-editor-host .tl')].filter(e => (e.textContent || '').includes('列甲') || (e.textContent || '').includes('值一'))
    return els.length
  })
  ok('G+t 表格点入转 raw 行可编辑', tLines >= 1, 'table lines=' + tLines)
  await page.keyboard.type('X')
  await page.waitForTimeout(900)
  const tblChanged = (await dbMd()).split('\n').some(l => l.includes('|') && l.includes('X'))
  ok('G+t2 表格行编辑落盘', tblChanged, JSON.stringify((await dbMd()).split('\n').filter(l => l.includes('|')).join(' / ')))
  // 离开表格块 → 重新渲染回真表格（tableOpen 必须释放）
  const box20 = await lineEl(20).boundingBox()
  await page.mouse.click(box20.x + box20.width * 0.5, box20.y + box20.height / 2)
  await page.waitForTimeout(300)
  ok('G+t3 离开后重新渲染成表格', (await page.locator('.tl-table').count()) === 1)
  ok('G+t4 编辑内容保留在表格里', await page.evaluate(() => {
    const t = document.querySelector('.tl-table'); return !!(t && t.textContent.includes('X'))
  }))
}

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail) { console.log('失败清单：\n' + fails.map(f => '  - ' + f).join('\n')); process.exit(1) }
await browser.close()
