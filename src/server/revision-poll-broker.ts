import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AgentProvider,
  BatchRevisionRequest,
  BatchRevisionResponse,
  QueuedRevisionSubmission,
  RevisionSubmissionStatus,
  RevisionSubmitTarget,
  RevisionSubmitTransport,
} from "../contracts/index.js";
import { buildRevisionAgentPollCommand } from "./revision-agent-poll-cli.js";

export type RevisionTransport = RevisionSubmitTransport;

export type RevisionPollTarget = RevisionSubmitTarget;

export type RevisionSubmissionRecord = {
  agentPollCommand: string;
  deliveredAt?: string;
  payloadPath: string;
  pollCommand: string;
  queuedAt: string;
  replyCommand: string;
  request: BatchRevisionRequest;
  requestId: string;
  response?: BatchRevisionResponse;
  status: "queued" | "delivered" | "completed";
  target: RevisionPollTarget;
};

export type RevisionPollResult =
  | {
      nextStep: string;
      status: "waiting";
      targetKey: string;
    }
  | {
      agentPollCommand: string;
      nextStep: string;
      payloadPath: string;
      replyCommand: string;
      request: BatchRevisionRequest;
      requestId: string;
      status: "feedback";
      target: RevisionPollTarget;
    };

export type CompletedRevisionSubmission = {
  requestId: string;
  response: BatchRevisionResponse;
  status: "completed";
};

export type RevisionPollBrokerOptions = {
  createId?: () => string;
  now?: () => string;
  onCompleted?: (record: RevisionSubmissionRecord) => void;
  onFeedbackDelivered?: (record: RevisionSubmissionRecord) => void;
  payloadRoot: string;
};

export type RevisionPollBroker = ReturnType<typeof createRevisionPollBroker>;

const feedbackEvent = "feedback";

