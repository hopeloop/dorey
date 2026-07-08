import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { RevisionPollResult } from "../src/server/revision-poll-broker.js";
import {
  buildDoreyServerEnv,
  buildDoreyHelpText,
  buildNoPollPreviewWarning,
  buildNoSessionTargetWarning,
  buildRevisionAgentPollCommand,
  buildRevisionAgentPollUrl,
  formatRevisionAgentPollFeedback,
  isDoreyServerHealthCompatible,
  isDirectRun,
  parseDoreyCliArgs,
  parseDoreyServerProcessList,
  prepareDoreyLaunchWorkspace,
  parseRevisionAgentPollArgs,
  resolveRevisionPollTargetFromEnv,
  runRevisionAgentPollLoop,
} from "../src/server/revision-agent-poll-cli.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status: 200,
  });
}

function pollFeedback(
  requestId: string,
): Extract<RevisionPollResult, { status: "feedback" }> {
  return {
    agentPollCommand:
      "dorey poll --base-url 'http://127.0.0.1:5175' --target 'traex-cli:session-1'",
    nextStep: "处理 request，然后 POST reply。",
    payloadPath: `/tmp/${requestId}/payload.json`,
    replyCommand: `curl -sS -X POST 'http://127.0.0.1:5175/api/agent/submissions/${requestId}/reply' -H 'Content-Type: application/json' --data-binary @response.json`,
    request: {
      artifact: {
        id: "doc-1",
        markdown: "# Doc\n",
        stage: "technical_design",
        title: "Doc",
      },
      comments: [],
    },
    requestId,
    status: "feedback",
    target: {
      key: "traex-cli:session-1",
      label: "TraeX CLI（原会话）",
      provider: "traex",
      transport: "traex_cli",
    },
  };
}

