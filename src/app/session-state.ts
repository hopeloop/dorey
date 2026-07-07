import type {
  AgentProvider,
  Artifact,
  ArtifactSessionLink,
  BatchRevisionRequest,
  CliSessionKind,
  ContextSnapshot,
  LauncherContext,
  RevisionSource,
  ReviewRunRecord,
  ReviewSession,
} from "../contracts/index.js";
import type { QueuedComment } from "../contracts/comment.js";

export type ReviewSessionState = {
  sessions: ReviewSession[];
  links: ArtifactSessionLink[];
};

export type InitialReviewSessionOptions = {
  externalSessionId?: string;
  externalSessionKind?: CliSessionKind;
  label?: string;
  launcherContext?: LauncherContext;
};

export type CreateContextSnapshotInput = {
  agentProvider?: AgentProvider;
  artifactId: string;
  link: ArtifactSessionLink;
  now: string;
  reviewRuns: ReviewRunRecord[];
  session: ReviewSession;
  snapshotId?: string;
};

export type CreateReviewRunRecordInput = {
  adapter: RevisionSource;
  artifactId: string;
  comments: QueuedComment[];
  contextSnapshot: ContextSnapshot;
  now: string;
  runId?: string;
  sessionId: string;
  summary?: string;
};

export type AcceptReviewRunInput = {
  acceptedAt: string;
  reviewRuns: ReviewRunRecord[];
  runId: string;
  sessions: ReviewSession[];
};

export type BuildSessionRevisionRequestInput = {
  agentProvider: AgentProvider;
  artifact: Artifact;
  comments: QueuedComment[];
  globalInstruction?: string;
  link: ArtifactSessionLink;
  now: string;
  reviewRuns: ReviewRunRecord[];
  session: ReviewSession;
  snapshotId?: string;
};

export type LinkReviewSessionToArtifactInput = {
  artifactId: string;
  links: ArtifactSessionLink[];
  sessionId: string;
  sessions: ReviewSession[];
  updatedAt?: string;
};

export type AttachReviewSessionInput = {
  attachedAt?: string;
  externalSessionId: string;
  externalSessionKind: CliSessionKind;
  provider: AgentProvider;
  sessionId: string;
  sessions: ReviewSession[];
};

export function createInitialReviewSessions(
  artifacts: Artifact[],
  now = new Date().toISOString(),
  provider: AgentProvider = "codex",
  options: InitialReviewSessionOptions = {},
): ReviewSessionState {
  const artifactIds = artifacts.map((artifact) => artifact.id);
  const taskId = artifacts[0]?.metadata?.taskId;
  const launcherCliSessionKind = isMatchingCliSessionKind(
    provider,
    options.launcherContext?.sessionKind,
  )
    ? options.launcherContext.sessionKind
    : undefined;
  const externalSessionId =
    options.externalSessionId?.trim() ??
    (launcherCliSessionKind ? options.launcherContext?.sessionId.trim() : "") ??
    "";
  const externalSessionKind = options.externalSessionKind ?? launcherCliSessionKind;
  const hasCliSession =
    externalSessionId.length > 0 &&
    isMatchingCliSessionKind(provider, externalSessionKind);
  const sessionId = `session-${sanitizeId(taskId ?? "main")}`;
  const session: ReviewSession = {
    id: sessionId,
    provider,
    label: options.label ?? "主审阅会话",
    taskGoal: taskId
      ? `审阅 ${taskId} 的 Markdown 产物。`
      : "审阅当前工作区的 Markdown 产物。",
    currentPhase: artifacts[0]?.stage ?? "technical_design",
    origin: hasCliSession ? "attached" : "launched_from_agent",
    launcherContext: options.launcherContext,
    externalSessionId: hasCliSession ? externalSessionId : undefined,
    externalSessionKind: hasCliSession ? externalSessionKind : undefined,
    contextSummary:
      "该工作区从 Agent 会话启动。审阅时应结合评论队列、已接受修订历史和当前文档阶段。",
    artifactIds,
    createdAt: now,
    updatedAt: now,
  };

  return {
    sessions: [session],
    links: artifacts.map((artifact) => ({
      artifactId: artifact.id,
      originSessionId: session.id,
      activeSessionId: session.id,
      linkedSessionIds: [session.id],
    })),
  };
}

export function createContextSnapshot({
  agentProvider,
  artifactId,
  link,
  now,
  reviewRuns,
  session,
  snapshotId,
}: CreateContextSnapshotInput): ContextSnapshot {
  const acceptedSummaries = reviewRuns
    .filter(
      (run) =>
        run.status === "accepted" &&
        run.artifactId === artifactId &&
        link.linkedSessionIds.includes(run.sessionId) &&
        typeof run.summary === "string" &&
        run.summary.trim().length > 0,
    )
    .map((run) => run.summary?.trim() ?? "");

  return {
    id: snapshotId ?? createScopedId("snapshot"),
    sessionId: session.id,
    artifactId,
    agentProvider: agentProvider ?? session.provider,
    createdAt: now,
    taskGoal: session.taskGoal,
    currentPhase: session.currentPhase,
    contextSummary: session.contextSummary,
    linkedSessionIds: [...link.linkedSessionIds],
    priorAcceptedRevisionSummaries: acceptedSummaries,
  };
}

