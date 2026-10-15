#!/usr/bin/env python3
"""UI acceptance harness for lib/client.js (browser half), headless Chromium.

  python3 test/ui-harness/run.py --theme dark --width 900 --scenario default
  python3 test/ui-harness/run.py --all            # every scenario x light/dark x 900/1400

Scenarios: default, float-scroll, undo-delete, mac-placeholder, narrow, contrast
Screenshots: /tmp/dr-harness/<scenario>-<theme>-<width>.png
Exit code: 0 when every assertion passed and no console errors were seen.

Nothing is installed or downloaded: python playwright + its cached Chromium, React 18 UMD
from the local pnpm store (override with DR_REACT_UMD / DR_REACT_DOM_UMD), client.js is
read live from lib/ on every run.
"""
import argparse, base64, glob, json, os, sys, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = '/tmp/dr-harness'
ORIGIN = 'http://harness.local'
SCENARIOS = ['default', 'float-scroll', 'undo-delete', 'mac-placeholder', 'narrow', 'contrast']
THEMES = ['light', 'dark']
WIDTHS = [900, 1400]
HEIGHT = 820
UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'


# ---------------------------------------------------------------- assets
def pnpm_umd(pkg, ver, rel):
    """Resolve a file inside a package from the pnpm v10 content-addressed store."""
    store = os.path.expanduser('~/Library/pnpm/store/v10')
    for idx in glob.glob(os.path.join(store, 'index', '*', '*-%s@%s.json' % (pkg, ver))):
        files = json.load(open(idx)).get('files', {})
        if rel in files:
            hexd = base64.b64decode(files[rel]['integrity'].split('-', 1)[1]).hex()
            p = os.path.join(store, 'files', hexd[:2], hexd[2:])
            if os.path.exists(p):
                return p
    return None


def assets():
    react = os.environ.get('DR_REACT_UMD') or pnpm_umd('react', '18.3.1', 'umd/react.production.min.js')
    dom = os.environ.get('DR_REACT_DOM_UMD') or pnpm_umd('react-dom', '18.3.1', 'umd/react-dom.production.min.js')
    if not react or not dom:
        sys.exit('React 18 UMD not found in ~/Library/pnpm/store/v10; set DR_REACT_UMD / DR_REACT_DOM_UMD')
    return {
        '/harness.html': (os.path.join(HERE, 'harness.html'), 'text/html'),
        '/theme.css': (os.path.join(HERE, 'theme.css'), 'text/css'),
        '/client.js': (os.environ.get('DR_CLIENT') or os.path.join(ROOT, 'lib', 'client.js'), 'application/javascript'),
        '/vendor/react.js': (react, 'application/javascript'),
        '/vendor/react-dom.js': (dom, 'application/javascript'),
    }


# ---------------------------------------------------------------- run context
class Run:
    def __init__(self, scenario, theme, width):
        self.scenario, self.theme, self.width = scenario, theme, width
        self.results = []      # (ok, label, detail)
        self.errors = []       # console errors / page errors / bad requests
        self.tables = []       # contrast rows
        self.shots = []

    def check(self, ok, label, detail=''):
        self.results.append((bool(ok), label, detail))
        return bool(ok)

    @property
    def tag(self):
        return '%s-%s-%d' % (self.scenario, self.theme, self.width)

    def shot(self, page, suffix=''):
        os.makedirs(OUT, exist_ok=True)
        p = os.path.join(OUT, self.tag + (('-' + suffix) if suffix else '') + '.png')
        page.screenshot(path=p)
        self.shots.append(p)
        return p


