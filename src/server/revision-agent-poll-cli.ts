#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildDemoTaskArtifacts,
  DEMO_ARTIFACT_FILE_NAMES,
} from "../demo/demo-task.js";
import type { RevisionPollResult } from "./revision-poll-broker.js";
import type { Env } from "./launcher-context.js";
import {
  launcherContextToTargetKey,
  resolveRevisionPollTargetFromEnv as resolveRevisionPollTargetFromLauncherEnv,
  targetKeyToServerEnv,
} from "./launcher-context.js";
import {
  discoverWorkflowRoots,
  hasWorkflowRunManifest,
} from "./workflow-root.js";

export type RevisionAgentPollOptions = {
  baseUrl: string;
  intervalMs: number;
  once: boolean;
  targetKey: string;
  timeoutMs: number;
};

export type DoreyLaunchMode = "single-file" | "demo";

export type DoreyLaunchWorkspace = {
  runId: string;
  workflowRoot: string;
  workspaceRoot: string;
};

const defaultBaseUrl = "http://127.0.0.1:5175";
const defaultHost = "127.0.0.1";
const defaultIntervalMs = 1_000;
const defaultPort = 5_175;
const defaultTimeoutMs = 120_000;
const defaultAutoStopIdleMs = 1_800_000;
const serverStartupTimeoutMs = 15_000;
const serverShutdownTimeoutMs = 5_000;
const launcherTargetEnvKeys = [
  "MARKDOWN_REVIEW_TARGET_KEY",
  "MARKDOWN_REVIEW_TRAEX_CLI_SESSION_ID",
  "MARKDOWN_REVIEW_CODEX_CLI_SESSION_ID",
  "MARKDOWN_REVIEW_TRAEX_THREAD_ID",
  "MARKDOWN_REVIEW_CODEX_THREAD_ID",
  "TRAECLI_SESSION_INBOX",
  "TRAEX_CLI_SESSION_INBOX",
  "TRAE_CLI_SESSION_INBOX",
  "TRAEX_CLI_SESSION_ID",
  "TRAE_CLI_SESSION_ID",
  "CODEX_CLI_SESSION_ID",
  "TRAEX_THREAD_ID",
  "CODEX_THREAD_ID",
] as const;

export type DoreyHealth = {
  app?: string;
  launcherContext?: {
    provider?: string;
    sessionId?: string;
    sessionKind?: string;
  };
  previewOnly?: boolean;
  workspaceRoot?: string;
};

type DoreyServerState = {
  owned: boolean;
  restarted: boolean;
};

export type DoreyCliOptions =
  | {
      baseUrl: string;
      command: "launch";
      host: string;
      intervalMs: number;
      launchMode: DoreyLaunchMode;
      openBrowser: boolean;
      poll: boolean;
      pollOptions?: RevisionAgentPollOptions;
      previewOnly: boolean;
      port: number;
      reviewFilePath?: string;
      targetKey?: string;
      timeoutMs: number;
      workflowRoot?: string;
      workspaceRoot: string;
      autoStop: boolean;
      autoStopIdleMs: number;
    }
  | {
      command: "poll";
      pollOptions: RevisionAgentPollOptions;
    }
  | {
      command: "server";
      host: string;
      port: number;
      workspaceRoot: string;
    }
  | {
      baseUrl: string;
      command: "status";
      host: string;
      port: number;
    }
  | {
      baseUrl: string;
      command: "stop";
      host: string;
      port: number;
      all: boolean;
    }
  | {
      command: "help";
      text: string;
    };

export function resolveRevisionPollTargetFromEnv(env: Env): string | undefined {
  return resolveRevisionPollTargetFromLauncherEnv(env);
}

export function parseRevisionAgentPollArgs(
  argv: string[],
  env: Env = process.env,
): RevisionAgentPollOptions {
  let baseUrl = firstEnv(env, "MARKDOWN_REVIEW_BASE_URL") ?? defaultBaseUrl;
  let intervalMs = numberOption(undefined, defaultIntervalMs);
  let once = false;
  let targetKey: string | undefined;
  let timeoutMs = numberOption(undefined, defaultTimeoutMs);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--base-url") {
      baseUrl = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--target") {
      targetKey = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--timeout-ms") {
      timeoutMs = numberOption(requiredValue(argv, index, arg), defaultTimeoutMs);
      index += 1;
      continue;
    }

    if (arg === "--interval-ms") {
      intervalMs = numberOption(requiredValue(argv, index, arg), defaultIntervalMs);
      index += 1;
      continue;
    }

    if (arg === "--once") {
      once = true;
      continue;
    }

    if (arg === "--watch") {
      once = false;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      throw new HelpRequested(helpText());
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  targetKey ??= resolveRevisionPollTargetFromEnv(env);

  if (!targetKey) {
    throw new Error(
      "Missing poll target. Pass --target, or set MARKDOWN_REVIEW_TARGET_KEY / CODEX_THREAD_ID / CODEX_CLI_SESSION_ID / TRAEX_CLI_SESSION_ID / TRAEX_THREAD_ID.",
    );
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    intervalMs,
    once,
    targetKey,
    timeoutMs,
  };
}