describe("revision agent poll CLI", () => {
  it("prints help for the bare dorey command instead of launching", () => {
    const options = parseDoreyCliArgs(
      [],
      {
        CODEX_THREAD_ID: "codex-thread-1",
      },
      "/tmp/review-workspace",
    );

    assert.equal(options.command, "help");

    if (options.command !== "help") {
      return;
    }

    assert.match(options.text, /dorey --review-file <file>/);
    assert.match(options.text, /dorey --demo/);
    assert.doesNotMatch(options.text, /dorey\s+Recommended for interactive review/);
  });

  it("parses single-file review launch options", () => {
    const options = parseDoreyCliArgs(
      ["--review-file", "README.md", "--no-open"],
      {
        CODEX_THREAD_ID: "codex-thread-1",
      },
      "/tmp/review-workspace",
    );

    assert.equal(options.command, "launch");

    if (options.command !== "launch") {
      return;
    }

    assert.equal(options.baseUrl, "http://127.0.0.1:5175");
    assert.equal(options.host, "127.0.0.1");
    assert.equal(options.launchMode, "single-file");
    assert.equal(options.openBrowser, false);
    assert.equal(options.poll, true);
    assert.equal(options.previewOnly, false);
    assert.equal(options.reviewFilePath, "/tmp/review-workspace/README.md");
    assert.equal(options.pollOptions?.targetKey, "codex-desktop:codex-thread-1");
    assert.equal(options.targetKey, "codex-desktop:codex-thread-1");
  });

  it("parses the built-in demo launch without using the caller workspace for discovery", () => {
    const options = parseDoreyCliArgs(["--demo", "--no-open"], {}, "/tmp/random-repo");

    assert.equal(options.command, "launch");

    if (options.command !== "launch") {
      return;
    }

    assert.equal(options.launchMode, "demo");
    assert.equal(options.openBrowser, false);
    assert.equal(options.poll, true);
    assert.equal(options.pollOptions, undefined);
    assert.equal(options.previewOnly, true);
    assert.notEqual(options.workspaceRoot, "/tmp/random-repo");
  });

  it("rejects mutually exclusive launch targets", () => {
    assert.throws(
      () =>
        parseDoreyCliArgs(
          ["--review-file", "README.md", "--demo"],
          {},
          "/tmp/review-workspace",
        ),
      /Choose either --review-file or --demo/,
    );
  });

  it("keeps the explicit poll subcommand for original agent sessions", () => {
    const options = parseDoreyCliArgs(
      [
        "poll",
        "--base-url",
        "http://127.0.0.1:5175/",
        "--target",
        "traex-cli:session-1",
        "--once",
      ],
      {},
      "/tmp/review-workspace",
    );

    assert.equal(options.command, "poll");

    if (options.command !== "poll") {
      return;
    }

    assert.equal(options.pollOptions.baseUrl, "http://127.0.0.1:5175");
    assert.equal(options.pollOptions.targetKey, "traex-cli:session-1");
    assert.equal(options.pollOptions.once, true);
  });

  it("parses launch/server options for installed-package startup", () => {
    const launchOptions = parseDoreyCliArgs(
      ["--review-file", "docs/README.md", "--no-open", "--port", "5180"],
      {},
      "/tmp/review-workspace",
    );

    assert.equal(launchOptions.command, "launch");

    if (launchOptions.command === "launch") {
      assert.equal(launchOptions.openBrowser, false);
      assert.equal(launchOptions.poll, true);
      assert.equal(launchOptions.autoStop, false);
      assert.equal(launchOptions.port, 5180);
      assert.equal(launchOptions.baseUrl, "http://127.0.0.1:5180");
      assert.equal(launchOptions.launchMode, "single-file");
      assert.equal(launchOptions.previewOnly, true);
      assert.equal(launchOptions.reviewFilePath, "/tmp/review-workspace/docs/README.md");
    }

    const serverOptions = parseDoreyCliArgs(
      ["server", "--host", "0.0.0.0", "--port", "5181"],
      {},
      "/tmp/review-workspace",
    );

    assert.equal(serverOptions.command, "server");

    if (serverOptions.command === "server") {
      assert.equal(serverOptions.host, "0.0.0.0");
      assert.equal(serverOptions.port, 5181);
      assert.equal(serverOptions.workspaceRoot, "/tmp/review-workspace");
    }
  });

  it("enables idle cleanup for poll-mode servers unless the user keeps them", () => {
    const defaultOptions = parseDoreyCliArgs(
      ["--review-file", "README.md"],
      {
        CODEX_THREAD_ID: "codex-thread-1",
        DOREY_AUTO_STOP_IDLE_MS: "1500",
      },
      "/tmp/review-workspace",
    );
    const keptOptions = parseDoreyCliArgs(
      ["--review-file", "README.md", "--keep-server"],
      {
        CODEX_THREAD_ID: "codex-thread-1",
        DOREY_AUTO_STOP_ON_REPLY: "1",
      },
      "/tmp/review-workspace",
    );

    assert.equal(defaultOptions.command, "launch");
    assert.equal(keptOptions.command, "launch");

    if (defaultOptions.command === "launch" && keptOptions.command === "launch") {
      assert.equal(defaultOptions.autoStop, true);
      assert.equal(defaultOptions.autoStopIdleMs, 1500);
      assert.equal(keptOptions.autoStop, false);

      const defaultEnv = buildDoreyServerEnv(
        {
          CODEX_THREAD_ID: "codex-thread-1",
          DOREY_AUTO_STOP_IDLE_MS: "1500",
        },
        defaultOptions,
      );
      const keptEnv = buildDoreyServerEnv(
        {
          CODEX_THREAD_ID: "codex-thread-1",
          DOREY_AUTO_STOP_ON_REPLY: "1",
        },
        keptOptions,
      );

      assert.equal(defaultEnv.DOREY_AUTO_STOP_ON_REPLY, "1");
      assert.equal(defaultEnv.DOREY_AUTO_STOP_IDLE_MS, "1500");
      assert.equal(keptEnv.DOREY_AUTO_STOP_ON_REPLY, undefined);
      assert.equal(keptEnv.DOREY_AUTO_STOP_IDLE_MS, undefined);

      const help = buildDoreyHelpText();

      assert.match(help, /after this many idle ms/);
      assert.match(help, /until explicitly stopped/);
      assert.doesNotMatch(help, /after poll completes/);
      assert.doesNotMatch(help, /if no reply arrives/);
    }
  });

  it("explains bash launches as preview-only when no agent session target is detected", () => {
    const options = parseDoreyCliArgs(
      ["--review-file", "README.md"],
      {},
      "/tmp/review-workspace",
    );

    assert.equal(options.command, "launch");

    if (options.command === "launch") {
      assert.equal(options.poll, true);
      assert.equal(options.pollOptions, undefined);
      assert.equal(options.autoStop, false);
      assert.equal(options.previewOnly, true);
    }

    const warning = buildNoSessionTargetWarning();

    assert.match(warning, /^\[dorey:warning\]/);
    assert.match(warning, /当前未检测到 Codex\/TraeX 会话上下文/);
    assert.match(warning, /Dorey 已以本地预览模式启动/);
    assert.match(warning, /承载当前任务上下文的 Codex\/TraeX 会话/);
    assert.match(warning, /提交不会自动进入你的 Agent 对话/);
  });

  it("rejects legacy open and no-poll launch forms", () => {
    const warning = buildNoPollPreviewWarning("traex-cli:session-1");

    assert.match(warning, /^\[dorey:warning\]/);
    assert.match(warning, /--preview/);
    assert.match(warning, /预览模式/);
    assert.match(warning, /不会收到 review 提交/);
    assert.match(warning, /dorey --review-file <file> --target 'traex-cli:session-1'/);

    assert.throws(
      () =>
        parseDoreyCliArgs(
          [
            "open",
            "--review-file",
            "README.md",
            "--target",
            "traex-cli:session-1",
            "--no-open",
            "--no-poll",
          ],
          {},
          "/tmp/review-workspace",
        ),
      /Unknown command: open/,
    );
    assert.throws(
      () =>
        parseDoreyCliArgs(
          ["--review-file", "README.md", "--no-open", "--no-poll"],
          {
            TRAECLI_SESSION_INBOX:
              "/Users/example/.trae/cli/sessions/2026/07/06/rollout-2026-07-06T18-12-44-019f36ea.artifacts/inbox.d",
          },
          "/tmp/review-workspace",
        ),
      /Unknown option: --no-poll/,
    );
  });

  it("allows explicit preview mode even when a session target is available", () => {
    const options = parseDoreyCliArgs(
      [
        "--review-file",
        "README.md",
        "--target",
        "traex-cli:session-1",
        "--no-open",
        "--preview",
      ],
      {},
      "/tmp/review-workspace",
    );

    assert.equal(options.command, "launch");

    if (options.command === "launch") {
      assert.equal(options.poll, false);
      assert.equal(options.pollOptions, undefined);
      assert.equal(options.targetKey, "traex-cli:session-1");
      assert.equal(options.autoStop, false);
      assert.equal(options.previewOnly, true);
    }
  });

  it("does not leak launcher session env into an explicit preview server", () => {
    const options = parseDoreyCliArgs(
      ["--demo", "--target", "traex-cli:session-1", "--no-open", "--preview"],
      {
        CODEX_THREAD_ID: "codex-thread-1",
        TRAECLI_SESSION_INBOX:
          "/Users/example/.trae/cli/sessions/2026/07/06/rollout-2026-07-06T18-12-44-019f36ea.artifacts/inbox.d",
      },
      "/tmp/review-workspace",
    );

    assert.equal(options.command, "launch");

    if (options.command !== "launch") {
      return;
    }

    const env = buildDoreyServerEnv(
      {
        CODEX_THREAD_ID: "codex-thread-1",
        TRAECLI_SESSION_INBOX:
          "/Users/example/.trae/cli/sessions/2026/07/06/rollout-2026-07-06T18-12-44-019f36ea.artifacts/inbox.d",
      },
      options,
    );

    assert.equal(env.MARKDOWN_REVIEW_TARGET_KEY, undefined);
    assert.equal(env.MARKDOWN_REVIEW_TRAEX_CLI_SESSION_ID, undefined);
    assert.equal(env.TRAECLI_SESSION_INBOX, undefined);
    assert.equal(env.CODEX_THREAD_ID, undefined);
    assert.equal(env.DOREY_LAUNCH_MODE, "demo");
    assert.equal(env.DOREY_PREVIEW_ONLY, "1");
  });

  it("does not auto-discover nested workflow roots for explicit single-file launch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dorey-session-root-"));

    try {
      const domainRoot = path.join(
        root,
        "domain-guides",
        "sample_config_platform",
        "feature-flag-rollout",
      );
      const runRoot = path.join(
        domainRoot,
        ".local",
        "ai-coding-workflow",
        "20260705-config-rollout-smoke",
      );
      await mkdir(runRoot, { recursive: true });
      await writeFile(
        path.join(runRoot, "workflow-run.json"),
        JSON.stringify({
          artifacts: {},
          runId: "20260705-config-rollout-smoke",
          taskTitle: "配置评估采纳结果随配置创建发布并用于 Server 埋点",
        }),
        "utf8",
      );

      const options = parseDoreyCliArgs(
        ["--review-file", "README.md"],
        {
          TRAEX_THREAD_ID: "traex-thread-1",
        },
        root,
      );

      assert.equal(options.command, "launch");

      if (options.command === "launch") {
        assert.equal(options.reviewFilePath, path.join(root, "README.md"));
        assert.notEqual(options.workspaceRoot, domainRoot);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("parses server status and stop commands", () => {
    const statusOptions = parseDoreyCliArgs(
      ["status", "--port", "5182"],
      {},
      "/tmp/review-workspace",
    );

    assert.equal(statusOptions.command, "status");

    if (statusOptions.command === "status") {
      assert.equal(statusOptions.baseUrl, "http://127.0.0.1:5182");
      assert.equal(statusOptions.port, 5182);
    }

    const stopOptions = parseDoreyCliArgs(
      ["stop", "--base-url", "http://127.0.0.1:5183/"],
      {},
      "/tmp/review-workspace",
    );

    assert.equal(stopOptions.command, "stop");

    if (stopOptions.command === "stop") {
      assert.equal(stopOptions.all, false);
      assert.equal(stopOptions.baseUrl, "http://127.0.0.1:5183");
      assert.equal(stopOptions.port, 5183);
    }

    const stopAllOptions = parseDoreyCliArgs(
      ["stop", "--all"],
      {},
      "/tmp/review-workspace",
    );

    assert.equal(stopAllOptions.command, "stop");

    if (stopAllOptions.command === "stop") {
      assert.equal(stopAllOptions.all, true);
    }
  });

  it("documents the public dorey commands", () => {
    const help = buildDoreyHelpText();

    assert.match(help, /dorey --review-file <file>/);
    assert.match(help, /dorey --demo/);
    assert.match(help, /dorey poll/);
    assert.match(help, /dorey status/);
    assert.match(help, /dorey stop/);
    assert.doesNotMatch(help, /dorey\s+Recommended for interactive review/);
    assert.doesNotMatch(help, /dorey open/);
  });

  it("resolves the original launcher target from Codex and TraeX environment", () => {
    assert.equal(
      resolveRevisionPollTargetFromEnv({
        CODEX_THREAD_ID: "codex-thread-1",
      }),
      "codex-desktop:codex-thread-1",
    );
    assert.equal(
      resolveRevisionPollTargetFromEnv({
        CODEX_CLI_SESSION_ID: "codex-cli-1",
      }),
      "codex-cli:codex-cli-1",
    );
    assert.equal(
      resolveRevisionPollTargetFromEnv({
        TRAEX_CLI_SESSION_ID: "traex-cli-1",
      }),
      "traex-cli:traex-cli-1",
    );
    assert.equal(
      resolveRevisionPollTargetFromEnv({
        TRAEX_THREAD_ID: "traex-visible-thread-1",
      }),
      "traex-cli:traex-visible-thread-1",
    );
    assert.equal(
      resolveRevisionPollTargetFromEnv({
        CODEX_THREAD_ID: "codex-thread-1",
        MARKDOWN_REVIEW_TARGET_KEY: "traex-cli:explicit-target",
      }),
      "traex-cli:explicit-target",
    );
    assert.equal(
      resolveRevisionPollTargetFromEnv({
        CODEX_THREAD_ID: "codex-thread-1",
        TRAEX_THREAD_ID: "traex-visible-thread-1",
      }),
      "traex-cli:traex-visible-thread-1",
    );
    assert.equal(
      resolveRevisionPollTargetFromEnv({
        CODEX_THREAD_ID: "codex-thread-1",
        TRAECLI_SESSION_INBOX:
          "/Users/example/.trae/cli/sessions/2026/07/06/rollout-2026-07-06T18-12-44-019f36ea.artifacts/inbox.d",
      }),
      "traex-cli:rollout-2026-07-06T18-12-44-019f36ea",
    );
    assert.equal(
      resolveRevisionPollTargetFromEnv({
        MARKDOWN_REVIEW_CODEX_THREAD_ID: "stale-codex-thread",
        TRAECLI_SESSION_INBOX:
          "/Users/example/.trae/cli/sessions/2026/07/06/rollout-2026-07-06T18-12-44-019f36ea.artifacts/inbox.d",
      }),
      "traex-cli:rollout-2026-07-06T18-12-44-019f36ea",
    );
    assert.equal(
      resolveRevisionPollTargetFromEnv({
        MARKDOWN_REVIEW_TARGET_KEY: "codex-desktop:explicit-thread",
        TRAECLI_SESSION_INBOX:
          "/Users/example/.trae/cli/sessions/2026/07/06/rollout-2026-07-06T18-12-44-019f36ea.artifacts/inbox.d",
      }),
      "codex-desktop:explicit-thread",
    );
  });

  it("passes the selected poll target into the detached server environment", () => {
    const options = parseDoreyCliArgs(
      [
        "--review-file",
        "README.md",
        "--target",
        "traex-cli:rollout-2026-07-06T18-12-44-019f36ea",
      ],
      {
        CODEX_THREAD_ID: "codex-thread-1",
      },
      "/tmp/review-workspace",
    );

    assert.equal(options.command, "launch");

    if (options.command !== "launch") {
      return;
    }

    const env = buildDoreyServerEnv(
      {
        CODEX_THREAD_ID: "codex-thread-1",
      },
      options,
    );

    assert.equal(env.MARKDOWN_REVIEW_TARGET_KEY, "traex-cli:rollout-2026-07-06T18-12-44-019f36ea");
    assert.equal(env.MARKDOWN_REVIEW_TRAEX_CLI_SESSION_ID, "rollout-2026-07-06T18-12-44-019f36ea");
    assert.equal(env.MARKDOWN_REVIEW_CODEX_THREAD_ID, undefined);
    assert.equal(env.DOREY_LAUNCH_MODE, "single-file");
    assert.equal(env.DOREY_PREVIEW_ONLY, "0");
  });

  it("materializes a single review file into a one-artifact workflow run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dorey-review-file-"));
    const source = path.join(root, "docs", "design.md");

    try {
      await mkdir(path.dirname(source), { recursive: true });
      await writeFile(source, "# Design\n", "utf8");

      const result = await prepareDoreyLaunchWorkspace({
        launchMode: "single-file",
        reviewFilePath: source,
      });

      const manifestPath = path.join(result.workflowRoot, result.runId, "workflow-run.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const copied = await readFile(
        path.join(result.workflowRoot, result.runId, "md", "design.md"),
        "utf8",
      );

      assert.equal(manifest.runId, result.runId);
      assert.equal(manifest.taskTitle, "Review design.md");
      assert.equal(manifest.artifacts.codingPlan, "md/design.md");
      assert.equal(copied, "# Design\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("materializes the built-in demo into a temporary workflow run", async () => {
    const result = await prepareDoreyLaunchWorkspace({
      launchMode: "demo",
    });
    const manifestPath = path.join(result.workflowRoot, result.runId, "workflow-run.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const draft = await readFile(
      path.join(result.workflowRoot, result.runId, "md", "03-technical-design.md"),
      "utf8",
    );

    assert.equal(result.runId, "bundled-demo");
    assert.equal(manifest.runId, "bundled-demo");
    assert.equal(manifest.artifacts.documentDraft, "md/03-technical-design.md");
    assert.match(draft, /^# 技术方案/m);
  });

  it("rejects unsupported review file extensions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dorey-review-file-"));
    const source = path.join(root, "notes.txt");

    try {
      await writeFile(source, "plain text", "utf8");

      await assert.rejects(
        () =>
          prepareDoreyLaunchWorkspace({
            launchMode: "single-file",
            reviewFilePath: source,
          }),
        /Review file must be Markdown or HTML/,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("detects when an already running server belongs to the wrong session or workspace", () => {
    const expected = {
      targetKey: "traex-cli:rollout-1",
      workspaceRoot: "/tmp/domain-a",
    };

    assert.equal(
      isDoreyServerHealthCompatible(
        {
          app: "dorey",
          launcherContext: {
            provider: "traex",
            sessionId: "rollout-1",
            sessionKind: "traex_cli_session",
          },
          workspaceRoot: "/tmp/domain-a",
        },
        expected,
      ),
      true,
    );
    assert.equal(
      isDoreyServerHealthCompatible(
        {
          app: "dorey",
          launcherContext: {
            provider: "codex",
            sessionId: "rollout-1",
            sessionKind: "codex_thread",
          },
          workspaceRoot: "/tmp/domain-a",
        },
        expected,
      ),
      false,
    );
    assert.equal(
      isDoreyServerHealthCompatible(
        {
          app: "dorey",
          launcherContext: {
            provider: "traex",
            sessionId: "rollout-1",
            sessionKind: "traex_cli_session",
          },
          workspaceRoot: "/tmp/domain-b",
        },
        expected,
      ),
      false,
    );
  });

  it("extracts Dorey server processes for stop --all without matching poll clients", () => {
    const processes = parseDoreyServerProcessList(
      [
        " 21494 node /opt/homebrew/lib/node_modules/dorey/dist/src/server/revision-agent-poll-cli.js server --host 127.0.0.1 --port 5175",
        " 24134 node /opt/homebrew/lib/node_modules/dorey/dist/src/server/revision-agent-poll-cli.js poll --target traex-cli:abc",
        " 3849 node /opt/homebrew/lib/node_modules/dorey/dist/src/server/revision-agent-poll-cli.js server --host 127.0.0.1 --port 5198",
      ].join("\n"),
      99999,
    );

    assert.deepEqual(
      processes.map((process) => process.pid),
      [21494, 3849],
    );
  });

  it("parses long-poll options and builds a browser-server poll URL", () => {
    const options = parseRevisionAgentPollArgs(
      [
        "--base-url",
        "http://127.0.0.1:5175/",
        "--target",
        "codex-desktop:thread-1",
        "--timeout-ms",
        "45000",
        "--once",
      ],
      {},
    );

    assert.equal(options.baseUrl, "http://127.0.0.1:5175");
    assert.equal(options.targetKey, "codex-desktop:thread-1");
    assert.equal(options.timeoutMs, 45_000);
    assert.equal(options.once, true);
    assert.equal(
      buildRevisionAgentPollUrl(options),
      "http://127.0.0.1:5175/api/agent/poll?target=codex-desktop%3Athread-1&timeoutMs=45000",
    );
  });

  it("prints feedback with enough context for the original agent to reply", () => {
    const output = formatRevisionAgentPollFeedback({
      agentPollCommand:
        "dorey poll --base-url 'http://127.0.0.1:5175' --target 'codex-desktop:thread-1'",
      nextStep: "处理 request，然后 POST reply。",
      payloadPath: "/tmp/payload.json",
      replyCommand:
        "curl -sS -X POST 'http://127.0.0.1:5175/api/agent/submissions/submit-1/reply' -H 'Content-Type: application/json' --data-binary @response.json",
      request: {
        artifact: {
          id: "doc-1",
          markdown: "# Doc\n",
          stage: "technical_design",
          title: "Doc",
        },
        comments: [],
      },
      requestId: "submit-1",
      status: "feedback",
      target: {
        key: "codex-desktop:thread-1",
        label: "Codex Desktop（原对话）",
        provider: "codex",
        transport: "codex_desktop",
      },
    });
    const parsed = JSON.parse(output);

    assert.equal(parsed.status, "feedback");
    assert.equal(parsed.requestId, "submit-1");
    assert.equal(parsed.payloadPath, "/tmp/payload.json");
    assert.equal(parsed.replyCommand.includes("/reply"), true);
    assert.equal(parsed.nextAction, "revise_markdown_and_post_batch_response");
  });

  it("keeps default poll alive after feedback so later submits are received", async () => {
    const originalFetch = globalThis.fetch;
    const originalStdoutWrite = process.stdout.write;
    let fetchCount = 0;
    let output = "";
    let thirdFetchCalled: () => void = () => {};
    const thirdFetch = new Promise<void>((resolve) => {
      thirdFetchCalled = resolve;
    });
    const pendingFetch = new Promise<Response>(() => {});

    globalThis.fetch = (async () => {
      fetchCount += 1;

      if (fetchCount === 1 || fetchCount === 2) {
        return jsonResponse(pollFeedback(`submit-${fetchCount}`));
      }

      thirdFetchCalled();
      return await pendingFetch;
    }) as typeof fetch;
    process.stdout.write = ((chunk: unknown) => {
      output += String(chunk);

      return true;
    }) as typeof process.stdout.write;

    try {
      void runRevisionAgentPollLoop({
        baseUrl: "http://127.0.0.1:5175",
        intervalMs: 1,
        once: false,
        targetKey: "traex-cli:session-1",
        timeoutMs: 1,
      });

      await thirdFetch;

      assert.equal(fetchCount, 3);
      assert.match(output, /"requestId": "submit-1"/);
      assert.match(output, /"requestId": "submit-2"/);
    } finally {
      globalThis.fetch = originalFetch;
      process.stdout.write = originalStdoutWrite;
    }
  });

  it("exits after the first feedback when --once is set", async () => {
    const originalFetch = globalThis.fetch;
    const originalStdoutWrite = process.stdout.write;
    let fetchCount = 0;
    let output = "";

    globalThis.fetch = (async () => {
      fetchCount += 1;

      return jsonResponse(pollFeedback("submit-once"));
    }) as typeof fetch;
    process.stdout.write = ((chunk: unknown) => {
      output += String(chunk);

      return true;
    }) as typeof process.stdout.write;

    try {
      const exitCode = await runRevisionAgentPollLoop({
        baseUrl: "http://127.0.0.1:5175",
        intervalMs: 1,
        once: true,
        targetKey: "traex-cli:session-1",
        timeoutMs: 1,
      });

      assert.equal(exitCode, 0);
      assert.equal(fetchCount, 1);
      assert.match(output, /"requestId": "submit-once"/);
    } finally {
      globalThis.fetch = originalFetch;
      process.stdout.write = originalStdoutWrite;
    }
  });

  it("builds the recommended command shown in the UI", () => {
    assert.equal(
      buildRevisionAgentPollCommand({
        baseUrl: "http://127.0.0.1:5175/",
        targetKey: "traex-cli:session-1",
      }),
      "dorey poll --base-url 'http://127.0.0.1:5175' --target 'traex-cli:session-1'",
    );
  });

  it("treats an npm global bin symlink as a direct CLI run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "dorey-cli-"));

    try {
      const realEntrypoint = path.join(root, "revision-agent-poll-cli.js");
      const binSymlink = path.join(root, "dorey");

      await writeFile(realEntrypoint, "#!/usr/bin/env node\n", "utf8");
      await symlink(realEntrypoint, binSymlink);

      assert.equal(isDirectRun(pathToFileURL(realEntrypoint).href, binSymlink), true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps the compiled CLI entrypoint executable for npm bin symlinks", async () => {
    const compiledBinPath = fileURLToPath(
      new URL("../src/server/revision-agent-poll-cli.js", import.meta.url),
    );
    const compiledBin = await stat(compiledBinPath);

    assert.notEqual(compiledBin.mode & 0o111, 0);
  });
});
