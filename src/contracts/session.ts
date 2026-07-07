export type AgentProvider = "codex" | "traex";
export type RevisionSource = AgentProvider | "manual";

export type SessionOrigin =
  | "launched_from_agent"
  | "created_in_web"
  | "attached";

export type LauncherSessionKind = "codex_thread" | "traex_thread";

export type CliSessionKind = "codex_cli_session" | "traex_cli_session";

export type ExternalSessionKind = LauncherSessionKind | CliSessionKind;

export type LauncherContext = {
  provider: AgentProvider;
  sessionId: string;
  sessionKind: ExternalSessionKind;
  label?: string;
};

export type ReviewSession = {
  id: string;
  provider: AgentProvider;
  label: string;
  taskGoal: string;
  currentPhase: string;
  origin: SessionOrigin;
  launcherContext?: LauncherContext;
  externalSessionId?: string;
  externalSessionKind?: CliSessionKind;
  contextSummary: string;
  artifactIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type ArtifactSessionLink = {
  artifactId: string;
  originSessionId: string;
  activeSessionId: string;
  linkedSessionIds: string[];
};

export type ContextSnapshot = {
  id: string;
  sessionId: string;
  artifactId: string;
  agentProvider: AgentProvider;
  createdAt: string;
  taskGoal: string;
  currentPhase: string;
  contextSummary: string;
  linkedSessionIds: string[];
  priorAcceptedRevisionSummaries: string[];
};

export type ReviewRunStatus = "proposed" | "accepted" | "rejected";

export type ReviewRunRecord = {
  id: string;
  sessionId: string;
  artifactId: string;
  adapter: RevisionSource;
  createdAt: string;
  commentIds: string[];
  contextSnapshot: ContextSnapshot;
  status: ReviewRunStatus;
  summary?: string;
  acceptedAt?: string;
};