export function parseDoreyCliArgs(
  argv: string[],
  env: Env = process.env,
  cwd: string = process.cwd(),
): DoreyCliOptions {
  const [command, ...rest] = argv;

  if (!command) {
    return {
      command: "help",
      text: buildDoreyHelpText(),
    };
  }

  if (command.startsWith("-")) {
    return parseDoreyLaunchArgs(argv, env, cwd);
  }

  if (command === "poll") {
    try {
      return {
        command: "poll",
        pollOptions: parseRevisionAgentPollArgs(rest, env),
      };
    } catch (error) {
      if (error instanceof HelpRequested) {
        return {
          command: "help",
          text: error.text,
        };
      }

      throw error;
    }
  }

  if (command === "server") {
    return parseDoreyServerArgs(rest, env, cwd);
  }

  if (command === "status" || command === "stop") {
    return parseDoreyControlArgs(command, rest, env);
  }

  if (command === "help") {
    return {
      command: "help",
      text: buildDoreyHelpText(),
    };
  }

  throw new Error(`Unknown command: ${command}`);
}

export function buildRevisionAgentPollUrl({
  baseUrl,
  targetKey,
  timeoutMs,
}: Pick<RevisionAgentPollOptions, "baseUrl" | "targetKey" | "timeoutMs">): string {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  return `${normalizedBaseUrl}/api/agent/poll?target=${encodeURIComponent(targetKey)}&timeoutMs=${encodeURIComponent(String(timeoutMs))}`;
}

export function buildRevisionAgentPollCommand({
  baseUrl,
  targetKey,
}: {
  baseUrl: string;
  targetKey: string;
}): string {
  return `dorey poll --base-url ${quoteForShell(normalizeBaseUrl(baseUrl))} --target ${quoteForShell(targetKey)}`;
}

export function formatRevisionAgentPollFeedback(
  result: Extract<RevisionPollResult, { status: "feedback" }>,
): string {
  return `${JSON.stringify(
    {
      status: result.status,
      requestId: result.requestId,
      target: result.target,
      payloadPath: result.payloadPath,
      replyCommand: result.replyCommand,
      agentPollCommand: result.agentPollCommand,
      nextAction: "revise_markdown_and_post_batch_response",
      nextStep: result.nextStep,
      expectedResponseShape: {
        revisedMarkdown: "完整修订后的 Markdown 文本",
        summary: "本次修改摘要",
        addressedComments: [
          {
            commentId: "评论 id",
            resolution: "如何处理该评论",
          },
        ],
      },
      request: result.request,
    },
    null,
    2,
  )}\n`;
}

export async function runRevisionAgentPollCli(
  argv: string[] = process.argv.slice(2),
  env: Env = process.env,
): Promise<number> {
  let options: RevisionAgentPollOptions;

  try {
    options = parseRevisionAgentPollArgs(argv, env);
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stdout.write(`${error.text}\n`);

      return 0;
    }

    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof HelpRequested ? 0 : 1;
  }

  return await runRevisionAgentPollLoop(options);
}

