import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type {
  Artifact,
  BatchRevisionRequest,
  ContextSnapshot,
  QueuedComment,
  ReviewSession,
} from "../src/contracts/index.js";
import {
  buildCodexDesktopPayload,
  buildCodexDesktopTurnPrompt,
  buildCodexAppServerMessages,
  parseCodexDesktopRevisionOutput,
  resolveDefaultCodexDesktopBin,
  resolveCodexDesktopThreadId,
} from "../src/server/codex-desktop-adapter.js";
import { handleCodexDesktopRevisionRequest } from "../src/server/codex-desktop-revision-endpoint.js";
import { createRevisionPollBroker } from "../src/server/revision-poll-broker.js";
import { CodexDesktopAgentAdapter } from "../src/review/codex-desktop-agent-adapter.js";

const artifact: Artifact = {
  id: "sample-technical-design",
  stage: "technical_design",
  title: "技术方案：配置快照发布",
  markdown:
    "# 技术方案：配置快照发布\n\n## 方案\n\n优先复用已有发布链路。\n",
};

const comment: QueuedComment = {
  id: "comment-1",
  artifactId: "sample-technical-design",
  anchor: {
    blockId: "sample-technical-design:p:4",
    startOffset: 0,
    endOffset: 8,
    quote: "复用已有发布链路",
  },
  body: "把 owner 和验证证据写清楚。",
  category: "missing_info",
  status: "queued",
  createdAt: "2026-07-04T09:00:00.000Z",
};

const session: ReviewSession = {
  id: "session-main",
  provider: "codex",
  label: "当前 Codex 对话",
  taskGoal: "修改配置快照发布方案",
  currentPhase: "technical_design",
  origin: "launched_from_agent",
  launcherContext: {
    provider: "codex",
    sessionId: "019f2c77-2758-7440-8011-5ce9091b66fa",
    sessionKind: "codex_thread",
    label: "当前 Codex 对话",
  },
  contextSummary:
    "主会话已经完成现状建模，正在根据 review comments 修改技术方案。",
  artifactIds: ["sample-technical-design"],
  createdAt: "2026-07-04T09:00:00.000Z",
  updatedAt: "2026-07-04T09:10:00.000Z",
};

const contextSnapshot: ContextSnapshot = {
  id: "snapshot-main",
  sessionId: "session-main",
  artifactId: "sample-technical-design",
  agentProvider: "codex",
  createdAt: "2026-07-04T09:11:00.000Z",
  taskGoal: session.taskGoal,
  currentPhase: session.currentPhase,
  contextSummary: session.contextSummary,
  linkedSessionIds: ["session-main"],
  priorAcceptedRevisionSummaries: ["Accepted older clarification."],
};

const request: BatchRevisionRequest = {
  artifact,
  comments: [comment],
  contextSnapshot,
  globalInstruction: "保持技术方案语气。",
  reviewHistory: [],
  session,
};

