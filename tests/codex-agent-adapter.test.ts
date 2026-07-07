import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  Artifact,
  BatchRevisionRequest,
  ContextSnapshot,
  QueuedComment,
  ReviewSession,
} from "../src/contracts/index.js";
import {
  buildCodexRevisionPrompt,
  buildCodexExecArgs,
  codexRevisionOutputSchema,
  parseCodexRevisionOutput,
  resolveCodexExecutionMode,
} from "../src/server/codex-cli-adapter.js";
import { handleCodexRevisionRequest } from "../src/server/codex-revision-endpoint.js";
import { CodexAgentAdapter } from "../src/review/codex-agent-adapter.js";
import { CodexCliAgentAdapter } from "../src/review/codex-cli-agent-adapter.js";

const artifact: Artifact = {
  id: "sample-technical-design",
  stage: "technical_design",
  title: "技术方案：配置快照发布",
  markdown:
    "# 技术方案：配置快照发布\n\n## 方案\n\n优先复用已有发布链路，只在必要位置新增配置快照发布逻辑。\n",
};

const comment: QueuedComment = {
  id: "comment-1",
  artifactId: "sample-technical-design",
  anchor: {
    blockId: "sample-technical-design:p:4",
    startOffset: 2,
    endOffset: 10,
    quote: "复用已有发布链路",
  },
  body: "把复用边界和验证证据写清楚。",
  category: "missing_info",
  status: "queued",
  createdAt: "2026-07-04T09:00:00.000Z",
};

const request: BatchRevisionRequest = {
  artifact,
  comments: [comment],
  globalInstruction: "保持技术方案语气。",
};

const session: ReviewSession = {
  id: "session-main",
  provider: "codex",
  label: "Main Codex session",
  taskGoal: "修改配置快照发布方案",
  currentPhase: "technical_design",
  origin: "launched_from_agent",
  contextSummary:
    "主会话已经完成现状建模，正在根据 review comments 修改技术方案。",
  artifactIds: ["sample-technical-design"],
  createdAt: "2026-07-04T09:00:00.000Z",
  updatedAt: "2026-07-04T09:10:00.000Z",
};

const contextSnapshot: ContextSnapshot = {
  id: "snapshot-main",
  sessionId: "session-main",
  artifactId: "sample-technical-design",
  agentProvider: "codex",
  createdAt: "2026-07-04T09:11:00.000Z",
  taskGoal: session.taskGoal,
  currentPhase: session.currentPhase,
  contextSummary: session.contextSummary,
  linkedSessionIds: ["session-main"],
  priorAcceptedRevisionSummaries: [
    "Clarified the published config snapshot fields.",
  ],
};

const requestWithSessionContext: BatchRevisionRequest = {
  ...request,
  session,
  contextSnapshot,
};