export async function runDoreyCli(
  argv: string[] = process.argv.slice(2),
  env: Env = process.env,
  cwd: string = process.cwd(),
): Promise<number> {
  let options: DoreyCliOptions;

  try {
    options = parseDoreyCliArgs(argv, env, cwd);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (options.command === "help") {
    process.stdout.write(`${options.text}\n`);

    return 0;
  }

  if (options.command === "poll") {
    return await runRevisionAgentPollLoop(options.pollOptions);
  }

  if (options.command === "server") {
    return await runDoreyServer(options);
  }

  if (options.command === "status") {
    return await runDoreyStatus(options);
  }

  if (options.command === "stop") {
    return await runDoreyStop(options);
  }

  const launchWorkspace = await prepareDoreyLaunchWorkspace(options);
  const launchOptions = {
    ...options,
    workflowRoot: launchWorkspace.workflowRoot,
    workspaceRoot: launchWorkspace.workspaceRoot,
  };

  await ensureDoreyServer(launchOptions, env);
  process.stderr.write(`[dorey] Web UI: ${options.baseUrl}/\n`);

  if (options.openBrowser) {
    openBrowser(options.baseUrl, { previewOnly: options.previewOnly });
  }

  if (!options.poll) {
    process.stderr.write(`${buildNoPollPreviewWarning(options.targetKey)}\n`);

    return 0;
  }

  if (!options.pollOptions) {
    process.stderr.write(`${buildNoSessionTargetWarning()}\n`);

    return 0;
  }

  process.stderr.write(
    `[dorey] Polling ${options.pollOptions.targetKey}. Leave this command running; submitted review payloads will print here.\n`,
  );

  return await runRevisionAgentPollLoop(options.pollOptions);
}

export async function runRevisionAgentPollLoop(
  options: RevisionAgentPollOptions,
): Promise<number> {
  while (true) {
    const response = await fetch(buildRevisionAgentPollUrl(options));

    if (!response.ok) {
      throw new Error(`Poll request failed with HTTP ${response.status}: ${await response.text()}`);
    }

    const result = (await response.json()) as RevisionPollResult;

    if (result.status === "feedback") {
      process.stdout.write(formatRevisionAgentPollFeedback(result));

      if (options.once) {
        return 0;
      }

      continue;
    }

    if (options.once) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    console.error(
      `[markdown-review] ${new Date().toISOString()} no pending submit for ${options.targetKey}; waiting...`,
    );
    await sleep(options.intervalMs);
  }
}

function parseDoreyLaunchArgs(
  argv: string[],
  env: Env,
  cwd: string,
): DoreyCliOptions {
  let baseUrlOverride = firstEnv(env, "DOREY_BASE_URL", "MARKDOWN_REVIEW_BASE_URL");
  let host = firstEnv(env, "DOREY_HOST") ?? defaultHost;
  let hostWasExplicit = false;
  let intervalMs = numberOption(firstEnv(env, "DOREY_INTERVAL_MS"), defaultIntervalMs);
  let openBrowserFlag = firstEnv(env, "DOREY_NO_OPEN") !== "1";
  let previewRequested = firstEnv(env, "DOREY_PREVIEW") === "1";
  let poll = !previewRequested;
  let autoStop = firstEnv(env, "DOREY_AUTO_STOP") !== "0" && firstEnv(env, "DOREY_KEEP_SERVER") !== "1";
  let autoStopIdleMs = numberOption(firstEnv(env, "DOREY_AUTO_STOP_IDLE_MS"), defaultAutoStopIdleMs);
  let port = numberOption(firstEnv(env, "DOREY_PORT"), defaultPort);
  let portWasExplicit = false;
  let reviewFilePath: string | undefined;
  let targetKey: string | undefined;
  let timeoutMs = numberOption(firstEnv(env, "DOREY_TIMEOUT_MS"), defaultTimeoutMs);
  let workspaceRoot = resolvePathOption(firstEnv(env, "DOREY_WORKSPACE_ROOT"), cwd);
  let demoRequested = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--base-url") {
      baseUrlOverride = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--host") {
      host = requiredValue(argv, index, arg);
      hostWasExplicit = true;
      index += 1;
      continue;
    }

    if (arg === "--port") {
      port = numberOption(requiredValue(argv, index, arg), defaultPort);
      portWasExplicit = true;
      index += 1;
      continue;
    }

    if (arg === "--target") {
      targetKey = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--review-file") {
      reviewFilePath = resolvePathOption(requiredValue(argv, index, arg), cwd);
      index += 1;
      continue;
    }

    if (arg === "--demo") {
      demoRequested = true;
      continue;
    }

    if (arg === "--timeout-ms") {
      timeoutMs = numberOption(requiredValue(argv, index, arg), defaultTimeoutMs);
      index += 1;
      continue;
    }

    if (arg === "--interval-ms") {
      intervalMs = numberOption(requiredValue(argv, index, arg), defaultIntervalMs);
      index += 1;
      continue;
    }

    if (arg === "--auto-stop-idle-ms") {
      autoStopIdleMs = numberOption(requiredValue(argv, index, arg), defaultAutoStopIdleMs);
      index += 1;
      continue;
    }

    if (arg === "--no-open") {
      openBrowserFlag = false;
      continue;
    }

    if (arg === "--open") {
      openBrowserFlag = true;
      continue;
    }

    if (arg === "--poll") {
      poll = true;
      previewRequested = false;
      continue;
    }

    if (arg === "--preview") {
      poll = false;
      previewRequested = true;
      continue;
    }

    if (arg === "--auto-stop") {
      autoStop = true;
      continue;
    }

    if (arg === "--no-auto-stop" || arg === "--keep-server") {
      autoStop = false;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      return {
        command: "help",
        text: buildDoreyHelpText(),
      };
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (baseUrlOverride) {
    const inferred = inferAddressFromBaseUrl(baseUrlOverride);

    if (!hostWasExplicit) {
      host = inferred.host;
    }

    if (!portWasExplicit) {
      port = inferred.port;
    }
  }

  const baseUrl = normalizeBaseUrl(baseUrlOverride ?? `http://${host}:${port}`);
  targetKey ??= resolveRevisionPollTargetFromEnv(env);
  const launchMode = resolveDoreyLaunchMode({ demoRequested, reviewFilePath });

  if (launchMode === "demo") {
    workspaceRoot = path.join(
      tmpdir(),
      "dorey-demo-runs",
      createHash("sha256")
        .update(`${Date.now()}:${Math.random()}`)
        .digest("hex")
        .slice(0, 12),
    );
  }

  const workflowRoot =
    launchMode === "demo" ? path.join(workspaceRoot, "workflow-runs") : undefined;
  const previewOnly = previewRequested || !targetKey;

  return {
    baseUrl,
    command: "launch",
    host,
    intervalMs,
    launchMode,
    openBrowser: openBrowserFlag,
    poll,
    pollOptions:
      poll && targetKey
        ? {
            baseUrl,
            intervalMs,
            once: false,
            targetKey,
            timeoutMs,
          }
        : undefined,
    previewOnly,
    port,
    reviewFilePath,
    targetKey,
    timeoutMs,
    workflowRoot,
    workspaceRoot,
    autoStop: Boolean(poll && targetKey && autoStop),
    autoStopIdleMs,
  };
}

function resolveDoreyLaunchMode({
  demoRequested,
  reviewFilePath,
}: {
  demoRequested: boolean;
  reviewFilePath?: string;
}): DoreyLaunchMode {
  if (demoRequested && reviewFilePath) {
    throw new Error("Choose either --review-file or --demo, not both.");
  }

  if (demoRequested) {
    return "demo";
  }

  if (reviewFilePath) {
    return "single-file";
  }

  throw new Error("Missing review target. Use dorey --review-file <file> or dorey --demo.");
}

export async function prepareDoreyLaunchWorkspace(input: {
  launchMode: DoreyLaunchMode;
  reviewFilePath?: string;
  workflowRoot?: string;
  workspaceRoot?: string;
}): Promise<DoreyLaunchWorkspace> {
  if (input.launchMode === "demo") {
    return materializeDemoLaunchWorkspace(input);
  }

  if (!input.reviewFilePath) {
    throw new Error("Missing review file. Use dorey --review-file <file>.");
  }

  const sourcePath = path.resolve(input.reviewFilePath);
  const sourceStat = await stat(sourcePath).catch(() => undefined);

  if (!sourceStat) {
    throw new Error(`Review file does not exist: ${sourcePath}`);
  }

  if (!sourceStat.isFile()) {
    throw new Error(`Review file is not a file: ${sourcePath}`);
  }

  const extension = path.extname(sourcePath).toLowerCase();

  if (![".md", ".markdown", ".html", ".htm"].includes(extension)) {
    throw new Error("Review file must be Markdown or HTML: .md, .markdown, .html, or .htm.");
  }

  const fileName = path.basename(sourcePath);
  const hash = createHash("sha256").update(sourcePath).digest("hex").slice(0, 12);
  const runId = `single-file-${Date.now()}-${hash}`;
  const workspaceRoot = path.join(tmpdir(), "dorey-review-runs", runId);
  const workflowRoot = path.join(workspaceRoot, "workflow-runs");
  const runRoot = path.join(workflowRoot, runId);
  const mdDir = path.join(runRoot, "md");

  await mkdir(mdDir, { recursive: true });
  await mkdir(path.join(runRoot, "review"), { recursive: true });
  await copyFile(sourcePath, path.join(mdDir, fileName));
  await writeFile(
    path.join(runRoot, "workflow-run.json"),
    `${JSON.stringify(
      {
        artifacts: {
          codingPlan: `md/${fileName}`,
        },
        review: {
          root: "review",
        },
        runId,
        taskTitle: `Review ${fileName}`,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    runId,
    workflowRoot,
    workspaceRoot,
  };
}

async function materializeDemoLaunchWorkspace(input: {
  workflowRoot?: string;
  workspaceRoot?: string;
}): Promise<DoreyLaunchWorkspace> {
  const runId = "bundled-demo";
  const workspaceRoot =
    input.workspaceRoot ?? (await mkdtemp(path.join(tmpdir(), "dorey-demo-")));
  const workflowRoot = input.workflowRoot ?? path.join(workspaceRoot, "workflow-runs");
  const runRoot = path.join(workflowRoot, runId);
  const mdDir = path.join(runRoot, "md");
  const demo = buildDemoTaskArtifacts();

  await mkdir(mdDir, { recursive: true });
  await mkdir(path.join(runRoot, "review"), { recursive: true });

  for (const file of demo.files) {
    const outputPath =
      file.name === "trace.json"
        ? path.join(runRoot, file.name)
        : path.join(mdDir, file.name);

    await writeFile(outputPath, file.content, "utf8");
  }

  await writeFile(
    path.join(runRoot, "workflow-run.json"),
    `${JSON.stringify(
      {
        artifacts: {
          codingPlan: `md/${DEMO_ARTIFACT_FILE_NAMES[3]}`,
          currentStateModeling: `md/${DEMO_ARTIFACT_FILE_NAMES[1]}`,
          documentDraft: `md/${DEMO_ARTIFACT_FILE_NAMES[2]}`,
          requirementOrientation: `md/${DEMO_ARTIFACT_FILE_NAMES[0]}`,
          trace: "trace.json",
          verificationPlan: `md/${DEMO_ARTIFACT_FILE_NAMES[4]}`,
        },
        review: {
          root: "review",
        },
        runId,
        taskTitle: demo.task.title,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    runId,
    workflowRoot,
    workspaceRoot,
  };
}

function parseDoreyServerArgs(
  argv: string[],
  env: Env,
  cwd: string,
): DoreyCliOptions {
  let host = firstEnv(env, "DOREY_HOST") ?? defaultHost;
  let port = numberOption(firstEnv(env, "DOREY_PORT"), defaultPort);
  let workspaceRoot = resolveDefaultWorkspaceRoot(env, cwd);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--host") {
      host = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--port") {
      port = numberOption(requiredValue(argv, index, arg), defaultPort);
      index += 1;
      continue;
    }

    if (arg === "--workspace-root") {
      workspaceRoot = resolvePathOption(requiredValue(argv, index, arg), cwd);
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      return {
        command: "help",
        text: buildDoreyHelpText(),
      };
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    command: "server",
    host,
    port,
    workspaceRoot,
  };
}

function parseDoreyControlArgs(
  command: "status" | "stop",
  argv: string[],
  env: Env,
): DoreyCliOptions {
  let baseUrlOverride = firstEnv(env, "DOREY_BASE_URL", "MARKDOWN_REVIEW_BASE_URL");
  let host = firstEnv(env, "DOREY_HOST") ?? defaultHost;
  let hostWasExplicit = false;
  let port = numberOption(firstEnv(env, "DOREY_PORT"), defaultPort);
  let portWasExplicit = false;
  let all = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--base-url") {
      baseUrlOverride = requiredValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--host") {
      host = requiredValue(argv, index, arg);
      hostWasExplicit = true;
      index += 1;
      continue;
    }

    if (arg === "--port") {
      port = numberOption(requiredValue(argv, index, arg), defaultPort);
      portWasExplicit = true;
      index += 1;
      continue;
    }

    if (arg === "--all") {
      all = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      return {
        command: "help",
        text: buildDoreyHelpText(),
      };
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  if (baseUrlOverride) {
    const inferred = inferAddressFromBaseUrl(baseUrlOverride);

    if (!hostWasExplicit) {
      host = inferred.host;
    }

    if (!portWasExplicit) {
      port = inferred.port;
    }
  }

  const baseUrl = normalizeBaseUrl(baseUrlOverride ?? `http://${host}:${port}`);

  if (command === "status") {
    return {
      baseUrl,
      command: "status",
      host,
      port,
    };
  }

  return {
    baseUrl,
    command: "stop",
    host,
    port,
    all,
  };
}

async function ensureDoreyServer(
  options: Extract<DoreyCliOptions, { command: "launch" }>,
  env: Env,
): Promise<DoreyServerState> {
  const health = await readDoreyHealthIfAvailable(options.baseUrl);

  if (health) {
    if (isDoreyServerHealthCompatible(health, {
      targetKey: options.pollOptions?.targetKey,
      workspaceRoot: options.workspaceRoot,
    })) {
      return {
        owned: false,
        restarted: false,
      };
    }

    process.stderr.write(
      `[dorey] Existing server at ${options.baseUrl} has a different workspace or session; restarting it for the current launch.\n`,
    );
    await requestDoreyStop(options.baseUrl);
    await waitForDoreyServerDown(options.baseUrl);
  }

  const childEnv = buildDoreyServerEnv(env, options);
  const entrypoint = resolveEntrypoint(process.argv[1] ?? fileURLToPath(import.meta.url));
  const child = spawn(
    process.execPath,
    [
      entrypoint,
      "server",
      "--host",
      options.host,
      "--port",
      String(options.port),
      "--workspace-root",
      options.workspaceRoot,
    ],
    {
      detached: true,
      env: childEnv,
      stdio: "ignore",
    },
  );

  child.unref();
  await waitForDoreyServer(options.baseUrl);

  return {
    owned: true,
    restarted: Boolean(health),
  };
}

export function isDoreyServerHealthCompatible(
  health: DoreyHealth,
  expected: { targetKey?: string; workspaceRoot: string },
): boolean {
  if (health.app !== "dorey") {
    return false;
  }

  if (!health.workspaceRoot || path.resolve(health.workspaceRoot) !== path.resolve(expected.workspaceRoot)) {
    return false;
  }

  const actualTargetKey = health.launcherContext?.sessionId
    ? launcherContextToTargetKey({
        provider: health.launcherContext.provider === "codex" ? "codex" : "traex",
        sessionId: health.launcherContext.sessionId,
        sessionKind:
          health.launcherContext.sessionKind === "codex_thread" ||
          health.launcherContext.sessionKind === "codex_cli_session" ||
          health.launcherContext.sessionKind === "traex_thread" ||
          health.launcherContext.sessionKind === "traex_cli_session"
            ? health.launcherContext.sessionKind
            : "traex_cli_session",
      })
    : undefined;

  return actualTargetKey === expected.targetKey;
}

async function isDoreyServerReady(baseUrl: string): Promise<boolean> {
  return Boolean(await readDoreyHealthIfAvailable(baseUrl));
}

async function readDoreyHealthIfAvailable(baseUrl: string): Promise<DoreyHealth | undefined> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  try {
    const health = await fetchWithTimeout(`${normalizedBaseUrl}/api/dorey/health`, 750);

    if (health.ok) {
      const body = (await health.json().catch(() => undefined)) as DoreyHealth | undefined;

      return body?.app === "dorey" ? body : undefined;
    }
  } catch {
    return undefined;
  }

  try {
    const response = await fetchWithTimeout(`${normalizedBaseUrl}/`, 750);

    if (!response.ok) {
      return undefined;
    }

    return (await response.text()).includes("<title>Dorey</title>")
      ? {
          app: "dorey",
        }
      : undefined;
  } catch {
    return undefined;
  }
}

async function waitForDoreyServer(baseUrl: string): Promise<void> {
  const deadline = Date.now() + serverStartupTimeoutMs;

  while (Date.now() < deadline) {
    if (await isDoreyServerReady(baseUrl)) {
      return;
    }

    await sleep(250);
  }

  throw new Error(
    `Dorey server did not start at ${normalizeBaseUrl(baseUrl)}. Run dorey server to inspect startup errors.`,
  );
}

async function waitForDoreyServerDown(baseUrl: string): Promise<void> {
  const deadline = Date.now() + serverShutdownTimeoutMs;

  while (Date.now() < deadline) {
    if (!(await isDoreyServerReady(baseUrl))) {
      return;
    }

    await sleep(250);
  }

  throw new Error(`Dorey server did not stop at ${normalizeBaseUrl(baseUrl)}.`);
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runDoreyServer(
  options: Extract<DoreyCliOptions, { command: "server" }>,
): Promise<number> {
  process.env.DOREY_WORKSPACE_ROOT = options.workspaceRoot;
  process.env.DOREY_HOST = options.host;
  process.env.DOREY_PORT = String(options.port);

  const packageRoot = resolveDoreyPackageRoot();
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.join(packageRoot, "vite.config.ts"),
    root: packageRoot,
    server: {
      host: options.host,
      port: options.port,
      strictPort: true,
    },
  });

  await server.listen();

  const serverUrl =
    server.resolvedUrls?.local?.[0] ?? `http://${options.host}:${options.port}/`;
  process.stderr.write(`[dorey] server ready: ${serverUrl}\n`);

  await new Promise<void>((resolve) => {
    const close = () => {
      server.close().finally(resolve);
    };

    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });

  return 0;
}

async function runDoreyStatus(
  options: Extract<DoreyCliOptions, { command: "status" }>,
): Promise<number> {
  try {
    const health = await readDoreyHealth(options.baseUrl);

    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `[dorey] No Dorey server is responding at ${options.baseUrl}: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    return 1;
  }
}

async function runDoreyStop(
  options: Extract<DoreyCliOptions, { command: "stop" }>,
): Promise<number> {
  try {
    if (options.all) {
      const stopped = await stopAllDoreyServers();

      process.stdout.write(
        stopped.length > 0
          ? `[dorey] Stopped ${stopped.length} Dorey server process(es): ${stopped.join(", ")}\n`
          : "[dorey] No Dorey server processes found.\n",
      );
      return 0;
    }

    await requestDoreyStop(options.baseUrl);
    process.stdout.write(`[dorey] Server stopping at ${options.baseUrl}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `[dorey] Could not stop Dorey server at ${options.baseUrl}: ${error instanceof Error ? error.message : String(error)}\n`,
    );

    return 1;
  }
}

