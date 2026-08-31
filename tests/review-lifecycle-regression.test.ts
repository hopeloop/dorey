import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type {
  Artifact,
  BatchRevisionRequest,
  BatchRevisionResponse,
  QueuedComment,
  ReviewSession,
  RevisionSubmissionStatus,
} from "../src/contracts/index.js";
import { handleCodexDesktopRevisionRequest } from "../src/server/codex-desktop-revision-endpoint.js";
import {
  archiveClosedDoreyState,
} from "../src/server/revision-agent-poll-cli.js";
import {
  createRevisionPollBroker,
  type RevisionPollBroker,
} from "../src/server/revision-poll-broker.js";
import {
  handleRevisionPollRequest,
  handleRevisionSubmissionRequest,
} from "../src/server/revision-poll-endpoint.js";
import { handleRevisionReviewRequest } from "../src/server/revision-review-endpoint.js";

const targetKey = "codex-desktop:thread-regression";
const baseUrl = "http://127.0.0.1:5175";

const artifact: Artifact = {
  id: "regression-document",
  stage: "technical_design",
  title: "Dorey lifecycle regression",
  markdown: "# Before\n\nOriginal content.\n",
};

const comment: QueuedComment = {
  id: "comment-regression",
  artifactId: artifact.id,
  anchor: {
    blockId: "regression-document:p:1",
    startOffset: 0,
    endOffset: 8,
    quote: "Original",
  },
  body: "Please revise this paragraph.",
  category: "rewrite",
  createdAt: "2026-08-31T06:00:00.000Z",
  status: "queued",
};

const session: ReviewSession = {
  id: "session-regression",
  provider: "codex",
  label: "Dorey regression session",
  taskGoal: "Verify the foreground review lifecycle.",
  currentPhase: "review",
  origin: "launched_from_agent",
  launcherContext: {
    provider: "codex",
    sessionId: "thread-regression",
    sessionKind: "codex_thread",
  },
  contextSummary: "A deterministic lifecycle regression fixture.",
  artifactIds: [artifact.id],
  createdAt: "2026-08-31T06:00:00.000Z",
  updatedAt: "2026-08-31T06:00:00.000Z",
};

const request: BatchRevisionRequest = {
  artifact,
  comments: [comment],
  globalInstruction: "Keep the heading.",
  session,
};

const firstResponse: BatchRevisionResponse = {
  addressedComments: [
    {
      commentId: comment.id,
      resolution: "Rewrote the paragraph.",
    },
  ],
  revisedMarkdown: "# Before\n\nRevised content.\n",
  summary: "Revised the requested paragraph.",
};

