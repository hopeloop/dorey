import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type {
  BatchRevisionRequest,
  BatchRevisionResponse,
  QueuedRevisionSubmission,
  RevisionSubmissionStatus,
} from "../contracts/index.js";
import {
  createRevisionPollBroker,
  type RevisionPollBroker,
  type RevisionPollResult,
  type RevisionPollTarget,
} from "./revision-poll-broker.js";

export type AgentRevisionSubmitHttpRequest = {
  baseUrl?: string;
  body: string;
  method?: string;
};

export type AgentRevisionSubmitHttpResponse =
  | {
      status: 200;
      body: QueuedRevisionSubmission;
    }
  | {
      status: 400 | 405 | 500;
      body: {
        error: string;
      };
    };

export type RevisionPollHttpRequest = {
  method?: string;
  url?: string;
};

export type RevisionPollHttpResponse =
  | {
      status: 200;
      body: RevisionPollResult;
    }
  | {
      status: 400 | 405;
      body: {
        error: string;
      };
    };

export type RevisionSubmissionHttpRequest = {
  body?: string;
  method?: string;
  url?: string;
};

export type RevisionSubmissionHttpResponse =
  | {
      status: 200;
      body: RevisionSubmissionStatus | { requestId: string; status: "completed" };
    }
  | {
      status: 400 | 404 | 405 | 500;
      body: {
        error: string;
      };
    };

export type RevisionSubmitTargetResolver = (
  req: BatchRevisionRequest,
) => RevisionPollTarget | undefined;

export type AgentRevisionSubmitHandlerOptions = {
  broker?: RevisionPollBroker;
  cwd: string;
  targetResolver: RevisionSubmitTargetResolver;
};

export type RevisionPollHandlerOptions = {
  broker?: RevisionPollBroker;
};

const defaultBroker = createRevisionPollBroker({
  payloadRoot: path.join(process.cwd(), ".local", "markdown-review-submits"),
});

