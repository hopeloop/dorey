import type { IncomingMessage, ServerResponse } from "node:http";

import type { BatchRevisionResponse } from "../contracts/index.js";
import {
  listWorkflowRuns,
  readWorkflowRunArtifact,
  writeWorkflowReviewResult,
  writeWorkflowRevisionTrace,
  type WorkflowReviewResult,
  type WorkflowRevisionTraceResult,
  type WorkflowRunSummary,
} from "./workflow-run-loader.js";

export type WorkflowRunHttpRequest = {
  body: string;
  method?: string;
  root: string;
  url: string;
};

export type WorkflowRunHttpResponse =
  | {
      status: 200;
      body:
        | { runs: WorkflowRunSummary[] }
        | { run: WorkflowRunSummary }
        | Awaited<ReturnType<typeof readWorkflowRunArtifact>>
        | WorkflowRevisionTraceResult
        | WorkflowReviewResult;
    }
  | {
      status: 400 | 404 | 405 | 500;
      body: { error: string };
    };

export async function handleWorkflowRunRequest({
  body,
  method,
  root,
  url,
}: WorkflowRunHttpRequest): Promise<WorkflowRunHttpResponse> {
  const route = parseWorkflowRoute(url);

  try {
    if (method === "GET" && route.kind === "runs") {
      return {
        status: 200,
        body: { runs: await listWorkflowRuns({ root }) },
      };
    }

    if (method === "GET" && route.kind === "run") {
      const runs = await listWorkflowRuns({ root });
      const run = runs.find((item) => item.runKey === route.runKey);

      if (!run) {
        return { status: 404, body: { error: "Workflow run not found." } };
      }

      return { status: 200, body: { run } };
    }

    if (method === "GET" && route.kind === "artifact") {
      return {
        status: 200,
        body: await readWorkflowRunArtifact({
          artifactId: route.artifactId,
          root,
          runKey: route.runKey,
        }),
      };
    }

    if (method === "POST" && route.kind === "revision") {
      const parsed = parseJsonBody(body);

      if (!isRevisionTraceBody(parsed)) {
        return {
          status: 400,
          body: { error: "Workflow revision body is invalid." },
        };
      }

      return {
        status: 200,
        body: await writeWorkflowRevisionTrace({
          ...parsed,
          artifactId: route.artifactId,
          root,
          runKey: route.runKey,
        }),
      };
    }

    if (method === "POST" && route.kind === "accept") {
      const parsed = parseJsonBody(body);

      if (!isAcceptBody(parsed)) {
        return {
          status: 400,
          body: { error: "Workflow accept body is invalid." },
        };
      }

      return {
        status: 200,
        body: await writeWorkflowReviewResult({
          ...parsed,
          artifactId: route.artifactId,
          root,
          runKey: route.runKey,
        }),
      };
    }

    if (route.kind === "unknown") {
      return { status: 404, body: { error: "Workflow endpoint not found." } };
    }

    return { status: 405, body: { error: "Method not allowed." } };
  } catch (error) {
    return {
      status: 500,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export function createWorkflowRunMiddleware(options: { root: string }) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next?: (error?: unknown) => void,
  ) => {
    try {
      const result = await handleWorkflowRunRequest({
        body: await readRequestBody(req),
        method: req.method,
        root: options.root,
        url: normalizeMountedUrl(req.url ?? ""),
      });

      res.statusCode = result.status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(result.body));
    } catch (error) {
      next?.(error);
    }
  };
}

function normalizeMountedUrl(url: string): string {
  if (url.startsWith("/api/workflow-runs")) {
    return url;
  }

  return `/api/workflow-runs${url.startsWith("/") ? url : `/${url}`}`;
}

type WorkflowRoute =
  | { kind: "runs" }
  | { kind: "run"; runKey: string }
  | { artifactId: string; kind: "artifact"; runKey: string }
  | { artifactId: string; kind: "revision"; runKey: string }
  | { artifactId: string; kind: "accept"; runKey: string }
  | { kind: "unknown" };

function parseWorkflowRoute(url: string): WorkflowRoute {
  const pathname = new URL(url, "http://localhost").pathname;
  const parts = pathname.split("/").filter(Boolean);

  if (parts[0] !== "api" || parts[1] !== "workflow-runs") {
    return { kind: "unknown" };
  }

  if (parts.length === 2) {
    return { kind: "runs" };
  }

  const runKey = decodeURIComponent(parts[2] ?? "");

  if (parts.length === 3) {
    return { kind: "run", runKey };
  }

  if (parts[3] === "artifacts" && parts[4]) {
    const artifactId = decodeURIComponent(parts[4]);

    if (parts.length === 5) {
      return { artifactId, kind: "artifact", runKey };
    }

    if (parts.length === 6 && parts[5] === "revision") {
      return { artifactId, kind: "revision", runKey };
    }

    if (parts.length === 6 && parts[5] === "accept") {
      return { artifactId, kind: "accept", runKey };
    }
  }

  return { kind: "unknown" };
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function isRevisionTraceBody(value: unknown): value is Omit<
  Parameters<typeof writeWorkflowRevisionTrace>[0],
  "artifactId" | "root" | "runKey"
> {
  return (
    isRecord(value) &&
    (value.adapterName === "codex" ||
      value.adapterName === "traex" ||
      value.adapterName === "manual") &&
    Array.isArray(value.comments) &&
    isRecord(value.contextSnapshot) &&
    typeof value.originalMarkdown === "string" &&
    isBatchRevisionResponse(value.response)
  );
}

function isAcceptBody(value: unknown): value is Omit<
  Parameters<typeof writeWorkflowReviewResult>[0],
  "artifactId" | "root" | "runKey"
> {
  return (
    isRecord(value) &&
    typeof value.latestRevisionRequestPath === "string" &&
    typeof value.latestRevisionResponsePath === "string" &&
    isBatchRevisionResponse(value.response)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
