# Dorey

Dorey 是 **Doc Review** 的缩写：一个面向 AI 编码产物的本地文档审阅闭环工具。

它的目标很简单：把 Markdown 技术文档放进一个本地 Web 工作台里，让人可以像评审文档一样选中文本、加评论、批量提交给当前 AI Agent 会话处理，也可以直接编辑 Markdown 源码，再把修订结果回写到页面和本地 review 目录。

## 核心能力

- 本地 Web UI：渲染 Markdown 产物，支持选中文本、添加评论、编辑评论、删除评论、批量提交，以及直接编辑 Markdown 源码。
- 原会话提交闭环：`Submit All` 不启动新的 `resume` 子进程，而是把 payload 写入本地队列，由启动 Dorey 的 Codex / TraeX 原会话通过 `dorey poll` 拉取。
- 多 Agent 入口：支持 Codex Desktop 原对话、Codex CLI 会话、TraeX CLI 会话。
- 会话上下文：每个文档至少关联一个 review session，submit payload 会携带任务目标、当前阶段、上下文摘要、关联会话和已接受历史。
- 修订结果视图：展示摘要、逐条处理结果、修订 Markdown、渲染态 diff，并支持 `接受` 把修订设为当前版本。
- 单文档入口：CLI 必须显式传入 `--review-file <file>` 或 `--demo`；不会从当前目录自动扫描 `.local` 或 workflow runs 后直接启动。
- PlantUML 渲染：Markdown 中的 `plantuml` fenced code block 会在编辑器里渲染为 inline SVG，并保留源码展开能力。

## 安装后启动

正常使用时，在 Codex / TraeX 会话所在的工作目录里显式指定要 review 的文档：

```bash
dorey --review-file path/to/design.md
```

当前版本只支持单文档 review。`--review-file` 接受 Markdown 文件，Dorey 会为这个文件生成一次临时 workflow run，左侧文档栏只围绕这个 review target 展示。

如果只是想打开 Dorey 自带的产品 demo：

```bash
dorey --demo
```

Demo 模式会在临时目录生成一份内置 workflow run，并在页面内明确提示当前打开的是 Dorey 内置 Demo，不是在审阅本地文件或仓库产物。

裸 `dorey` 命令不会启动 UI，也不会扫描目录；它只会打印当前支持的命令和选项。

默认地址：

```text
http://127.0.0.1:5175/
```

如果只想打开 UI 预览，不想让当前命令进入 poll 等待，仍然需要显式指定文件或 demo：

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

1. 使用 `dorey --review-file <file>` 或 `dorey --demo` 打开 Dorey Web UI。
2. 在左侧或中间文档区选择一个 Markdown 产物。
3. 在渲染后的文档中选中文本。
4. 点击 `添加评论`。
5. 输入评论内容，选择评论类型，点击 `添加`。
6. 多条评论会进入右侧评论队列。
7. 点击 `提交全部`。
8. Dorey 会把完整 payload 写到 `.local/markdown-review-submits/.../payload.json`，并把本次请求排队给原 Agent 会话。
9. 原会话里的 `dorey poll` 收到 payload 后，根据评论修订 Markdown，并把 `BatchRevisionResponse` POST 回页面给出的 reply endpoint。
10. 页面展示 `本次返回`、`已处理评论`、`修订信息`、`差异`。
11. 点击 `接受修订` 后，当前文档更新，评论队列清空，run history 记录为 accepted。

如果只是想删掉一段话或改几个字，也可以在 Markdown 文档上点击 `编辑 Markdown`，修改源码后点击 `保存为修订`；页面会生成普通修订、展示 diff，并在 `接受修订` 后写入 review 结果。

## 原会话 Poll 机制

Dorey 的 submit 是 AXI-style pull loop：

```text
Browser Submit All
  -> POST /api/agent/<target>/revise
  -> server writes .local/markdown-review-submits/<target>-<id>/payload.json
  -> server returns dorey poll / raw poll / reply commands
  -> original Codex/TraeX session runs dorey poll --target <target>
  -> original session reads payload and produces BatchRevisionResponse
  -> original session POSTs /api/agent/submissions/<id>/reply
  -> browser shows revision / diff / accept controls
```

这个机制刻意不走 `codex exec resume` 或 `traex exec resume`。原因是：修改方案需要原会话上下文，Dorey 要让 prompt 和 payload 回到启动它的那个 Agent 会话里，而不是开一个用户看不见的新上下文。

## CLI 命令

```bash
dorey --review-file README.md # review 单个 Markdown 文档
dorey --demo                  # 打开 Dorey 自带产品 demo
dorey poll                    # 在原 agent session 中等待 submit payload
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

`dorey --review-file <file>`、`dorey --demo` 和 `dorey poll` 会自动读取这些环境变量：

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

## Workflow Run Loader

Dorey 的 Web server 仍然通过 workflow run contract 读取文档，但 CLI 不再从当前工作目录自动发现 workflow root。启动时只有两个来源：

- `dorey --review-file <file>`：把指定的单个 Markdown 文件复制到临时 workflow run。
- `dorey --demo`：在临时目录生成 Dorey 内置 demo workflow run。

临时单文档 run 的结构仍然是：

```text
workflow-root/
  <run-id>/
    workflow-run.json
    md/<review-file>
    review/
```

Web server 读取每个 run 下的：

```text
workflow-run.json
artifacts
review
```

默认用户可见文件：

- Markdown 文件

默认隐藏：

- scratch 草稿目录
- metadata 元数据目录
- JSON / PlantUML 等内部产物

在 UI 中勾选 `显示隐藏产物` 后，可以查看这些内部产物。单文档入口默认只产生一个用户文档 artifact。

提交 Workflow artifact 的评论后，Dorey 会把 review 过程写回：

```text
runRoot/review/<artifactId>/
  revision-request-*.json
  revision-response-*.json
  review-result.json
  revised.md
```

原始 artifact 文件不会被直接覆盖。

## Agent 返回格式

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
- `addressedComments`：逐条说明每个评论如何处理。

## 项目结构

```text
src/app/
  App.tsx                         # 三栏 review workspace
  components/MarkdownDocument.tsx # react-markdown + remark-gfm 渲染
  components/DiffView.tsx         # 渲染态 Markdown diff 视图
  components/PlantUmlDiagram.tsx  # PlantUML inline SVG 渲染
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
- 评论队列：新增、编辑、删除、清空、分类、批量提交。
- Codex Desktop / Codex CLI / TraeX CLI queued submit flow。
- 原会话 poll/reply 闭环，不启动隐藏 `resume` 子进程。
- Session context editor：任务目标、阶段、上下文摘要、启动上下文、accepted history。
- Batch revision result：摘要、逐条处理、修订 Markdown、渲染态 diff。
- Markdown source editor：直接编辑当前 Markdown 源码，保存为 manual revision 并复用 diff / accept / review 写回链路。
- Accept：更新当前 artifact，清空评论队列，记录 accepted run。
- 单文档启动：显式 `--review-file` materialize 一次临时 workflow run；`--demo` 只打开内置 demo，不扫描调用目录。

## 暂不覆盖范围

- 跨 block 文本选择。
- 多人协同编辑。
- 富文本所见即所得编辑 rendered Markdown。
- 外部 LLM API 直连。
- 复杂 patch merge。
- 完整 workflow state machine 编排。