export function createReviewRunRecord({
  adapter,
  artifactId,
  comments,
  contextSnapshot,
  now,
  runId,
  sessionId,
  summary,
}: CreateReviewRunRecordInput): ReviewRunRecord {
  return {
    id: runId ?? createScopedId("run"),
    sessionId,
    artifactId,
    adapter,
    createdAt: now,
    commentIds: comments.map((comment) => comment.id),
    contextSnapshot,
    status: "proposed",
    summary,
  };
}

export function buildSessionRevisionRequest({
  agentProvider,
  artifact,
  comments,
  globalInstruction,
  link,
  now,
  reviewRuns,
  session,
  snapshotId,
}: BuildSessionRevisionRequestInput): {
  contextSnapshot: ContextSnapshot;
  request: BatchRevisionRequest;
} {
  const contextSnapshot = createContextSnapshot({
    agentProvider,
    artifactId: artifact.id,
    link,
    now,
    reviewRuns,
    session,
    snapshotId,
  });
  const reviewHistory = reviewRuns.filter(
    (run) =>
      run.status === "accepted" &&
      run.artifactId === artifact.id &&
      link.linkedSessionIds.includes(run.sessionId),
  );

  return {
    contextSnapshot,
    request: {
      artifact,
      comments,
      contextSnapshot,
      globalInstruction,
      reviewHistory,
      session,
    },
  };
}

export function acceptReviewRun({
  acceptedAt,
  reviewRuns,
  runId,
  sessions,
}: AcceptReviewRunInput): {
  sessions: ReviewSession[];
  reviewRuns: ReviewRunRecord[];
} {
  const targetRun = reviewRuns.find((run) => run.id === runId);
  const targetSessionId = targetRun?.sessionId;

  return {
    reviewRuns: reviewRuns.map((run) =>
      run.id === runId
        ? {
            ...run,
            status: "accepted",
            acceptedAt,
          }
        : run,
    ),
    sessions: sessions.map((session) =>
      session.id === targetSessionId
        ? {
            ...session,
            updatedAt: acceptedAt,
          }
        : session,
    ),
  };
}

export function attachReviewSession({
  attachedAt = new Date().toISOString(),
  externalSessionId,
  externalSessionKind,
  provider,
  sessionId,
  sessions,
}: AttachReviewSessionInput): ReviewSession[] {
  const trimmedExternalSessionId = externalSessionId.trim();
  const hasCliSession =
    trimmedExternalSessionId.length > 0 &&
    isMatchingCliSessionKind(provider, externalSessionKind);

  return sessions.map((session) =>
    session.id === sessionId
      ? {
          ...session,
          externalSessionId: hasCliSession
            ? trimmedExternalSessionId
            : undefined,
          externalSessionKind: hasCliSession ? externalSessionKind : undefined,
          origin: hasCliSession ? "attached" : session.origin,
          provider,
          updatedAt: attachedAt,
        }
      : session,
  );
}

export function updateReviewSession(
  sessions: ReviewSession[],
  sessionId: string,
  patch: Partial<
    Pick<
      ReviewSession,
      "contextSummary" | "currentPhase" | "label" | "taskGoal"
    >
  >,
  updatedAt = new Date().toISOString(),
): ReviewSession[] {
  return sessions.map((session) =>
    session.id === sessionId
      ? {
          ...session,
          ...patch,
          updatedAt,
        }
      : session,
  );
}

export function createLinkedWebSession({
  artifact,
  baseSession,
  now = new Date().toISOString(),
  provider,
}: {
  artifact: Artifact;
  baseSession?: ReviewSession;
  now?: string;
  provider: AgentProvider;
}): ReviewSession {
  return {
    id: createScopedId("session"),
    provider,
    label: `${provider.toUpperCase()} 审阅会话`,
    taskGoal:
      baseSession?.taskGoal ??
      artifact.metadata?.taskId ??
      `审阅 ${artifact.title}。`,
    currentPhase: baseSession?.currentPhase ?? artifact.stage,
    origin: "created_in_web",
    contextSummary: baseSession?.contextSummary ?? "",
    artifactIds: [artifact.id],
    createdAt: now,
    updatedAt: now,
  };
}

export function linkArtifactToSession(
  links: ArtifactSessionLink[],
  artifactId: string,
  sessionId: string,
): ArtifactSessionLink[] {
  return links.map((link) => {
    if (link.artifactId !== artifactId) {
      return link;
    }

    const linkedSessionIds = link.linkedSessionIds.includes(sessionId)
      ? link.linkedSessionIds
      : [...link.linkedSessionIds, sessionId];

    return {
      ...link,
      activeSessionId: sessionId,
      linkedSessionIds,
    };
  });
}

export function linkReviewSessionToArtifact({
  artifactId,
  links,
  sessionId,
  sessions,
  updatedAt = new Date().toISOString(),
}: LinkReviewSessionToArtifactInput): ReviewSessionState {
  return {
    links: linkArtifactToSession(links, artifactId, sessionId),
    sessions: sessions.map((session) => {
      if (session.id !== sessionId) {
        return session;
      }

      if (session.artifactIds.includes(artifactId)) {
        return session;
      }

      return {
        ...session,
        artifactIds: [...session.artifactIds, artifactId],
        updatedAt,
      };
    }),
  };
}

export function createScopedId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
}

function isMatchingCliSessionKind(
  provider: AgentProvider,
  sessionKind?: LauncherContext["sessionKind"],
): sessionKind is CliSessionKind {
  return (
    (provider === "codex" && sessionKind === "codex_cli_session") ||
    (provider === "traex" && sessionKind === "traex_cli_session")
  );
}

function sanitizeId(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return sanitized || "main";
}
