import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type ViteDevServer } from "vite";

import { prepareDoreyLaunchWorkspace } from "../../src/server/revision-agent-poll-cli.js";

import { createWorkflowRunFixture } from "../workflow-run-test-fixture.js";

const targetKey = "codex-desktop:browser-regression-thread";
const revisedParagraph = "Browser regression completed automatically.";

test("DOR-BROWSER-P0-001: submit -> foreground feedback -> reply -> automatic UI refresh -> review closed", async ({
  page,
}) => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "dorey-browser-regression-"));
  const workflowRoot = path.join(workspaceRoot, "workflow-runs");
  const stateRoot = path.join(workspaceRoot, "state");
  const previousEnv = captureEnv([
    "AI_CODING_WORKFLOW_ROOT",
    "CODEX_THREAD_ID",
    "DOREY_AUTO_STOP_ON_REPLY",
    "DOREY_DELIVERY_MODE",
    "DOREY_LAUNCH_MODE",
    "DOREY_PREVIEW_ONLY",
    "DOREY_STATE_ROOT",
    "DOREY_WORKSPACE_ROOT",
  ]);
  let server: ViteDevServer | undefined;
  let closePollController: AbortController | undefined;

  try {
    await createWorkflowRunFixture(workflowRoot, "browser-regression-run");
    process.env.AI_CODING_WORKFLOW_ROOT = workflowRoot;
    process.env.CODEX_THREAD_ID = "browser-regression-thread";
    process.env.DOREY_AUTO_STOP_ON_REPLY = "0";
    process.env.DOREY_DELIVERY_MODE = "foreground";
    process.env.DOREY_LAUNCH_MODE = "single-file";
    process.env.DOREY_PREVIEW_ONLY = "0";
    process.env.DOREY_STATE_ROOT = stateRoot;
    process.env.DOREY_WORKSPACE_ROOT = workspaceRoot;

    server = await createServer({
      configFile: path.resolve("vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
      },
    });
    await server.listen();

    const address = server.httpServer?.address() as AddressInfo | null;
    expect(address).not.toBeNull();
    const baseUrl = `http://127.0.0.1:${address!.port}`;

    await page.goto(baseUrl);
    await expect(page.getByRole("heading", { level: 1, name: "Dorey" })).toBeVisible();
    await expect(page.getByText("技术方案：配置快照发布", { exact: true }).first()).toBeVisible();

    const feedbackPoll = fetch(
      `${baseUrl}/api/agent/poll?target=${encodeURIComponent(targetKey)}&clientId=browser-e2e&timeoutMs=30000`,
    );
    await expect(page.getByText(/正在监听/)).toBeVisible({ timeout: 10_000 });

    await page
      .getByRole("textbox", { name: "全文修订要求" })
      .fill(`Replace the document paragraph with: ${revisedParagraph}`);
    await page.getByRole("button", { name: "提交修订" }).click();
    await expect(page.getByRole("heading", { name: "等待原 Agent 会话处理" })).toBeVisible();

    const feedbackResponse = await feedbackPoll;
    expect(feedbackResponse.ok).toBe(true);
    const feedback = (await feedbackResponse.json()) as {
      requestId?: string;
      status?: string;
    };
    expect(feedback.status).toBe("feedback");
    expect(feedback.requestId).toBeTruthy();

    const replyResponse = await fetch(
      `${baseUrl}/api/agent/submissions/${encodeURIComponent(feedback.requestId!)}/reply`,
      {
        body: JSON.stringify({
          addressedComments: [],
          revisedMarkdown: `# 技术方案：配置快照发布\n\n## 需求详情\n\n${revisedParagraph}\n`,
          summary: "Applied the browser regression revision.",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    );
    expect(replyResponse.ok).toBe(true);
    expect(await replyResponse.json()).toEqual({
      requestId: feedback.requestId,
      status: "completed",
    });

    await expect(page.getByText(revisedParagraph, { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("heading", { name: "本次返回" })).toBeVisible();
    await expect(page.getByRole("button", { exact: true, name: "修订" })).toBeEnabled();

    await expect
      .poll(async () => {
        const response = await fetch(
          `${baseUrl}/api/agent/submissions?target=${encodeURIComponent(targetKey)}&unacknowledged=1`,
        );
        const body = (await response.json()) as { submissions?: unknown[] };
        return body.submissions?.length;
      })
      .toBe(1);

    await page.getByRole("button", { name: "接受修订" }).click();
    await expect.poll(async () => {
      const response = await fetch(`${baseUrl}/api/agent/submissions?target=${encodeURIComponent(targetKey)}&unacknowledged=1`);
      return (await response.json()).submissions.length;
    }).toBe(0);

    closePollController = new AbortController();
    const closePoll = fetch(
      `${baseUrl}/api/agent/poll?target=${encodeURIComponent(targetKey)}&clientId=browser-e2e&timeoutMs=30000`,
      { signal: closePollController.signal },
    );
    await expect(page.getByText(/正在监听/)).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "结束评审" }).click();

    const closedResponse = await closePoll;
    expect(closedResponse.ok).toBe(true);
    expect(await closedResponse.json()).toMatchObject({
      status: "review_closed",
      targetKey,
    });
    closePollController = undefined;

    await expect(page.getByRole("button", { name: "评审已结束" })).toBeDisabled();
    await expect(page.getByText("评审已结束；foreground poll 已停止。", { exact: true })).toBeVisible();
  } finally {
    closePollController?.abort();
    await server?.close();
    restoreEnv(previousEnv);
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test("explanation comments are acknowledged in Dorey and answered in the original conversation", async ({
  page,
}) => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "dorey-browser-explanation-"));
  const workflowRoot = path.join(workspaceRoot, "workflow-runs");
  const stateRoot = path.join(workspaceRoot, "state");
  const previousEnv = captureEnv([
    "AI_CODING_WORKFLOW_ROOT",
    "CODEX_THREAD_ID",
    "DOREY_AUTO_STOP_ON_REPLY",
    "DOREY_DELIVERY_MODE",
    "DOREY_LAUNCH_MODE",
    "DOREY_PREVIEW_ONLY",
    "DOREY_STATE_ROOT",
    "DOREY_WORKSPACE_ROOT",
  ]);
  let server: ViteDevServer | undefined;

  try {
    await createWorkflowRunFixture(workflowRoot, "browser-explanation-run");
    process.env.AI_CODING_WORKFLOW_ROOT = workflowRoot;
    process.env.CODEX_THREAD_ID = "browser-regression-thread";
    process.env.DOREY_AUTO_STOP_ON_REPLY = "0";
    process.env.DOREY_DELIVERY_MODE = "foreground";
    process.env.DOREY_LAUNCH_MODE = "single-file";
    process.env.DOREY_PREVIEW_ONLY = "0";
    process.env.DOREY_STATE_ROOT = stateRoot;
    process.env.DOREY_WORKSPACE_ROOT = workspaceRoot;

    server = await createServer({
      configFile: path.resolve("vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
      },
    });
    await server.listen();

    const address = server.httpServer?.address() as AddressInfo | null;
    expect(address).not.toBeNull();
    const baseUrl = `http://127.0.0.1:${address!.port}`;

    await page.goto(baseUrl);
    const sourceParagraph = page
      .locator(".review-markdown")
      .getByText("当前 demo 用于本地审阅闭环验证。", { exact: true });
    await expect(sourceParagraph).toBeVisible();
    await sourceParagraph.evaluate((element) => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });

    await page.getByRole("button", { exact: true, name: "评论" }).click();
    const commentKindControl = page.getByRole("group", { name: "评论类型" });
    const revisionKind = commentKindControl.getByRole("button", {
      exact: true,
      name: "修订",
    });
    await expect(revisionKind).toHaveAttribute("aria-pressed", "true");
    await commentKindControl
      .getByRole("button", { exact: true, name: "解释" })
      .click();
    await expect(page.getByText("Agent 会在原对话回答，不修改原文。")).toBeVisible();
    await page.getByPlaceholder("你想了解什么？").fill("这里为什么叫闭环？");
    await page.getByRole("button", { name: "添加解释" }).click();
    await expect(page.getByText("0 条修订 · 1 条解释")).toBeVisible();

    const feedbackPoll = fetch(
      `${baseUrl}/api/agent/poll?target=${encodeURIComponent(targetKey)}&clientId=browser-explanation&timeoutMs=30000`,
    );
    await expect(page.getByText(/正在监听/)).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "提交问题" }).click();

    const feedbackResponse = await feedbackPoll;
    expect(feedbackResponse.ok).toBe(true);
    const feedback = (await feedbackResponse.json()) as {
      request?: { comments?: Array<{ id?: string; kind?: string }> };
      requestId?: string;
    };
    expect(feedback.request?.comments?.[0]?.kind).toBe("explanation");

    const commentId = feedback.request?.comments?.[0]?.id;
    const replyResponse = await fetch(
      `${baseUrl}/api/agent/submissions/${encodeURIComponent(feedback.requestId!)}/reply`,
      {
        body: JSON.stringify({
          addressedComments: [
            {
              commentId,
              resolution: "这里的闭环指评论、处理结果和确认动作都在同一条评审链路中。",
            },
          ],
          revisedMarkdown: "# Agent 不应写入的内容\n",
          summary: "回答了解释型评论。",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    );
    expect(replyResponse.ok).toBe(true);

    await expect(
      page.getByText("1 个问题已在原 Agent 对话中回答。", { exact: true }),
    ).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("heading", { name: "Agent 解释" })).toHaveCount(0);
    await expect(
      page.getByText("这里的闭环指评论、处理结果和确认动作都在同一条评审链路中。"),
    ).toHaveCount(0);
    await expect(sourceParagraph).toBeVisible();
    await expect(page.getByText("Agent 不应写入的内容")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "接受修订" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "查看差异" })).toHaveCount(0);
    await expect(page.getByText("0 条修订 · 0 条解释")).toBeVisible();
    await expect.poll(async () => {
      const response = await fetch(`${baseUrl}/api/agent/submissions?target=${encodeURIComponent(targetKey)}&unacknowledged=1`);
      return (await response.json()).submissions.length;
    }).toBe(0);
    await page.reload();
    await expect(sourceParagraph).toBeVisible();
    await expect(page.getByRole("button", { name: "接受修订" })).toHaveCount(0);
  } finally {
    await server?.close();
    restoreEnv(previousEnv);
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});


