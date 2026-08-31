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
      .getByRole("textbox", { name: "全文评论" })
      .fill(`Replace the document paragraph with: ${revisedParagraph}`);
    await page.getByRole("button", { name: "提交全部" }).click();
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
