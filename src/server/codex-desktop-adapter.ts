import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type {
  BatchRevisionRequest,
  BatchRevisionResponse,
} from "../contracts/revision.js";
import {
  codexRevisionOutputSchema,
  parseCodexRevisionOutput,
} from "./codex-cli-adapter.js";

export type CodexDesktopPayload = {
  artifact: BatchRevisionRequest["artifact"];
  comments: BatchRevisionRequest["comments"];
  contextSnapshot: BatchRevisionRequest["contextSnapshot"] | null;
  globalInstruction: string | null;
  reviewHistory: NonNullable<BatchRevisionRequest["reviewHistory"]>;
  session: BatchRevisionRequest["session"] | null;
};

export type CodexAppServerMessage = {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
};

export type RunCodexDesktopRevisionOptions = {
  codexBin?: string;
  cwd: string;
  timeoutMs?: number;
};

export type ResolveDefaultCodexDesktopBinInput = {
  env?: Record<string, string | undefined>;
  existsSync?: (path: string) => boolean;
  homeDir?: string;
};

type RunCodexAppServerTurnInput = {
  codexBin: string;
  cwd: string;
  outputSchema: Record<string, unknown>;
  prompt: string;
  threadId: string;
  timeoutMs: number;
};

export function resolveCodexDesktopThreadId(
  req: BatchRevisionRequest,
): string | undefined {
  const launcherContext = req.session?.launcherContext;

  if (
    launcherContext?.provider === "codex" &&
    launcherContext.sessionKind === "codex_thread"
  ) {
    const threadId = launcherContext.sessionId.trim();

    return threadId.length > 0 ? threadId : undefined;
  }

  return undefined;
}

export function buildCodexDesktopPayload(
  req: BatchRevisionRequest,
): CodexDesktopPayload {
  return {
    artifact: req.artifact,
    comments: req.comments,
    contextSnapshot: req.contextSnapshot ?? null,
    globalInstruction: req.globalInstruction?.trim() || null,
    reviewHistory: req.reviewHistory ?? [],
    session: req.session ?? null,
  };
}

