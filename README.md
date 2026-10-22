# dsh-delete-guard

**给 DeepSeek Harness 里的 AI 装一道删除总闸。** 按会话累计 AI 通过 shell 删掉多少字节，
一旦要越过阈值（默认 **300 MB**），这一次删除**在执行前就被强制终止**，并弹出对话框把 AI 已经删掉的文件摆给你看，
由你选择「继续删除（重置计数）」还是「停止并保持阻止」。

> 这是 DSH（Cordis）插件，不是独立程序。它挂在工具流水线上，无 UI 页面、无外部依赖、零 npm 依赖。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [安装](#安装)
- [验证是否生效](#验证是否生效)
- [工作原理](#工作原理)
- [配置](#配置)
- [账本与报告](#账本与报告)
- [已知边界](#已知边界)
- [开发与测试](#开发与测试)
- [English](#english)

---

## 它解决什么问题

DSH 的文件沙箱管的是**路径范围**（能改哪些目录），不管**删除量**。
所以一次误判生成的 `Remove-Item -Recurse` / `rm -rf` 可以合法地把整个项目目录清空——
权限没问题，命令也确实执行了，只是没人问过你。

这个插件补上「删除量」这一维：

| | 文件沙箱 | 删除保护 |
|---|---|---|
| 管什么 | 能碰哪些路径 | 一个会话累计删掉多少字节 |
| 超限表现 | 拒绝访问 | 命令不执行 + 弹窗让用户决定 |
| 依据 | 路径策略 | 执行前实测的删除体积 |

---

## 安装

三种方式，选一种。装完后插件是 **profile 级**的：对该 profile 的所有会话生效，重启后仍在。

### 方式 A：插件管理器（推荐）

Web 界面侧边栏 → **插件** → 安装本地 bundle，目标填本仓库的绝对路径，例如 `D:/dsh/dsh-delete-guard`。
或者让 Agent 调 `plugin_manager`：`{ action: 'install_bundle', target: 'D:/dsh/dsh-delete-guard' }`。

这条路径由 DSH 自己完成依赖登记、bundle 选择与安装，不需要手工改任何配置文件。

### 方式 B：手动 pnpm link

在 profile 目录（`$DSH_PROFILE_DIR`，Windows 上是 `%USERPROFILE%\.dsh\profiles\<profile>`）：

```json
{
  "dependencies": { "dsh-delete-guard": "link:D:/dsh/dsh-delete-guard" },
  "dsh": { "profile": { "bundles": [ "...原有项...", "dsh-delete-guard" ] } }
}
```

然后在该目录 `pnpm install`，重启 DSH（或让 HMR 感知到 bundles 列表变化）。

### 方式 C：目录 junction，不动 pnpm（本机采用）

```powershell
# 1) 把仓库挂进 profile 的 node_modules
New-Item -ItemType Junction `
  -Path "$env:DSH_PROFILE_DIR\node_modules\dsh-delete-guard" `
  -Target 'D:\dsh\dsh-delete-guard'

# 2) package.json 里同样加两处：dependencies 的 link: 依赖 + dsh.profile.bundles 末尾追加
# 3) 改完 package.json，HMR 会按新的 bundles 列表重排（不重启也能生效）
```

三条路殊途同归：bundle 的 `cordis.patch.yml` 插入一行 `delete-guard` 插件，模块名解析到本仓库。

---

## 验证是否生效

```powershell
# 1) 造一个 1 MB 的靶子
[IO.File]::WriteAllBytes('D:\tmp\probe\p.bin', (New-Object byte[] 1048576))

# 2) 让 AI 删掉它（例如在会话里说：删掉 D:\tmp\probe）

# 3) 看账本
Get-Content "$env:DSH_HOME\delete-guard\state\<session-id>.json"
```

账本里出现 `"usedBytes": 1048576`、以及被删文件的绝对路径，就说明拦截、测量、记账全链路通了。
阈值测试不想真删 300 MB 的话，把 `limitBytes` 临时调到 1 MB，删一个 2 MB 文件即可看到弹窗。

---

## 工作原理

### 挂在流水线的哪一段

DSH 的工具调用是固定的五段流水线：

```text
tools/pre-execute  →  guards  →  tools/execute  →  tools/post-execute  →  tools/result
   allow/deny        单调拒绝      真正执行          可改写结果/阻断        只读观察
```

插件只占首尾两段，中间不碰：

- **`tools/pre-execute`（waterfall）**：命令还在字符串阶段、**尚未执行**，这里返回 deny 就是真正的「未发生」。
- **`tools/post-execute`（waterfall）**：拿最终结果，调用失败就把这一步的记账退回去。

### 一次删除的完整路径

```text
  shell 工具调用（pwsh / bash）
        │
        ├─ 不是删除命令 ────────────────→ 放行（零成本，实测 0.1 ms 级）
        │
        └─ 是删除命令
              │
              ├─ 1. 解析：拆命令 → 认动词 → 展开变量/通配符 → 求目标绝对路径
              ├─ 2. 测量：文件取 size，目录递归求和，跳过符号链接，重叠路径去重
              ├─ 3. 记账：usedBytes += 本次体积，写入会话账本（**先记账，再执行**）
              ├─ 4. 判定：usedBytes > limitBytes ?
              │        ├─ 否 → 放行，命令执行
              │        └─ 是 → 不执行，弹对话框
              │                 ├─ 继续删除（重置计数）→ 清零 + 放行本次
              │                 └─ 停止 / 超时 / 界面不可用 → 拒绝 + 15s 冷却
              └─ 5. 收尾：post-execute 发现调用失败 → 退回这次记账
```

### 为什么「先记账再执行」

两个并发删除各自都在额度内、合起来超限时，先测量后执行会双放行。先扣额度，第二个调用就能看到第一个的占用。

### 为什么弹窗必须是 fail-closed

决策入口是 `ctx.userQuestions.askTimed()`。以下情况一律按「停止」处理，绝不默认放行：

- 部署里没有 userQuestions 服务；
- 调用方是子 Agent（DSH 只允许运行时根 Agent 发起人机交互）；
- 用户在 `askTimeoutSeconds` 内没作答（返回 `{ pending: true }`）；
- 信号被取消 / 界面异常。

### 拒绝时模型看到什么

不是一句「操作失败」，而是结构化说明：超限原因、本次请求的体积、已删文件（体积最大的 8 项）、完整报告路径，
外加一条约束：「在用户明确同意前不要重试删除，也不要换成别的命令绕过这个限制」。
模型收到的是 tool error，不会把拒绝当成成功，也不会误以为文件已经没了。

### 命令解析覆盖到什么程度

| 类别 | 识别 |
|---|---|
| PowerShell | `Remove-Item` / `ri` / `Clear-Content` / `del` / `erase` / `rd`，`-Path` / `-LiteralPath` / `-Recurse -Force` |
| cmd | `del /f /q`、`erase`、`rd /s /q`、`rmdir` |
| POSIX | `rm -rf`、`rmdir`、`unlink`、`shred` |
| 组合命令 | `find ... -delete`、`git clean -fdx`、管道/分号/&& 拆段 |
| 脚本内删除 | `fs.rmSync(` / `fs.rm(` / `unlinkSync(` / `rimraf(` / `shutil.rmtree(` / `os.remove(` |
| 路径形态 | 绝对/相对/`~`、引号、逗号列表、`*` / `**` / `?` 通配、`%VAR%` / `$env:VAR` / `$VAR` 展开 |

测不准的（管道喂给 `Remove-Item`、变量拼路径）**不会虚报成 0 字节**，而是记为 `unmeasured++`：
账本里看得见「有一次删除没测出来」，但它不占用额度，也不假装安全。

---

## 配置

在 profile 的 `cordis.patch.yml` 里按行 id 覆盖（覆盖会替换整份 config，没写的字段回落默认值）：

```yaml
- id: delete-guard
  name: 'dsh-delete-guard'
  config:
    enabled: true
    limitBytes: 314572800      # 300 MiB；想按十进制 300 MB 写 300000000
    limitFiles: 0              # >0 时同时按文件数封顶
    tools: [pwsh, bash]        # 需要覆盖哪些 shell 工具
    askTimeoutSeconds: 180     # 弹窗等待上限，超时按停止处理
    reportTopFiles: 30         # 弹窗/报告里列多少个文件
    continueLabel: '继续删除（重置计数）'
    stopLabel: '停止并保持阻止（推荐）'
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关，false 时插件完全不介入 |
| `limitBytes` | `314572800` | 每会话累计删除字节阈值 |
| `limitFiles` | `0` | 每会话累计删除文件数阈值，0 = 不启用 |
| `tools` | `[pwsh, bash]` | 参与检查的 shell 工具名 |
| `askTimeoutSeconds` | `180` | 对话框等待上限（秒），超时按停止 |
| `reportTopFiles` | `30` | 对话框与报告列出的文件条数 |
| `continueLabel` / `stopLabel` | 见上 | 选项文案，含「继续」即视为放行 |

---

## 账本与报告

| | 路径 | 说明 |
|---|---|---|
| 状态 | `$DSH_HOME/delete-guard/state/<session-id>.json` | 会话级：已删字节、文件数、文件清单、阻止状态 |
| 报告 | `$DSH_HOME/delete-guard/reports/<session-id>-<ISO>.md` | 每次弹窗生成一份，按体积排序 |

两样都在会话日志之外：不进模型上下文、不参与 fork/replay，纯 Host 侧安全账本。
**清零办法**：删掉对应会话的 state 文件即可（或换会话重来）。

---

## 已知边界

- 只覆盖**经 shell 工具执行**的删除。交互式终端里手敲的 `rm`、其他进程的删除、外部同步工具的清空，插件看不到。
- 不做回收站备份：这是「拦在删除之前」，不是「删了还能恢复」。要可恢复删除，请让 AI 用系统回收站命令。
- `write` / `edit` 覆盖写不属于删除，不计数（覆盖同样会毁数据，但它不是删除语义）。
- 目标无法静态解析时只记 `unmeasured`，不虚报体积；这类调用仍受「已阻止」状态约束。
- 体积测量有预算（4 秒 / 12 万目录项）；超预算标记为 unknown，避免拖慢工具调用。

---

## 开发与测试

```bash
npm test        # = node --test
```

15 个用例，分两组：

- `test/analyze.test.mjs`：解析与测量（rm / Remove-Item / del / 通配符 / 重叠去重 / 脚本调用 / git clean / 只读命令 / 不可解析）。
- `test/guard.test.mjs`：行为（放行并扣额、超限拦截并弹窗、冷却期不重复弹窗、选择继续后清零、失败回滚、非删除命令不动账本）。

两组都用假的 `ctx` 与假的 `userQuestions` 跑，不需要启动 DSH。

### 目录结构

```text
dsh-delete-guard/
├── index.js              # 插件入口：apply()、两个流水线监听、弹窗与拒绝文案
├── lib/analyze.js        # 命令解析 + 体积测量 + 通配/变量/去重
├── lib/state.js          # 会话账本、报告落盘
├── cordis.patch.yml      # bundle 补丁：插入 delete-guard 行与默认配置
├── locale/{zh,en}.json   # 插件管理器里的标题/描述
├── icon.svg              # 图标（必须是有效图像，管理器会渲染）
├── package.json          # dsh.bundle.patch 声明 + exports
└── test/                 # node:test 用例
```

### 兼容性

验证环境：DSH 桌面版（运行时 `@deepseek-ai/dsh-desktop-runtime 0.2.1-rc.2`）+ Windows 11 + Node 24。
插件只用 `node:fs` / `node:path` / `node:os` 与 Cordis 的 `ctx.on`、
`ctx.reflect.get` 两个接口，不 import 任何 `@deepseek-ai/*` 包，因此不随 DSH 版本漂移而编译失败。

---

## English

**dsh-delete-guard** is a DeepSeek Harness (Cordis) plugin that meters AI-driven deletion.
It hooks `tools/pre-execute` and `tools/post-execute`: every shell command that removes files is parsed and
measured *before* it runs, the byte count is charged to a per-session ledger, and as soon as a call
would push the session past the threshold (300 MiB by default) the call is terminated **before execution** and
the user is asked, through a dialog listing the files already deleted, whether to continue or stay blocked.

The guard is fail-closed: no answerer, a delegated subagent, a timeout, or a cancelled signal all resolve to *stop*.
Deleted-byte accounting is pre-charged so concurrent deletions cannot jointly slip past the limit, and a failed
tool call is refunded. No runtime dependencies, no UI page, no session-log writes.

```bash
# install (one of)
# A) plugin manager: install_bundle with target = this repo directory
# B) pnpm: add "dsh-delete-guard": "link:<abs path>" and append it to dsh.profile.bundles, then pnpm install
# C) junction: link node_modules/dsh-delete-guard -> this directory and add the same two package.json entries
npm test   # 15 node:test cases, no DSH required
```

MIT licensed.
