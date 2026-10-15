# @caihua/dsh-doc-review · DSH 文档批注台

在 DSH 里直接对方案文档**划词批注**，批注落盘成 sidecar 文件，Agent 用 `doc_review_*` 工具读批注改稿，改完回标状态。

## 30 秒装上

两个办法，任选一个。

**办法一：让你 DSH 里的 AI 自己装（推荐）**

把下面这句话整段发给你自己 DSH 会话里的 AI：

> 帮我装一个 DSH 插件：`github:caihua8669/dsh-doc-review`。
> 装到桌面端正在用的那个 profile（不是 web），用桌面端自带的 CLI（`resources/runtime/cli/bin/dsh.cmd`）执行 `plugin --profile <profile名> add github:caihua8669/dsh-doc-review`。
> 装完确认三件事：①命令退出码为 0；②该 profile 的 `package.json` 里 `dependencies` 与 `dsh.profile.bundles` 都出现了 `@caihua/dsh-doc-review`；③`GET http://127.0.0.1:19387/api/dsh-doc-review/ping` 有响应（说明宿主半边挂上了）。最后刷新页面，确认会话页顶部页签栏出现「批注」。

**办法二：自己敲一行**

```bash
# 桌面端自带的 CLI；profile 名换成你正在用的（桌面端通常是 desktop）
dsh plugin --profile desktop add github:caihua8669/dsh-doc-review
```

装完刷新页面，会话页顶部页签栏里会出现「批注」。

**要求**：DSH 桌面端（或任意 profile）+ Node 20 以上。不需要构建，仓库里带的就是能直接跑的 `lib`。

## 它解决什么

以前的改稿回环：把段落复制到聊天窗口 → 下一行写建议 → 发出去。批注台把这一步改成：**在文档上划词 → 旁边写意见 → 点「交给 AI 改稿」**，Agent 拿到的是带行号、带原文引用、带作者与状态的结构化批注，不再丢上下文。

## 界面在哪

DSH 会话页顶部页签栏里的 **「批注」**（与「对话轨迹」「上下文」「白板看板」并列）。三栏：

- 左：**按优先级列文档**，右上角按钮切换三档（本机记忆选择）：
  - **相关**（默认）：两层优先级，不扫文件夹全量。
    - 第一层「本会话产出 / 编辑」：这个会话里 agent 真正 read / write / edit 过的文档，加上 `deliverables/presented`（交付给你的文件）与 `agent/inbox/spliced`（子代理产出，子代理写的文档只在这里出现）。条目上标「产出 / 编辑 / 读过」，时间显示的是**会话里最后一次动它的时间**，并用它排序（比文件 mtime 更贴近「会话里最新那篇」）。
    - 第二层「本项目其它会话碰过」：同一工作区里**最近 15 个会话**（可配 `projectSessions`）碰过的文档并集，去重后按文档改动时间倒序。标「本项目」，悬浮显示来自几个会话。这一层回答的是「这个项目里被工作过的文档」，不是 `C:\业务\其他` 那 5,494 篇全量。
    - **有搜索词时**改在项目文件夹里全量找（否则只搜得到已经碰过的那几篇），提示行会写「搜索：项目文件夹全量」。
  - **工作区**：会话 cwd 下的全部 md（想翻整个文件夹时用）。
  - **全库**：配置 `roots`（Windows 缺省 `C:\业务`，macOS/Linux 缺省用户主目录）下的全部 md，作者库实测 **24,856 篇**（深度不限，实测扫完 1.6 秒）。
  - 两层都空时，自动放宽到「工作区」并在提示行标注原因，不会给你一个空列表。
  - **层间不混排**：本会话的永远在最前，层内才按时间/待处理排；右上另一按钮切「最新 ⇄ 待处理优先」。
  - 列表项显示相对时间（今天 16:20 / 昨天 09:05 / 08-29 14:00）、待处理条数与批注总数。底部输入框可直接粘绝对路径。
  - 返回给界面的始终是「最新 400 篇」（搜索时是命中的最新 400 篇）；批注数只挂在这 400 篇上算，所以「待处理优先」是在最近 400 篇里的排序。
  - 缓存：全库/工作区扫描 5 分钟，本会话转写 20 秒（会话进行中一直在长），本项目聚合 10 分钟。真实数据实测：本工作区 205 个会话 / 140MB 转写，取最近 15 个会话解码 + 合并统计共 **311ms**。
  - 会话碰过的文档即使不在 `roots` 里（比如插件源码、`~/.dsh/skills` 下的文件）也允许打开与写批注；没被碰过的域外路径仍然拒。
  - **踩过的坑（2026-10-11）**：①`getConfig()` 里曾写死 `Math.min(disk.maxDocs, 5000)`，把配置的 60000 静默压成 5000；叠加 `maxDepth: 9`，全库只扫到 7,960 篇（约三分之一）。现在钳位上限放到 200000 / 64 层。②**一个会话目录里可能有多份转写**（`session.jsonl.zstd` / `session.v3.jsonl.zstd` / `session.v4.jsonl.zstd`…），旧版文件按字母序排在前面；曾用 `files.find()` 取第一个 ⇒ 读到几个月前的旧转写，会话最近做的事全看不到（实测 `session-7c58dbd2`：v3=9/23 旧稿 306 次引用 vs v4=今天 519 次；修好后该会话第一层从 3 篇变 15 篇）。现在会把该目录下**所有**转写合并（同一路径累加次数、取较晚的发生时间），第二层按会话取最新那一份以省时间。
  - 回归断言覆盖上述两条（`test/scan-coverage.mjs` 对数量、烟测第 [15] 组对多转写）。