def open_page(browser, run, files, ua=None, platform=None, box_w=0, fixture='default'):
    ctx = browser.new_context(
        viewport={'width': run.width, 'height': HEIGHT}, device_scale_factor=1,
        user_agent=ua or UA_WIN, locale='zh-CN', timezone_id='Asia/Shanghai',
        color_scheme='dark' if run.theme == 'dark' else 'light',
    )
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=ORIGIN)
    # client.js reads userAgentData.platform first; the host Chromium is macOS, so pin it
    plat = platform or ('MacIntel' if ua == UA_MAC else 'Win32')
    uad = 'macOS' if plat == 'MacIntel' else 'Windows'
    ctx.add_init_script(
        "Object.defineProperty(Navigator.prototype,'platform',{get:()=>%s});"
        "try{Object.defineProperty(Navigator.prototype,'userAgentData',{get:()=>({platform:%s,mobile:false,brands:[]})})}catch(e){}"
        % (json.dumps(plat), json.dumps(uad)))

    def handle(route):
        url = route.request.url
        path = url[len(ORIGIN):].split('?', 1)[0]
        if path in files:
            fp, ctype = files[path]
            route.fulfill(status=200, content_type=ctype + '; charset=utf-8', body=open(fp, 'rb').read())
        else:
            run.errors.append('unexpected request: ' + url)
            route.fulfill(status=404, body='')
    ctx.route(ORIGIN + '/**', handle)
    ctx.route(lambda u: not u.startswith(ORIGIN), lambda r: (run.errors.append('external request: ' + r.request.url), r.abort()))

    page = ctx.new_page()
    page.set_default_timeout(4000)   # a missing element should fail fast, not hang 30s
    page.on('console', lambda m: m.type == 'error' and run.errors.append('console.error: ' + m.text))
    page.on('pageerror', lambda e: run.errors.append('pageerror: ' + str(e)))
    q = 'theme=%s&fixture=%s%s' % (run.theme, fixture, ('&w=%d' % box_w) if box_w else '')
    page.goto(ORIGIN + '/harness.html?' + q)
    page.wait_for_function('window.__harness && window.__harness.ready')
    page.wait_for_selector('.dr-root', timeout=5000)
    page.wait_for_selector('.dr-doc-scroll .dr-block', timeout=5000)
    page.wait_for_selector('.dr-card', timeout=5000)
    page.wait_for_timeout(150)
    return ctx, page


# ---------------------------------------------------------------- helpers in page
SELECT_JS = """(needle) => {
  const root = document.querySelector('.dr-doc-scroll')
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let n
  while ((n = w.nextNode())) {
    const i = n.data.indexOf(needle)
    if (i < 0) continue
    n.parentElement.scrollIntoView({ block: 'center' })
    const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length)
    const s = getSelection(); s.removeAllRanges(); s.addRange(r)
    const b = r.getBoundingClientRect()
    n.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: b.right, clientY: b.bottom }))
    return true
  }
  return false
}"""


SET_VALUE_JS = """(sel, val) => {
  const t = document.querySelector(sel)
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(t, val)
  t.dispatchEvent(new Event('input', { bubbles: true }))
  return t.value
}"""


def float_state(page):
    return page.evaluate("""() => { const f = document.querySelector('.dr-root ~ .dr-float, .dr-root .dr-float, .dr-float');
      const t = f && f.querySelector('.dr-float-input');
      return { open: !!f, value: t ? t.value : null } }""")


# ---------------------------------------------------------------- scenarios
def sc_default(browser, run, files):
    ctx, page = open_page(browser, run, files)
    c = page.evaluate("""() => ({
      cols: ['.dr-col-docs', '.dr-col-doc', '.dr-col-notes'].map(s => { const e = document.querySelector(s); const r = e && e.getBoundingClientRect(); return { s, w: r ? Math.round(r.width) : 0, vis: !!(e && e.getClientRects().length) } }),
      table: document.querySelectorAll('.dr-doc-scroll table.dr-table td').length,
      pre: document.querySelectorAll('.dr-doc-scroll pre.dr-pre').length,
      li: document.querySelectorAll('.dr-doc-scroll .dr-ul li').length,
      cards: document.querySelectorAll('.dr-card').length,
      props: document.querySelectorAll('.dr-prop').length,
      inlineProp: document.querySelectorAll('.dr-block-pending').length,
      title: (document.querySelector('.dr-title') || {}).textContent,
      style: !!document.getElementById('dsh-doc-review-style'),
      slots: Object.fromEntries(Object.entries(__harness.registry).map(([k, v]) => [k, v.length])),
    })""")
    run.check(c['style'], 'style tag injected')
    run.check(c['slots'].get('conversation.view') == 1 and c['slots'].get('shell.overlay') == 1, 'both slots registered', json.dumps(c['slots']))
    doc_col = c['cols'][1]
    run.check(doc_col['vis'] and doc_col['w'] >= 320, 'doc column visible and >=320px', 'w=%d' % doc_col['w'])
    run.check(c['cols'][2]['vis'], 'notes column visible', 'w=%d' % c['cols'][2]['w'])
    if run.width >= 1400:
        run.check(c['cols'][0]['vis'], 'docs column visible at 1400', 'w=%d' % c['cols'][0]['w'])
    run.check(c['table'] == 9, 'table rendered (9 td)', str(c['table']))
    run.check(c['pre'] == 1, 'code block rendered', str(c['pre']))
    run.check(c['li'] == 3, 'list rendered (3 li)', str(c['li']))
    run.check(c['cards'] == 2, '2 comment cards', str(c['cards']))
    run.check(c['props'] == 1 and c['inlineProp'] >= 1, '1 pending proposal (panel + inline)', 'panel=%d inline=%d' % (c['props'], c['inlineProp']))
    run.check(c['title'] == '批注台-v0.8-方案.md', 'lastDoc auto-opened', c['title'] or '')
    run.shot(page)
    ctx.close()


