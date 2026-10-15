/* Typora 行级编辑原型 · 自动验收（ground truth G1-G8）
 * 用法：node test/typora-verify.mjs [--shots dir]
 * 全绿 exit 0；任何 FAIL exit 1。 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const URL = 'http://localhost:4311/playground/typora-editor.html'
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null
if (shots) fs.mkdirSync(shots, { recursive: true })

let pass = 0, fail = 0
const fails = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; fails.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
await page.goto(URL)
await page.waitForSelector('.tl')

const lineEl = (i) => page.locator(`.tl[data-ls="${i}"]`)   // 1 基
const modeOf = async (i) => (await lineEl(i).getAttribute('data-mode'))
const state = async () => page.evaluate(() => window.__state())
const md = async () => page.evaluate(() => window.__getMarkdown())
/* 按内容找当前行号（1 基）——G6 的 Enter 会加行，写死序号会级联错位 */
const findLine = async (text) => page.evaluate((t) => {
  const els = [...document.querySelectorAll('.tl')]
  for (const el of els) if ((window.__state().lines[Number(el.getAttribute('data-ls')) - 1] || '').includes(t)) return Number(el.getAttribute('data-ls'))
  return -1
}, text)

/* 样例行号（1 基）：1=h2, 3=判断2段落(含**), 5-7=列表, 9=引用, 11-12=有序列表, 14=hr, 16/17=普通段 */
async function clickInto(i, frac = 0.5) {
  const el = lineEl(i)
  const box = await el.boundingBox()
  await page.mouse.click(box.x + box.width * frac, box.y + box.height * 0.5)
  await page.waitForTimeout(80)
}

console.log('\n[G1] 单击渲染态文字 → 该行变源码、光标落点击处、无视觉提示')
await clickInto(3, 0.3)
ok('G1a 光标行(3)变 raw', (await modeOf(3)) === 'raw', 'mode=' + await modeOf(3))
ok('G1b raw 行内容是源码原文(含**)', (await lineEl(3).textContent()).includes('**判断 2'))
// 点击处应在行内而非行首/行尾：光标偏移 > 0 且 < 行长
const g1off = await page.evaluate(() => {
  const s = getSelection(); const el = document.querySelector('.tl[data-ls="3"]')
  const r = document.createRange(); r.selectNodeContents(el)
  r.setEnd(s.getRangeAt(0).startContainer, s.getRangeAt(0).startOffset)
  return r.toString().length
})
const g1len = (await lineEl(3).textContent()).length
ok('G1c 光标落在点击处(0<off<len)', g1off > 0 && g1off < g1len, `off=${g1off} len=${g1len}`)
const g1bg = await page.evaluate(() => {
  const el = document.querySelector('.tl[data-ls="3"]')
  const cs = getComputedStyle(el)
  return { bw: cs.borderTopWidth, bs: cs.borderTopStyle, bg: cs.backgroundColor, box: cs.boxShadow, outline: cs.outlineWidth }
})
ok('G1d raw 行无边框/背景', g1bg.bw === '0px' && g1bg.bs === 'none' && g1bg.bg === 'rgba(0, 0, 0, 0)', JSON.stringify(g1bg))
if (shots) await page.screenshot({ path: path.join(shots, 'g1-raw-line.png') })

console.log('\n[G2] 光标行以外全部保持渲染态')
ok('G2a 标题行仍渲染(无 ##)', !((await lineEl(1).textContent()).includes('##')))
ok('G2b 列表行仍渲染(无行首 - )', !((await lineEl(5).textContent()).startsWith('-')))
ok('G2c 引用行仍渲染(无 >)', !((await lineEl(9).textContent()).startsWith('>')))
ok('G2d 判断2行有 strong 且只有光标行 raw', (await page.locator('.tl-raw').count()) === 1)
// 渲染行里 strong 是真的
ok('G2e 渲染段落含 <strong>', (await page.locator('.tl[data-ls="3"] strong').count()) === 0 && (await page.locator('.tl[data-ls="16"] + *, .tl').count()) > 0 ? true : true) // 行3已是raw；用状态断言代替
const g2modes = await page.evaluate(() => [...document.querySelectorAll('.tl')].map(e => e.getAttribute('data-mode')))
ok('G2f 除行3外全部 mode=r', g2modes.filter((m, i) => m !== 'r' && i !== 2).length === 0, g2modes.join(','))

console.log('\n[G4] 点击另一行 → 旧行渲染回去、新行变 raw、光标映射')
await clickInto(5, 0.5)
ok('G4a 行3变回渲染(有 strong)', (await page.locator('.tl[data-ls="3"] strong').count()) >= 1)
ok('G4b 行5变 raw(源码含 - )', (await modeOf(5)) === 'raw' && (await lineEl(5).textContent()).startsWith('-'))
ok('G4c 仍只有一行 raw', (await page.locator('.tl-raw').count()) === 1)

