import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type ViteDevServer } from "vite";

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
      .toBe(0);

    await page.getByRole("button", { name: "接受修订" }).click();

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
  } finally {
    await server?.close();
    restoreEnv(previousEnv);
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

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
