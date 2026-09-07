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
import {
  handleRevisionSubmissionRequest,
  resolveTraexCliPollTarget,
} from "../src/server/revision-poll-endpoint.js";

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

  it("uses foreground polling for Codex Desktop targets", () => {
    const commands = createRevisionPollCommands({
      baseUrl: "http://127.0.0.1:5175",
      requestId: "submit-foreground",
      targetKey: "codex-desktop:thread-1",
    });

    assert.match(commands.agentPollCommand, /^dorey poll /);
    assert.doesNotMatch(commands.agentPollCommand, /--check/);
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

  it("closes the review lifecycle and resolves attached poll checks", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "review-close-"));

    try {
      const broker = createRevisionPollBroker({ payloadRoot });

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

      assert.deepEqual(broker.getReviewStatus(), { status: "open" });
      assert.deepEqual(await broker.closeReview(), { status: "review_closed" });
      assert.deepEqual(
        await broker.poll({ targetKey: "codex-desktop:thread-1", timeoutMs: 0 }),
        {
          nextStep: "Dorey review 已结束；停止 foreground poll。",
          status: "review_closed",
          targetKey: "codex-desktop:thread-1",
        },
      );
      assert.equal(broker.getSubmissionStatus(broker.listSubmissionStatuses()[0]!.requestId)?.status, "queued");
      await assert.rejects(
        broker.enqueue({
          baseUrl: "http://127.0.0.1:5175",
          request,
          target: {
            key: "codex-desktop:thread-1",
            label: "Codex Desktop（原对话）",
            provider: "codex",
            transport: "codex_desktop",
          },
        }),
        /review is closed/i,
      );
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("acceptance supersedes only earlier completed proposals for the same target and artifact", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "review-accept-ack-"));
    try {
      let sequence = 0;
      const broker = createRevisionPollBroker({
        createId: () => `proposal-${++sequence}`,
        now: () => "2026-09-07T00:00:00.000Z",
        payloadRoot,
      });
      async function enqueue(artifactId = artifact.id, targetKey = "codex-desktop:thread-1", complete = true) {
        const queued = await broker.enqueue({
          baseUrl: "http://127.0.0.1:5175",
          request: { ...request, artifact: { ...artifact, id: artifactId } },
          target: { key: targetKey, label: "Codex", provider: "codex", transport: "codex_desktop" },
        });
        if (complete) await broker.complete(queued.requestId, {
          revisedMarkdown: "# Revised\n", summary: "Proposal", addressedComments: [],
        });
        return queued.requestId;
      }
      const earlier = await enqueue();
      const otherArtifact = await enqueue("other-document");
      const otherTarget = await enqueue(artifact.id, "codex-desktop:other-thread");
      const queued = await enqueue(artifact.id, "codex-desktop:thread-1", false);
      const accepted = await enqueue();
      const newer = await enqueue();
      // An ordinary receipt must not discard an older pending revision.
      await broker.acknowledge(accepted);
      assert.equal(broker.getSubmissionStatus(earlier)?.acknowledgedAt, undefined);
      const invalid = await handleRevisionSubmissionRequest({
        method: "POST", url: `/${accepted}/acknowledge`, body: JSON.stringify({ accepted: "yes" }),
      }, { broker });
      assert.equal(invalid.status, 400);
      const response = await handleRevisionSubmissionRequest({
        method: "POST", url: `/${accepted}/acknowledge`, body: JSON.stringify({ accepted: true }),
      }, { broker });
      assert.equal(response.status, 200);
      assert.ok(broker.getSubmissionStatus(earlier)?.acknowledgedAt);
      assert.ok(broker.getSubmissionStatus(accepted)?.acknowledgedAt);
      const restored = createRevisionPollBroker({ payloadRoot });
      assert.deepEqual(new Set(restored.listSubmissionStatuses({ unacknowledgedOnly: true }).map((item) => item.requestId)),
        new Set([otherArtifact, otherTarget, queued, newer]));
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("lists and acknowledges completed submissions for one-time UI recovery", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "review-ack-"));

    try {
      const broker = createRevisionPollBroker({
        createId: () => "submit-ack",
        now: () => "2026-07-05T12:30:00.000Z",
        payloadRoot,
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
      await broker.complete("submit-ack", {
        addressedComments: [],
        revisedMarkdown: "# revised\n",
        summary: "revised",
      });

      const unacknowledged = broker.listSubmissionStatuses({
        targetKey: "codex-desktop:thread-1",
        unacknowledgedOnly: true,
      });
      assert.equal(unacknowledged.length, 1);
      assert.deepEqual(unacknowledged[0]?.request, request);
      assert.equal(unacknowledged[0]?.acknowledgedAt, undefined);

      const listed = await handleRevisionSubmissionRequest(
        {
          method: "GET",
          url: "/?target=codex-desktop%3Athread-1&unacknowledged=1&limit=1",
        },
        { broker },
      );
      assert.equal(listed.status, 200);
      assert.equal(
        "submissions" in listed.body ? listed.body.submissions[0]?.requestId : "",
        "submit-ack",
      );

      const acknowledged = await handleRevisionSubmissionRequest(
        { method: "POST", url: "/submit-ack/acknowledge" },
        { broker },
      );
      assert.equal(acknowledged.status, 200);
      assert.equal(
        "requestId" in acknowledged.body ? acknowledged.body.requestId : "",
        "submit-ack",
      );
      assert.equal(
        broker.listSubmissionStatuses({ unacknowledgedOnly: true }).length,
        0,
      );
      assert.equal(
        broker.getSubmissionStatus("submit-ack")?.acknowledgedAt,
        "2026-07-05T12:30:00.000Z",
      );
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("allows an already delivered request to reply after review close", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "review-close-inflight-"));

    try {
      const broker = createRevisionPollBroker({
        createId: () => "submit-inflight",
        payloadRoot,
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
      assert.equal(
        (await broker.poll({ targetKey: "codex-desktop:thread-1" })).status,
        "feedback",
      );
      await broker.closeReview();

      const completed = await broker.complete("submit-inflight", {
        addressedComments: [],
        revisedMarkdown: "# completed after close\n",
        summary: "completed after close",
      });
      assert.equal(completed.status, "completed");
      assert.equal(
        (await broker.poll({ targetKey: "codex-desktop:thread-1" })).status,
        "review_closed",
      );
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("keeps the first completed reply when delivery races", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "review-idempotent-"));

    try {
      const broker = createRevisionPollBroker({
        createId: () => "submit-idempotent",
        payloadRoot,
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
      const first = await broker.complete("submit-idempotent", {
        addressedComments: [],
        revisedMarkdown: "# first\n",
        summary: "first",
      });
      const second = await broker.complete("submit-idempotent", {
        addressedComments: [],
        revisedMarkdown: "# second\n",
        summary: "second",
      });

      assert.deepEqual(second, first);
      assert.equal(broker.getSubmission("submit-idempotent")?.response?.summary, "first");
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("restores queued submissions after the broker process restarts", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "review-persisted-"));

    try {
      const firstBroker = createRevisionPollBroker({
        createId: () => "submit-persisted",
        payloadRoot,
      });
      await firstBroker.enqueue({
        baseUrl: "http://127.0.0.1:5175",
        request,
        target: {
          key: "codex-desktop:thread-1",
          label: "Codex Desktop（原对话）",
          provider: "codex",
          transport: "codex_desktop",
        },
      });

      const restoredBroker = createRevisionPollBroker({ payloadRoot });
      assert.equal(restoredBroker.getSubmission("submit-persisted")?.status, "queued");
      const poll = await restoredBroker.poll({
        targetKey: "codex-desktop:thread-1",
        timeoutMs: 0,
      });
      assert.equal(poll.status, "feedback");
      assert.equal(poll.status === "feedback" ? poll.requestId : "", "submit-persisted");
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("requeues a leased submission when delivery is released", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "review-release-"));

    try {
      const broker = createRevisionPollBroker({
        createId: () => "submit-release",
        payloadRoot,
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

      assert.equal(
        (await broker.poll({ targetKey: "codex-desktop:thread-1" })).status,
        "feedback",
      );
      assert.equal((await broker.getAgentPresence("codex-desktop:thread-1")).state, "working");
      assert.equal(await broker.release("submit-release"), true);
      assert.equal(broker.getSubmission("submit-release")?.status, "queued");
      assert.equal(
        (await broker.poll({ targetKey: "codex-desktop:thread-1" })).status,
        "feedback",
      );
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("reclaims an expired delivery lease", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "review-lease-"));
    let currentTime = 1_000;

    try {
      const broker = createRevisionPollBroker({
        clock: () => currentTime,
        createId: () => "submit-lease",
        leaseDurationMs: 100,
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

      assert.equal(
        (await broker.poll({ targetKey: "traex-cli:traex-session-1" })).status,
        "feedback",
      );
      currentTime = 1_101;
      const reclaimed = await broker.poll({
        targetKey: "traex-cli:traex-session-1",
        timeoutMs: 0,
      });
      assert.equal(reclaimed.status, "feedback");
      assert.equal(reclaimed.status === "feedback" ? reclaimed.requestId : "", "submit-lease");
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("renews leases owned by the same foreground poll client", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "review-lease-renew-"));
    let currentTime = 1_000;

    try {
      const broker = createRevisionPollBroker({
        clock: () => currentTime,
        createId: () => "submit-lease-renew",
        leaseDurationMs: 100,
        payloadRoot,
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

      assert.equal(
        (
          await broker.poll({
            clientId: "foreground-worker-1",
            targetKey: "codex-desktop:thread-1",
          })
        ).status,
        "feedback",
      );

      currentTime = 1_090;
      assert.equal(
        (
          await broker.poll({
            clientId: "foreground-worker-1",
            targetKey: "codex-desktop:thread-1",
          })
        ).status,
        "waiting",
      );

      currentTime = 1_150;
      assert.equal(
        (
          await broker.poll({
            clientId: "another-worker",
            targetKey: "codex-desktop:thread-1",
          })
        ).status,
        "waiting",
      );

      currentTime = 1_191;
      const reclaimed = await broker.poll({
        clientId: "another-worker",
        targetKey: "codex-desktop:thread-1",
      });
      assert.equal(reclaimed.status, "feedback");
      assert.equal(
        reclaimed.status === "feedback" ? reclaimed.requestId : "",
        "submit-lease-renew",
      );
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("reports listening presence only while a long poll is attached", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "review-presence-"));
    const abortController = new AbortController();

    try {
      const broker = createRevisionPollBroker({ payloadRoot });
      const pendingPoll = broker.poll({
        signal: abortController.signal,
        targetKey: "codex-desktop:thread-1",
        timeoutMs: 5_000,
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal((await broker.getAgentPresence("codex-desktop:thread-1")).state, "listening");
      abortController.abort();
      assert.equal((await pendingPoll).status, "waiting");
      assert.equal((await broker.getAgentPresence("codex-desktop:thread-1")).state, "waiting");
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