describe("Codex Desktop thread adapter", () => {
  it("resolves only Codex Desktop launcher sessions to a desktop thread id", () => {
    assert.equal(
      resolveCodexDesktopThreadId(request),
      "019f2c77-2758-7440-8011-5ce9091b66fa",
    );
    assert.equal(
      resolveCodexDesktopThreadId({
        ...request,
        session: {
          ...session,
          launcherContext: {
            provider: "codex",
            sessionId: "codex-cli-session",
            sessionKind: "codex_cli_session",
          },
        },
      }),
      undefined,
    );
  });

  it("builds a small human-readable turn prompt pointing at a payload file", () => {
    const prompt = buildCodexDesktopTurnPrompt({
      payloadPath: "/tmp/review-submit/payload.json",
      request,
    });

    assert.match(prompt, /Dorey/);
    assert.match(prompt, /\/tmp\/review-submit\/payload\.json/);
    assert.match(prompt, /读取 payload JSON 文件/);
    assert.match(prompt, /revisedMarkdown/);
    assert.doesNotMatch(prompt, /优先复用已有发布链路/);
    assert.doesNotMatch(prompt, /BatchRevisionRequest JSON/);
  });

  it("materializes the complete submit payload separately from the thread prompt", () => {
    const payload = buildCodexDesktopPayload(request);

    assert.equal(payload.artifact.markdown, artifact.markdown);
    assert.equal(payload.comments[0]?.body, comment.body);
    assert.equal(payload.contextSnapshot?.id, "snapshot-main");
    assert.equal(payload.session?.launcherContext?.sessionKind, "codex_thread");
  });

  it("builds app-server initialize, resume, and turn messages for the original thread", () => {
    const messages = buildCodexAppServerMessages({
      cwd: "/repo",
      outputSchema: { type: "object" },
      prompt: "Handle review.",
      threadId: "019f2c77-2758-7440-8011-5ce9091b66fa",
    });

    assert.deepEqual(
      messages.map((message) => message.method),
      ["initialize", "initialized", "thread/resume", "turn/start"],
    );
    assert.deepEqual(messages[2], {
      id: 1,
      method: "thread/resume",
      params: {
        cwd: "/repo",
        threadId: "019f2c77-2758-7440-8011-5ce9091b66fa",
      },
    });
    assert.equal(messages[3]?.params?.threadId, "019f2c77-2758-7440-8011-5ce9091b66fa");
    assert.equal(messages[3]?.params?.cwd, "/repo");
    assert.deepEqual(messages[3]?.params?.input, [
      {
        text: "Handle review.",
        type: "text",
      },
    ]);
    assert.deepEqual(messages[3]?.params?.outputSchema, { type: "object" });
  });

  it("parses the final Codex Desktop JSON response", () => {
    const response = parseCodexDesktopRevisionOutput(
      JSON.stringify({
        revisedMarkdown: "# Revised\n",
        summary: "Updated.",
        addressedComments: [
          { commentId: "comment-1", resolution: "Clarified owner." },
        ],
      }),
    );

    assert.equal(response.summary, "Updated.");
    assert.equal(response.addressedComments[0]?.commentId, "comment-1");
  });

  it("prefers the Desktop bundled app-server binary over a stale global codex", () => {
    const bundledPath = "/Users/demo/.codex/plugins/.plugin-appserver/codex";

    assert.equal(
      resolveDefaultCodexDesktopBin({
        env: {},
        existsSync: (candidate) => candidate === bundledPath,
        homeDir: "/Users/demo",
      }),
      bundledPath,
    );
    assert.equal(
      resolveDefaultCodexDesktopBin({
        env: {},
        existsSync: () => false,
        homeDir: "/Users/demo",
      }),
      "codex",
    );
    assert.equal(
      resolveDefaultCodexDesktopBin({
        env: {
          MARKDOWN_REVIEW_CODEX_DESKTOP_BIN: "/custom/codex",
        },
        existsSync: () => true,
        homeDir: "/Users/demo",
      }),
      "/custom/codex",
    );
  });

  it("posts batch revision requests to the local Codex Desktop endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const abortController = new AbortController();
    const adapter = new CodexDesktopAgentAdapter({
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });

        return new Response(
          JSON.stringify({
            revisedMarkdown: "# Revised\n",
            summary: "Codex Desktop revised the artifact.",
            addressedComments: [
              {
                commentId: "comment-1",
                resolution: "Resolved.",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });

    const response = await adapter.reviseArtifact(request, {
      signal: abortController.signal,
    });

    assert.equal(calls[0]?.url, "/api/agent/codex-desktop/revise");
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal(calls[0]?.init.signal, abortController.signal);
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), request);
    assert.equal(
      "summary" in response ? response.summary : "",
      "Codex Desktop revised the artifact.",
    );
  });

  it("queues Codex Desktop submit work for the original thread poll target", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "desktop-poll-"));

    try {
      const broker = createRevisionPollBroker({
        createId: () => "desktop-submit-1",
        now: () => "2026-07-05T12:20:00.000Z",
        payloadRoot,
      });
      const result = await handleCodexDesktopRevisionRequest(
        {
          baseUrl: "http://127.0.0.1:5175",
          method: "POST",
          body: JSON.stringify({ ...request, globalInstruction: "first" }),
        },
        {
          broker,
          cwd: "/repo",
        },
      );

      assert.equal(result.status, 200);
      assert.equal(result.body.status, "queued");
      assert.equal(
        result.body.target.key,
        "codex-desktop:019f2c77-2758-7440-8011-5ce9091b66fa",
      );
      assert.match(result.body.pollCommand, /\/api\/agent\/poll/);

      const poll = await broker.poll({
        targetKey: "codex-desktop:019f2c77-2758-7440-8011-5ce9091b66fa",
        timeoutMs: 0,
      });

      assert.equal(poll.status, "feedback");
      assert.equal(poll.requestId, "desktop-submit-1");
      assert.equal(poll.status === "feedback" ? poll.request.globalInstruction : "", "first");
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });
});
