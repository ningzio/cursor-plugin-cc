# cursor-plugin-cc

一个 Claude Code / Codex 插件——把任务派发给 [cursor-agent CLI](https://docs.cursor.com/cli)，在隔离的 git worktree 里跑。前台/后台都行，带完整的 job 控制（status / result / cancel）和跨 agent 会话的安全边界。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-blue.svg)](https://nodejs.org/)

[English →](./README.md)

---

## 这是什么

当 Claude Code 或 Codex 在做主任务、你想同时让另一个 agent 干点活——做第二轮 review、跑长时间的 migration、独立写一遍实现——就可以把任务交给 cursor-agent。这个插件提供 5 个 slash 命令，让这件事做起来安全：

- `/cursor:setup` — 检查 cursor-agent 是否安装并已登录
- `/cursor:dispatch <prompt>` — 派任务到 cursor-agent，在新建的 git worktree 里跑（前台或后台）
- `/cursor:status` — 列出当前 agent 会话里的 job
- `/cursor:result [jobId]` — 取最新（或指定）job 的结果
- `/cursor:cancel [jobId]` — 取消运行中的 job

插件负责创建 worktree、跑完后自动 commit cursor 的修改到 per-job 分支、把 job 状态持久化（这样下一次 slash 命令还能看到）。

## 为什么不直接 shell 调 cursor-agent？

朴素 wrapper 大概 150 行就够了。这个插件代码量大，因为它解决了**一旦你越过 `--wait` 阻塞模式**就会立刻撞上的 4 个真问题：

1. **后台派发 + job 控制**。`/cursor:status` 和 `/cursor:result` 必须跨多次 Claude 调用工作，所以状态必须落盘。这就需要原子写、文件锁、去重的 job 记录。
2. **并发安全**。两个 `/cursor:dispatch` 撞在一起不能互相覆盖。插件在 state 锁内显式做 reservation。
3. **PID 安全**。cancel 必须 signal 到正确的进程。这套代码早期版本曾经把 SIGTERM 发到 PID `-1`，把用户登出过——现在拒绝不安全的 pid 并在 signal 前做 liveness check。
4. **会话边界**。如果你同时开两个 agent 会话，`/cursor:status` 必须只显示当前会话的 job。SessionStart hook 把当前会话 ID 注入环境变量，companion 据此过滤。

如果上面 4 个你都不需要，就别用这个插件——直接 `cursor-agent` 也挺好。

## 前置条件

- **Claude Code** 或 **Codex**
- **cursor-agent CLI** — 按 [cursor 官方文档](https://docs.cursor.com/cli) 安装并登录（`agent login`）
- **Node.js ≥ 18.18** — 仅插件 companion 运行时用，不需要单独装包
- **Git** — 大量使用 `git worktree`

安装完跑一下 `/cursor:setup` 验证 agent 二进制能找到、已登录。

## 安装

### Codex

仓库自带 Codex 插件根目录（[`plugins/cursor`](./plugins/cursor)），里面有 manifest（[`plugins/cursor/.codex-plugin/plugin.json`](./plugins/cursor/.codex-plugin/plugin.json)），同时仓库根目录提供 Codex marketplace catalog（[`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json)）。

在 Codex 里注册 marketplace：

```bash
codex plugin marketplace add ningzio/cursor-plugin-cc
```

然后在 Codex 插件界面里安装 `cursor` 插件。安装后启动一个新的 Codex 会话，让 SessionStart hook 注册。

后续更新 marketplace：

```bash
codex plugin marketplace upgrade cursor-plugin-cc
```

如果你是在 `v0.2.2` 之前添加过这个 marketplace，请先运行上面的 upgrade 命令，然后重启 Codex，再去插件界面搜索。

本地开发时，可以注册本地 checkout：

```bash
git clone https://github.com/ningzio/cursor-plugin-cc.git
codex plugin marketplace add ./cursor-plugin-cc
```

### Claude Code

仓库自带 [`marketplace.json`](./.claude-plugin/marketplace.json)，Claude Code 可以直接从 GitHub 装。在任意 Claude Code 会话里：

```
/plugin marketplace add ningzio/cursor-plugin-cc
/plugin install cursor@cursor-plugin-cc
```

第一行把这个 GitHub 仓库注册成 marketplace；第二行从里面装 `cursor` 插件。装完**重启 Claude Code 会话**，让 SessionStart hook 注册。

后续升级：

```
/plugin marketplace update cursor-plugin-cc
/plugin install cursor@cursor-plugin-cc      # 拉新版本
```

#### 手动安装（路径方式）

如果你想本地改插件代码、不走 marketplace：

```bash
git clone https://github.com/ningzio/cursor-plugin-cc.git ~/.claude/plugins/cursor-plugin-cc
```

然后在 `~/.claude/settings.json` 里把 path 指过去。日常使用建议用 marketplace 方式。

## 快速上手

```text
> /cursor:setup
agent binary: /Users/you/.local/bin/agent
version     : 2026.04.28-e984b46
logged in   : yes
account     : you@example.com

> /cursor:dispatch --background "把订单处理流程重构成状态机"
Dispatched cur-8a0de9e1 in the background.
  cursor session : (pending)
  worktree       : /your/repo/.cursor/worktrees/cur-8a0de9e1
  branch         : cur-8a0de9e1

> /cursor:status
✅ cur-8a0de9e1  completed   把订单处理流程重构成状态机...

> /cursor:result
Job: cur-8a0de9e1  status=completed  cursor=3209a7f0-...
branch: cur-8a0de9e1  head=abc1234
worktree: /your/repo/.cursor/worktrees/cur-8a0de9e1

[cursor 的完整回复]
```

## Slash 命令参考

### `/cursor:dispatch`

```
/cursor:dispatch [--wait | --background]
                 [--resume <jobId> | --fresh]
                 [--model <model>]
                 [--mode plan | ask | agent]
                 [--plan-only]
                 [--worktree-base <ref>]
                 <prompt>
```

| Flag | 作用 |
|---|---|
| `--wait`（短任务默认） | 阻塞等 cursor 跑完，结果直接打印 |
| `--background` | 立即 detach，靠 `/cursor:status` 看进度 |
| `--resume <jobId>` | 在原 worktree 里继续之前的 cursor 线程 |
| `--fresh` | 即使有可复用的旧 job 也另起一个 |
| `--model <model>` | 给 cursor-agent 传模型名（例如 `--model claude-4.5-sonnet`）。新派遣若没传 `--model`，slash 命令会静默追加 `--model auto`，让 cursor 自己按请求挑模型。可用 `cursor-agent --list-models`（或 `cursor-agent models`）查当前账号可用的模型 ID——cursor 的型号阵列会随时间变化。`--resume <jobId>` 沿用原线程已绑定的模型 |
| `--mode <plan\|ask\|agent>` | 选 cursor 执行模式：`plan` 只读出方案、`ask` 只读问答、`agent` 默认（可改文件）。只读模式不传 `--force`，也不会做 worktree 自动 commit |
| `--plan-only` | `--mode plan` 的兼容别名 |
| `--worktree-base <ref>` | 从指定 ref 拉 worktree，不从 HEAD |

未显式指定模式时，slash 命令会根据请求形态推断，并通过三选一的 `AskUserQuestion`（Ask only / Plan only / Agent）让用户最终确认一次。

`<prompt>` 里如果有 shell 元字符（`$`、反引号、`;`），不会被 sh 重新求值——slash 命令把原始 prompt 写到 tempfile，companion 在 Node 里 tokenize。

### `/cursor:status [--all] [--json]`

列出当前 agent 会话的 job。`--all` 显示所有会话的 job。

### `/cursor:result [jobId] [--json]`

不带 `jobId`：返回当前会话最新的**已完成** job。带 `jobId`：返回指定 job（不分会话）。

### `/cursor:cancel [jobId] [--json]`

取消正在跑或 queued 的 job。不带 `jobId` 时挑当前会话最新的可取消 job。先给 cursor-agent 进程发 SIGTERM，再发给 Node 包装层。

## 架构（简）

```
                    Agent session
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
  SessionStart hook    /cursor:dispatch    /cursor:status
  (打 session id)      (raw args 落 tempfile)    ↓
        ↓                       ↓        cursor-companion.mjs
   $CURSOR_COMPANION_      cursor-dispatch  (读 state.json
    SESSION_ID 导出         subagent          按 session 过滤)
        ↓                       ↓
        └───────────────────────┘
                 ↓
       cursor-companion.mjs dispatch
       1. 在 state.json 内原子预定 job
       2. 创建 git worktree
       3. spawn cursor-agent
       4. 解析 stream-json 事件
       5. 跑完自动 commit
       6. 更新 state.json
```

状态文件在 `$CLAUDE_PLUGIN_DATA/state/<repo-slug>-<hash>/`，按 cwd 分区，所以不同项目不会共享 job 记录。

worktree 在 `<repo>/.cursor/worktrees/<jobId>/`，分支名也是 `<jobId>`。第一次 dispatch 时插件会把 `.cursor/worktrees/` 加到 `.gitignore`（如果只读则降级写到 `.git/info/exclude`）。

## 环境变量

普通用户不用改。

| 变量 | 谁设的 | 用途 |
|---|---|---|
| `CURSOR_COMPANION_SESSION_ID` | SessionStart hook | 当前 agent 会话 ID；用来过滤 job |
| `CLAUDE_PLUGIN_DATA` | 插件宿主 | 插件数据目录 |
| `CLAUDE_ENV_FILE` | 插件宿主（SessionStart 时） | hook 把 export 语句写到这个文件，由宿主 source 进会话 |
| `CURSOR_COMPANION_AGENT_BINARY` | 你（测试） | 覆盖 cursor-agent 二进制路径 |
| `CURSOR_COMPANION_AGENT_BINARY_ARG0` | 你（测试） | 覆盖 argv[0] |

## 状态

**Phase 1** — 上面 5 个 slash 命令已稳定，有 119 个单元测试覆盖：原子状态写、dispatch reservation、PID 安全、会话过滤、dirty-worktree 拒 resume、stream-json 解析、mode/--plan-only 路由、Codex manifest wiring。

已知限制：

- `splitRawArgumentString` 是个最小化 tokenizer（空格分词 + 单/双引号成对；不支持 shell 转义）。prompt 里有引号字符就用相反风格的引号包起来。
- 每个 state 文件最多保留 50 条 job 记录（按 `updatedAt` 倒序，超出的丢最旧）。
- 必须在 git 仓库内使用。`/cursor:dispatch` 在仓库外会以非零状态退出。

## 开发

```bash
git clone https://github.com/ningzio/cursor-plugin-cc.git
cd cursor-plugin-cc
npm test  # 通过 node:test 跑 tests/*.test.mjs，无 npm 依赖
```

插件运行时**零依赖**——只用 Node 标准库 + cursor-agent CLI。

测试分类：

- `state.test.mjs` — 原子写、`withStateLock`、`reserveDispatchJob` 冲突检测
- `companion-jobs.test.mjs` — status/result/cancel/resume-candidate 全流程（子进程级）
- `companion-dispatch.test.mjs` — 用 fake cursor agent 跑完整 dispatch 流程
- `worktree.test.mjs` — git worktree 创建、finalize、cleanup、gitignore 降级
- `job-control.test.mjs` — `isSafePid` / `isPidLive` / `cancelJob`
- `cursor-cli.test.mjs` — stream-json 事件解析
- `session-lifecycle-hook.test.mjs` — SessionStart / SessionEnd hook
- `args.test.mjs` — 参数解析器 + raw-args tokenizer

## 致谢

最初在一个私有项目里开发，提取出来作为独立插件。每次重要 commit 之前都经过 codex (gpt-5.4 high) 和 cursor-agent 双模型交叉审查。

## License

MIT — 见 [LICENSE](./LICENSE)。