- 中：Markdown 正文（标题/段落/列表/表格/引用/代码块/分割线/行内强调）。**选中任意文字**弹出批注框，`Ctrl+Enter` 保存。
  - 批注框默认贴在**选区上方**（下沿离选区留 10px），上方放不下（选区在视口顶部 170px 内）才落到选区下方；横向与选区左沿对齐并夹在视口内——**任何情况下都不压住选中的文字**。定位算法抽成纯函数 `floatPlacement(rect, vw, vh)`，有 8 条断言。
  - 弹框抢走焦点后浏览器原生选区会变淡，所以用 CSS Custom Highlight（`::highlight(dr-pending)`）把选区持续标黄，并在框内显示所选文字前 28 字，避免「改着改着忘了选的是哪段」。
- **建议模式（改稿默认走这条路）**：AI 不再直接改文件，而是先用 `doc_change_propose` 登记改动提案（`quote` 原文 → `after` 新文 + `note` 为什么），落 `<文档目录>/.dsh-review/<文件名>.proposals.json`。**登记时文件一个字都不动**；用户在「批注」页的「待审改动」面板逐条 接受/拒绝（可填拒绝原因），**接受那一刻才真正写文件**，并按 `quote` 重新定位（文档后来被别人改过也能对上；原文彻底找不到就一个字都不写并说明是哪几条对不上）。受影响的段落在正文里会挂一条**内联预览**（红=原文、绿=拟改）+ 就地接受/拒绝按钮。
- 右：批注清单（#序号 / 行号 / 状态 / 原文引用 / 意见输入 / 已处理·退回·删除），底部是整篇级意见。
- **会话批注**：在**正常对话界面**里选中一段文字，选区旁边会出现一个小「批注」按钮，点开写意见即可——不用占用对话输入框，也不用把整段贴进来。落盘在 `~/.dsh/doc-review/session-notes/<sessionId>.json`，`doc_review_list` 之外的 `session_note_list` / `session_note_resolve` 负责给 agent 读与回标。
  - **保存即写进聊天输入框（攒批发送）**：保存后批注以 `【批注 · 请逐条回应】…【批注结束】` 的块追加进当前会话的输入框草稿，并保持焦点。可以连着划好几段逐条保存，块会**整体重算**（不会攒出两个块），你写在块下方的问题原样保留，攒够了一次回车发出。依据：GitHub pending review 的官方理由就是"别让 AI 在你没写完之前就按单条开工"。
  - 输入框是斜杠命令（`/…`）时不动它，只落盘；批注被处理/删除后再同步会把块自动摘掉。
  - 输入框走 `ctx.get('conversation').input.for(sessions.scope(sessionId))`（`.state.getSnapshot().draft` / `.setDraft()`）。**用 `ctx.get` 取而不声明依赖**：服务拿不到就只落盘、不碰输入框，绝不让客户端条目挂掉（v0.5.0 那次 boot 崩溃的教训）。抽出的纯逻辑有 16 条断言（`test/composer-block.mjs`）。
  - 为什么是「先出按钮再点开」而不是像文档那样直接弹框：对话里选文字经常是为了复制，直接抢弹框会烦。文档视口内仍是直接弹。
  - 「批注」页左栏顶部有「本会话批注 (待处理数)」区，可逐条 已处理 / 退回 / 删除，或一键「交给 AI」把这一批发给当前会话。
  - 浮层挂在 `shell.overlay` 插槽（全局，独立于「批注」页签），所以选中文字时人在哪儿都行。

工具条三个动作：

