import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  Artifact,
  ReviewRunRecord,
} from "../src/contracts/index.js";
import {
  acceptReviewRun,
  attachReviewSession,
  buildSessionRevisionRequest,
  createContextSnapshot,
  createInitialReviewSessions,
  createLinkedWebSession,
  linkReviewSessionToArtifact,
} from "../src/app/session-state.js";

const artifacts: Artifact[] = [
  {
    id: "technical-design",
    stage: "technical_design",
    title: "技术方案",
    markdown: "# 技术方案\n",
    metadata: {
      taskId: "config-snapshot-release",
      sourceRefs: ["samples/technical-design.md"],
      createdAt: "2026-07-04T09:00:00.000Z",
    },
  },
  {
    id: "verification-plan",
    stage: "verification",
    title: "验证方案",
    markdown: "# 验证方案\n",
    metadata: {
      taskId: "config-snapshot-release",
      sourceRefs: ["generated/demo-task/05-verification.md"],
      createdAt: "2026-07-04T09:00:00.000Z",
    },
  },
];

describe("review session state", () => {
  it("creates a launched main session and links every artifact to it", () => {
    const state = createInitialReviewSessions(
      artifacts,
      "2026-07-04T10:00:00.000Z",
      "codex",
      {
        launcherContext: {
          provider: "codex",
          sessionId: "019f2c77-2758-7440-8011-5ce9091b66fa",
          sessionKind: "codex_thread",
          label: "当前 Codex 对话",
        },
      },
    );

    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0]?.origin, "launched_from_agent");
    assert.equal(state.sessions[0]?.provider, "codex");
    assert.equal(
      state.sessions[0]?.launcherContext?.sessionId,
      "019f2c77-2758-7440-8011-5ce9091b66fa",
    );
    assert.equal(state.sessions[0]?.externalSessionId, undefined);
    assert.deepEqual(state.sessions[0]?.artifactIds, [
      "technical-design",
      "verification-plan",
    ]);

    for (const artifact of artifacts) {
      const link = state.links.find((item) => item.artifactId === artifact.id);

      assert.ok(link, `${artifact.id} should have a session link`);
      assert.equal(link.activeSessionId, state.sessions[0]?.id);
      assert.deepEqual(link.linkedSessionIds, [state.sessions[0]?.id]);
    }
  });

  it("records launcher thread context without marking the session attached", () => {
    const state = createInitialReviewSessions(
      artifacts,
      "2026-07-04T10:00:00.000Z",
      "codex",
      {
        launcherContext: {
          provider: "codex",
          sessionId: "019f2c77-2758-7440-8011-5ce9091b66fa",
          sessionKind: "codex_thread",
          label: "当前 Codex 对话",
        },
      },
    );

    assert.equal(state.sessions[0]?.origin, "launched_from_agent");
    assert.equal(
      state.sessions[0]?.launcherContext?.sessionId,
      "019f2c77-2758-7440-8011-5ce9091b66fa",
    );
    assert.equal(state.sessions[0]?.launcherContext?.sessionKind, "codex_thread");
    assert.equal(state.sessions[0]?.externalSessionId, undefined);
  });

  it("treats CLI launcher context as an attached session by default", () => {
    const state = createInitialReviewSessions(
      artifacts,
      "2026-07-04T10:00:00.000Z",
      "codex",
      {
        launcherContext: {
          provider: "codex",
          sessionId: "019f2dbb-5d9e-73c3-a99e-7fc6558dbdff",
          sessionKind: "codex_cli_session",
          label: "当前 Codex CLI",
        },
      },
    );

    assert.equal(state.sessions[0]?.origin, "attached");
    assert.equal(
      state.sessions[0]?.externalSessionId,
      "019f2dbb-5d9e-73c3-a99e-7fc6558dbdff",
    );
    assert.equal(state.sessions[0]?.externalSessionKind, "codex_cli_session");
    assert.equal(
      state.sessions[0]?.launcherContext?.sessionKind,
      "codex_cli_session",
    );
  });

  it("builds a context snapshot from the active session and accepted history", () => {
    const state = createInitialReviewSessions(
      artifacts,
      "2026-07-04T10:00:00.000Z",
      "traex",
    );
    const session = {
      ...state.sessions[0]!,
      taskGoal: "修改配置快照发布方案",
      currentPhase: "technical_design",
      contextSummary:
        "主会话已经完成现状建模，正在根据 review comments 修改技术方案。",
    };
    const link = {
      ...state.links[0]!,
      linkedSessionIds: [session.id, "session-follow-up"],
    };
    const acceptedRun: ReviewRunRecord = {
      id: "run-accepted",
      sessionId: session.id,
      artifactId: "technical-design",
      adapter: "traex",
      createdAt: "2026-07-04T10:02:00.000Z",
      commentIds: ["comment-1"],
      contextSnapshot: {
        id: "older-snapshot",
        sessionId: session.id,
        artifactId: "technical-design",
        agentProvider: "traex",
        createdAt: "2026-07-04T10:02:00.000Z",
        taskGoal: session.taskGoal,
        currentPhase: session.currentPhase,
        contextSummary: session.contextSummary,
        linkedSessionIds: [session.id],
        priorAcceptedRevisionSummaries: [],
      },
      status: "accepted",
      summary: "Clarified the published config snapshot fields.",
      acceptedAt: "2026-07-04T10:04:00.000Z",
    };

    const snapshot = createContextSnapshot({
      artifactId: "technical-design",
      link,
      now: "2026-07-04T10:05:00.000Z",
      reviewRuns: [
        acceptedRun,
        { ...acceptedRun, id: "run-proposed", status: "proposed" },
      ],
      session,
      snapshotId: "snapshot-current",
    });

    assert.equal(snapshot.id, "snapshot-current");
    assert.equal(snapshot.sessionId, session.id);
    assert.equal(snapshot.agentProvider, "traex");
    assert.equal(snapshot.taskGoal, "修改配置快照发布方案");
    assert.equal(snapshot.currentPhase, "technical_design");
    assert.match(snapshot.contextSummary, /现状建模/);
    assert.deepEqual(snapshot.linkedSessionIds, [
      session.id,
      "session-follow-up",
    ]);
    assert.deepEqual(snapshot.priorAcceptedRevisionSummaries, [
      "Clarified the published config snapshot fields.",
    ]);
  });

  it("can record the submitting adapter without mutating the owning session", () => {
    const state = createInitialReviewSessions(
      artifacts,
      "2026-07-04T10:00:00.000Z",
      "codex",
    );
    const session = state.sessions[0]!;

    const snapshot = createContextSnapshot({
      agentProvider: "traex",
      artifactId: "technical-design",
      link: state.links[0]!,
      now: "2026-07-04T10:06:00.000Z",
      reviewRuns: [],
      session,
      snapshotId: "snapshot-traex-submit",
    });

    assert.equal(session.provider, "codex");
    assert.equal(snapshot.agentProvider, "traex");
  });

  it("builds a submit payload with owning session and executing adapter separated", () => {
    const state = createInitialReviewSessions(
      artifacts,
      "2026-07-04T10:00:00.000Z",
      "codex",
    );
    const session = state.sessions[0]!;
    const acceptedRun: ReviewRunRecord = {
      id: "run-accepted",
      sessionId: session.id,
      artifactId: "technical-design",
      adapter: "codex",
      createdAt: "2026-07-04T10:02:00.000Z",
      commentIds: ["comment-older"],
      contextSnapshot: createContextSnapshot({
        artifactId: "technical-design",
        link: state.links[0]!,
        now: "2026-07-04T10:02:00.000Z",
        reviewRuns: [],
        session,
        snapshotId: "snapshot-older",
      }),
      status: "accepted",
      summary: "Accepted older clarification.",
      acceptedAt: "2026-07-04T10:04:00.000Z",
    };

    const submission = buildSessionRevisionRequest({
      agentProvider: "traex",
      artifact: artifacts[0]!,
      comments: [
        {
          id: "comment-current",
          artifactId: "technical-design",
          anchor: {
            blockId: "technical-design:p:1",
            startOffset: 0,
            endOffset: 2,
            quote: "技术",
          },
          body: "Current review comment.",
          category: "clarification",
          status: "queued",
          createdAt: "2026-07-04T10:06:00.000Z",
        },
      ],
      globalInstruction: "Keep the current phase explicit.",
      link: state.links[0]!,
      now: "2026-07-04T10:07:00.000Z",
      reviewRuns: [acceptedRun],
      session,
      snapshotId: "snapshot-current",
    });

    assert.equal(submission.request.session?.provider, "codex");
    assert.equal(submission.request.contextSnapshot?.agentProvider, "traex");
    assert.equal(
      submission.request.reviewHistory?.[0]?.summary,
      "Accepted older clarification.",
    );
    assert.equal(
      submission.request.globalInstruction,
      "Keep the current phase explicit.",
    );
  });

  it("keeps session artifactIds in sync when linking an existing session", () => {
    const state = createInitialReviewSessions(
      artifacts,
      "2026-07-04T10:00:00.000Z",
      "codex",
    );
    const extraSession = createLinkedWebSession({
      artifact: artifacts[0]!,
      baseSession: state.sessions[0],
      now: "2026-07-04T10:08:00.000Z",
      provider: "traex",
    });

    const linked = linkReviewSessionToArtifact({
      artifactId: "verification-plan",
      links: state.links,
      sessionId: extraSession.id,
      sessions: [...state.sessions, extraSession],
      updatedAt: "2026-07-04T10:09:00.000Z",
    });

    const verificationLink = linked.links.find(
      (link) => link.artifactId === "verification-plan",
    );
    const updatedSession = linked.sessions.find(
      (session) => session.id === extraSession.id,
    );

    assert.equal(verificationLink?.activeSessionId, extraSession.id);
    assert.deepEqual(updatedSession?.artifactIds, [
      "technical-design",
      "verification-plan",
    ]);
    assert.equal(updatedSession?.updatedAt, "2026-07-04T10:09:00.000Z");
  });

  it("attaches an owning external session id without changing the executor", () => {
    const state = createInitialReviewSessions(
      artifacts,
      "2026-07-04T10:00:00.000Z",
      "codex",
    );

    const sessions = attachReviewSession({
      attachedAt: "2026-07-04T10:10:00.000Z",
      externalSessionId: "019f2dbb-5d9e-73c3-a99e-7fc6558dbdff",
      externalSessionKind: "codex_cli_session",
      provider: "codex",
      sessionId: state.sessions[0]!.id,
      sessions: state.sessions,
    });

    assert.equal(sessions[0]?.origin, "attached");
    assert.equal(sessions[0]?.provider, "codex");
    assert.equal(
      sessions[0]?.externalSessionId,
      "019f2dbb-5d9e-73c3-a99e-7fc6558dbdff",
    );
    assert.equal(sessions[0]?.externalSessionKind, "codex_cli_session");
    assert.equal(sessions[0]?.updatedAt, "2026-07-04T10:10:00.000Z");
  });

  it("marks a proposed run accepted while preserving review history", () => {
    const state = createInitialReviewSessions(
      artifacts,
      "2026-07-04T10:00:00.000Z",
      "codex",
    );
    const session = state.sessions[0]!;
    const proposedRun: ReviewRunRecord = {
      id: "run-proposed",
      sessionId: session.id,
      artifactId: "technical-design",
      adapter: "codex",
      createdAt: "2026-07-04T10:03:00.000Z",
      commentIds: ["comment-1", "comment-2"],
      contextSnapshot: createContextSnapshot({
        artifactId: "technical-design",
        link: state.links[0]!,
        now: "2026-07-04T10:03:00.000Z",
        reviewRuns: [],
        session,
        snapshotId: "snapshot-proposed",
      }),
      status: "proposed",
      summary: "Added explicit verification evidence.",
    };

    const accepted = acceptReviewRun({
      acceptedAt: "2026-07-04T10:08:00.000Z",
      reviewRuns: [proposedRun],
      runId: "run-proposed",
      sessions: state.sessions,
    });

    assert.equal(accepted.reviewRuns.length, 1);
    assert.equal(accepted.reviewRuns[0]?.status, "accepted");
    assert.equal(
      accepted.reviewRuns[0]?.acceptedAt,
      "2026-07-04T10:08:00.000Z",
    );
    assert.equal(
      accepted.sessions[0]?.updatedAt,
      "2026-07-04T10:08:00.000Z",
    );
  });
});
