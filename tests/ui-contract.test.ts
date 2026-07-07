import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("review workspace UI contract", () => {
  it("keeps the markdown document column independently scrollable", async () => {
    const styles = await readFile("src/app/styles.css", "utf8");

    assert.match(styles, /\.reader-column\s*{[^}]*min-height:\s*0;/s);
    assert.match(styles, /\.reader-column\s*{[^}]*overflow:\s*hidden;/s);
    assert.match(styles, /\.document-stage\s*{[^}]*overflow:\s*auto;/s);
    assert.match(styles, /\.document-stage\s*{[^}]*overscroll-behavior:\s*contain;/s);
  });

  it("uses Chinese UI copy and removes low/medium/high severity controls", async () => {
    const appSource = await readFile("src/app/App.tsx", "utf8");
    const indexHtml = await readFile("index.html", "utf8");
    const packageJson = await readFile("package.json", "utf8");
    const styles = await readFile("src/app/styles.css", "utf8");

    assert.match(appSource, /Dorey/);
    assert.match(appSource, /Doc Review/);
    assert.match(appSource, /Powered by JO/);
    assert.match(appSource, /aria-label="播放 Dorey 发音"/);
    assert.match(appSource, /dorey-pronunciation\.m4a\?url/);
    assert.match(appSource, /new Audio\(doreyPronunciationUrl\)/);
    assert.match(styles, /\.sidebar-heading\s*{[^}]*border-bottom:\s*1px solid #edf1f5;[^}]*display:\s*grid;/s);
    assert.match(styles, /\.sidebar-heading h1\s*{[^}]*font-size:\s*28px;/s);
    assert.match(styles, /\.sidebar-brand-row\s*{[^}]*justify-content:\s*space-between;/s);
    assert.match(styles, /\.pronunciation-button\s*{[^}]*height:\s*18px;[^}]*width:\s*18px;/s);
    assert.match(indexHtml, /<title>Dorey<\/title>/);
    assert.match(packageJson, /"name": "dorey"/);
    assert.match(appSource, /评论队列/);
    assert.match(appSource, /提交全部/);
    assert.doesNotMatch(appSource, /CommentSeverity|Draft severity|Severity/);
    assert.doesNotMatch(appSource, /\b(low|medium|high)\b/);
  });

  it("does not expose a mock agent mode in the workspace UI", async () => {
    const appSource = await readFile("src/app/App.tsx", "utf8");
    const sessionContract = await readFile("src/contracts/session.ts", "utf8");

    assert.doesNotMatch(appSource, /模拟 Agent|MockAgentAdapter|value="mock"/);
    assert.doesNotMatch(sessionContract, /"mock"/);
  });

  it("does not expose web-only review session creation", async () => {
    const appSource = await readFile("src/app/App.tsx", "utf8");

    assert.doesNotMatch(appSource, /createSessionForActiveArtifact/);
    assert.doesNotMatch(appSource, />新建</);
  });

  it("defaults workflow runs to user-facing documents and hides internals", async () => {
    const appSource = await readFile("src/app/App.tsx", "utf8");

    assert.match(appSource, /Workflow Runs/);
    assert.match(appSource, /显示隐藏产物/);
    assert.match(appSource, /isDefaultUserVisibleArtifact/);
    assert.match(appSource, /workflow\.group !== "scratch"/);
    assert.match(appSource, /workflow\.group !== "metadata"/);
    assert.match(appSource, /workflow\.kind === "markdown"/);
    assert.match(appSource, /workflow\.kind === "html"/);
    assert.match(appSource, /Scratch 草稿/);
    assert.match(appSource, /Document 发布文档/);
    assert.match(appSource, /Execution 执行/);
    assert.match(appSource, /Metadata 元数据/);
    assert.match(appSource, /只读产物不支持评论/);
  });

  it("renders PlantUML fenced code blocks with the client-side PlantUML engine", async () => {
    const packageJson = await readFile("package.json", "utf8");
    const markdownDocument = await readFile(
      "src/app/components/MarkdownDocument.tsx",
      "utf8",
    );
    const plantUmlDiagram = await readFile(
      "src/app/components/PlantUmlDiagram.tsx",
      "utf8",
    );
    const plantUmlRenderer = await readFile(
      "src/app/plantuml-renderer.ts",
      "utf8",
    );

    assert.match(packageJson, /"@plantuml\/core"/);
    assert.match(markdownDocument, /PlantUmlDiagram/);
    assert.match(markdownDocument, /language-plantuml/);
    assert.match(plantUmlDiagram, /dangerouslySetInnerHTML/);
    assert.match(plantUmlDiagram, /显示源码/);
    assert.match(plantUmlRenderer, /@plantuml\/core/);
    assert.match(plantUmlRenderer, /renderToString/);
    assert.match(plantUmlRenderer, /renderQueue/);
  });

  it("keeps long cross-block selections commentable with a document anchor", async () => {
    const markdownDocument = await readFile(
      "src/app/components/MarkdownDocument.tsx",
      "utf8",
    );
    const selectionSource = await readFile("src/app/selection.ts", "utf8");

    assert.match(markdownDocument, /\$\{artifactId\}:document:1/);
    assert.match(selectionSource, /documentBlock/);
    assert.match(
      selectionSource,
      /const anchorBlock = startBlock === endBlock \? startBlock : documentBlock;/,
    );
    assert.doesNotMatch(
      selectionSource,
      /startBlock\s*!==\s*endBlock[\s\S]{0,80}return null;/,
    );
  });

  it("keeps PlantUML diagrams mounted during unrelated workspace edits", async () => {
    const appSource = await readFile("src/app/App.tsx", "utf8");
    const markdownDocument = await readFile(
      "src/app/components/MarkdownDocument.tsx",
      "utf8",
    );

    assert.match(appSource, /const handleSelectionMouseUp = useCallback/);
    assert.match(markdownDocument, /import \{ Children, isValidElement, memo \}/);
    assert.match(markdownDocument, /export const MarkdownDocument = memo/);
  });

  it("keeps Codex submit results readable and explains execution visibility", async () => {
    const appSource = await readFile("src/app/App.tsx", "utf8");
    const bootstrapSource = await readFile("src/app/bootstrap.ts", "utf8");
    const styles = await readFile("src/app/styles.css", "utf8");
    const viteConfig = await readFile("vite.config.ts", "utf8");

    assert.match(appSource, /本次返回/);
    assert.match(appSource, /已处理评论/);
    assert.match(appSource, /写回文件/);
    assert.match(appSource, /执行可见性/);
    assert.match(appSource, /Codex Desktop（原对话）/);
    assert.match(appSource, /等待原 Agent 会话处理/);
    assert.match(appSource, /配置原会话命令/);
    assert.match(appSource, /Payload 文件/);
    assert.match(appSource, /Raw Poll 命令/);
    assert.match(appSource, /Reply 命令/);
    assert.match(appSource, /poll 队列/);
    assert.match(appSource, /排队/);
    assert.match(appSource, /未绑定 CLI 会话/);
    assert.match(appSource, /当前是本地预览模式/);
    assert.match(appSource, /Dorey 没有检测到可承载任务上下文的 Codex\/TraeX 会话/);
    assert.match(appSource, /Submit All 不会自动回到 Agent 对话中处理/);
    assert.match(appSource, /isPreviewOnlyLaunch/);
    assert.match(appSource, /doreyMode/);
    const previewWarningIndex = appSource.indexOf("当前是本地预览模式");
    const agentDetailsIndex = appSource.indexOf('className="agent-debug-details"');
    const adapterSelectIndex = appSource.indexOf('aria-label="Agent 适配器"');
    const sessionContextIndex = appSource.indexOf('className="session-context"');
    assert.ok(previewWarningIndex > -1);
    assert.ok(agentDetailsIndex > previewWarningIndex);
    assert.ok(adapterSelectIndex > agentDetailsIndex);
    assert.ok(sessionContextIndex > agentDetailsIndex);
    assert.match(bootstrapSource, /previewOnly\?: boolean/);
    assert.match(viteConfig, /process\.env\.DOREY_PREVIEW_ONLY === "1" \|\| !launcherContext/);
    assert.match(styles, /\.session-launch-warning\s*{[^}]*border-left:\s*3px solid #d97706;/s);
    assert.match(viteConfig, /codex-desktop\/revise/);
    assert.match(styles, /\.result-text\s*{[^}]*white-space:\s*pre-wrap;/s);
    assert.doesNotMatch(styles, /\.agent-result\s*{[^}]*max-height:/s);
    assert.doesNotMatch(styles, /\.run-history\s*{[^}]*max-height:/s);
  });

  it("keeps demo and no-agent launch notices visible", async () => {
    const appSource = await readFile("src/app/App.tsx", "utf8");
    const bootstrapSource = await readFile("src/app/bootstrap.ts", "utf8");
    const viteConfig = await readFile("vite.config.ts", "utf8");

    assert.match(bootstrapSource, /launchMode\?: "single-file" \| "demo"/);
    assert.match(appSource, /bootstrap\.launchMode === "demo"/);
    assert.match(appSource, /内置 Demo/);
    assert.match(appSource, /不是在审阅本地文件或仓库产物/);
    assert.match(appSource, /不会自动回到 Agent 对话/);
    assert.match(viteConfig, /DoreyLaunchMode/);
    assert.match(viteConfig, /DOREY_LAUNCH_MODE/);
    assert.match(viteConfig, /DOREY_PREVIEW_ONLY/);
  });

  it("keeps the real review sidebar compact without removing queue editing", async () => {
    const appSource = await readFile("src/app/App.tsx", "utf8");
    const styles = await readFile("src/app/styles.css", "utf8");

    const queuePanelIndex = appSource.indexOf('className="queue-panel"');
    const globalPanelIndex = appSource.indexOf('className="global-comment-panel"');
    const agentPanelIndex = appSource.indexOf('className="agent-panel"');
    const globalTextareaIndex = appSource.indexOf('className="global-instruction"');
    const submitButtonIndex = appSource.indexOf('className="submit-button compact-submit"');

    assert.ok(queuePanelIndex > -1);
    assert.ok(globalPanelIndex > queuePanelIndex);
    assert.ok(agentPanelIndex > globalPanelIndex);
    assert.ok(globalTextareaIndex > globalPanelIndex);
    assert.ok(submitButtonIndex > globalTextareaIndex);
    assert.ok(submitButtonIndex < agentPanelIndex);

    assert.match(appSource, /expandedCommentId/);
    assert.match(appSource, /setExpandedCommentId/);
    assert.match(appSource, /comment-item compact/);
    assert.match(appSource, /comment-edit-area/);
    assert.match(appSource, /comment-body-preview/);
    assert.match(appSource, /agent-debug-details/);
    assert.match(appSource, /aria-label="Agent 适配器"/);
    assert.match(appSource, /CLI 会话 ID/);
    assert.doesNotMatch(appSource, /批量分类/);

    assert.match(styles, /\.app-shell\s*{[^}]*grid-template-columns:\s*212px minmax\(0,\s*1fr\) 488px;/s);
    assert.match(styles, /\.review-sidebar\s*{[^}]*grid-template-rows:\s*minmax\(390px,\s*1fr\) auto minmax\(210px,\s*0\.48fr\);/s);
    assert.match(styles, /\.comment-list\s*{[^}]*gap:\s*5px;[^}]*overflow:\s*auto;/s);
    assert.match(styles, /\.comment-item\.compact\s*{[^}]*gap:\s*4px;[^}]*padding:\s*6px 7px;/s);
    assert.match(styles, /\.comment-item blockquote\s*{[^}]*border-left:\s*2px solid #2f6fed;[^}]*font-size:\s*12px;[^}]*line-height:\s*1\.35;[^}]*-webkit-line-clamp:\s*1;/s);
    assert.match(styles, /\.comment-body-preview\s*{[^}]*font-size:\s*12px;[^}]*line-height:\s*1\.35;[^}]*-webkit-line-clamp:\s*1;/s);
    assert.match(styles, /\.global-instruction\s*{[^}]*font-size:\s*12px;[^}]*min-height:\s*46px;/s);
    assert.match(styles, /\.compact-submit\s*{[^}]*min-height:\s*30px;[^}]*min-width:\s*132px;/s);
    assert.match(appSource, /const hasSubmitContent =\s*commentsForArtifact\.length > 0 \|\|\s*globalInstruction\.trim\(\)\.length > 0;/s);
    assert.match(appSource, /const canSubmit =\s*hasSubmitContent &&/s);
    assert.match(appSource, /全文评论（可选）/);
    assert.match(appSource, /评论队列或全文评论有内容即可提交/);
    assert.match(appSource, /只显示会影响提交去向的信息/);
    assert.match(appSource, /调试详情/);
    assert.match(styles, /\.compact-popover \.icon-button\.primary\s*{[^}]*justify-self:\s*center;[^}]*min-height:\s*30px;[^}]*width:\s*auto;/s);
  });

  it("exposes direct Markdown source editing as a manual review revision", async () => {
    const appSource = await readFile("src/app/App.tsx", "utf8");
    const styles = await readFile("src/app/styles.css", "utf8");
    const workflowClient = await readFile("src/app/workflow-run-client.ts", "utf8");

    assert.match(appSource, /sourceEditDraft/);
    assert.match(appSource, /applyManualSourceEdit/);
    assert.match(appSource, /编辑 Markdown/);
    assert.match(appSource, /发布为修订/);
    assert.match(appSource, /adapterName:\s*"manual"/);
    assert.match(workflowClient, /"codex" \| "traex" \| "manual"/);
    assert.match(styles, /\.source-editor\s*{/);
    assert.match(styles, /\.source-editor textarea\s*{/);
  });

  it("documents the public review launch and poll contracts", async () => {
    const readme = await readFile("README.md", "utf8");
    const cliSource = await readFile("src/server/revision-agent-poll-cli.ts", "utf8");

    assert.match(readme, /dorey --review-file path\/to\/design\.md/);
    assert.match(readme, /dorey --demo/);
    assert.match(readme, /dorey poll/);
    assert.match(readme, /Submit All/);
    assert.match(readme, /Markdown 源码/);
    assert.match(readme, /review-result\.json/);
    assert.match(cliSource, /Missing review target/);
    assert.match(cliSource, /Open the built-in Dorey product demo/);
    assert.doesNotMatch(readme, /模拟 Agent|MockAgentAdapter/);
  });
});