- **交给 AI 改稿 (n)**：把待处理批注组装成指令，直接往**当前会话**排队一条消息（`remote.session.prompt`），切回对话页就能看它逐条改。
- **复制指令**：同样的内容进剪贴板（remote 面不可用时自动降级为复制）。
- **刷新正文**：重新读盘。

## 数据落在哪

跟着文档走，Obsidian 不索引点开头目录：

```
<文档目录>/.dsh-review/<文件名>.review.json   结构化真源（MRSF / Sidemark 形状）
<文档目录>/.dsh-review/<文件名>.review.md     人读 / 别的工具读的导出
```

`.review.json` 落盘格式对齐 **MRSF v1.0（Markdown Review Sidecar Format，sidemark.org）**：

| 字段 | 含义 |
|---|---|
| `id` / `author` / `timestamp` | 批注身份 |
| `text` / `resolved` | 意见正文、是否已处理 |
| `line` / `end_line` | 1 基源码行号 |
| `selected_text` | 划词原文（**权威锚点，任何情况下都不改写**） |
| `selected_text_hash` | `sha256:...` |
| `anchored_text` | 重锚后实际命中的文本；空串 = 已失锚 |
| `x_status` / `x_reply` / `x_resolved_at` | 本插件私有状态（MRSF 的 `x_` 扩展位） |

为什么不自创格式：MRSF 已有 `@mrsf/mcp`、`@mrsf/cli`、VS Code 扩展等消费方，字段语义也写死了重锚规则（§7.4 / §8）。

## 锚点怎么保持有效

锚点**打在 .md 源文本上**，不是渲染后的 DOM 偏移：渲染时把源码行号写进每个块的 `data-ls` / `data-le`，划词时反查行区间。

文档被改过之后，打开文档那一刻按 MRSF §7.4 的重锚四步重新定位：**精确匹配 → 多命中按旧行号就近消歧 → 空白归一化再匹配 → 都失败标「已失锚」但保留**。孤儿批注绝不静默删除，也不做假锚定（行号保持原值，卡片上挂红色「已失锚」）。

## Agent 侧三个工具

| 工具 | 用途 |
|---|---|
| `doc_review_list` | 读批注。给 `doc` 读单篇；不给则巡检配置根目录下所有带批注的文档。返回行号区间 + 原文 + 意见 |
| `doc_review_resolve` | 改完标记已处理，可回填一句「改了什么」（写进 `x_reply`，用户和同事都能看到） |
| `doc_review_reopen` | 改得不满意，退回待处理 |

## 宿主路由（回环限定）

```
GET  /api/dsh-doc-review/state          配置、根目录、上次打开的文档
GET  /api/dsh-doc-review/docs?ws=&q=    列文档（按待处理数、改动时间排序）
GET  /api/dsh-doc-review/doc?path=      读正文 + 批注 + 指纹
POST /api/dsh-doc-review/save           { path, comments } 整体覆盖写回
POST /api/dsh-doc-review/hello          浏览器半边加载心跳
GET  /api/dsh-doc-review/ping           存活探针
```

全部 `isLoopback` 校验；读文档限定在配置根目录内，写批注也只允许落在根目录内。

## 配置

`~/.dsh/doc-review/config.json`（首次运行自动生成）：

```json
{ "roots": ["C:\\业务"], "maxDocs": 60000, "maxDepth": 20, "projectSessions": 15, "author": "your-name" }
```

macOS / Linux 上 `roots` 写 POSIX 绝对路径即可，如 `["/Users/you/notes"]`。

`author` 缺省取本机登录用户名（`os.userInfo().username`）。**根目录**默认取环境变量 `DSH_DOC_REVIEW_VAULT`；没设时 Windows 上 `C:\业务` 存在就用它，否则（以及 macOS/Linux 上一律）退到用户主目录——所以换台机器第一次跑，记得改 `roots` 或设这个环境变量。

**跨平台**：会话转写里的路径在 Windows 上认盘符路径、在 macOS/Linux 上认 `/` 开头的绝对路径；路径比较在 Windows/macOS 上不区分大小写、在 Linux 上区分（规则见 `lib/impl.js` 的 `isAbsDocPath` / `pathKey`，断言在 `test/path-utils.mjs`）。

`maxDocs` 缺省 60000、`maxDepth` 缺省 20（都等于不设上限，全量收），配置值上限分别是 200000 / 64；`projectSessions` 是「相关」第二层聚合几个最近会话，缺省 15、上限 60（另有 25MB 转写字节预算兜底）。根目录下有超大目录时把它们加进源码里的 `SKIP_DIR_NAMES` / `SKIP_REL_PREFIXES`（当前已排除 `node_modules`、`.git`、`.obsidian`、`系统/tools`、`系统/ppt-master`、各类 `_` 前缀归档目录）。

