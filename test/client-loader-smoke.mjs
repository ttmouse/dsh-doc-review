/**
 * 浏览器半边加载契约烟测：用假 window.__ModuleLoader__ + 假 React，
 * 验证新增的 AI 审查组件能被加载、只依赖 react、且每个导出都能渲染出元素。
 * 运行：node test/client-loader-smoke.mjs
 * 覆盖：lib/ai-review-hero.js、lib/ai-review-preview.js
 *
 * 为什么需要它：这两个文件走 __ModuleLoader__ 协议（不是 Node ESM/CJS），
 * 语法检查 node --check 只能验语法、验不出「变量名写错」这类运行期错误
 * （v0.8 就曾出现 outline: focus ? ... 引用了不存在的变量 focus）。
 */
const loaded = []

// 假 React：useState 直接返回初值 + 空 setter，足够把组件函数跑一遍
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}

global.window = {
  __ModuleLoader__: { load: (entry) => { loaded.push(entry) } },
}

const ROOT = new URL('../lib/', import.meta.url).pathname
await import(ROOT + 'ai-review-hero.js')
await import(ROOT + 'ai-review-preview.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

console.log('\n[1] 模块注册')
ok('两个模块都注册进 __ModuleLoader__', loaded.length === 2, 'got ' + loaded.length)
const ids = loaded.map((e) => e.id)
ok('id 正确',
  ids.includes('@caihua/dsh-doc-review/ai-review-hero') && ids.includes('@caihua/dsh-doc-review/ai-review-preview'),
  ids.join(', '))

console.log('\n[2] factory 契约与渲染')
for (const entry of loaded) {
  const ex = entry.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
  ok(entry.id + ' 只依赖 react 且导出成功', ex && typeof ex === 'object', String(ex))
  const names = Object.keys(ex)
  ok(entry.id + ' 有导出组件', names.length > 0, names.join(','))

  for (const k of names) {
    if (typeof ex[k] !== 'function') { ok(entry.id + '.' + k + ' 是组件函数', false, typeof ex[k]); continue }
    try {
      let out
      if (k === 'FeatureCard') out = ex[k]({ card: { key: 'x', step: '01', title: 'T', body: 'B' } })
      else if (k === 'BrandButton' || k === 'GhostButton') out = ex[k]({ children: 'go' })
      else out = ex[k]({})
      ok(entry.id + '.' + k + ' 可渲染', !!out && !!out.type, JSON.stringify(out).slice(0, 80))
    } catch (e) {
      ok(entry.id + '.' + k + ' 可渲染', false, e.message)
    }
  }
}

console.log('\n[3] 设计系统合规')
const fsp = await import('node:fs').then((m) => m.promises)
const heroSrc = await fsp.readFile(ROOT + 'ai-review-hero.js', 'utf8')
const prevSrc = await fsp.readFile(ROOT + 'ai-review-preview.js', 'utf8')

// 只检查「用户可见文案」里的 em-dash：文件头注释沿用仓库既有分隔符约定（同 client.js 首行），不算违规。
// 做法：抽出所有单引号/双引号字符串字面量，跳过纯 ASCII 标点/路径/字体栈，再看有没有 U+2014。
function userFacingStrings(src) {
  const out = []
  const re = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g
  let m
  while ((m = re.exec(src))) {
    const s = m[1] !== undefined ? m[1] : m[2]
    if (/[\u4e00-\u9fff]/.test(s)) out.push(s) // 含中文的才算文案
  }
  return out
}

for (const [label, src] of [['hero', heroSrc], ['preview', prevSrc]]) {
  ok(label + ' 用 Inter Variable 字体栈', /Inter Variable/.test(src))
  ok(label + ' 启用 OpenType cv01/ss03', /cv01/.test(src) && /ss03/.test(src))
  const bad = userFacingStrings(src).filter((s) => s.includes('\u2014'))
  ok(label + ' 用户可见文案无 em-dash（Pre-Flight）', bad.length === 0, bad.join(' | ').slice(0, 120))
  ok(label + ' 用户可见文案非空', userFacingStrings(src).length > 0, 'found ' + userFacingStrings(src).length)
}

console.log('\n结果：pass=' + pass + ' fail=' + fail)
process.exitCode = fail ? 1 : 0
