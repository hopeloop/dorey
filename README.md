# Dorey

Dorey 是 **Doc Review** 的缩写：一个面向 AI 编码产物的本地文档审阅闭环工具。

> [!IMPORTANT]
> **当前已支持：Codex Desktop、Codex CLI、TraeX CLI。** 三者都通过保持在原会话中的 foreground poll 接收反馈；已经结束的 Agent turn 不会被 Dorey 自动唤醒。
>
> Dorey 的评论提交依赖对应工具的 session adapter 和 `dorey poll`；**Cursor 和 Claude Code 目前均未适配**，无法把评论自动回传到它们的原会话。
>
> **欢迎共建新的 Agent 适配。** 如果你希望接入 Cursor、Claude Code 或其他 Agent 工具，可以基于现有 adapter 提交 MR，补齐会话识别、评论队列 poll 和修订结果回传能力。

它的目标很简单：把 Markdown 技术文档放进一个本地 Web 工作台里，让人可以像评审文档一样选中文本、加评论、批量提交给当前 AI Agent 会话处理，也可以直接编辑 Markdown 源码；接受修订后，Dorey 会把结果写回原文件并保留本地 review 记录。

## 核心能力

- 本地 Web UI：渲染 Markdown 产物，支持选中文本、添加评论、编辑评论、删除评论、批量提交，以及直接编辑 Markdown 源码。
- 原会话提交闭环：`Submit All` 不启动新的 `resume` 子进程，而是把 payload 写入本地队列，由启动 Dorey 的 Codex / TraeX 原会话通过 `dorey poll` 拉取。
- 可靠投递：队列索引和 payload 写入由源文件、Agent target 与端口共同确定的稳定目录；正常重启可恢复，领取使用 delivery lease，响应断连会立即回队，废弃 lease 超时后可再次领取。
- Agent presence：页面展示原会话当前处于未监听、正在监听或正在处理，HTTP 入队成功不会被误报成 Agent 已经开始工作。
- 多 Agent 入口：支持 Codex Desktop 原对话、Codex CLI 会话、TraeX CLI 会话。
- 会话上下文：每个文档至少关联一个 review session，submit payload 会携带任务目标、当前阶段、上下文摘要、关联会话和已接受历史。
- 修订结果视图：展示摘要、逐条处理结果、修订 Markdown、渲染态 diff，并支持 `接受` 把修订设为当前版本。
- 页面恢复：刷新或重新打开页面时恢复最近一条未确认 submission；纯解释或无改动结果展示后写入 acknowledge；有改动的结果保留到接受写回成功，刷新后仍可查看差异和接受，接受后不再重复回放。
- 文件与文件夹入口：CLI 显式传入 `--review-file <file>`、`--review-folder <folder>` 或 `--demo`；文件夹模式递归列出 Markdown，并在左侧显示文件树。
- 本地图片：Markdown 的相对图片路径会从当前文档所在目录解析，并通过 Dorey 的受限图片端点加载。
- Mermaid / PlantUML 渲染：Markdown 中的 `mermaid` 和 `plantuml` fenced code block 会在编辑器里渲染为 inline SVG，并保留源码展开与错误回退能力。

## 安装

Dorey 通过 GitHub Release 提供可直接安装的 npm tarball。需要本机已经安装 Node.js 22 和 npm。以下命令适用于 v0.2.2 Release 及其安装包发布后；发布准备阶段请使用下方的源码安装方式：

```bash
curl -L -o dorey-0.2.2.tgz \
  https://github.com/hopeloop/dorey/releases/download/v0.2.2/dorey-0.2.2.tgz
npm install -g ./dorey-0.2.2.tgz
dorey --help
```