def sc_float_scroll(browser, run, files):
    ctx, page = open_page(browser, run, files)
    needle = '路径归一'
    run.check(page.evaluate(SELECT_JS, needle), 'selected text in doc')
    try:
        page.wait_for_selector('.dr-float .dr-float-input', timeout=2000)
    except Exception:
        pass
    run.check(float_state(page)['open'], 'float box opened on selection')
    if not float_state(page)['open']:
        run.shot(page); ctx.close(); return
    lines = ['第 %d 行：草稿内容' % i for i in range(1, 6)]
    draft = '\n'.join(lines)
    ta = page.locator('.dr-float .dr-float-input')
    ta.click()
    page.keyboard.type(draft)
    run.check(float_state(page)['value'] == draft, 'typed 5 lines', repr(float_state(page)['value'])[:60])
    # scroll inside the box
    box = ta.bounding_box()
    page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    page.mouse.wheel(0, 200)
    page.evaluate("() => { const t = document.querySelector('.dr-float-input'); t.scrollTop = t.scrollHeight; t.dispatchEvent(new Event('scroll', { bubbles: false })) }")
    page.wait_for_timeout(200)
    st = float_state(page)
    run.check(st['open'] and st['value'] == draft, 'scroll inside box: box kept, draft intact')
    # scroll the document body
    page.evaluate("() => { const d = document.querySelector('.dr-doc-scroll'); d.scrollTop += 400 }")
    db = page.locator('.dr-doc-scroll').bounding_box()
    page.mouse.move(db['x'] + 40, db['y'] + db['height'] - 40)
    page.mouse.wheel(0, 300)
    page.wait_for_timeout(250)
    st = float_state(page)
    run.check(st['open'] and st['value'] == draft, 'scroll doc body: box kept, draft intact')
    run.shot(page, 'scrolled')
    # single click in the body (collapsed selection)
    page.mouse.click(db['x'] + 60, db['y'] + db['height'] - 60)
    page.wait_for_timeout(250)
    st = float_state(page)
    run.check(st['open'] and st['value'] == draft, 'click in doc body: box kept, draft intact')
    # Esc closes, draft kept for re-selection
    page.locator('.dr-float .dr-float-input').focus()
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)
    run.check(not float_state(page)['open'], 'Esc closes the box')
    page.evaluate(SELECT_JS, needle)
    page.wait_for_timeout(250)
    st = float_state(page)
    run.check(st['open'] and st['value'] == draft, 're-select same text: draft restored', repr(st['value'])[:60])
    run.shot(page)
    ctx.close()


def sc_undo_delete(browser, run, files):
    ctx, page = open_page(browser, run, files)
    ids = lambda: page.evaluate("() => [...document.querySelectorAll('.dr-card .dr-card-quote')].map(e => e.textContent)")
    before = ids()
    run.check(len(before) == 2, '2 cards before delete', json.dumps(before, ensure_ascii=False))
    page.locator('.dr-card').first.locator('.dr-btn-del').click()
    page.wait_for_timeout(200)
    run.check(len(ids()) == 1, 'card removed after ✕')
    undo = page.locator('.dr-undo button', has_text='撤销')
    has_undo = undo.count() == 1
    run.check(has_undo, '.dr-undo shows 「撤销」')
    run.shot(page, 'undo-offered')
    if has_undo:
        undo.click()
        page.wait_for_timeout(300)
        after = ids()
        run.check(after == before, 'card back in original position', json.dumps(after, ensure_ascii=False))
        last = page.evaluate("() => __harness.lastCall('save')")
        got = [c.get('id') for c in ((last or {}).get('body') or {}).get('comments', [])]
        run.check('c-float' in got, 'last /save contains restored comment', json.dumps(got))
        run.check(page.locator('.dr-undo').count() == 0, 'undo bar gone after undo')
    run.shot(page)
    ctx.close()


