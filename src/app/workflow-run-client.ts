import type { BatchRevisionResponse, ContextSnapshot, QueuedComment } from "../contracts/index.js";
import type {
  WorkflowArtifactContent,
  WorkflowReviewResult,
  WorkflowRevisionTraceResult,
  WorkflowRunSummary,
} from "../server/workflow-run-loader.js";
import { resolveMarkdownAssetPath } from "../shared/markdown-document.js";

export async function listWorkflowRuns(): Promise<WorkflowRunSummary[]> {
  const response = await fetchJson<{ runs: WorkflowRunSummary[] }>(
    "/api/workflow-runs",
  );

  return response.runs;
}

export async function getWorkflowRun(
  runKey: string,
): Promise<WorkflowRunSummary> {
  const response = await fetchJson<{ run: WorkflowRunSummary }>(
    `/api/workflow-runs/${encodeURIComponent(runKey)}`,
  );

  return response.run;
}

export async function getWorkflowArtifact(
  runKey: string,
  artifactId: string,
): Promise<WorkflowArtifactContent> {
  return await fetchJson<WorkflowArtifactContent>(
    `/api/workflow-runs/${encodeURIComponent(runKey)}/artifacts/${encodeURIComponent(artifactId)}`,
  );
}

export function getWorkflowAssetUrl(
  runKey: string,
  documentRelativePath: string,
  source: string,
): string {
  const relativePath = resolveMarkdownAssetPath(documentRelativePath, source);

  if (!relativePath) {
    return source;
  }

  return `/api/workflow-runs/${encodeURIComponent(runKey)}/assets/${encodeURIComponent(relativePath)}`;
}

export async function saveWorkflowRevisionTrace(input: {
  adapterName: "codex" | "traex" | "manual";
  artifactId: string;
  comments: QueuedComment[];
  contextSnapshot: ContextSnapshot;
  globalInstruction?: string;
  originalMarkdown: string;
  response: BatchRevisionResponse;
  runKey: string;
  submittedAt: string;
}): Promise<WorkflowRevisionTraceResult> {
  return await fetchJson<WorkflowRevisionTraceResult>(
    `/api/workflow-runs/${encodeURIComponent(input.runKey)}/artifacts/${encodeURIComponent(input.artifactId)}/revision`,
    {
      body: JSON.stringify({
        adapterName: input.adapterName,
        comments: input.comments,
        contextSnapshot: input.contextSnapshot,
        globalInstruction: input.globalInstruction,
        originalMarkdown: input.originalMarkdown,
        response: input.response,
        submittedAt: input.submittedAt,
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );
}

export async function saveWorkflowReviewResult(input: {
  acceptedAt: string;
  artifactId: string;
  latestRevisionRequestPath: string;
  latestRevisionResponsePath: string;
  response: BatchRevisionResponse;
  runKey: string;
}): Promise<WorkflowReviewResult> {
  return await fetchJson<WorkflowReviewResult>(
    `/api/workflow-runs/${encodeURIComponent(input.runKey)}/artifacts/${encodeURIComponent(input.artifactId)}/accept`,
    {
      body: JSON.stringify({
        acceptedAt: input.acceptedAt,
        latestRevisionRequestPath: input.latestRevisionRequestPath,
        latestRevisionResponsePath: input.latestRevisionResponsePath,
        response: input.response,
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as T;
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text();

  if (!text) {
    return `Workflow request failed with HTTP ${response.status}.`;
  }

  try {
    const body = JSON.parse(text) as { error?: unknown };

    if (typeof body.error === "string") {
      return body.error;
    }
  } catch {
    return text;
  }

  return text;
}
