/**
 * 跨平台路径规则的纯函数断言（platform 显式注入，在任何系统上跑结果都一样）。
 * 运行：node test/path-utils.mjs
 * 背景：插件最早只在 Windows 上开发，会话转写里只认盘符路径、一律 toLowerCase；
 * macOS/Linux 上 POSIX 路径全部漏掉。这里同时钉住「POSIX 能识别」与「Windows 不回退」。
 */
import os from 'node:os'
import path from 'node:path'

// impl.js 顶层只读常量，不碰任何运行时目录；仍把 HOME/SESSIONS 顶到临时目录，防止误写真实数据
process.env.DSH_DOC_REVIEW_HOME = path.join(os.tmpdir(), 'dsh-doc-review-path-utils')
process.env.DSH_DOC_REVIEW_SESSIONS = path.join(os.tmpdir(), 'dsh-doc-review-path-utils', 'sessions')
const m = await import('../lib/impl.js')

let pass = 0, fail = 0
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n) } else { fail++; console.log('  FAIL ' + n + (x !== undefined ? ' :: ' + x : '')) } }

console.log('\n[1] isAbsDocPath — Windows（不回退）')
ok('C:\\业务\\a.md', m.isAbsDocPath('C:\\业务\\a.md', 'win32'))
ok('c:/业务/a.md（正斜杠盘符也认）', m.isAbsDocPath('c:/业务/a.md', 'win32'))
ok('POSIX 路径在 win32 上不认', !m.isAbsDocPath('/Users/x/a.md', 'win32'))
ok('相对路径不认', !m.isAbsDocPath('docs\\a.md', 'win32'))
ok('UNC 不认（与旧行为一致）', !m.isAbsDocPath('\\\\srv\\share\\a.md', 'win32'))

console.log('\n[2] isAbsDocPath — POSIX')
for (const plat of ['darwin', 'linux']) {
  ok(plat + ': /Users/douba/a.md', m.isAbsDocPath('/Users/douba/a.md', plat))
  ok(plat + ': /home/u/中文 目录/a.md', m.isAbsDocPath('/home/u/中文 目录/a.md', plat))
  ok(plat + ': 盘符路径不认', !m.isAbsDocPath('C:\\业务\\a.md', plat))
  ok(plat + ': 相对路径不认', !m.isAbsDocPath('docs/a.md', plat))
  ok(plat + ': //cdn.x/a.md 不认（协议相对 URL）', !m.isAbsDocPath('//cdn.x/a.md', plat))
  ok(plat + ': 空串不认', !m.isAbsDocPath('', plat))
}

console.log('\n[3] normDocPath')
ok('win32: / → \\（旧行为）', m.normDocPath('C:/业务/sub/a.md', 'win32') === 'C:\\业务\\sub\\a.md', m.normDocPath('C:/业务/sub/a.md', 'win32'))
ok('POSIX: 原样保留', m.normDocPath('/Users/x/a.md', 'darwin') === '/Users/x/a.md')
ok('POSIX: 文件名里的 \\ 不被改写', m.normDocPath('/tmp/a\\b.md', 'linux') === '/tmp/a\\b.md')

console.log('\n[4] pathKey / 大小写策略')
ok('win32 不区分大小写', m.caseInsensitiveFs('win32') === true)
ok('darwin 不区分大小写（APFS 默认）', m.caseInsensitiveFs('darwin') === true)
ok('linux 区分大小写', m.caseInsensitiveFs('linux') === false)
ok('win32: 大小写 + 斜杠不同 → 同一键', m.pathKey('C:\\业务\\A.md', 'win32') === m.pathKey('c:/业务/a.md', 'win32'))
ok('darwin: 大小写不同 → 同一键', m.pathKey('/Users/X/A.md', 'darwin') === m.pathKey('/users/x/a.md', 'darwin'))
ok('linux: 大小写不同 → 不同键', m.pathKey('/home/X/A.md', 'linux') !== m.pathKey('/home/x/a.md', 'linux'))
ok('linux: .. 被 resolve', m.pathKey('/home/x/sub/../a.md', 'linux') === '/home/x/a.md')

