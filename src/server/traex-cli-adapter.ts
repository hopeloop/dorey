import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  BatchRevisionRequest,
  BatchRevisionResponse,
} from "../contracts/revision.js";

export const traexRevisionOutputSchema = {
  type: "object",
  properties: {
    revisedMarkdown: {
      type: "string",
      description: "The complete revised Markdown artifact.",
    },
    summary: {
      type: "string",
      description: "Concise summary of the changes made.",
    },
    addressedComments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          commentId: { type: "string" },
          resolution: { type: "string" },
        },
        required: ["commentId", "resolution"],
        additionalProperties: false,
      },
    },
  },
  required: ["revisedMarkdown", "summary", "addressedComments"],
  additionalProperties: false,
} as const;

export type TraexExecArgsInput = {
  cwd: string;
  execution?: CliExecutionMode;
  outputPath: string;
};

export type CliExecutionMode =
  | {
      type: "ephemeral";
    }
  | {
      sessionId: string;
      type: "attached";
    };

export type RunTraexRevisionOptions = {
  cwd: string;
  timeoutMs?: number;
  traexBin?: string;
};

export function buildTraexRevisionPrompt(
  req: BatchRevisionRequest,
): string {
  return [
    "You revise the provided Markdown artifact according to queued review comments.",
    "",
    "Do not edit files, run commands, or describe plans. Work only from the JSON request below.",
    "Return a complete revised Markdown artifact, not a patch.",
    "Apply every comment that can be reasonably addressed. Preserve Markdown structure and tone.",
    "If a comment cannot be applied, keep the markdown coherent and explain that in addressedComments.",
    "Do not append review metadata unless the user explicitly asked for it.",
    "Return only one JSON object. Do not wrap it in Markdown fences or explanatory prose.",
    "The JSON object must conform to this JSON schema:",
    JSON.stringify(traexRevisionOutputSchema, null, 2),
    "",
    ...buildSessionContextPromptSection(req),
    "",
    "BatchRevisionRequest JSON:",
    JSON.stringify(req, null, 2),
  ].join("\n");
}

function buildSessionContextPromptSection(
  req: BatchRevisionRequest,
): string[] {
  if (!req.session && !req.contextSnapshot && !req.reviewHistory?.length) {
    return [];
  }

  return [
    "Session context JSON:",
    JSON.stringify(
      {
        session: req.session ?? null,
        contextSnapshot: req.contextSnapshot ?? null,
        acceptedReviewHistory:
          req.reviewHistory?.filter((run) => run.status === "accepted") ?? [],
      },
      null,
      2,
    ),
    "",
    "Use this session context as the materialized main-session memory for the artifact review.",
    "Treat the artifact as belonging to this session, and keep the revision aligned with its task goal, phase, and accepted history.",
  ];
}

export function buildTraexExecArgs({
  cwd,
  execution = { type: "ephemeral" },
  outputPath,
}: TraexExecArgsInput): string[] {
  if (execution.type === "attached") {
    return [
      "--ask-for-approval",
      "never",
      "--sandbox",
      "read-only",
      "--cd",
      cwd,
      "exec",
      "resume",
      "--output-last-message",
      outputPath,
      execution.sessionId,
      "-",
    ];
  }

  return [
    "--ask-for-approval",
    "never",
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--output-last-message",
    outputPath,
    "--cd",
    cwd,
    "-",
  ];
}

export function resolveTraexExecutionMode(
  req: BatchRevisionRequest,
): CliExecutionMode {
  if (
    req.session?.origin === "attached" &&
    req.session.provider === "traex" &&
    req.session.externalSessionKind === "traex_cli_session" &&
    req.session.externalSessionId
  ) {
    return {
      sessionId: req.session.externalSessionId,
      type: "attached",
    };
  }

  return { type: "ephemeral" };
}

export function parseTraexRevisionOutput(
  rawOutput: string,
): BatchRevisionResponse {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    throw new Error("TraeX adapter expected valid JSON output.");
  }

  if (!isRecord(parsed)) {
    throw new Error("TraeX adapter output must be a JSON object.");
  }

  const { revisedMarkdown, summary, addressedComments } = parsed;

  if (typeof revisedMarkdown !== "string") {
    throw new Error("TraeX adapter output missing revisedMarkdown.");
  }

  if (typeof summary !== "string") {
    throw new Error("TraeX adapter output missing summary.");
  }

  if (!Array.isArray(addressedComments)) {
    throw new Error("TraeX adapter output missing addressedComments.");
  }

  return {
    revisedMarkdown,
    summary,
    addressedComments: addressedComments.map((item, index) => {
      if (!isRecord(item)) {
        throw new Error(
          `TraeX adapter addressedComments[${index}] must be an object.`,
        );
      }

      if (typeof item.commentId !== "string") {
        throw new Error(
          `TraeX adapter addressedComments[${index}] missing commentId.`,
        );
      }

      if (typeof item.resolution !== "string") {
        throw new Error(
          `TraeX adapter addressedComments[${index}] missing resolution.`,
        );
      }

      return {
        commentId: item.commentId,
        resolution: item.resolution,
      };
    }),
  };
}

export async function runTraexRevision(
  req: BatchRevisionRequest,
  options: RunTraexRevisionOptions,
): Promise<BatchRevisionResponse> {
  const workspaceDir = options.cwd;
  const runDir = await mkdtemp(path.join(tmpdir(), "markdown-review-traex-"));
  const outputPath = path.join(runDir, "revision-output.json");

  try {
    const prompt = buildTraexRevisionPrompt(req);
    const stdout = await execTraex({
      args: buildTraexExecArgs({
        cwd: workspaceDir,
        execution: resolveTraexExecutionMode(req),
        outputPath,
      }),
      prompt,
      timeoutMs: options.timeoutMs ?? 120_000,
      traexBin: options.traexBin ?? "traex",
    });

    const output = await readFile(outputPath, "utf8").catch(() => stdout);

    return parseTraexRevisionOutput(output.trim());
  } finally {
    await rm(runDir, { force: true, recursive: true });
  }
}

type ExecTraexInput = {
  args: string[];
  prompt: string;
  timeoutMs: number;
  traexBin: string;
};

async function execTraex({
  args,
  prompt,
  timeoutMs,
  traexBin,
}: ExecTraexInput): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(traexBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`TraeX adapter timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);

      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(
        new Error(
          `TraeX adapter exited with code ${code}. ${stderr.trim() || stdout.trim()}`,
        ),
      );
    });

    child.stdin.end(prompt, "utf8");
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
