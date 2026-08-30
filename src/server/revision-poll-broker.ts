import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
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
  acknowledgedAt?: string;
  agentPollCommand: string;
  deliveredAt?: string;
  leaseExpiresAt?: string;
  leaseOwner?: string;
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
  | { nextStep: string; status: "waiting"; targetKey: string }
  | {
      agentPollCommand: string;
      nextStep: string;
      payloadPath: string;
      replyCommand: string;
      request: BatchRevisionRequest;
      requestId: string;
      status: "feedback";
      target: RevisionPollTarget;
    }
  | { nextStep: string; status: "review_closed"; targetKey: string };

export type RevisionAgentPresence = {
  activePolls: number;
  leasedRequests: number;
  state: "waiting" | "listening" | "working";
  targetKey: string;
};

export type CompletedRevisionSubmission = {
  requestId: string;
  response: BatchRevisionResponse;
  status: "completed";
};

export type RevisionPollBrokerOptions = {
  clock?: () => number;
  createId?: () => string;
  leaseDurationMs?: number;
  now?: () => string;
  onCompleted?: (record: RevisionSubmissionRecord) => void;
  onFeedbackDelivered?: (record: RevisionSubmissionRecord) => void;
  payloadRoot: string;
};

type PersistedRevisionPollState = {
  records: RevisionSubmissionRecord[];
  reviewClosed: boolean;
  version: 1;
};

export type RevisionPollBroker = ReturnType<typeof createRevisionPollBroker>;

const feedbackEvent = "feedback";
const defaultLeaseDurationMs = 15 * 60_000;
const stateFileName = "revision-poll-state.json";