for (const mode of ["accept", "conflict", "ack-retry", "resubmit"]) {
  test(`DOR-P0-008: mixed revision survives refresh (${mode})`, async ({ page }) => {
    const root = await mkdtemp(path.join(tmpdir(), "dorey-pending-revision-"));
    const sourcePath = path.join(root, "review.md");
    const original = "# Recovery test\n\nReview requires submission and acceptance.\n";
    const revised = original.replace("submission and acceptance", "submission, processing and acceptance");
    await writeFile(sourcePath, original);
    const launch = await prepareDoreyLaunchWorkspace({ launchMode: "single-file", reviewFilePath: sourcePath });
    const previousEnv = captureEnv([
      "AI_CODING_WORKFLOW_ROOT", "CODEX_THREAD_ID", "DOREY_AUTO_STOP_ON_REPLY",
      "DOREY_DELIVERY_MODE", "DOREY_LAUNCH_MODE", "DOREY_PREVIEW_ONLY",
      "DOREY_STATE_ROOT", "DOREY_WORKSPACE_ROOT",
    ]);
    let server: ViteDevServer | undefined;
    try {
      process.env.AI_CODING_WORKFLOW_ROOT = launch.workflowRoot;
      process.env.CODEX_THREAD_ID = "browser-regression-thread";
      process.env.DOREY_AUTO_STOP_ON_REPLY = "0";
      process.env.DOREY_DELIVERY_MODE = "foreground";
      process.env.DOREY_LAUNCH_MODE = "single-file";
      process.env.DOREY_PREVIEW_ONLY = "0";
      process.env.DOREY_STATE_ROOT = path.join(root, "state");
      process.env.DOREY_WORKSPACE_ROOT = launch.workspaceRoot;
      server = await createServer({
        configFile: path.resolve("vite.config.ts"),
        server: { host: "127.0.0.1", port: 0, strictPort: false },
      });
      await server.listen();
      const baseUrl = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
      const pendingResults = async () => {
        const response = await fetch(`${baseUrl}/api/agent/submissions?target=${encodeURIComponent(targetKey)}&unacknowledged=1`);
        return (await response.json()).submissions as Array<{ requestId: string; status: string }>;
      };
      await page.goto(baseUrl);
      const paragraph = page.locator(".review-markdown").getByText("Review requires submission and acceptance.", { exact: true });
      await expect(paragraph).toBeVisible();
      for (const kind of ["修订", "解释"]) {
        await paragraph.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });
        await page.getByRole("button", { name: "评论", exact: true }).click();
        await page.getByRole("group", { name: "评论类型" }).getByRole("button", { name: kind, exact: true }).click();
        await page.getByRole("textbox", { name: kind === "修订" ? "说明希望如何修改" : "你想了解什么？" }).fill(kind === "修订" ? "Add processing to the review steps." : "Why is acceptance required?");
        await page.getByRole("button", { name: `添加${kind}` }).click();
      }
      const poll = fetch(`${baseUrl}/api/agent/poll?target=${encodeURIComponent(targetKey)}&clientId=recovery-browser&timeoutMs=30000`);
      await expect(page.getByText(/正在监听/)).toBeVisible();
      await page.getByRole("button", { name: "提交全部" }).click();
      const feedback = await (await poll).json();
      expect(feedback.request.comments.map((comment: { kind: string }) => comment.kind)).toEqual(["revision", "explanation"]);
      const reply = await fetch(`${baseUrl}/api/agent/submissions/${feedback.requestId}/reply`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revisedMarkdown: revised, summary: "Added processing; answered in the original conversation.",
          addressedComments: feedback.request.comments.map((comment: { id: string; kind: string }) => ({
            commentId: comment.id, resolution: comment.kind === "revision" ? "Added processing." : "Explanation must stay in the original conversation.",
          })),
        }),
      });
      expect(reply.ok).toBe(true);
      await expect(page.getByRole("button", { name: "接受修订" })).toBeVisible();
      expect(await readFile(sourcePath, "utf8")).toBe(original);
      // This was the missing boundary: the result has already reached the UI.
      await page.reload();
      await expect(page.getByRole("button", { name: "接受修订" })).toBeVisible();
      await expect(page.getByText("Review requires submission, processing and acceptance.", { exact: true })).toBeVisible();
      await expect(page.getByText("1 条修订 · 0 条解释")).toBeVisible();
      await expect(page.getByText("1 个问题已在原 Agent 对话中回答。", { exact: true })).toBeVisible();
      await expect(page.getByText("Explanation must stay in the original conversation.", { exact: true })).toHaveCount(0);
      expect(await pendingResults()).toEqual([expect.objectContaining({ requestId: feedback.requestId, status: "completed" })]);
      if (mode === "resubmit") {
        const nextPoll = fetch(`${baseUrl}/api/agent/poll?target=${encodeURIComponent(targetKey)}&clientId=recovery-browser&timeoutMs=30000`);
        await page.getByRole("button", { name: "提交修订" }).click();
        const nextFeedback = await (await nextPoll).json();
        expect(nextFeedback.requestId).not.toBe(feedback.requestId);
        const nextReply = await fetch(`${baseUrl}/api/agent/submissions/${nextFeedback.requestId}/reply`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revisedMarkdown: revised, summary: "Newer proposal.", addressedComments: [] }),
        });
        expect(nextReply.ok).toBe(true);
        await expect(page.getByText("Newer proposal.", { exact: true }).first()).toBeVisible();
        expect(await pendingResults()).toHaveLength(2);
      }
      await page.getByRole("button", { name: "查看差异" }).click();
      await expect(page.locator(".diff-view")).toBeVisible();
      if (mode === "conflict") {
        await writeFile(sourcePath, "# External edit\n");
        await page.getByRole("button", { name: "接受修订" }).click();
        await expect(page.getByText(/接受修订写回失败/)).toBeVisible();
        expect(await readFile(sourcePath, "utf8")).toBe("# External edit\n");
        await page.reload();
        await expect(page.getByRole("button", { name: "接受修订" })).toBeVisible();
        expect(await pendingResults()).toHaveLength(1);
        await writeFile(sourcePath, original);
      }
      if (mode === "ack-retry") {
        await page.route("**/acknowledge", (route) => route.fulfill({ status: 503, body: "temporary acknowledgement failure" }));
        await page.getByRole("button", { name: "接受修订" }).click();
        await expect(page.getByText(/修订已写回，但确认结果失败/)).toBeVisible();
        expect(await readFile(sourcePath, "utf8")).toBe(revised);
        expect(await pendingResults()).toHaveLength(1);
        await page.unroute("**/acknowledge");
        await page.reload();
        await expect(page.getByRole("button", { name: "接受修订" })).toBeVisible();
      }
      await page.getByRole("button", { name: "接受修订" }).click();
      await expect.poll(() => readFile(sourcePath, "utf8")).toBe(revised);
      await expect.poll(pendingResults).toEqual([]);
      await page.reload();
      await expect(page.getByText("Review requires submission, processing and acceptance.", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "接受修订" })).toHaveCount(0);
      expect(await pendingResults()).toEqual([]);
    } finally {
      await server?.close();
      restoreEnv(previousEnv);
      await rm(root, { recursive: true, force: true });
      await rm(launch.workspaceRoot, { recursive: true, force: true });
    }
  });
}

function captureEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(previousEnv: Map<string, string | undefined>): void {
  for (const [key, value] of previousEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
