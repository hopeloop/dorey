import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type {
  Artifact,
  BatchRevisionRequest,
  QueuedComment,
  ReviewSession,
} from "../src/contracts/index.js";
import {
  createRevisionPollBroker,
  createRevisionPollCommands,
} from "../src/server/revision-poll-broker.js";
import { resolveTraexCliPollTarget } from "../src/server/revision-poll-endpoint.js";

const artifact: Artifact = {
  id: "technical-design",
  stage: "technical_design",
  title: "技术方案",
  markdown: "# 技术方案\n\n正文。\n",
};

const comment: QueuedComment = {
  id: "comment-1",
  artifactId: artifact.id,
  anchor: {
    blockId: "technical-design:p:1",
    startOffset: 0,
    endOffset: 2,
    quote: "正文",
  },
  body: "内容还简略了，在下钻一点。",
  category: "missing_info",
  createdAt: "2026-07-05T12:00:00.000Z",
  status: "queued",
};

const session: ReviewSession = {
  id: "session-main",
  provider: "traex",
  label: "当前 TraeX 会话",
  taskGoal: "审阅技术方案。",
  currentPhase: "technical_design",
  origin: "launched_from_agent",
  launcherContext: {
    provider: "traex",
    sessionId: "traex-session-1",
    sessionKind: "traex_cli_session",
  },
  contextSummary: "从 TraeX 会话启动，submit 应由原会话 poll 处理。",
  artifactIds: [artifact.id],
  createdAt: "2026-07-05T12:00:00.000Z",
  updatedAt: "2026-07-05T12:00:00.000Z",
};

const request: BatchRevisionRequest = {
  artifact,
  comments: [comment],
  session,
};

describe("revision poll broker", () => {
  it("queues submitted payloads for the launcher session instead of executing an agent subprocess", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "review-poll-broker-"));

    try {
      const broker = createRevisionPollBroker({
        createId: () => "submit-1",
        now: () => "2026-07-05T12:01:00.000Z",
        payloadRoot,
      });

      const submit = await broker.enqueue({
        baseUrl: "http://127.0.0.1:5175",
        request,
        target: {
          key: "traex-cli:traex-session-1",
          label: "TraeX CLI（原会话）",
          provider: "traex",
          transport: "traex_cli",
        },
      });

      assert.equal(submit.status, "queued");
      assert.equal(submit.requestId, "submit-1");
      assert.equal(submit.target.key, "traex-cli:traex-session-1");
      assert.match(
        submit.agentPollCommand,
        /dorey poll --base-url 'http:\/\/127\.0\.0\.1:5175' --target 'traex-cli:traex-session-1'/,
      );
      assert.match(submit.pollCommand, /\/api\/agent\/poll\?target=traex-cli%3Atraex-session-1/);
      assert.match(submit.replyCommand, /\/api\/agent\/submissions\/submit-1\/reply/);

      const payload = JSON.parse(await readFile(submit.payloadPath, "utf8"));
      assert.equal(payload.artifact.markdown, artifact.markdown);
      assert.equal(payload.comments[0]?.body, comment.body);
      assert.equal(payload.session.launcherContext.sessionKind, "traex_cli_session");
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("delivers queued work through poll and exposes completed replies to the browser", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "review-poll-broker-"));

    try {
      const broker = createRevisionPollBroker({
        createId: () => "submit-2",
        now: () => "2026-07-05T12:02:00.000Z",
        payloadRoot,
      });
      const commands = createRevisionPollCommands({
        baseUrl: "http://127.0.0.1:5175",
        requestId: "submit-2",
        targetKey: "codex-desktop:thread-1",
      });

      await broker.enqueue({
        baseUrl: "http://127.0.0.1:5175",
        request,
        target: {
          key: "codex-desktop:thread-1",
          label: "Codex Desktop（原对话）",
          provider: "codex",
          transport: "codex_desktop",
        },
      });

      const poll = await broker.poll({
        targetKey: "codex-desktop:thread-1",
        timeoutMs: 0,
      });

      assert.equal(poll.status, "feedback");
      assert.equal(poll.requestId, "submit-2");
      assert.equal(poll.payloadPath.endsWith("payload.json"), true);
      assert.deepEqual(poll.request, request);
      assert.equal(poll.replyCommand, commands.replyCommand);
      assert.equal(poll.agentPollCommand, commands.agentPollCommand);

      const completed = await broker.complete("submit-2", {
        addressedComments: [
          {
            commentId: "comment-1",
            resolution: "补充了下钻内容。",
          },
        ],
        revisedMarkdown: "# 技术方案\n\n更完整的正文。\n",
        summary: "补充了方案正文。",
      });

      assert.equal(completed.status, "completed");

      const status = broker.getSubmission("submit-2");

      assert.equal(status?.status, "completed");
      assert.equal(status?.response?.summary, "补充了方案正文。");
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("notifies server lifecycle hooks after delivery and after reply completion", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "review-poll-broker-"));

    try {
      const deliveredRequestIds: string[] = [];
      const completedRequestIds: string[] = [];
      const broker = createRevisionPollBroker({
        createId: () => "submit-auto-stop",
        now: () => "2026-07-05T12:03:00.000Z",
        onCompleted: (record) => {
          completedRequestIds.push(record.requestId);
        },
        onFeedbackDelivered: (record) => {
          deliveredRequestIds.push(record.requestId);
        },
        payloadRoot,
      });

      await broker.enqueue({
        baseUrl: "http://127.0.0.1:5175",
        request,
        target: {
          key: "traex-cli:traex-session-1",
          label: "TraeX CLI（原会话）",
          provider: "traex",
          transport: "traex_cli",
        },
      });

      assert.deepEqual(deliveredRequestIds, []);
      assert.deepEqual(completedRequestIds, []);

      const poll = await broker.poll({
        targetKey: "traex-cli:traex-session-1",
        timeoutMs: 0,
      });

      assert.equal(poll.status, "feedback");
      assert.deepEqual(deliveredRequestIds, ["submit-auto-stop"]);
      assert.deepEqual(completedRequestIds, []);

      await broker.complete("submit-auto-stop", {
        addressedComments: [
          {
            commentId: "comment-1",
            resolution: "补充了下钻内容。",
          },
        ],
        revisedMarkdown: "# 技术方案\n\n更完整的正文。\n",
        summary: "补充了方案正文。",
      });

      assert.deepEqual(completedRequestIds, ["submit-auto-stop"]);
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("uses the visible TraeX launcher session as the TraeX poll target", () => {
    const target = resolveTraexCliPollTarget({
      ...request,
      session: {
        ...session,
        id: "web-session-id",
        launcherContext: {
          provider: "traex",
          sessionId: "visible-traex-thread",
          sessionKind: "traex_thread",
        },
      },
    });

    assert.equal(target.key, "traex-cli:visible-traex-thread");
    assert.equal(target.label, "TraeX CLI（原会话）");
  });
});