诊断文件：`~/.dsh/doc-review/heartbeat.json`（宿主半边挂载时间与 pid、路由与工具清单、浏览器半边加载时间/次数/UA）、`state.json`（上次打开的文档）。

## 安装 / 升级 / 卸载

```bash
# 装：git 方式（别人用这个）
dsh plugin --profile desktop add github:caihua8669/dsh-doc-review

# 装：本地源码目录方式（自己开发改代码用这个，改完立刻生效）
dsh plugin --profile desktop add "file:/绝对路径/dsh-doc-review"

# 升级到最新
dsh plugin --profile desktop add github:caihua8669/dsh-doc-review

# 卸载
dsh plugin --profile desktop remove "@caihua/dsh-doc-review"
```

装完核对两处：该 profile 的 `package.json` 里 `dependencies` 与 `dsh.profile.bundles` 是否都有 `@caihua/dsh-doc-review`；再探 `GET /api/dsh-doc-review/ping`。

- **装进 desktop profile**（桌面端 GUI 用的是它，不是 web）。
- **宿主半边为什么不会自动重载**：DSH 宿主**按插件名缓存已加载的模块**，`remove + add` 只会重新 apply、不会失效缓存——实测连「换掉 package.json 的入口文件名」都没用（心跳里的 version 一直是旧值）。所有已挂载的旧实例都这样，只能重启一次桌面端。
- **所以入口做成了薄壳**：`lib/index.js` 只负责每次 apply 时用**带缓存戳的动态 import** 重新加载 `lib/impl.js`（真正的实现）。这样在**第一次重启之后**，改宿主半边只要 `remove + add`（或任何一次 profile 重挂）就会加载新代码，不用再重启桌面端。机制自证见 `test/hot-swap.mjs`。
- 浏览器半边是每次请求从磁盘读的，页面刷新即可拿到新版；`patchReload: live` 下 bundle 重挂时客户端会立刻重新加载（心跳里会看到 clientHello 时间更新）。

## 自测

```powershell
node test\host-smoke.mjs                                   # 96 条断言：真路由 / 真工具 / 真落盘 / 相关分层 / 多转写 / 弹框落点 / 会话批注 / 全量覆盖
node test\hot-swap.mjs                                     # 3 条断言：入口热替换机制自证
node test\verify-real-session.mjs <sessionId>              # 拿真会话转写验抽取质量（只读）
node test\verify-related.mjs <sessionId>                   # 拿真会话+真项目数据看「相关」两层实际会列出什么（只读）
node test\scan-coverage.mjs                                # 插件扫描 vs 独立遍历的数量/深度对比（只读）
node test\verify-session-timeline.mjs <sessionId>          # 按转写顺序列出该会话碰过的文档，并显示读了几份转写（只读）
```

96 条断言：假 ctx 挂真插件 → 真路由 + 真工具 + 真落盘；含 MRSF 字段校验、越界拦截、按最近产出排序、搜索过滤、**「相关」分层（本会话永远在最前、项目层去重不重复计、搜索时改走项目文件夹全量）**、**多帧 zstd 转写解析与会话范围（域外路径按会话放行、空会话自动放宽）**、**同一会话多份转写必须全部读到（v3 旧稿陷阱）**、**全量覆盖回归（11 层深的文档必须被扫到、getConfig 不得把 maxDocs 钳回 5000）**、**划词弹框落点（上方优先、不压选区、横向夹紧）**、**建议模式（提案阶段不动文件 / 拒绝留原因 / 顶部插行后仍改对位置 / 原文对不上则一个字不写）**、**会话批注（存取 / 按会话读回 / 空值拒绝 / agent 侧读与回标）**、**建议模式（提案阶段不动文件 / 拒绝留原因 / 顶部插行后仍改对位置 / 原文对不上则一个字不写）**，以及**直接从 client.js 抽源码跑**的失锚重定位四案例（行号位移 / 空白归一化 / 孤儿保留 / 多命中就近消歧）。

另外宿主侧还有一条真机自检路径：插件的路由**不走 GUI 鉴权**，所以可以直接 curl：
`Invoke-RestMethod http://127.0.0.1:19387/api/dsh-doc-review/docs?scope=session&sessionId=<id>`（`/ping` `/state` 同理）。

烟测与真会话校验都通过 `DSH_DOC_REVIEW_HOME` / `DSH_DOC_REVIEW_SESSIONS` 把运行目录与会话根顶到临时目录，**不会碰你真实的 `~/.dsh/doc-review/` 与 `~/.dsh/sessions/`**。