console.log('\n[5] isUnder（越界判断）')
ok('win32: 子路径（大小写不同）', m.isUnder('c:\\业务\\Sub\\a.md', 'C:\\业务', 'win32'))
ok('win32: 前缀相同的兄弟目录不算', !m.isUnder('C:\\业务2\\a.md', 'C:\\业务', 'win32'))
ok('win32: 根本身', m.isUnder('C:\\业务', 'C:\\业务\\', 'win32'))
ok('darwin: 子路径（大小写不同）', m.isUnder('/Users/Douba/doc/a.md', '/Users/douba', 'darwin'))
ok('linux: 子路径', m.isUnder('/home/u/doc/a.md', '/home/u', 'linux'))
ok('linux: 大小写不同 → 越界', !m.isUnder('/home/U/doc/a.md', '/home/u', 'linux'))
ok('linux: 前缀相同的兄弟目录不算', !m.isUnder('/home/u2/a.md', '/home/u', 'linux'))
ok('linux: .. 逃逸不算', !m.isUnder('/home/u/../v/a.md', '/home/u', 'linux'))

console.log('\n[6] 默认 vault / SKIP_REL_PREFIXES')
ok('win32 默认 vault = C:\\业务', m.defaultVault('win32') === 'C:\\业务')
ok('POSIX 没有默认 vault（退到主目录）', m.defaultVault('darwin') === '' && m.defaultVault('linux') === '')
ok('toFwd win32', m.toFwd('C:\\业务\\系统\\tools', 'win32') === 'C:/业务/系统/tools')
ok('toFwd POSIX 不动', m.toFwd('/a\\b', 'linux') === '/a\\b')
ok('win32: 系统/tools 被跳过', m.isSkippedRel('C:/业务/系统/tools', 'win32'))
ok('darwin: 系统/Tools 被跳过（不区分大小写）', m.isSkippedRel('/Users/x/系统/Tools', 'darwin'))
ok('linux: 系统/ppt-master 被跳过', m.isSkippedRel('/home/x/系统/ppt-master', 'linux'))
ok('linux: 系统/Tools 不跳过（区分大小写）', !m.isSkippedRel('/home/x/系统/Tools', 'linux'))
ok('普通目录不跳过', !m.isSkippedRel('/home/x/系统/docs', 'linux'))

console.log('\n[7] NOISE_PATH_RE 两种分隔符都认')
ok('Windows node_modules', m.NOISE_PATH_RE.test('C:\\p\\node_modules\\x\\README.md'))
ok('POSIX node_modules', m.NOISE_PATH_RE.test('/p/node_modules/x/README.md'))
ok('POSIX .dsh/profiles', m.NOISE_PATH_RE.test('/Users/x/.dsh/profiles/desktop/a.md'))
ok('Windows .dsh\\memory\\workspaces', m.NOISE_PATH_RE.test('C:\\Users\\x\\.dsh\\memory\\workspaces\\a.md'))
ok('POSIX .git / .obsidian', m.NOISE_PATH_RE.test('/r/.git/a.md') && m.NOISE_PATH_RE.test('/v/.obsidian/a.md'))
ok('普通文档不算噪音', !m.NOISE_PATH_RE.test('/Users/x/docs/方案.md') && !m.NOISE_PATH_RE.test('C:\\业务\\方案.md'))
ok('名字里带 .github 不误伤', !m.NOISE_PATH_RE.test('/r/.github/a.md'))

console.log('\n[8] collectDocPaths（当前平台 = ' + process.platform + '）')
const sample = process.platform === 'win32' ? 'C:\\业务\\方案.md' : '/Users/x/方案.md'
const out = []
m.collectDocPaths({ arguments: JSON.stringify({ file_path: sample, other: 'not a path.md', url: '//cdn/a.md' }) }, out, 0)
ok('从内层 JSON 字符串里收到本平台绝对路径', out.length === 1 && out[0] === sample, JSON.stringify(out))

console.log('\n结果：pass=' + pass + ' fail=' + fail)
process.exitCode = fail ? 1 : 0
