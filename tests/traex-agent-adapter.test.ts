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
  buildTraexRevisionPrompt,
  buildTraexExecArgs,
  parseTraexRevisionOutput,
  resolveTraexExecutionMode,
  traexRevisionOutputSchema,
} from "../src/server/traex-cli-adapter.js";
import { handleTraexRevisionRequest } from "../src/server/traex-revision-endpoint.js";
import { TraexAgentAdapter } from "../src/review/traex-agent-adapter.js";

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
  provider: "traex",
  label: "Main TraeX session",
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
  agentProvider: "traex",
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

describe("TraeX CLI adapter prompt and schema", () => {
  it("builds a read-only revision prompt with artifact and queued comments", () => {
    const prompt = buildTraexRevisionPrompt(request);

    assert.match(prompt, /revise the provided Markdown artifact/i);
    assert.match(prompt, /Do not edit files/);
    assert.match(prompt, /sample-technical-design:p:4/);
    assert.match(prompt, /复用已有发布链路/);
    assert.match(prompt, /把复用边界和验证证据写清楚/);
    assert.match(prompt, /保持技术方案语气/);
    assert.match(prompt, /revisedMarkdown/);
    assert.match(prompt, /Return only one JSON object/);
    assert.match(prompt, /JSON schema/);
  });

  it("materializes session context separately for the TraeX subprocess", () => {
    const prompt = buildTraexRevisionPrompt(requestWithSessionContext);

    assert.match(prompt, /Session context JSON:/);
    assert.match(prompt, /session-main/);
    assert.match(prompt, /修改配置快照发布方案/);
    assert.match(prompt, /technical_design/);
    assert.match(prompt, /priorAcceptedRevisionSummaries/);
    assert.match(prompt, /Clarified the published config snapshot fields/);
    assert.match(prompt, /BatchRevisionRequest JSON:/);
  });

  it("defines the exact structured response fields expected from TraeX", () => {
    assert.deepEqual(traexRevisionOutputSchema.required, [
      "revisedMarkdown",
      "summary",
      "addressedComments",
    ]);
    assert.equal(traexRevisionOutputSchema.additionalProperties, false);
    assert.equal(
      traexRevisionOutputSchema.properties.addressedComments.items.required[0],
      "commentId",
    );
  });

  it("builds safe non-interactive traex exec arguments without schema mode", () => {
    const args = buildTraexExecArgs({
      cwd: "/tmp/review-workspace",
      outputPath: "/tmp/output.json",
    });

    assert.deepEqual(args, [
      "--ask-for-approval",
      "never",
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--output-last-message",
      "/tmp/output.json",
      "--cd",
      "/tmp/review-workspace",
      "-",
    ]);
    assert.equal(args.includes("--output-schema"), false);
  });

  it("builds traex exec resume arguments for attached TraeX sessions", () => {
    const args = buildTraexExecArgs({
      cwd: "/tmp/review-workspace",
      execution: {
        sessionId: "019f2dbb-5d9e-73c3-a99e-7fc6558dbdff",
        type: "attached",
      },
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
      "--output-last-message",
      "/tmp/output.json",
      "019f2dbb-5d9e-73c3-a99e-7fc6558dbdff",
      "-",
    ]);
    assert.equal(args.includes("--ephemeral"), false);
  });

  it("resolves attached execution only for attached TraeX sessions", () => {
    assert.deepEqual(
      resolveTraexExecutionMode({
        ...request,
        session: {
          ...session,
          externalSessionId: "traex-session-id",
          externalSessionKind: "traex_cli_session",
          origin: "attached",
          provider: "traex",
        },
      }),
      { sessionId: "traex-session-id", type: "attached" },
    );
    assert.deepEqual(
      resolveTraexExecutionMode({
        ...request,
        session: {
          ...session,
          externalSessionId: "codex-session-id",
          origin: "attached",
          provider: "codex",
        },
      }),
      { type: "ephemeral" },
    );
  });

  it("does not resume a launcher thread as a TraeX CLI session", () => {
    const launcherThreadSession = {
      ...session,
      externalSessionId: "019f2c77-2758-7440-8011-5ce9091b66fa",
      launcherContext: {
        provider: "codex",
        sessionId: "019f2c77-2758-7440-8011-5ce9091b66fa",
        sessionKind: "codex_thread",
      },
      origin: "attached",
      provider: "traex",
    } as ReviewSession;

    assert.deepEqual(
      resolveTraexExecutionMode({
        ...request,
        session: launcherThreadSession,
      }),
      { type: "ephemeral" },
    );
  });
});