安装包和版本说明也可以从 [GitHub Releases](https://github.com/hopeloop/dorey/releases) 查看。v0.2.1 仅发布了源码，没有 npm tarball 附件。

从当前检出的源码安装发布候选版本：

```bash
npm ci
npm run build
npm pack --pack-destination /tmp
npm install -g /tmp/dorey-0.2.2.tgz
dorey --help
```

v0.2.2 新增“修订 / 解释”评论分流；本版本同时修复待接受结果刷新恢复，兼容说明、验证结果和发布步骤见 [v0.2.2 发布说明](docs/releases/v0.2.2.md)。

## 启动

正常使用时，在 Codex / TraeX 会话所在的工作目录里显式指定要 review 的文档：

```bash
dorey --review-file path/to/design.md
```

打开一个文件夹及其子目录下的 Markdown：

```bash
dorey --review-folder path/to/docs
```

`--review-file` 接受 Markdown 或 HTML 文件；`--review-folder` 递归加载 `.md` 和 `.markdown`，左侧使用文件树导航。两种模式都会先复制到临时 review workspace，避免评审中的草稿直接改动原稿；点击“接受修订”时才校验并原子写回对应原文件。

Dorey 会在打开评审时记录原文件的 SHA-256。若原文件在评审期间被其他程序修改，接受操作会返回冲突并保留评论和待接受修订，不会覆盖外部改动。只有原文件写回成功后，页面才标记 accepted 并清空评论。`--demo` 没有原文件，仍只写临时 workspace 和 review 记录。

交互模式会在启动后保持 foreground poll。请让启动 Dorey 的 Agent turn 和命令会话持续运行，直到页面执行“结束评审”；这样用户点击 Submit 后会由同一个原会话自动收到反馈，不需要再输入 `poll`。

如果只是想打开 Dorey 自带的产品 demo：

```bash
dorey --demo
```

Demo 模式会在临时目录生成一组内置文档，并在页面内明确提示当前打开的是 Dorey 内置 Demo，不是在审阅本地文件。

裸 `dorey` 命令不会启动 UI，也不会扫描目录；它只会打印当前支持的命令和选项。

## 安装 Agent Skill

仓库内提供轻量的 `dorey` 参考 skill，只说明 Dorey 是什么、常用命令和启动时的可见生命周期。Codex 用户可以安装到个人 skills 目录：

```bash
mkdir -p ~/.codex/skills
cp -R skills/dorey ~/.codex/skills/
```

Skill 不承载一套独立的 review-loop 工作流；Dorey 自己负责队列、状态和恢复。它让 Agent 能发现正确入口，并知道交互启动命令需要保持运行。遇到不确定状态时直接运行 `dorey doctor` 获取当前生命周期和下一步操作。

默认地址：

```text
http://127.0.0.1:5175/
```

如果只想打开 UI 预览，不想让当前命令进入 poll 等待，仍然需要显式指定文件、文件夹或 demo：

```bash
dorey --review-file path/to/design.md --preview
```

## 源码开发启动

```bash
npm install
npm run dev
```

`npm run dev` 会使用 Vite 默认端口，通常是：

```text
http://127.0.0.1:5173/
```

如果 5173 被占用，Vite 会自动切到下一个可用端口，以命令行实际打印的 URL 为准。

## 基本使用流程

1. 使用 `dorey --review-file <file>`、`dorey --review-folder <folder>` 或 `dorey --demo` 打开 Dorey Web UI。
2. 在左侧文件树选择一个 Markdown 文档。
3. 在渲染后的文档中选中文本。
4. 点击 `评论`，选择 `修订`（默认）或 `解释`。
5. 输入评论内容，点击 `添加修订` 或 `添加解释`。
6. 多条评论会进入右侧评论队列，并显示对应类型。
7. 点击 `提交修订`、`提交问题` 或混合场景下的 `提交全部`。
8. Dorey 会把完整 payload 写到 `.local/dorey-submissions/<review>/active/.../payload.json`，并把本次请求排队给原 Agent 会话。
9. 原会话里的 `dorey poll` 收到 payload 后，先在原 Agent 对话中直接回答解释型评论，再应用修订型评论，并把 `BatchRevisionResponse` POST 回页面给出的 reply endpoint。
10. Dorey 不展示解释正文，只显示“已在原 Agent 对话中回答”的轻量回执；有文档修改时才展示修订、差异和接受按钮。
11. 有修订时点击 `接受修订`，Dorey 会先校验并原子写回原文件；成功后当前文档更新、修订评论清空，run history 记录为 accepted。若检测到原文件已被外部修改，则保持待接受状态并提示冲突。

如果只是想删掉一段话或改几个字，也可以在 Markdown 文档上点击 `编辑 Markdown`，修改源码后点击 `保存为修订`；页面会生成普通修订、展示 diff，并在 `接受修订` 后写入 review 结果。

## 原会话 Poll 机制

Dorey 的 submit 是 AXI-style pull loop：

```text
Browser Submit All
  -> POST /api/agent/<target>/revise
  -> server writes payload.json and revision-poll-state.json
  -> server returns dorey poll / raw poll / reply commands
  -> foreground poll already attached to the original Codex/TraeX session
  -> original session reads payload and produces BatchRevisionResponse
  -> original session POSTs /api/agent/submissions/<id>/reply
  -> browser shows revision / diff / accept controls
```

这个机制刻意不走 `codex app-server thread/resume`、`codex exec resume` 或 `traex exec resume`。原因是：Desktop 已经持有原 task 的 writer，再启动一个 App Server 会产生 writer 冲突；前台 poll 则直接把反馈交给仍然活跃的原会话。

Poll 领取反馈后会获得 15 分钟 delivery lease。HTTP 响应未写完就断连时，请求立即恢复为 queued；Agent 领取后崩溃且没有 reply 时，lease 到期后下一次 poll 会重新领取。

交互 review 的状态目录由 `source + target + port` 稳定派生，位于启动目录的 `.local/dorey-submissions/<review>/active/`。同一 review 正常停止再启动会恢复 queue；如果上一次已经执行“结束评审”，旧状态会移到同 namespace 的 `archive/`，新启动不会继承 `review_closed`。页面只恢复未 acknowledge 的 submission，成功展示 completed response 后立即 acknowledge。

“结束评审”采用 stop-new-work 语义：尚未领取的 queued request 不再投递，foreground poll 返回 `review_closed`；已经领取的 in-flight request 仍可提交完成结果。后台 server 的 stdout/stderr 写入临时 review workspace 的 `.local/dorey/server.log`。

## CLI 命令

```bash
dorey --review-file README.md # review 单个 Markdown 文档
dorey --review-folder path/to/docs # review 文件夹下的 Markdown 文档
dorey --demo                  # 打开 Dorey 自带产品 demo
dorey poll                    # 在原 Agent session 中前台等待 submit payload
dorey doctor                  # 诊断 lifecycle、target、队列并给出下一步操作
dorey status                  # 查看 server health、workspace root、launcher context
dorey stop                    # 停止后台 Web server
```

源码开发脚本：

```bash
npm run dev          # 启动本地 Vite editor
npm run agent:poll   # 源码开发模式下的 poller wrapper
npm run typecheck    # TypeScript 类型检查
npm test             # 构建 Node 代码并运行 node:test 测试
npm run build        # 构建 Node 输出和生产 Web bundle
npm run build:web    # 只构建 Web app 到 dist/web
```

## Session Target 自动识别

`dorey --review-file <file>`、`dorey --review-folder <folder>`、`dorey --demo` 和 `dorey poll` 会自动读取这些环境变量：

```text
CODEX_THREAD_ID
CODEX_CLI_SESSION_ID
TRAEX_CLI_SESSION_ID
TRAE_CLI_SESSION_ID
TRAEX_THREAD_ID
MARKDOWN_REVIEW_TARGET_KEY
```

也可以显式指定：

```bash
dorey poll --base-url http://127.0.0.1:5175 --target codex-desktop:<thread-id>
dorey poll --base-url http://127.0.0.1:5175 --target codex-cli:<session-id>
dorey poll --base-url http://127.0.0.1:5175 --target traex-cli:<session-id>
```

## 文档加载契约

Dorey 不会自动扫描当前仓库。启动时只有三个显式来源：

- `dorey --review-file <file>`：复制单个文档，以及文档实际引用的本地图片。
- `dorey --review-folder <folder>`：递归复制文件夹，跳过 `.git`、`node_modules` 和符号链接；文件树只展示 Markdown。
- `dorey --demo`：在临时目录生成 Dorey 内置 demo 文档。

临时 review workspace 的核心结构是：

```text
workflow-root/
  <run-id>/
    workflow-run.json
    documents/<relative-document-path>
    review/
```

`documents/` 保留文件夹内的相对目录。Markdown 中的 `assets/example.png` 会相对于当前 Markdown 解析，图片请求只能读取临时 workspace 内受支持的图片类型。对于 `--review-file` 和 `--review-folder`，`workflow-run.json` 还会记录受限的 artifact → 原文件相对路径映射、原文件根目录和打开时的 SHA-256，供接受修订时做冲突检测。

Web server 内部读取：

```text
workflow-run.json
artifacts
review
```

UI 只展示 Markdown / HTML 文档，不再暴露 Workflow Runs、Execution、Coding Plan 等内部 artifact 术语。侧边栏显示文件名和目录层级，正文标题优先使用 Markdown 的第一个 H1。

提交 Workflow artifact 的评论后，Dorey 会把 review 过程写回：

```text
runRoot/review/<artifactId>/
  revision-request-*.json
  revision-response-*.json
  review-result.json
  revised.md
```

评审和生成修订阶段不会直接覆盖原文件。点击“接受修订”后，`--review-file` / `--review-folder` 对应的原文件会在 hash 校验通过后原子替换，同时更新临时 artifact 和上述 hash；普通 workflow artifact 与 `--demo` 没有源文件映射，仍只写 `review/` 记录。

## Agent 返回格式

`QueuedComment.kind` 支持两种值：

- `revision`：要求修改 Markdown，也是字段缺失时的默认行为。
- `explanation`：在原 Agent 对话中回答问题，不得因此修改 Markdown。纯解释请求返回的 `revisedMarkdown` 必须与原文完全一致。

原 Agent 会话收到 payload 后，需要返回 `BatchRevisionResponse`：

```json
{
  "revisedMarkdown": "# Revised markdown...",
  "summary": "What changed.",
  "addressedComments": [
    {
      "commentId": "comment-1",
      "resolution": "How it was handled."
    }
  ]
}
```

字段含义：

- `revisedMarkdown`：完整修订后的 Markdown 文本。
- `summary`：本次修改摘要。
- `addressedComments`：逐条记录每个评论如何处理，供完成状态和 review trace 使用。解释正文由原 Agent 对话承载，Dorey 页面不重复展示。

## 项目结构

```text
src/app/
  App.tsx                         # 三栏 review workspace
  components/MarkdownDocument.tsx # react-markdown + remark-gfm 渲染
  components/MermaidDiagram.tsx   # Mermaid inline SVG 渲染
  components/DiffView.tsx         # 渲染态 Markdown diff 视图
  components/PlantUmlDiagram.tsx  # PlantUML inline SVG 渲染
  mermaid-renderer.ts              # Mermaid 客户端渲染器
  selection.ts                    # 单 block DOM selection anchor
  session-state.ts                # review session、snapshot、run history
  workflow-run-client.ts          # Workflow Run API client

src/contracts/
  artifact.ts                     # Artifact 和 workflow stage contract
  comment.ts                      # CommentAnchor 和 QueuedComment contract
  revision.ts                     # BatchRevisionRequest/Response 和 AgentAdapter
  session.ts                      # ReviewSession、ContextSnapshot、ReviewRunRecord

src/review/
  codex-agent-adapter.ts          # 浏览器侧 Codex HTTP adapter
  codex-desktop-agent-adapter.ts  # 浏览器侧 Codex Desktop adapter
  traex-agent-adapter.ts          # 浏览器侧 TraeX HTTP adapter
  diff.ts                         # rendered/inline diff helper
  popover-position.ts             # 评论弹窗定位

src/server/
  revision-agent-poll-cli.ts      # dorey CLI / launch / poll / status / stop
  revision-poll-broker.ts         # submit 队列和 payload 写入
  revision-poll-endpoint.ts       # poll / status / reply endpoint
  codex-revision-endpoint.ts      # Codex CLI submit endpoint
  codex-desktop-revision-endpoint.ts
  traex-revision-endpoint.ts      # TraeX submit endpoint
  workflow-run-loader.ts          # workflow-run.json loader
  workflow-run-endpoint.ts        # Workflow Run HTTP endpoint

src/workflow/
  *.ts                            # staged Markdown artifact generation engine

samples/
  technical-design.md             # 本地 review fallback sample

tests/
  *.test.ts                       # node:test 测试
```

## 已实现范围

- React + Vite + TypeScript 本地 Web app。
- Markdown 渲染：`react-markdown`、`remark-gfm`、`github-markdown-css`。
- PlantUML fenced code block 渲染为 inline SVG。
- 稳定 `data-block-id`，覆盖 heading、paragraph、list item、blockquote、code block、table、table row。
- 单 block 文本选择，记录 quote、blockId、startOffset、endOffset、prefix、suffix。
- 评论队列：新增、编辑、删除、清空、批量提交。
- Codex Desktop / Codex CLI / TraeX CLI queued submit flow。
- 原会话 poll/reply 闭环，不启动隐藏 `resume` 子进程。
- Session context editor：任务目标、阶段、上下文摘要、启动上下文、accepted history。
- Batch revision result：摘要、逐条处理、修订 Markdown、渲染态 diff。
- Markdown source editor：直接编辑当前 Markdown 源码，保存为 manual revision 并复用 diff / accept / review 写回链路。
- Accept：先校验并原子写回 `--review-file` / `--review-folder` 原文件；成功后更新当前 artifact、清空评论队列并记录 accepted run，冲突或写入失败则保留待接受状态。
- 单文档启动：显式 `--review-file` materialize 一次临时文档 workspace。
- 文件夹启动：显式 `--review-folder` 递归展示 Markdown 文件树，并支持相对图片资源。
- `--demo` 只打开内置 demo，不扫描调用目录。

## 暂不覆盖范围

- 跨 block 文本选择。
- 多人协同编辑。
- 富文本所见即所得编辑 rendered Markdown。
- 外部 LLM API 直连。
- 复杂 patch merge。
- 完整 workflow state machine 编排。