def sc_mac_placeholder(browser, run, files):
    for ua, plat, want, label in ((UA_MAC, 'MacIntel', '⌘', 'Mac'), (UA_WIN, 'Win32', 'Ctrl+Enter', 'Windows')):
        ctx, page = open_page(browser, run, files, ua=ua, platform=plat)
        ph = page.evaluate("() => { const t = document.querySelector('.dr-global textarea'); return t ? t.placeholder : null }")
        run.check(ph is not None and want in ph, '%s UA: global placeholder contains %s' % (label, want), ph or 'missing')
        page.evaluate(SELECT_JS, '路径归一')
        page.wait_for_timeout(250)
        fph = page.evaluate("() => { const t = document.querySelector('.dr-float-input'); return t ? t.placeholder : null }")
        run.check(fph is not None and want in fph, '%s UA: float placeholder contains %s' % (label, want), fph or 'missing')
        if label == 'Mac':
            run.check(fph is not None and 'Ctrl' not in fph, 'Mac UA: no "Ctrl" in float placeholder', fph or '')
            run.shot(page)
        ctx.close()


def sc_narrow(browser, run, files):
    ctx, page = open_page(browser, run, files, box_w=800)
    m = page.evaluate("""() => {
      const vis = s => { const e = document.querySelector(s); return !!(e && e.getClientRects().length && getComputedStyle(e).display !== 'none') }
      const w = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().width) : 0 }
      return { box: w('#view'), docs: vis('.dr-col-docs'), toggle: vis('.dr-docs-toggle'), doc: w('.dr-col-doc'), notes: w('.dr-col-notes'),
               overflow: document.querySelector('.dr-root').scrollWidth - document.querySelector('.dr-root').clientWidth }
    }""")
    run.check(m['box'] == 800, 'container is 800px', str(m['box']))
    run.check(not m['docs'], '.dr-col-docs hidden')
    run.check(m['toggle'], '.dr-docs-toggle visible')
    run.check(m['doc'] >= 320, '.dr-col-doc >= 320px', 'w=%d notes=%d' % (m['doc'], m['notes']))
    run.check(m['overflow'] <= 0, 'no horizontal overflow in .dr-root', 'overflow=%dpx' % m['overflow'])
    run.shot(page)
    if m['toggle']:
        page.locator('.dr-docs-toggle').click()
        page.wait_for_timeout(150)
        run.check(page.evaluate("() => !!document.querySelector('.dr-col-docs').getClientRects().length"), 'toggle opens docs drawer')
        run.shot(page, 'drawer')
    ctx.close()


CONTRAST_TARGETS = [
    # (selector, pseudo, min ratio, label)
    ('.dr-prop-new', None, 4.5, 'proposal new text'),
    ('.dr-prop-old', None, 4.5, 'proposal old text'),
    ('.dr-btn-on', None, 4.5, 'toggle button on'),
    ('.dr-chip-warn', None, 4.5, 'chip warn (文档已改动)'),
    ('.dr-status-orphan', None, 4.5, 'status orphan (已失锚)'),
    ('.dr-msg:not(.dr-msg-warn)', None, 4.5, 'msg ok'),
    ('.dr-msg-warn', None, 4.5, 'msg warn'),
    ('.dr-global textarea', '::placeholder', 3.0, 'placeholder (global textarea)'),
    ('.dr-float-input', '::placeholder', 3.0, 'placeholder (float input)'),
]


def measure(page, run, sel, pseudo, need, label):
    r = page.evaluate("([s, p]) => { const e = document.querySelector(s); return e ? __harness.contrastOf(e, p) : null }", [sel, pseudo])
    if not r or not r['visible']:
        run.check(False, 'contrast %s: element present' % label, sel + ' not found/visible')
        return
    ok = r['ratio'] >= need
    run.tables.append((run.theme, label, sel + (pseudo or ''), r['ratio'], need, r['fg'], r['bg'], ok))
    run.check(ok, 'contrast %s >= %.1f' % (label, need), '%.2f fg=%s bg=%s (%s)' % (r['ratio'], r['fg'], r['bg'], r['rawColor']))