export function createRevisionPollBroker({
  createId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`,
  now = () => new Date().toISOString(),
  onCompleted,
  onFeedbackDelivered,
  payloadRoot,
}: RevisionPollBrokerOptions) {
  const events = new EventEmitter();
  const records = new Map<string, RevisionSubmissionRecord>();
  const pendingIdsByTarget = new Map<string, string[]>();

  async function enqueue({
    baseUrl,
    request,
    target,
  }: {
    baseUrl: string;
    request: BatchRevisionRequest;
    target: RevisionPollTarget;
  }): Promise<QueuedRevisionSubmission> {
    const requestId = createId();
    const queuedAt = now();
    const requestDir = path.join(
      payloadRoot,
      `${sanitizeForPath(target.key)}-${sanitizeForPath(requestId)}`,
    );
    await mkdir(requestDir, { recursive: true });
    const payloadPath = path.join(requestDir, "payload.json");
    await writeFile(payloadPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");

    const commands = createRevisionPollCommands({
      baseUrl,
      requestId,
      targetKey: target.key,
    });
    const record: RevisionSubmissionRecord = {
      agentPollCommand: commands.agentPollCommand,
      payloadPath,
      pollCommand: commands.pollCommand,
      queuedAt,
      replyCommand: commands.replyCommand,
      request,
      requestId,
      status: "queued",
      target,
    };

    records.set(requestId, record);
    pendingIdsByTarget.set(target.key, [
      ...(pendingIdsByTarget.get(target.key) ?? []),
      requestId,
    ]);
    events.emit(feedbackEvent, target.key);

    return {
      agentPollCommand: commands.agentPollCommand,
      message: `已排队给 ${target.label}。请在启动该 Workspace 的原 Agent 会话中运行 poll 命令处理。`,
      payloadPath,
      pollCommand: commands.pollCommand,
      replyCommand: commands.replyCommand,
      requestId,
      status: "queued",
      target,
    };
  }

  async function poll({
    targetKey,
    timeoutMs = 0,
  }: {
    targetKey: string;
    timeoutMs?: number;
  }): Promise<RevisionPollResult> {
    const immediate = takeNext(targetKey);

    if (immediate) {
      return immediate;
    }

    if (timeoutMs <= 0) {
      return waiting(targetKey);
    }

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(waiting(targetKey));
      }, timeoutMs);
      const onFeedback = (changedTargetKey: string) => {
        if (changedTargetKey !== targetKey) {
          return;
        }

        const result = takeNext(targetKey);

        if (!result) {
          return;
        }

        cleanup();
        resolve(result);
      };
      const cleanup = () => {
        clearTimeout(timer);
        events.off(feedbackEvent, onFeedback);
      };

      events.on(feedbackEvent, onFeedback);
    });
  }

  async function complete(
    requestId: string,
    response: BatchRevisionResponse,
  ): Promise<CompletedRevisionSubmission> {
    const record = records.get(requestId);

    if (!record) {
      throw new Error(`Unknown revision submission: ${requestId}`);
    }

    record.status = "completed";
    record.response = response;
    notifyLifecycleHook(onCompleted, record);

    return {
      requestId,
      response,
      status: "completed",
    };
  }

  function getSubmission(requestId: string): RevisionSubmissionRecord | undefined {
    return records.get(requestId);
  }

  function getSubmissionStatus(
    requestId: string,
  ): RevisionSubmissionStatus | undefined {
    const record = records.get(requestId);

    if (!record) {
      return undefined;
    }

    const base = {
      agentPollCommand: record.agentPollCommand,
      payloadPath: record.payloadPath,
      pollCommand: record.pollCommand,
      queuedAt: record.queuedAt,
      replyCommand: record.replyCommand,
      requestId: record.requestId,
      target: record.target,
    };

    if (record.status === "completed") {
      if (!record.response) {
        return {
          ...base,
          status: "delivered",
        };
      }

      return {
        ...base,
        response: record.response,
        status: "completed",
      };
    }

    return {
      ...base,
      status: record.status,
    };
  }

  function takeNext(targetKey: string): RevisionPollResult | undefined {
    const pendingIds = pendingIdsByTarget.get(targetKey) ?? [];

    while (pendingIds.length > 0) {
      const requestId = pendingIds.shift();
      const record = requestId ? records.get(requestId) : undefined;

      if (!record || record.status !== "queued") {
        continue;
      }

      record.status = "delivered";
      record.deliveredAt = now();
      pendingIdsByTarget.set(targetKey, pendingIds);
      notifyLifecycleHook(onFeedbackDelivered, record);

      return {
        agentPollCommand: record.agentPollCommand,
        nextStep:
          "请在当前 Agent 会话中根据 request/payload 修改 Markdown，并把完整 BatchRevisionResponse JSON POST 到 replyCommand 指向的地址。",
        payloadPath: record.payloadPath,
        replyCommand: record.replyCommand,
        request: record.request,
        requestId: record.requestId,
        status: "feedback",
        target: record.target,
      };
    }

    pendingIdsByTarget.set(targetKey, pendingIds);

    return undefined;
  }

  return {
    complete,
    enqueue,
    getSubmission,
    getSubmissionStatus,
    poll,
  };
}

function notifyLifecycleHook(
  hook: ((record: RevisionSubmissionRecord) => void) | undefined,
  record: RevisionSubmissionRecord,
): void {
  try {
    hook?.(record);
  } catch {
    // Lifecycle hooks must not make poll/reply delivery fail.
  }
}

export function createRevisionPollCommands({
  baseUrl,
  requestId,
  targetKey,
}: {
  baseUrl: string;
  requestId: string;
  targetKey: string;
}): {
  agentPollCommand: string;
  pollCommand: string;
  replyCommand: string;
} {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const pollUrl = `${normalizedBaseUrl}/api/agent/poll?target=${encodeURIComponent(targetKey)}`;
  const replyUrl = `${normalizedBaseUrl}/api/agent/submissions/${encodeURIComponent(requestId)}/reply`;

  return {
    agentPollCommand: buildRevisionAgentPollCommand({
      baseUrl: normalizedBaseUrl,
      targetKey,
    }),
    pollCommand: `curl -sS ${quoteForShell(pollUrl)}`,
    replyCommand: `curl -sS -X POST ${quoteForShell(replyUrl)} -H 'Content-Type: application/json' --data-binary @response.json`,
  };
}

function waiting(targetKey: string): RevisionPollResult {
  return {
    nextStep:
      "暂无待处理 Dorey submit。保持当前会话，稍后重新运行 poll 命令即可。",
    status: "waiting",
    targetKey,
  };
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sanitizeForPath(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "item"
  );
}