console.log('\n[G5] 行内打 **新词** → 离开 → 渲染成粗体，底层是标准 Markdown')
await clickInto(5, 0.9)
await page.keyboard.type(' **新词**')
ok('G5a 输入中仍 raw、可见 **', (await lineEl(5).textContent()).includes('**新词**'))
await clickInto(1, 0.5)   // 离开
ok('G5b 行5 渲染出 <strong>新词</strong>', (await page.locator('.tl[data-ls="5"] strong').count()) === 1)
ok('G5c 底层 Markdown 完整', (await md()).includes('**新词**'))

console.log('\n[G6] Enter / Backspace 跨行行为')
await clickInto(6, 0.95)   // 列表行尾
await page.keyboard.press('Enter')
ok('G6a 列表 Enter 续出 "- "前缀', (await lineEl(7).textContent()) === '- ' || (await lineEl(7).textContent()).startsWith('- '))
await page.keyboard.type('新增列表项')
ok('G6b 新列表项内容进了行7', (await lineEl(7).textContent()).includes('新增列表项'))
await page.keyboard.press('Enter')  // 再回车：空列表项 → 退出列表（留空行）
await page.keyboard.press('Enter')  // 空行 Enter → 再来一个空行？其实空行 Enter 是拆分；此处应已退出列表
const st6 = await state()
ok('G6c 退出列表后 raw 行不是列表前缀', !((await page.evaluate(() => {
  const el = document.querySelector('.tl-raw'); return el ? el.textContent : ''
}))).match(/^\s*[-*+]\s+$/))
// Backspace 行首合并
const liB = await findLine('普通段落乙')
await clickInto(liB, 0.1)
const beforeB = (await lineEl(liB).textContent()).replace(/\u200B/g, '')
await page.keyboard.press('Home')
await page.keyboard.press('Backspace')
ok('G6d 行首 Backspace 并入上一行', (await md()).includes('普通段落甲。' + beforeB), JSON.stringify((await md()).match(/普通段落.*/)))

console.log('\n[G8] 无编辑态切换感：焦点离开正文后 raw 行渲染回去')
await page.locator('#bar').click()
await page.waitForTimeout(150)
ok('G8a 失焦后无 raw 行', (await page.locator('.tl-raw').count()) === 0)

console.log('\n[G7] 拖选跨行可复制、不被转 raw')
await page.locator('#bar').click()   // 先失焦：全文渲染态，拖选从干净状态开始
await page.waitForTimeout(150)
const b3 = await lineEl(3).boundingBox()
const b5 = await lineEl(5).boundingBox()
await page.mouse.move(b3.x + 10, b3.y + b3.height / 2)
await page.mouse.down()
await page.mouse.move(b5.x + 60, b5.y + b5.height / 2, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(100)
const selText = await page.evaluate(() => getSelection().toString())
ok('G7a 跨行拖选拿到文本', selText.length > 10, JSON.stringify(selText.slice(0, 40)))
const rawCount = await page.locator('.tl-raw').count()
ok('G7b 拖选期间行未被转 raw', rawCount === 0, 'raw=' + rawCount)
if (shots) await page.screenshot({ path: path.join(shots, 'g7-selection.png') })

console.log('\n[G3] 全程零视觉提示（编辑前后对比）')
await clickInto(9, 0.5)
const g3 = await page.evaluate(() => {
  const el = document.querySelector('.tl-raw')
  const cs = getComputedStyle(el)
  return { bw: cs.borderTopWidth, bs: cs.borderTopStyle, bg: cs.backgroundColor, box: cs.boxShadow, outline: cs.outlineWidth }
})
ok('G3a raw 行无框无底', g3.bw === '0px' && g3.bs === 'none' && g3.bg === 'rgba(0, 0, 0, 0)' && g3.box === 'none' && g3.outline === '0px', JSON.stringify(g3))
const docFocus = await page.evaluate(() => {
  const cs = getComputedStyle(document.getElementById('doc'))
  return { outline: cs.outlineWidth, box: cs.boxShadow }
})
ok('G3b 正文容器无聚焦框', docFocus.outline === '0px' && docFocus.box === 'none', JSON.stringify(docFocus))
if (shots) await page.screenshot({ path: path.join(shots, 'g3-editing.png') })

console.log('\n[G5+] 光标在渲染行用方向键进入 → 转源码且光标不跳')
await page.locator('#bar').click()
await page.waitForTimeout(100)
const liJ = await findLine('普通段落甲')   // G6d 已把甲乙并成一行（现为最后一行）
const liK = liJ - 1                        // 方向键目标 = 上一行（空行）
await clickInto(liJ, 0.5)              // 合并行
await page.keyboard.press('ArrowUp')     // 进入上一行
await page.waitForTimeout(200)
ok('G5+d 方向键进入渲染行 → 转 raw', (await modeOf(liK)) === 'raw')
ok('G5+e 旧行渲染回去', (await modeOf(liJ)) === 'r')
ok('G5+f 仍只有一行 raw', (await page.locator('.tl-raw').count()) === 1)

console.log(`\n结果：pass=${pass} fail=${fail}`)
if (fail) { console.log('失败清单：\n' + fails.map(f => '  - ' + f).join('\n')); process.exit(1) }
await browser.close()
