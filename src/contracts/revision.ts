import type { Artifact } from "./artifact.js";
import type { QueuedComment } from "./comment.js";
import type {
  ContextSnapshot,
  ReviewRunRecord,
  ReviewSession,
} from "./session.js";

export type BatchRevisionRequest = {
  artifact: Artifact;
  comments: QueuedComment[];
  globalInstruction?: string;
  session?: ReviewSession;
  contextSnapshot?: ContextSnapshot;
  reviewHistory?: ReviewRunRecord[];
};

export type BatchRevisionResponse = {
  revisedMarkdown: string;
  summary: string;
  addressedComments: {
    commentId: string;
    resolution: string;
  }[];
};

export type RevisionSubmitTransport =
  | "codex_cli"
  | "codex_desktop"
  | "traex_cli";

export type RevisionSubmitTarget = {
  key: string;
  label: string;
  provider: "codex" | "traex";
  transport: RevisionSubmitTransport;
};

export type QueuedRevisionSubmission = {
  agentPollCommand: string;
  message: string;
  payloadPath: string;
  pollCommand: string;
  replyCommand: string;
  requestId: string;
  status: "queued";
  target: RevisionSubmitTarget;
};

type RevisionSubmissionStatusBase = {
  acknowledgedAt?: string;
  agentPollCommand: string;
  payloadPath: string;
  pollCommand: string;
  queuedAt: string;
  replyCommand: string;
  request: BatchRevisionRequest;
  requestId: string;
  target: RevisionSubmitTarget;
};

export type RevisionSubmissionStatus =
  | (RevisionSubmissionStatusBase & {
      status: "queued" | "delivered";
    })
  | (RevisionSubmissionStatusBase & {
      response: BatchRevisionResponse;
      status: "completed";
    });

export type RevisionSubmissionList = {
  submissions: RevisionSubmissionStatus[];
};

export type BatchRevisionSubmitResponse =
  | BatchRevisionResponse
  | QueuedRevisionSubmission;

export type AgentRevisionOptions = {
  signal?: AbortSignal;
};

export interface AgentAdapter {
  reviseArtifact(
    req: BatchRevisionRequest,
    options?: AgentRevisionOptions,
  ): Promise<BatchRevisionSubmitResponse>;
}
