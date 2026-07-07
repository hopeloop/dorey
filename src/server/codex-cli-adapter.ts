import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  BatchRevisionRequest,
  BatchRevisionResponse,
} from "../contracts/revision.js";

export const codexRevisionOutputSchema = {
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

export type CodexExecArgsInput = {
  cwd: string;
  execution?: CliExecutionMode;
  schemaPath: string;
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

export type RunCodexRevisionOptions = {
  cwd: string;
  codexBin?: string;
  timeoutMs?: number;
};

export function buildCodexRevisionPrompt(
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
    "Your final answer must conform to the supplied JSON schema with revisedMarkdown, summary, and addressedComments.",
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

export function buildCodexExecArgs({
  cwd,
  execution = { type: "ephemeral" },
  schemaPath,
  outputPath,
}: CodexExecArgsInput): string[] {
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
      "--output-schema",
      schemaPath,
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
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "--cd",
    cwd,
    "-",
  ];
}

export function resolveCodexExecutionMode(
  req: BatchRevisionRequest,
): CliExecutionMode {
  if (
    req.session?.origin === "attached" &&
    req.session.provider === "codex" &&
    req.session.externalSessionKind === "codex_cli_session" &&
    req.session.externalSessionId
  ) {
    return {
      sessionId: req.session.externalSessionId,
      type: "attached",
    };
  }

  return { type: "ephemeral" };
}

export function parseCodexRevisionOutput(
  rawOutput: string,
): BatchRevisionResponse {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    throw new Error("Codex adapter expected valid JSON output.");
  }

  if (!isRecord(parsed)) {
    throw new Error("Codex adapter output must be a JSON object.");
  }

  const { revisedMarkdown, summary, addressedComments } = parsed;

  if (typeof revisedMarkdown !== "string") {
    throw new Error("Codex adapter output missing revisedMarkdown.");
  }

  if (typeof summary !== "string") {
    throw new Error("Codex adapter output missing summary.");
  }

  if (!Array.isArray(addressedComments)) {
    throw new Error("Codex adapter output missing addressedComments.");
  }

  return {
    revisedMarkdown,
    summary,
    addressedComments: addressedComments.map((item, index) => {
      if (!isRecord(item)) {
        throw new Error(
          `Codex adapter addressedComments[${index}] must be an object.`,
        );
      }

      if (typeof item.commentId !== "string") {
        throw new Error(
          `Codex adapter addressedComments[${index}] missing commentId.`,
        );
      }

      if (typeof item.resolution !== "string") {
        throw new Error(
          `Codex adapter addressedComments[${index}] missing resolution.`,
        );
      }

      return {
        commentId: item.commentId,
        resolution: item.resolution,
      };
    }),
  };
}

export async function runCodexRevision(
  req: BatchRevisionRequest,
  options: RunCodexRevisionOptions,
): Promise<BatchRevisionResponse> {
  const workspaceDir = options.cwd;
  const runDir = await mkdtemp(path.join(tmpdir(), "markdown-review-codex-"));
  const schemaPath = path.join(runDir, "revision-schema.json");
  const outputPath = path.join(runDir, "revision-output.json");

  try {
    await writeFile(
      schemaPath,
      `${JSON.stringify(codexRevisionOutputSchema, null, 2)}\n`,
      "utf8",
    );

    const prompt = buildCodexRevisionPrompt(req);
    const stdout = await execCodex({
      args: buildCodexExecArgs({
        cwd: workspaceDir,
        execution: resolveCodexExecutionMode(req),
        schemaPath,
        outputPath,
      }),
      codexBin: options.codexBin ?? "codex",
      prompt,
      timeoutMs: options.timeoutMs ?? 120_000,
    });

    const output = await readFile(outputPath, "utf8").catch(() => stdout);

    return parseCodexRevisionOutput(output.trim());
  } finally {
    await rm(runDir, { force: true, recursive: true });
  }
}

type ExecCodexInput = {
  codexBin: string;
  args: string[];
  prompt: string;
  timeoutMs: number;
};

async function execCodex({
  codexBin,
  args,
  prompt,
  timeoutMs,
}: ExecCodexInput): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Codex adapter timed out after ${timeoutMs}ms.`));
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
          `Codex adapter exited with code ${code}. ${stderr.trim() || stdout.trim()}`,
        ),
      );
    });

    child.stdin.end(prompt, "utf8");
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