export function buildCodexDesktopTurnPrompt({
  payloadPath,
  request,
}: {
  payloadPath: string;
  request: BatchRevisionRequest;
}): string {
  const session = request.session;
  const context = request.contextSnapshot;

  return [
    "Dorey 请求你处理一批已排队的 doc review comments。",
    "",
    `请读取 payload JSON 文件：${payloadPath}`,
    "",
    "你需要：",
    "1. 只根据 payload 中的 artifact、comments、session context、accepted review history 修改 Markdown。",
    "2. 返回完整修订后的 Markdown，不要返回 patch。",
    "3. 尽量处理每一条 queued comment；无法处理时在 addressedComments 解释原因。",
    "4. 不要把 payload JSON 原文粘贴到回复里。",
    "5. 最终回复必须是符合 output schema 的 JSON object，字段包含 revisedMarkdown、summary、addressedComments。",
    "",
    session?.taskGoal ? `任务目标：${session.taskGoal}` : undefined,
    context?.currentPhase ?? session?.currentPhase
      ? `当前阶段：${context?.currentPhase ?? session?.currentPhase}`
      : undefined,
    context?.contextSummary ?? session?.contextSummary
      ? `会话上下文摘要：${context?.contextSummary ?? session?.contextSummary}`
      : undefined,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

export function buildCodexAppServerMessages({
  cwd,
  outputSchema,
  prompt,
  threadId,
}: {
  cwd: string;
  outputSchema: Record<string, unknown>;
  prompt: string;
  threadId: string;
}): CodexAppServerMessage[] {
  return [
    {
      id: 0,
      method: "initialize",
      params: {
        capabilities: {
          experimentalApi: true,
        },
        clientInfo: {
          name: "dorey",
          title: "Dorey",
          version: "0.1.0",
        },
      },
    },
    {
      method: "initialized",
      params: {},
    },
    {
      id: 1,
      method: "thread/resume",
      params: {
        cwd,
        threadId,
      },
    },
    {
      id: 2,
      method: "turn/start",
      params: {
        approvalPolicy: "never",
        cwd,
        input: [
          {
            text: prompt,
            type: "text",
          },
        ],
        outputSchema,
        sandboxPolicy: {
          networkAccess: false,
          type: "readOnly",
        },
        threadId,
      },
    },
  ];
}

export function parseCodexDesktopRevisionOutput(
  rawOutput: string,
): BatchRevisionResponse {
  return parseCodexRevisionOutput(rawOutput);
}

export function resolveDefaultCodexDesktopBin(
  input: ResolveDefaultCodexDesktopBinInput = {},
): string {
  const env = input.env ?? process.env;
  const configuredBin = env.MARKDOWN_REVIEW_CODEX_DESKTOP_BIN?.trim();

  if (configuredBin) {
    return configuredBin;
  }

  const bundledBin = path.join(
    input.homeDir ?? homedir(),
    ".codex",
    "plugins",
    ".plugin-appserver",
    "codex",
  );
  const fileExists = input.existsSync ?? existsSync;

  return fileExists(bundledBin) ? bundledBin : "codex";
}

export async function runCodexDesktopRevision(
  req: BatchRevisionRequest,
  options: RunCodexDesktopRevisionOptions,
): Promise<BatchRevisionResponse> {
  const threadId = resolveCodexDesktopThreadId(req);

  if (!threadId) {
    throw new Error(
      "Codex Desktop revision requires a Codex Desktop launcher thread id.",
    );
  }

  const submitRoot = path.join(options.cwd, ".local", "markdown-review-submits");
  await mkdir(submitRoot, { recursive: true });
  const runDir = await mkdtemp(path.join(submitRoot, "codex-desktop-"));
  const payloadPath = path.join(runDir, "payload.json");

  await writeFile(
    payloadPath,
    `${JSON.stringify(buildCodexDesktopPayload(req), null, 2)}\n`,
    "utf8",
  );

  const prompt = buildCodexDesktopTurnPrompt({
    payloadPath,
    request: req,
  });
  const rawOutput = await runCodexAppServerTurn({
    codexBin: options.codexBin ?? resolveDefaultCodexDesktopBin(),
    cwd: options.cwd,
    outputSchema: codexRevisionOutputSchema,
    prompt,
    threadId,
    timeoutMs: options.timeoutMs ?? 120_000,
  });

  return parseCodexDesktopRevisionOutput(rawOutput.trim());
}

async function runCodexAppServerTurn({
  codexBin,
  cwd,
  outputSchema,
  prompt,
  threadId,
  timeoutMs,
}: RunCodexAppServerTurnInput): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(codexBin, ["app-server", "--stdio"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lineReader = createInterface({ input: child.stdout });
    let stderr = "";
    let agentText = "";
    let completedAgentText = "";
    let settled = false;

    const timeout = setTimeout(() => {
      fail(new Error(`Codex Desktop adapter timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      lineReader.close();
    }

    function fail(error: Error) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      child.kill("SIGTERM");
      reject(error);
    }

    function succeed(output: string) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      child.kill("SIGTERM");
      resolve(output);
    }

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      fail(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }

      if (code !== 0) {
        fail(
          new Error(
            `Codex Desktop adapter exited with code ${code}. ${stderr.trim()}`,
          ),
        );
        return;
      }

      fail(
        new Error(
          `Codex Desktop adapter exited before turn completion. ${stderr.trim()}`,
        ),
      );
    });
    lineReader.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      let message: unknown;

      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (!isRecord(message)) {
        return;
      }

      if (isRecord(message.error)) {
        fail(new Error(readJsonRpcError(message.error)));
        return;
      }

      if (
        (typeof message.id === "number" || typeof message.id === "string") &&
        typeof message.method === "string"
      ) {
        sendUnsupportedServerRequest(child.stdin, message.id, message.method);
        return;
      }

      const method = typeof message.method === "string" ? message.method : "";
      const params = isRecord(message.params) ? message.params : {};

      if (
        method === "item/agentMessage/delta" &&
        typeof params.delta === "string"
      ) {
        agentText += params.delta;
        return;
      }

      if (method === "item/completed") {
        const item = isRecord(params.item) ? params.item : undefined;

        if (item?.type === "agentMessage" && typeof item.text === "string") {
          completedAgentText = item.text;
        }

        return;
      }

      if (method === "error") {
        fail(new Error(readNotificationError(params)));
        return;
      }

      if (method === "turn/completed") {
        succeed(completedAgentText.trim() || agentText.trim());
      }
    });

    for (const message of buildCodexAppServerMessages({
      cwd,
      outputSchema,
      prompt,
      threadId,
    })) {
      child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
    }
  });
}

function sendUnsupportedServerRequest(
  stdin: NodeJS.WritableStream,
  id: number | string,
  method: string,
) {
  stdin.write(
    `${JSON.stringify({
      error: {
        code: -32601,
        message: `Dorey does not implement app-server request ${method}.`,
      },
      id,
    })}\n`,
    "utf8",
  );
}

function readJsonRpcError(error: Record<string, unknown>): string {
  if (typeof error.message === "string") {
    return error.message;
  }

  return JSON.stringify(error);
}

function readNotificationError(params: Record<string, unknown>): string {
  if (typeof params.message === "string") {
    return params.message;
  }

  if (typeof params.error === "string") {
    return params.error;
  }

  return JSON.stringify(params);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