describe("TraeX CLI adapter output parsing", () => {
  it("parses a valid structured TraeX response", () => {
    const response = parseTraexRevisionOutput(
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

  it("rejects malformed or incomplete TraeX output", () => {
    assert.throws(
      () => parseTraexRevisionOutput("{\"summary\":\"missing fields\"}"),
      /missing revisedMarkdown/,
    );
    assert.throws(() => parseTraexRevisionOutput("not json"), /valid JSON/);
  });
});

describe("TraexAgentAdapter client", () => {
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
      assert.equal(String(input), "/api/agent/traex/revise");
      assert.equal(init?.method, "POST");

      return Promise.resolve(
        new Response(
          JSON.stringify({
            revisedMarkdown: "# Revised\n",
            summary: "TraeX revised the artifact.",
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
      const adapter = new TraexAgentAdapter();
      const response = await adapter.reviseArtifact(request);

      assert.equal(calls.length, 1);
      assert.equal(
        "summary" in response ? response.summary : "",
        "TraeX revised the artifact.",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("posts batch revision requests to the local TraeX endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const abortController = new AbortController();
    const adapter = new TraexAgentAdapter({
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });

        return new Response(
          JSON.stringify({
            revisedMarkdown: "# Revised\n",
            summary: "TraeX revised the artifact.",
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

    assert.equal(calls[0]?.url, "/api/agent/traex/revise");
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal(calls[0]?.init.signal, abortController.signal);
    assert.equal(
      (calls[0]?.init.headers as Record<string, string>)["Content-Type"],
      "application/json",
    );
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), request);
    assert.equal(
      "summary" in response ? response.summary : "",
      "TraeX revised the artifact.",
    );
  });

  it("surfaces endpoint failures as actionable errors", async () => {
    const adapter = new TraexAgentAdapter({
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "traex exited with code 1" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
    });

    await assert.rejects(
      () => adapter.reviseArtifact(request),
      /traex exited with code 1/,
    );
  });
});

describe("TraeX revision endpoint handler", () => {
  it("queues TraeX CLI submit work for the launcher session", async () => {
    const result = await handleTraexRevisionRequest(
      {
        baseUrl: "http://127.0.0.1:5175",
        method: "POST",
        body: JSON.stringify({
          ...request,
          session: {
            ...session,
            launcherContext: {
              provider: "traex",
              sessionId: "traex-cli-session-1",
              sessionKind: "traex_cli_session",
            },
          },
        }),
      },
      { cwd: "/tmp/review-workspace" },
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.status, "queued");
    assert.equal(result.body.target.key, "traex-cli:traex-cli-session-1");
    assert.match(result.body.pollCommand, /\/api\/agent\/poll/);
    assert.match(result.body.replyCommand, /\/api\/agent\/submissions\//);
  });

  it("rejects non-POST methods and invalid JSON bodies", async () => {
    const methodResult = await handleTraexRevisionRequest(
      { method: "GET", body: "" },
      { cwd: "/tmp/review-workspace" },
    );

    assert.equal(methodResult.status, 405);
    assert.equal(methodResult.body.error, "Method not allowed.");

    const jsonResult = await handleTraexRevisionRequest(
      { method: "POST", body: "not json" },
      { cwd: "/tmp/review-workspace" },
    );

    assert.equal(jsonResult.status, 400);
    assert.match(jsonResult.body.error, /valid JSON/);
  });
});