describe("Codex CLI adapter prompt and schema", () => {
  it("builds a read-only revision prompt with artifact and queued comments", () => {
    const prompt = buildCodexRevisionPrompt(request);

    assert.match(prompt, /revise the provided Markdown artifact/i);
    assert.match(prompt, /Do not edit files/);
    assert.match(prompt, /sample-technical-design:p:4/);
    assert.match(prompt, /复用已有发布链路/);
    assert.match(prompt, /把复用边界和验证证据写清楚/);
    assert.match(prompt, /保持技术方案语气/);
    assert.match(prompt, /revisedMarkdown/);
  });

  it("materializes session context separately for the Codex subprocess", () => {
    const prompt = buildCodexRevisionPrompt(requestWithSessionContext);

    assert.match(prompt, /Session context JSON:/);
    assert.match(prompt, /session-main/);
    assert.match(prompt, /修改配置快照发布方案/);
    assert.match(prompt, /technical_design/);
    assert.match(prompt, /priorAcceptedRevisionSummaries/);
    assert.match(prompt, /Clarified the published config snapshot fields/);
    assert.match(prompt, /BatchRevisionRequest JSON:/);
  });

  it("defines the exact structured response fields expected from Codex", () => {
    assert.deepEqual(codexRevisionOutputSchema.required, [
      "revisedMarkdown",
      "summary",
      "addressedComments",
    ]);
    assert.equal(codexRevisionOutputSchema.additionalProperties, false);
    assert.equal(
      codexRevisionOutputSchema.properties.addressedComments.items.required[0],
      "commentId",
    );
  });

  it("builds safe non-interactive codex exec arguments", () => {
    const args = buildCodexExecArgs({
      cwd: "/tmp/review-workspace",
      schemaPath: "/tmp/schema.json",
      outputPath: "/tmp/output.json",
    });

    assert.deepEqual(args, [
      "--ask-for-approval",
      "never",
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--output-schema",
      "/tmp/schema.json",
      "--output-last-message",
      "/tmp/output.json",
      "--cd",
      "/tmp/review-workspace",
      "-",
    ]);
  });

  it("builds codex exec resume arguments for attached Codex sessions", () => {
    const args = buildCodexExecArgs({
      cwd: "/tmp/review-workspace",
      execution: {
        sessionId: "019f2dbb-5d9e-73c3-a99e-7fc6558dbdff",
        type: "attached",
      },
      schemaPath: "/tmp/schema.json",
      outputPath: "/tmp/output.json",
    });

    assert.deepEqual(args, [
      "--ask-for-approval",
      "never",
      "--sandbox",
      "read-only",
      "--cd",
      "/tmp/review-workspace",
      "exec",
      "resume",
      "--output-schema",
      "/tmp/schema.json",
      "--output-last-message",
      "/tmp/output.json",
      "019f2dbb-5d9e-73c3-a99e-7fc6558dbdff",
      "-",
    ]);
    assert.equal(args.includes("--ephemeral"), false);
  });

  it("resolves attached execution only for attached Codex sessions", () => {
    assert.deepEqual(
      resolveCodexExecutionMode({
        ...request,
        session: {
          ...session,
          externalSessionId: "codex-session-id",
          externalSessionKind: "codex_cli_session",
          origin: "attached",
          provider: "codex",
        },
      }),
      { sessionId: "codex-session-id", type: "attached" },
    );
    assert.deepEqual(
      resolveCodexExecutionMode({
        ...request,
        session: {
          ...session,
          externalSessionId: "traex-session-id",
          origin: "attached",
          provider: "traex",
        },
      }),
      { type: "ephemeral" },
    );
  });

  it("does not resume a Codex Desktop launcher thread as a CLI session", () => {
    const launcherThreadSession = {
      ...session,
      externalSessionId: "019f2c77-2758-7440-8011-5ce9091b66fa",
      launcherContext: {
        provider: "codex",
        sessionId: "019f2c77-2758-7440-8011-5ce9091b66fa",
        sessionKind: "codex_thread",
      },
      origin: "attached",
      provider: "codex",
    } as ReviewSession;

    assert.deepEqual(
      resolveCodexExecutionMode({
        ...request,
        session: launcherThreadSession,
      }),
      { type: "ephemeral" },
    );
  });
});

describe("Codex CLI adapter output parsing", () => {
  it("parses a valid structured Codex response", () => {
    const response = parseCodexRevisionOutput(
      JSON.stringify({
        revisedMarkdown: "# Revised\n\nUpdated body.\n",
        summary: "Updated the方案 paragraph.",
        addressedComments: [
          {
            commentId: "comment-1",
            resolution: "Added reuse boundary and verification evidence.",
          },
        ],
      }),
    );

    assert.equal(response.revisedMarkdown, "# Revised\n\nUpdated body.\n");
    assert.equal(response.addressedComments[0]?.commentId, "comment-1");
  });

  it("rejects malformed or incomplete Codex output", () => {
    assert.throws(
      () => parseCodexRevisionOutput("{\"summary\":\"missing fields\"}"),
      /missing revisedMarkdown/,
    );
    assert.throws(() => parseCodexRevisionOutput("not json"), /valid JSON/);
  });
});