export async function handleAgentRevisionSubmitRequest(
  req: AgentRevisionSubmitHttpRequest,
  options: AgentRevisionSubmitHandlerOptions,
): Promise<AgentRevisionSubmitHttpResponse> {
  if (req.method !== "POST") {
    return {
      status: 405,
      body: { error: "Method not allowed." },
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(req.body);
  } catch {
    return {
      status: 400,
      body: { error: "Revision submit request body must be valid JSON." },
    };
  }

  if (!isBatchRevisionRequest(parsed)) {
    return {
      status: 400,
      body: { error: "Revision submit request body is not a BatchRevisionRequest." },
    };
  }

  const target = options.targetResolver(parsed);

  if (!target) {
    return {
      status: 400,
      body: { error: "Revision submit request cannot resolve a launcher target." },
    };
  }

  try {
    const broker = options.broker ?? defaultBroker;

    return {
      status: 200,
      body: await broker.enqueue({
        baseUrl: req.baseUrl ?? "http://127.0.0.1:5173",
        request: parsed,
        target,
      }),
    };
  } catch (error) {
    return {
      status: 500,
      body: {
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function handleRevisionPollRequest(
  req: RevisionPollHttpRequest,
  options: RevisionPollHandlerOptions = {},
): Promise<RevisionPollHttpResponse> {
  if (req.method !== "GET") {
    return {
      status: 405,
      body: { error: "Method not allowed." },
    };
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const targetKey = url.searchParams.get("target")?.trim();

  if (!targetKey) {
    return {
      status: 400,
      body: { error: "Missing poll target." },
    };
  }

  const timeoutMs = Math.max(
    0,
    Math.min(Number(url.searchParams.get("timeoutMs") ?? 0) || 0, 120_000),
  );

  return {
    status: 200,
    body: await (options.broker ?? defaultBroker).poll({ targetKey, timeoutMs }),
  };
}

export async function handleRevisionSubmissionRequest(
  req: RevisionSubmissionHttpRequest,
  options: RevisionPollHandlerOptions = {},
): Promise<RevisionSubmissionHttpResponse> {
  const parsedPath = parseSubmissionPath(req.url ?? "/");

  if (!parsedPath) {
    return {
      status: 404,
      body: { error: "Revision submission not found." },
    };
  }

  const broker = options.broker ?? defaultBroker;

  if (req.method === "GET" && parsedPath.action === "status") {
    const status = broker.getSubmissionStatus(parsedPath.requestId);

    if (!status) {
      return {
        status: 404,
        body: { error: "Revision submission not found." },
      };
    }

    return {
      status: 200,
      body: status,
    };
  }

  if (req.method === "POST" && parsedPath.action === "reply") {
    let parsed: unknown;

    try {
      parsed = JSON.parse(req.body ?? "");
    } catch {
      return {
        status: 400,
        body: { error: "Revision reply body must be valid JSON." },
      };
    }

    if (!isBatchRevisionResponse(parsed)) {
      return {
        status: 400,
        body: { error: "Revision reply body is not a BatchRevisionResponse." },
      };
    }

    try {
      await broker.complete(parsedPath.requestId, parsed);

      return {
        status: 200,
        body: {
          requestId: parsedPath.requestId,
          status: "completed",
        },
      };
    } catch (error) {
      return {
        status: 404,
        body: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  return {
    status: 405,
    body: { error: "Method not allowed." },
  };
}

export function createAgentRevisionSubmitMiddleware(
  options: AgentRevisionSubmitHandlerOptions,
) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next?: (error?: unknown) => void,
  ) => {
    try {
      const result = await handleAgentRevisionSubmitRequest(
        {
          baseUrl: baseUrlFromRequest(req),
          body: await readRequestBody(req),
          method: req.method,
        },
        options,
      );

      writeJson(res, result.status, result.body);
    } catch (error) {
      next?.(error);
    }
  };
}

export function createRevisionPollMiddleware(
  options: RevisionPollHandlerOptions = {},
) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next?: (error?: unknown) => void,
  ) => {
    try {
      const result = await handleRevisionPollRequest(
        {
          method: req.method,
          url: req.url,
        },
        options,
      );

      writeJson(res, result.status, result.body);
    } catch (error) {
      next?.(error);
    }
  };
}

export function createRevisionSubmissionMiddleware(
  options: RevisionPollHandlerOptions = {},
) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next?: (error?: unknown) => void,
  ) => {
    try {
      const result = await handleRevisionSubmissionRequest(
        {
          body: req.method === "POST" ? await readRequestBody(req) : undefined,
          method: req.method,
          url: req.url,
        },
        options,
      );

      writeJson(res, result.status, result.body);
    } catch (error) {
      next?.(error);
    }
  };
}

export function resolveCodexCliPollTarget(
  req: BatchRevisionRequest,
): RevisionPollTarget {
  const sessionId =
    resolveSessionId(req, "codex_cli_session") ?? req.session?.id ?? "default";

  return {
    key: `codex-cli:${sessionId}`,
    label: "Codex CLI（原会话）",
    provider: "codex",
    transport: "codex_cli",
  };
}

export function resolveTraexCliPollTarget(
  req: BatchRevisionRequest,
): RevisionPollTarget {
  const sessionId =
    resolveSessionId(req, "traex_cli_session") ??
    resolveLauncherThreadId(req, "traex") ??
    req.session?.id ??
    "default";

  return {
    key: `traex-cli:${sessionId}`,
    label: "TraeX CLI（原会话）",
    provider: "traex",
    transport: "traex_cli",
  };
}

export function resolveCodexDesktopPollTarget(
  req: BatchRevisionRequest,
): RevisionPollTarget | undefined {
  const launcherContext = req.session?.launcherContext;

  if (
    launcherContext?.provider !== "codex" ||
    launcherContext.sessionKind !== "codex_thread"
  ) {
    return undefined;
  }

  const threadId = launcherContext.sessionId.trim();

  if (!threadId) {
    return undefined;
  }

  return {
    key: `codex-desktop:${threadId}`,
    label: "Codex Desktop（原对话）",
    provider: "codex",
    transport: "codex_desktop",
  };
}

function resolveSessionId(
  req: BatchRevisionRequest,
  sessionKind: "codex_cli_session" | "traex_cli_session",
): string | undefined {
  if (
    req.session?.externalSessionKind === sessionKind &&
    req.session.externalSessionId?.trim()
  ) {
    return req.session.externalSessionId.trim();
  }

  if (
    req.session?.launcherContext?.sessionKind === sessionKind &&
    req.session.launcherContext.sessionId.trim()
  ) {
    return req.session.launcherContext.sessionId.trim();
  }

  return undefined;
}

function resolveLauncherThreadId(
  req: BatchRevisionRequest,
  provider: "codex" | "traex",
): string | undefined {
  if (
    req.session?.launcherContext?.provider === provider &&
    req.session.launcherContext.sessionId.trim()
  ) {
    return req.session.launcherContext.sessionId.trim();
  }

  return undefined;
}

function parseSubmissionPath(
  rawUrl: string,
): { action: "reply" | "status"; requestId: string } | undefined {
  const url = new URL(rawUrl, "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length === 1) {
    return {
      action: "status",
      requestId: decodeURIComponent(parts[0] ?? ""),
    };
  }

  if (parts.length === 2 && parts[1] === "reply") {
    return {
      action: "reply",
      requestId: decodeURIComponent(parts[0] ?? ""),
    };
  }

  return undefined;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function baseUrlFromRequest(req: IncomingMessage): string {
  const host = req.headers.host ?? "127.0.0.1:5173";

  return `http://${host}`;
}

function isBatchRevisionRequest(value: unknown): value is BatchRevisionRequest {
  if (!isRecord(value) || !isRecord(value.artifact)) {
    return false;
  }

  return (
    typeof value.artifact.id === "string" &&
    typeof value.artifact.title === "string" &&
    typeof value.artifact.markdown === "string" &&
    Array.isArray(value.comments)
  );
}

function isBatchRevisionResponse(value: unknown): value is BatchRevisionResponse {
  return (
    isRecord(value) &&
    typeof value.revisedMarkdown === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.addressedComments)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