async function requestDoreyStop(baseUrl: string): Promise<void> {
  const response = await fetchWithTimeout(
    `${normalizeBaseUrl(baseUrl)}/api/dorey/shutdown`,
    2_000,
    { method: "POST" },
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
}

export type DoreyServerProcess = {
  command: string;
  pid: number;
};

export function parseDoreyServerProcessList(
  psOutput: string,
  currentPid = process.pid,
): DoreyServerProcess[] {
  return psOutput
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);

      if (!match) {
        return [];
      }

      const pid = Number(match[1]);
      const command = match[2] ?? "";

      if (!Number.isInteger(pid) || pid === currentPid) {
        return [];
      }

      if (!/\brevision-agent-poll-cli\.js\s+server\b/.test(command)) {
        return [];
      }

      return [
        {
          command,
          pid,
        },
      ];
    });
}

async function stopAllDoreyServers(): Promise<number[]> {
  const psOutput = await collectProcessList();
  const processes = parseDoreyServerProcessList(psOutput);
  const stopped: number[] = [];

  for (const processInfo of processes) {
    try {
      process.kill(processInfo.pid, "SIGTERM");
      stopped.push(processInfo.pid);
    } catch {
      // Process may have exited between ps and kill.
    }
  }

  return stopped;
}

function collectProcessList(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ps", ["-x", "-o", "pid=,command="], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr.trim() || `ps exited with code ${code}`));
    });
  });
}