export function createRevisionPollBroker({
  clock = Date.now,
  createId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`,
  leaseDurationMs = defaultLeaseDurationMs,
  now = () => new Date().toISOString(),
  onCompleted,
  onFeedbackDelivered,
  payloadRoot,
}: RevisionPollBrokerOptions) {
  const events = new EventEmitter();
  const records = new Map<string, RevisionSubmissionRecord>();
  const pendingIdsByTarget = new Map<string, string[]>();
  const activePollsByTarget = new Map<string, number>();
  const statePath = path.join(payloadRoot, stateFileName);
  let operationTail: Promise<void> = Promise.resolve();
  let reviewClosed = false;

  hydrateFromDisk();

  async function enqueue({
    baseUrl,
    request,
    target,
  }: {
    baseUrl: string;
    request: BatchRevisionRequest;
    target: RevisionPollTarget;
  }): Promise<QueuedRevisionSubmission> {
    const submission = await runExclusive(async () => {
      if (reviewClosed) throw new Error("Dorey review is closed.");

      const requestId = createId();
      const queuedAt = now();
      const requestDir = path.join(
        payloadRoot,
        `${sanitizeForPath(target.key)}-${sanitizeForPath(requestId)}`,
      );
      await mkdir(requestDir, { recursive: true });
      const payloadPath = path.join(requestDir, "payload.json");
      await writeFile(payloadPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");

      const commands = createRevisionPollCommands({ baseUrl, requestId, targetKey: target.key });
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
      rebuildPendingIds();
      await persistState();

      return {
        agentPollCommand: commands.agentPollCommand,
        message: `已排队给 ${target.label}。原 Agent 会话保持 foreground poll 时会自动领取。`,
        payloadPath,
        pollCommand: commands.pollCommand,
        replyCommand: commands.replyCommand,
        requestId,
        status: "queued" as const,
        target,
      };
    });

    events.emit(feedbackEvent, target.key);
    return submission;
  }

  async function poll({
    clientId,
    targetKey,
    timeoutMs = 0,
    signal,
  }: {
    clientId?: string;
    targetKey: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<RevisionPollResult> {
    if (clientId) await renewOwnedLeases(targetKey, clientId);
    const immediate = await claimNext(targetKey, clientId);
    if (immediate) return immediate;
    if (reviewClosed) return reviewClosedResult(targetKey);
    if (timeoutMs <= 0 || signal?.aborted) return waiting(targetKey);

    incrementActivePolls(targetKey);

    return await new Promise((resolve) => {
      let claiming = false;
      let checkAgain = false;
      let settled = false;
      const timer = setTimeout(() => finish(waiting(targetKey)), timeoutMs);
      const onAbort = () => finish(waiting(targetKey));
      const onFeedback = (changedTargetKey: string) => {
        if (changedTargetKey === targetKey || changedTargetKey === "*") void checkQueue();
      };
      const cleanup = () => {
        clearTimeout(timer);
        events.off(feedbackEvent, onFeedback);
        signal?.removeEventListener("abort", onAbort);
        decrementActivePolls(targetKey);
      };
      const finish = (result: RevisionPollResult) => {
        if (settled) {
          if (result.status === "feedback") void release(result.requestId);
          return;
        }
        settled = true;
        cleanup();
        resolve(result);
      };
      const checkQueue = async () => {
        if (claiming) {
          checkAgain = true;
          return;
        }
        claiming = true;
        checkAgain = false;
        try {
          const result = await claimNext(targetKey, clientId);
          if (result || reviewClosed) finish(result ?? reviewClosedResult(targetKey));
        } finally {
          claiming = false;
          if (!settled && checkAgain) void checkQueue();
        }
      };

      events.on(feedbackEvent, onFeedback);
      signal?.addEventListener("abort", onAbort, { once: true });
      void checkQueue();
    });
  }

  async function complete(
    requestId: string,
    response: BatchRevisionResponse,
  ): Promise<CompletedRevisionSubmission> {
    const completed = await runExclusive(async () => {
      const record = records.get(requestId);
      if (!record) throw new Error(`Unknown revision submission: ${requestId}`);

      if (record.status === "completed" && record.response) {
        return {
          record,
          result: { requestId, response: record.response, status: "completed" as const },
          updated: false,
        };
      }

      record.status = "completed";
      record.response = response;
      delete record.leaseExpiresAt;
      delete record.leaseOwner;
      rebuildPendingIds();
      await persistState();
      return {
        record,
        result: { requestId, response, status: "completed" as const },
        updated: true,
      };
    });

    if (completed.updated) notifyLifecycleHook(onCompleted, completed.record);
    return completed.result;
  }

  async function release(requestId: string): Promise<boolean> {
    const releasedTarget = await runExclusive(async () => {
      const record = records.get(requestId);
      if (!record || record.status !== "delivered") return undefined;

      record.status = "queued";
      delete record.deliveredAt;
      delete record.leaseExpiresAt;
      delete record.leaseOwner;
      rebuildPendingIds();
      await persistState();
      return record.target.key;
    });

    if (!releasedTarget) return false;
    events.emit(feedbackEvent, releasedTarget);
    return true;
  }

  function getSubmission(requestId: string): RevisionSubmissionRecord | undefined {
    return records.get(requestId);
  }

  function getSubmissionStatus(requestId: string): RevisionSubmissionStatus | undefined {
    const record = records.get(requestId);
    if (!record) return undefined;

    const base = {
      acknowledgedAt: record.acknowledgedAt,
      agentPollCommand: record.agentPollCommand,
      payloadPath: record.payloadPath,
      pollCommand: record.pollCommand,
      queuedAt: record.queuedAt,
      replyCommand: record.replyCommand,
      request: record.request,
      requestId: record.requestId,
      target: record.target,
    };

    if (record.status === "completed") {
      if (!record.response) return { ...base, status: "delivered" };
      return { ...base, response: record.response, status: "completed" };
    }
    return { ...base, status: record.status };
  }

  function listSubmissionStatuses({
    limit = 20,
    targetKey,
    unacknowledgedOnly = false,
  }: {
    limit?: number;
    targetKey?: string;
    unacknowledgedOnly?: boolean;
  } = {}): RevisionSubmissionStatus[] {
    return [...records.values()]
      .filter((record) => !targetKey || record.target.key === targetKey)
      .filter((record) => !unacknowledgedOnly || !record.acknowledgedAt)
      .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt))
      .slice(0, Math.max(0, Math.min(limit, 100)))
      .flatMap((record) => {
        const status = getSubmissionStatus(record.requestId);
        return status ? [status] : [];
      });
  }

  async function acknowledge(requestId: string): Promise<{ acknowledgedAt: string; requestId: string }> {
    return await runExclusive(async () => {
      const record = records.get(requestId);
      if (!record) throw new Error(`Unknown revision submission: ${requestId}`);
      if (record.status !== "completed") {
        throw new Error(`Revision submission is not completed: ${requestId}`);
      }
      record.acknowledgedAt ??= now();
      await persistState();
      return { acknowledgedAt: record.acknowledgedAt, requestId };
    });
  }

  async function getAgentPresence(targetKey: string): Promise<RevisionAgentPresence> {
    await runExclusive(async () => {
      if (reclaimExpiredLeases()) await persistState();
    });

    const leasedRequests = [...records.values()].filter(
      (record) => record.target.key === targetKey && record.status === "delivered",
    ).length;
    const activePolls = activePollsByTarget.get(targetKey) ?? 0;
    return {
      activePolls,
      leasedRequests,
      state: leasedRequests > 0 ? "working" : activePolls > 0 ? "listening" : "waiting",
      targetKey,
    };
  }

  async function closeReview(): Promise<{ status: "review_closed" }> {
    await runExclusive(async () => {
      reviewClosed = true;
      await persistState();
    });
    events.emit(feedbackEvent, "*");
    return { status: "review_closed" };
  }

  function getReviewStatus(): { status: "open" | "review_closed" } {
    return { status: reviewClosed ? "review_closed" : "open" };
  }

  async function claimNext(
    targetKey: string,
    clientId?: string,
  ): Promise<RevisionPollResult | undefined> {
    const claimed = await runExclusive(async () => {
      if (reviewClosed) return undefined;
      const reclaimed = reclaimExpiredLeases();
      const record = takeNextRecord(targetKey);
      if (!record) {
        if (reclaimed) await persistState();
        return undefined;
      }

      record.status = "delivered";
      record.deliveredAt = now();
      record.leaseExpiresAt = new Date(clock() + leaseDurationMs).toISOString();
      record.leaseOwner = clientId;
      rebuildPendingIds();
      await persistState();
      return record;
    });

    if (!claimed) return undefined;
    notifyLifecycleHook(onFeedbackDelivered, claimed);
    return {
      agentPollCommand: claimed.agentPollCommand,
      nextStep:
        "请在当前 Agent 会话中根据 request/payload 修改 Markdown，并把完整 BatchRevisionResponse JSON POST 到 replyCommand 指向的地址。",
      payloadPath: claimed.payloadPath,
      replyCommand: claimed.replyCommand,
      request: claimed.request,
      requestId: claimed.requestId,
      status: "feedback",
      target: claimed.target,
    };
  }

  async function renewOwnedLeases(targetKey: string, clientId: string): Promise<void> {
    await runExclusive(async () => {
      let changed = false;
      for (const record of records.values()) {
        if (
          record.target.key === targetKey &&
          record.status === "delivered" &&
          record.leaseOwner === clientId
        ) {
          record.leaseExpiresAt = new Date(clock() + leaseDurationMs).toISOString();
          changed = true;
        }
      }
      if (changed) await persistState();
    });
  }

  function takeNextRecord(targetKey: string): RevisionSubmissionRecord | undefined {
    for (const requestId of pendingIdsByTarget.get(targetKey) ?? []) {
      const record = records.get(requestId);
      if (record?.status === "queued") return record;
    }
    return undefined;
  }

  function reclaimExpiredLeases(): boolean {
    const currentTime = clock();
    let changed = false;
    for (const record of records.values()) {
      if (
        record.status === "delivered" &&
        (!record.leaseExpiresAt || Date.parse(record.leaseExpiresAt) <= currentTime)
      ) {
        record.status = "queued";
        delete record.deliveredAt;
        delete record.leaseExpiresAt;
        delete record.leaseOwner;
        changed = true;
      }
    }
    if (changed) rebuildPendingIds();
    return changed;
  }

  function rebuildPendingIds(): void {
    pendingIdsByTarget.clear();
    const queued = [...records.values()]
      .filter((record) => record.status === "queued")
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
    for (const record of queued) {
      pendingIdsByTarget.set(record.target.key, [
        ...(pendingIdsByTarget.get(record.target.key) ?? []),
        record.requestId,
      ]);
    }
  }

  function hydrateFromDisk(): void {
    let persisted: PersistedRevisionPollState;
    try {
      persisted = JSON.parse(readFileSync(statePath, "utf8")) as PersistedRevisionPollState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(
        `Could not load Dorey revision queue state at ${statePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (persisted.version !== 1 || !Array.isArray(persisted.records)) {
      throw new Error(`Unsupported Dorey revision queue state at ${statePath}.`);
    }
    reviewClosed = persisted.reviewClosed === true;
    for (const record of persisted.records) {
      if (record?.requestId && record?.target?.key) records.set(record.requestId, record);
    }
    reclaimExpiredLeases();
    rebuildPendingIds();
  }

  async function persistState(): Promise<void> {
    await mkdir(payloadRoot, { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    const state: PersistedRevisionPollState = {
      records: [...records.values()],
      reviewClosed,
      version: 1,
    };

    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    try {
      await rename(temporaryPath, statePath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  function runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation, operation);
    operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function incrementActivePolls(targetKey: string): void {
    activePollsByTarget.set(targetKey, (activePollsByTarget.get(targetKey) ?? 0) + 1);
  }

  function decrementActivePolls(targetKey: string): void {
    const next = Math.max(0, (activePollsByTarget.get(targetKey) ?? 0) - 1);
    if (next === 0) activePollsByTarget.delete(targetKey);
    else activePollsByTarget.set(targetKey, next);
  }

  return {
    acknowledge,
    closeReview,
    complete,
    enqueue,
    getAgentPresence,
    getReviewStatus,
    getSubmission,
    getSubmissionStatus,
    listSubmissionStatuses,
    poll,
    release,
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
}): { agentPollCommand: string; pollCommand: string; replyCommand: string } {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const pollUrl = `${normalizedBaseUrl}/api/agent/poll?target=${encodeURIComponent(targetKey)}`;
  const replyUrl = `${normalizedBaseUrl}/api/agent/submissions/${encodeURIComponent(requestId)}/reply`;
  return {
    agentPollCommand: buildRevisionAgentPollCommand({
      baseUrl: normalizedBaseUrl,
      check: false,
      targetKey,
    }),
    pollCommand: `curl -sS ${quoteForShell(pollUrl)}`,
    replyCommand: `curl -sS -X POST ${quoteForShell(replyUrl)} -H 'Content-Type: application/json' --data-binary @response.json`,
  };
}

function waiting(targetKey: string): RevisionPollResult {
  return {
    nextStep: "暂无待处理 Dorey submit。保持当前会话和 foreground poll，后续提交会自动送达。",
    status: "waiting",
    targetKey,
  };
}

function reviewClosedResult(targetKey: string): RevisionPollResult {
  return {
    nextStep: "Dorey review 已结束；停止 foreground poll。",
    status: "review_closed",
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

export function createRevisionPollTarget({
  provider,
  sessionId,
  sessionLabel,
  transport,
}: {
  provider: AgentProvider;
  sessionId: string;
  sessionLabel?: string;
  transport: RevisionTransport;
}): RevisionPollTarget {
  return {
    key: `${transport.replaceAll("_", "-")}:${sessionId}`,
    label: sessionLabel ?? `${provider === "codex" ? "Codex" : "TraeX"} 原会话`,
    provider,
    transport,
  };
}