describe("CodexAgentAdapter client", () => {
  it("exposes an explicit Codex CLI adapter name for the local CLI target", async () => {
    const calls: string[] = [];
    const adapter = new CodexCliAgentAdapter({
      fetchImpl: async (url) => {
        calls.push(String(url));

        return new Response(
          JSON.stringify({
            revisedMarkdown: "# Revised\n",
            summary: "Codex CLI revised the artifact.",
            addressedComments: [
              {
                commentId: "comment-1",
                resolution: "Resolved.",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });

    const response = await adapter.reviseArtifact(request);

    assert.deepEqual(calls, ["/api/agent/codex/revise"]);
    assert.equal(
      "summary" in response ? response.summary : "",
      "Codex CLI revised the artifact.",
    );
  });

  it("binds the default browser fetch to globalThis", async () => {
    const originalFetch = globalThis.fetch;
    const calls: unknown[] = [];

    globalThis.fetch = function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) {
      calls.push(this);
      assert.equal(this, globalThis);
      assert.equal(String(input), "/api/agent/codex/revise");
      assert.equal(init?.method, "POST");

      return Promise.resolve(
        new Response(
          JSON.stringify({
            revisedMarkdown: "# Revised\n",
            summary: "Codex revised the artifact.",
            addressedComments: [
              {
                commentId: "comment-1",
                resolution: "Resolved.",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    } as typeof fetch;

    try {
      const adapter = new CodexAgentAdapter();
      const response = await adapter.reviseArtifact(request);

      assert.equal(calls.length, 1);
      assert.equal(
        "summary" in response ? response.summary : "",
        "Codex revised the artifact.",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("posts batch revision requests to the local Codex endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const abortController = new AbortController();
    const adapter = new CodexAgentAdapter({
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });

        return new Response(
          JSON.stringify({
            revisedMarkdown: "# Revised\n",
            summary: "Codex revised the artifact.",
            addressedComments: [
              {
                commentId: "comment-1",
                resolution: "Resolved.",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });

    const response = await adapter.reviseArtifact(request, {
      signal: abortController.signal,
    });

    assert.equal(calls[0]?.url, "/api/agent/codex/revise");
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal(calls[0]?.init.signal, abortController.signal);
    assert.equal(
      (calls[0]?.init.headers as Record<string, string>)["Content-Type"],
      "application/json",
    );
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), request);
    assert.equal(
      "summary" in response ? response.summary : "",
      "Codex revised the artifact.",
    );
  });

  it("surfaces endpoint failures as actionable errors", async () => {
    const adapter = new CodexAgentAdapter({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "codex exited with code 1" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await assert.rejects(
      () => adapter.reviseArtifact(request),
      /codex exited with code 1/,
    );
  });
});

describe("Codex revision endpoint handler", () => {
  it("queues Codex CLI submit work for the launcher session", async () => {
    const result = await handleCodexRevisionRequest(
      {
        baseUrl: "http://127.0.0.1:5175",
        method: "POST",
        body: JSON.stringify({
          ...request,
          session: {
            ...session,
            launcherContext: {
              provider: "codex",
              sessionId: "codex-cli-session-1",
              sessionKind: "codex_cli_session",
            },
          },
        }),
      },
      { cwd: "/tmp/review-workspace" },
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.status, "queued");
    assert.equal(result.body.target.key, "codex-cli:codex-cli-session-1");
    assert.match(result.body.pollCommand, /\/api\/agent\/poll/);
    assert.match(result.body.replyCommand, /\/api\/agent\/submissions\//);
  });

  it("rejects non-POST methods and invalid JSON bodies", async () => {
    const methodResult = await handleCodexRevisionRequest(
      { method: "GET", body: "" },
      { cwd: "/tmp/review-workspace" },
    );

    assert.equal(methodResult.status, 405);
    assert.equal(methodResult.body.error, "Method not allowed.");

    const jsonResult = await handleCodexRevisionRequest(
      { method: "POST", body: "not json" },
      { cwd: "/tmp/review-workspace" },
    );

    assert.equal(jsonResult.status, 400);
    assert.match(jsonResult.body.error, /valid JSON/);
  });
});