async function readDoreyHealth(baseUrl: string): Promise<unknown> {
  const response = await fetchWithTimeout(`${normalizeBaseUrl(baseUrl)}/api/dorey/health`, 1_000);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return await response.json();
}

function openBrowser(
  baseUrl: string,
  options: { previewOnly?: boolean } = {},
): void {
  const url = buildDoreyWebUrl(baseUrl, options);
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });

  child.unref();
}

function buildDoreyWebUrl(
  baseUrl: string,
  options: { previewOnly?: boolean } = {},
): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/`);

  if (options.previewOnly) {
    url.searchParams.set("doreyMode", "preview");
  }

  return url.toString();
}

export function buildDoreyServerEnv(
  env: Env,
  options: Extract<DoreyCliOptions, { command: "launch" }>,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }

  childEnv.DOREY_HOST = options.host;
  childEnv.DOREY_PORT = String(options.port);
  childEnv.DOREY_WORKSPACE_ROOT = options.workspaceRoot;
  childEnv.AI_CODING_WORKFLOW_ROOT = options.workflowRoot ?? options.workspaceRoot;
  childEnv.DOREY_LAUNCH_MODE = options.launchMode;
  childEnv.DOREY_PREVIEW_ONLY = options.previewOnly ? "1" : "0";
  childEnv.MARKDOWN_REVIEW_BASE_URL = options.baseUrl;

  clearLauncherTargetEnv(childEnv);

  for (const [key, value] of Object.entries(targetKeyToServerEnv(options.pollOptions?.targetKey))) {
    if (value === undefined) {
      delete childEnv[key];
    } else {
      childEnv[key] = value;
    }
  }

  if (options.pollOptions?.targetKey?.startsWith("traex-cli:")) {
    delete childEnv.CODEX_THREAD_ID;
    delete childEnv.MARKDOWN_REVIEW_CODEX_THREAD_ID;
  }

  if (options.autoStop) {
    childEnv.DOREY_AUTO_STOP_ON_REPLY = "1";
    childEnv.DOREY_AUTO_STOP_IDLE_MS = String(options.autoStopIdleMs);
  } else {
    delete childEnv.DOREY_AUTO_STOP_ON_REPLY;
    delete childEnv.DOREY_AUTO_STOP_IDLE_MS;
  }

  return childEnv;
}

function clearLauncherTargetEnv(env: NodeJS.ProcessEnv): void {
  for (const key of launcherTargetEnvKeys) {
    delete env[key];
  }
}

export function buildDoreyHelpText(): string {
  return [
    "Dorey - a local doc review loop for AI coding artifacts",
    "",
    "Usage:",
    "  dorey --review-file <file>  Review one local Markdown or HTML document.",
    "  dorey --demo                Open the built-in Dorey product demo.",
    "  dorey poll                  Wait for submit payloads from an existing Dorey server.",
    "  dorey status                Print the running server health, workspace root, and launcher context.",
    "  dorey stop                  Stop the background Web server on the configured port.",
    "",
    "Common options:",
    "  --port <port>          Web UI port, default 5175.",
    "  --host <host>          Bind host, default 127.0.0.1.",
    "  --target <target>      Poll target, for example codex-desktop:<thread-id> or traex-cli:<session-id>.",
    "  --no-open              Do not open a browser window.",
    "  --preview              Preview only: do not poll; this agent will not receive review submits.",
    "  --no-auto-stop         Keep a server started by this command until explicitly stopped.",
    "  --auto-stop-idle-ms <n> Stop an owned server after this many idle ms.",
    "  --all                  With `dorey stop`, stop all current-user Dorey server processes.",
    "",
    "Environment target detection:",
    "  TRAECLI_SESSION_INBOX, CODEX_THREAD_ID, CODEX_CLI_SESSION_ID, TRAEX_CLI_SESSION_ID, TRAE_CLI_SESSION_ID, TRAEX_THREAD_ID.",
  ].join("\n");
}

export function buildNoPollPreviewWarning(targetKey?: string): string {
  const targetHint = targetKey ? ` --target ${quoteForShell(targetKey)}` : "";

  return [
    "[dorey:warning] 当前是 --preview 预览模式，这个 CLI 不会收到 review 提交。",
    `[dorey:warning] 交互 review 请运行 dorey --review-file <file>${targetHint} 或 dorey --demo${targetHint}，并去掉 --preview。`,
  ].join("\n");
}

export function buildNoSessionTargetWarning(): string {
  return [
    "[dorey:warning] 当前未检测到 Codex/TraeX 会话上下文。Dorey 已以本地预览模式启动，适合查看文档、验证 UI 和调试流程。",
    "[dorey:warning] 若要让 Submit All 被 Agent 正确理解并处理，请在承载当前任务上下文的 Codex/TraeX 会话中启动 dorey；否则提交不会自动进入你的 Agent 对话。",
  ].join("\n");
}

function firstEnv(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();

    if (value) {
      return value;
    }
  }

  return undefined;
}

function helpText(): string {
  return [
    "Usage: dorey poll [--base-url http://127.0.0.1:5175] [--target <target>] [--once]",
    "",
    "Keeps the original agent session waiting for Dorey submits.",
  ].join("\n");
}

function inferAddressFromBaseUrl(baseUrl: string): { host: string; port: number } {
  const parsed = new URL(normalizeBaseUrl(baseUrl));
  const port =
    parsed.port === ""
      ? parsed.protocol === "https:"
        ? 443
        : 80
      : numberOption(parsed.port, defaultPort);

  return {
    host: parsed.hostname || defaultHost,
    port,
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();

  return (trimmed || defaultBaseUrl).replace(/\/+$/, "");
}

function numberOption(value: string | undefined, fallback: number): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim();

  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

function resolveDefaultWorkspaceRoot(env: Env, cwd: string): string {
  const explicitRoot = firstEnv(env, "DOREY_WORKSPACE_ROOT");

  if (explicitRoot) {
    return resolvePathOption(explicitRoot, cwd);
  }

  const sessionRoot = firstEnv(
    env,
    "MARKDOWN_REVIEW_WORKSPACE_ROOT",
    "MARKDOWN_REVIEW_SESSION_ROOT",
    "TRAEX_WORKSPACE_ROOT",
    "TRAE_WORKSPACE_ROOT",
    "TRAEX_PROJECT_ROOT",
    "TRAE_PROJECT_ROOT",
    "CODEX_WORKSPACE_ROOT",
    "CODEX_PROJECT_ROOT",
    "WORKSPACE_ROOT",
    "PROJECT_ROOT",
    "INIT_CWD",
    "PWD",
  );

  return inferWorkflowWorkspaceRoot(resolvePathOption(sessionRoot, cwd));
}

function inferWorkflowWorkspaceRoot(candidateRoot: string): string {
  const resolvedRoot = path.resolve(candidateRoot);
  const localWorkflowRoot = path.join(
    resolvedRoot,
    ".local",
    "ai-coding-workflow",
  );

  if (hasWorkflowRunManifest(localWorkflowRoot)) {
    return resolvedRoot;
  }

  const nestedWorkflowRoots = discoverWorkflowRoots(resolvedRoot).filter(
    (workflowRoot) =>
      path.resolve(workflowRoot) !== path.resolve(localWorkflowRoot),
  );

  if (nestedWorkflowRoots.length === 1) {
    return workflowRootToWorkspaceRoot(nestedWorkflowRoots[0]);
  }

  return resolvedRoot;
}

function workflowRootToWorkspaceRoot(workflowRoot: string): string {
  return path.dirname(path.dirname(path.resolve(workflowRoot)));
}

function resolvePathOption(value: string | undefined, cwd: string): string {
  return path.resolve(cwd, value?.trim() || ".");
}

function resolveDoreyPackageRoot(metaUrl: string = import.meta.url): string {
  let cursor = path.dirname(fileURLToPath(metaUrl));

  while (true) {
    if (existsSync(path.join(cursor, "package.json"))) {
      return cursor;
    }

    const parent = path.dirname(cursor);

    if (parent === cursor) {
      return path.resolve(path.dirname(fileURLToPath(metaUrl)), "../../..");
    }

    cursor = parent;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isDirectRun(
  metaUrl: string,
  entrypoint: string | undefined,
): boolean {
  if (!entrypoint) {
    return false;
  }

  return normalizeFileUrl(metaUrl) === pathToFileURL(resolveEntrypoint(entrypoint)).href;
}

class HelpRequested extends Error {
  constructor(readonly text: string) {
    super(text);
  }
}

function normalizeFileUrl(value: string): string {
  try {
    return pathToFileURL(resolveEntrypoint(fileURLToPath(value))).href;
  } catch {
    return value;
  }
}

function resolveEntrypoint(entrypoint: string): string {
  const resolved = path.resolve(entrypoint);

  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  runDoreyCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