describe("Dorey review lifecycle regression cases", () => {
  it("DOR-P0-001: submit -> wait -> feedback -> reply -> automatic page refresh -> review closed", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "dorey-regression-main-"));

    try {
      const broker = createRevisionPollBroker({
        createId: () => "main-path",
        now: () => "2026-08-31T06:01:00.000Z",
        payloadRoot,
      });
      const submitted = await submit(broker, request);
      assert.equal(submitted, "main-path");
      assert.equal(await submissionStatus(broker, submitted), "queued");

      const feedback = await poll(broker);
      assert.equal(feedback.status, "feedback");
      assert.equal(feedback.status === "feedback" ? feedback.requestId : "", submitted);
      assert.equal(await submissionStatus(broker, submitted), "delivered");

      const replied = await reply(broker, submitted, firstResponse);
      assert.deepEqual(replied, { requestId: submitted, status: "completed" });

      const refreshed = await unacknowledged(broker);
      assert.equal(refreshed.length, 1);
      assert.equal(refreshed[0]?.status, "completed");
      assert.deepEqual(
        refreshed[0]?.status === "completed" ? refreshed[0].response : undefined,
        firstResponse,
      );

      const acknowledged = await handleRevisionSubmissionRequest(
        { method: "POST", url: `/${submitted}/acknowledge` },
        { broker },
      );
      assert.equal(acknowledged.status, 200);
      assert.deepEqual(await unacknowledged(broker), []);

      const closed = await handleRevisionReviewRequest({ method: "POST" }, { broker });
      assert.deepEqual(closed, { status: 200, body: { status: "review_closed" } });
      assert.equal((await poll(broker)).status, "review_closed");

      const appSource = await readFile("src/app/App.tsx", "utf8");
      const autoRefreshStart = appSource.indexOf("async function checkSubmission()");
      const autoRefreshEnd = appSource.indexOf(
        "async function loadWorkflowRunByKey",
        autoRefreshStart,
      );
      const autoRefreshSource = appSource.slice(autoRefreshStart, autoRefreshEnd);
      assert.ok(autoRefreshStart > -1);
      assert.match(autoRefreshSource, /fetchRevisionSubmissionStatus/);
      assert.match(autoRefreshSource, /status\.status === "completed"/);
      assert.match(autoRefreshSource, /applyAgentRevisionResponse/);
      assert.match(autoRefreshSource, /window\.setTimeout\(checkSubmission, 1500\)/);
      assert.match(appSource, /fetchLatestUnacknowledgedSubmission/);
      assert.match(appSource, /acknowledgeRevisionSubmission/);
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("DOR-P0-002: completes two consecutive review rounds without resetting the broker", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "dorey-regression-rounds-"));
    const ids = ["round-1", "round-2"];

    try {
      const broker = createRevisionPollBroker({
        createId: () => ids.shift() ?? "unexpected-round",
        payloadRoot,
      });

      for (const [index, expectedId] of ["round-1", "round-2"].entries()) {
        const requestId = await submit(broker, {
          ...request,
          globalInstruction: `round ${index + 1}`,
        });
        assert.equal(requestId, expectedId);
        assert.equal((await poll(broker)).status, "feedback");
        await reply(broker, requestId, {
          ...firstResponse,
          summary: `completed round ${index + 1}`,
        });
        assert.equal(await submissionStatus(broker, requestId), "completed");
      }

      assert.equal(broker.listSubmissionStatuses().length, 2);
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("DOR-P0-003: restores queued, delivered, and completed work after a page refresh", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "dorey-regression-refresh-"));

    try {
      const broker = createRevisionPollBroker({
        createId: () => "refresh-path",
        payloadRoot,
      });
      const requestId = await submit(broker, request);
      assert.equal((await unacknowledged(broker))[0]?.status, "queued");

      await poll(broker);
      assert.equal((await unacknowledged(broker))[0]?.status, "delivered");

      await reply(broker, requestId, firstResponse);
      const completed = await unacknowledged(broker);
      assert.equal(completed[0]?.status, "completed");
      assert.deepEqual(
        completed[0]?.status === "completed" ? completed[0].response : undefined,
        firstResponse,
      );
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("DOR-P0-004: requeues feedback after the foreground poll disconnects", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "dorey-regression-release-"));

    try {
      const broker = createRevisionPollBroker({
        createId: () => "released-feedback",
        payloadRoot,
      });
      const requestId = await submit(broker, request);
      assert.equal((await poll(broker)).status, "feedback");
      assert.equal(await broker.release(requestId), true);
      assert.equal(await submissionStatus(broker, requestId), "queued");
      assert.equal((await poll(broker)).status, "feedback");
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("DOR-P0-005: keeps the first response when duplicate replies race", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "dorey-regression-idempotent-"));

    try {
      const broker = createRevisionPollBroker({
        createId: () => "duplicate-reply",
        payloadRoot,
      });
      const requestId = await submit(broker, request);
      await poll(broker);
      await reply(broker, requestId, firstResponse);
      await reply(broker, requestId, {
        ...firstResponse,
        revisedMarkdown: "# Incorrect second response\n",
        summary: "incorrect second response",
      });

      const status = broker.getSubmissionStatus(requestId);
      assert.equal(status?.status, "completed");
      assert.deepEqual(status?.status === "completed" ? status.response : undefined, firstResponse);
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("DOR-P0-006: stops queued work on close but lets an in-flight reply finish", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "dorey-regression-close-"));
    const ids = ["in-flight", "still-queued"];

    try {
      const broker = createRevisionPollBroker({
        createId: () => ids.shift() ?? "unexpected-close-id",
        payloadRoot,
      });
      const inFlight = await submit(broker, request);
      await poll(broker);
      const queued = await submit(broker, {
        ...request,
        globalInstruction: "must remain queued after close",
      });

      await handleRevisionReviewRequest({ method: "POST" }, { broker });
      assert.equal((await poll(broker)).status, "review_closed");
      assert.equal(await submissionStatus(broker, queued), "queued");

      await reply(broker, inFlight, firstResponse);
      assert.equal(await submissionStatus(broker, inFlight), "completed");
      assert.equal(await submissionStatus(broker, queued), "queued");
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });

  it("DOR-P0-007: archives a closed queue and opens a clean review", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dorey-regression-reopen-"));
    const stateRoot = path.join(root, "stable-review", "active");

    try {
      const firstBroker = createRevisionPollBroker({ payloadRoot: stateRoot });
      await firstBroker.closeReview();
      const archivePath = await archiveClosedDoreyState(stateRoot);

      assert.ok(archivePath);
      assert.equal(await stat(stateRoot).catch(() => undefined), undefined);
      assert.equal(
        JSON.parse(
          await readFile(path.join(archivePath, "revision-poll-state.json"), "utf8"),
        ).reviewClosed,
        true,
      );

      await mkdir(stateRoot, { recursive: true });
      const reopenedBroker = createRevisionPollBroker({ payloadRoot: stateRoot });
      assert.deepEqual(reopenedBroker.getReviewStatus(), { status: "open" });
      assert.deepEqual(reopenedBroker.listSubmissionStatuses(), []);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

async function submit(
  broker: RevisionPollBroker,
  revisionRequest: BatchRevisionRequest,
): Promise<string> {
  const result = await handleCodexDesktopRevisionRequest(
    {
      baseUrl,
      body: JSON.stringify(revisionRequest),
      method: "POST",
    },
    { broker, cwd: "/repo" },
  );

  assert.equal(result.status, 200);
  assert.equal("status" in result.body ? result.body.status : "", "queued");
  return "requestId" in result.body ? result.body.requestId : "";
}

async function poll(broker: RevisionPollBroker) {
  const result = await handleRevisionPollRequest(
    {
      method: "GET",
      url: `/?target=${encodeURIComponent(targetKey)}&timeoutMs=0`,
    },
    { broker },
  );

  assert.equal(result.status, 200);
  return result.body;
}

async function reply(
  broker: RevisionPollBroker,
  requestId: string,
  response: BatchRevisionResponse,
): Promise<{ requestId: string; status: "completed" }> {
  const result = await handleRevisionSubmissionRequest(
    {
      body: JSON.stringify(response),
      method: "POST",
      url: `/${requestId}/reply`,
    },
    { broker },
  );

  assert.equal(result.status, 200);
  assert.ok("requestId" in result.body);
  assert.equal("status" in result.body ? result.body.status : "", "completed");
  return { requestId, status: "completed" };
}

async function submissionStatus(
  broker: RevisionPollBroker,
  requestId: string,
): Promise<RevisionSubmissionStatus["status"]> {
  const result = await handleRevisionSubmissionRequest(
    { method: "GET", url: `/${requestId}` },
    { broker },
  );

  assert.equal(result.status, 200);
  assert.ok("status" in result.body);
  assert.ok(
    result.body.status === "queued" ||
      result.body.status === "delivered" ||
      result.body.status === "completed",
  );
  return result.body.status;
}

async function unacknowledged(
  broker: RevisionPollBroker,
): Promise<RevisionSubmissionStatus[]> {
  const result = await handleRevisionSubmissionRequest(
    {
      method: "GET",
      url: `/?target=${encodeURIComponent(targetKey)}&unacknowledged=1&limit=20`,
    },
    { broker },
  );

  assert.equal(result.status, 200);
  assert.ok("submissions" in result.body);
  return result.body.submissions;
}