def sc_contrast(browser, run, files):
    ctx, page = open_page(browser, run, files, fixture='rich')
    # ok message: 「复制指令」 -> note('指令已复制。')
    page.locator('.dr-toolbar button', has_text='复制指令').click()
    page.wait_for_selector('.dr-msg', timeout=2000)
    if not page.evaluate("() => !!document.querySelector('.dr-btn-on')?.getClientRects().length"):
        page.locator('.dr-docs-toggle').click()      # narrow: docs column lives in a drawer
        page.wait_for_timeout(150)
    for t in CONTRAST_TARGETS[:6]:
        measure(page, run, *t)
    measure(page, run, *CONTRAST_TARGETS[7])
    run.shot(page)
    # float placeholder (empty draft), then warn message via Esc with a draft
    # scroll first, then select: selecting triggers scrollIntoView, and an empty float
    # is dismissed on scroll by design — so the needle must already be in view
    page.evaluate(SELECT_JS, '路径归一')
    page.wait_for_timeout(120)
    page.evaluate(SELECT_JS, '路径归一')
    page.wait_for_selector('.dr-float-input', timeout=2000)
    measure(page, run, *CONTRAST_TARGETS[8])
    # Playwright's keyboard.type doesn't reach this textarea (a page-level key handler
    # swallows it), so drive React's own value setter and fire a real input event
    page.evaluate(SET_VALUE_JS, ['.dr-float-input', 'x'])
    page.keyboard.press('Escape')
    try:
        page.wait_for_selector('.dr-msg-warn', timeout=1500)
    except Exception:
        pass
    measure(page, run, *CONTRAST_TARGETS[6])
    ctx.close()


FUNCS = {'default': sc_default, 'float-scroll': sc_float_scroll, 'undo-delete': sc_undo_delete,
         'mac-placeholder': sc_mac_placeholder, 'narrow': sc_narrow, 'contrast': sc_contrast}


# ---------------------------------------------------------------- main
def execute(browser, files, scenario, theme, width, quiet=False):
    run = Run(scenario, theme, width)
    try:
        FUNCS[scenario](browser, run, files)
    except Exception as e:
        run.check(False, 'scenario raised', '%s: %s' % (type(e).__name__, str(e).splitlines()[0][:200]))
    run.check(not run.errors, 'no console errors', '; '.join(run.errors)[:400])
    ok = all(r[0] for r in run.results)
    if not quiet:
        print('== %s  %s' % (run.tag, 'PASS' if ok else 'FAIL'))
        for good, label, detail in run.results:
            print('  %s %s%s' % ('ok  ' if good else 'FAIL', label, ('  [' + detail + ']') if detail else ''))
        for e in run.errors:
            print('  console: ' + e)
        for p in run.shots:
            print('  screenshot: ' + p)
    return run, ok


def print_contrast(runs):
    rows = [t for r in runs for t in r.tables]
    if not rows:
        return
    seen, uniq = set(), []
    for t in rows:
        k = (t[0], t[2])
        if k not in seen:
            seen.add(k); uniq.append(t)
    print('\n== contrast (WCAG 2.x, composited on opaque ancestors)')
    print('  %-5s %-34s %6s %5s  %-8s %-8s' % ('theme', 'target', 'ratio', 'min', 'fg', 'bg'))
    for theme, label, sel, ratio, need, fg, bg, ok in uniq:
        print('  %-5s %-34s %6.2f %5.1f  %-8s %-8s %s' % (theme, label[:34], ratio, need, fg, bg, '' if ok else '<-- FAIL'))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--theme', choices=THEMES, default='light')
    ap.add_argument('--width', type=int, choices=WIDTHS, default=1400)
    ap.add_argument('--scenario', choices=SCENARIOS, default='default')
    ap.add_argument('--all', action='store_true', help='full matrix: all scenarios x themes x widths')
    ap.add_argument('--headed', action='store_true')
    a = ap.parse_args()
    files = assets()
    for p, _ in files.values():
        if not os.path.exists(p):
            sys.exit('missing asset: ' + p)
    combos = [(s, t, w) for s in SCENARIOS for t in THEMES for w in WIDTHS] if a.all else [(a.scenario, a.theme, a.width)]
    runs, failed = [], []
    t0 = time.time()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not a.headed)
        for s, t, w in combos:
            run, ok = execute(browser, files, s, t, w)
            runs.append(run)
            if not ok:
                failed.append(run)
        browser.close()
    print_contrast(runs)
    print('\n== %d/%d runs passed in %.1fs' % (len(runs) - len(failed), len(runs), time.time() - t0))
    for r in failed:
        for good, label, detail in r.results:
            if not good:
                print('  FAIL %-28s %s%s' % (r.tag, label, ('  [' + detail + ']') if detail else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
