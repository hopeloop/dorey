import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import type { QueuedComment } from "../src/contracts/index.js";
import {
  listWorkflowRuns,
  normalizeWorkflowRunManifest,
  readWorkflowRunArtifact,
  resolveWorkflowRelativePath,
  writeWorkflowReviewResult,
  writeWorkflowRevisionTrace,
} from "../src/server/workflow-run-loader.js";
import { createWorkflowRunFixture } from "./workflow-run-test-fixture.js";

describe("workflow run manifest normalizer", () => {
  it("normalizes the real map-based workflow-run contract into ordered artifacts", async () => {
    const fixture = await createWorkflowRunFixture();
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));

    const artifacts = normalizeWorkflowRunManifest(manifest, fixture.manifestPath);

    assert.deepEqual(
      artifacts.map((artifact) => artifact.id),
      [
        "requirement-orientation",
        "current-state-modeling",
        "change-convergence",
        "open-questions",
        "convergence-status",
        "document-draft",
        "document-manifest",
        "coding-plan",
        "verification-plan",
        "trace",
      ],
    );
    assert.deepEqual(artifacts[1], {
      id: "current-state-modeling",
      title: "现状建模",
      stage: "current_state_modeling",
      group: "scratch",
      kind: "markdown",
      relativePath: "scratch/02-current-state-modeling.md",
      reviewable: true,
      displayOrder: 20,
      assets: [
        {
          id: "current-state-modeling-asset-1",
          kind: "plantuml",
          relativePath: "scratch/diagrams/current-state-entry-flow.puml",
          title: "current-state-entry-flow.puml",
        },
        {
          id: "current-state-modeling-asset-2",
          kind: "plantuml",
          relativePath: "scratch/diagrams/current-state-persistence-flow.puml",
          title: "current-state-persistence-flow.puml",
        },
      ],
    });
    assert.equal(
      artifacts.find((artifact) => artifact.id === "trace")?.reviewable,
      false,
    );
  });

  it("resolves artifact paths under the manifest directory, not manifest.runRoot", async () => {
    const fixture = await createWorkflowRunFixture();
    const resolved = resolveWorkflowRelativePath(
      fixture.runRoot,
      "scratch/01-requirement-orientation.md",
    );

    assert.equal(
      resolved,
      path.join(fixture.runRoot, "scratch/01-requirement-orientation.md"),
    );
    assert.throws(
      () => resolveWorkflowRelativePath(fixture.runRoot, "../escape.md"),
      /outside workflow run root/,
    );
  });
});

describe("workflow run loader", () => {
  it("lists workflow runs with safe editor run keys", async () => {
    const fixture = await createWorkflowRunFixture();
    const runs = await listWorkflowRuns({ root: fixture.root });

    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.runId, "ai-coding-workflow-demo-20260704T170733Z");
    assert.equal(runs[0]?.taskTitle, "配置快照发布 / 多环境功能开关改造");
    assert.notEqual(runs[0]?.runKey, runs[0]?.runId);
    assert.equal(runs[0]?.effectiveRunRoot, fixture.runRoot);
    assert.equal(runs[0]?.artifacts.length, 10);
  });

  it("reads markdown, PlantUML, and JSON artifacts for display", async () => {
    const fixture = await createWorkflowRunFixture();
    const [run] = await listWorkflowRuns({ root: fixture.root });
    assert.ok(run);

    const markdown = await readWorkflowRunArtifact({
      artifactId: "document-draft",
      root: fixture.root,
      runKey: run.runKey,
    });
    const plantuml = await readWorkflowRunArtifact({
      artifactId: "current-state-modeling-asset-1",
      root: fixture.root,
      runKey: run.runKey,
    });
    const json = await readWorkflowRunArtifact({
      artifactId: "trace",
      root: fixture.root,
      runKey: run.runKey,
    });

    assert.equal(markdown.kind, "markdown");
    assert.match(markdown.displayMarkdown, /# 技术方案：配置快照发布/);
    assert.equal(plantuml.kind, "plantuml");
    assert.match(plantuml.displayMarkdown, /^```plantuml\n@startuml/m);
    assert.equal(json.kind, "json");
    assert.match(json.displayMarkdown, /^```json\n\{/);
  });

  it("recognizes html artifacts as user-facing document files", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "workflow-runs-html-"));
    const { runRoot: tempRunRoot } = await createWorkflowRunFixture(tempRoot, "demo-run");
    const manifestPath = path.join(tempRunRoot, "workflow-run.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.artifacts.documentDraft = "document/document-draft.html";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await writeFile(
      path.join(tempRunRoot, "document/document-draft.html"),
      "<h1>HTML 技术方案</h1>",
      "utf8",
    );

    const [run] = await listWorkflowRuns({ root: tempRoot });
    assert.ok(run);
    const artifact = run.artifacts.find((item) => item.id === "document-draft");
    const content = await readWorkflowRunArtifact({
      artifactId: "document-draft",
      root: tempRoot,
      runKey: run.runKey,
    });

    assert.equal(artifact?.kind, "html");
    assert.equal(content.kind, "html");
    assert.match(content.displayMarkdown, /<h1>HTML 技术方案<\/h1>/);
  });

  it("accepts schema-less workflow manifests and discovers user-facing directory docs", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "workflow-runs-real-"));
    const tempRunRoot = path.join(tempRoot, "20260705-config-rollout-smoke");
    await mkdir(path.join(tempRunRoot, "document"), { recursive: true });
    await mkdir(path.join(tempRunRoot, "md"), { recursive: true });
    await mkdir(path.join(tempRunRoot, "scratch"), { recursive: true });
    await writeFile(
      path.join(tempRunRoot, "workflow-run.json"),
      JSON.stringify(
        {
          artifacts: {
            codingPlan: "md/coding-plan.md",
            trace: "trace.json",
          },
          review: {
            root: "review/",
          },
          runId: "20260705-config-rollout-smoke",
          runRoot: tempRunRoot,
          taskTitle: "配置评估采纳结果随配置创建发布并用于 Server 埋点",
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      path.join(tempRunRoot, "document/document-draft.md"),
      "# 发布文档草稿\n",
      "utf8",
    );
    await writeFile(
      path.join(tempRunRoot, "document/document-manifest.json"),
      "{}",
      "utf8",
    );
    await writeFile(
      path.join(tempRunRoot, "document/template-cache.md"),
      "",
      "utf8",
    );
    await writeFile(
      path.join(tempRunRoot, "md/coding-plan.md"),
      "# Coding Plan\n",
      "utf8",
    );
    await writeFile(
      path.join(tempRunRoot, "md/debug-notes.md"),
      "# Debug Notes\n",
      "utf8",
    );
    await writeFile(
      path.join(tempRunRoot, "scratch/internal-notes.md"),
      "# Internal Notes\n",
      "utf8",
    );
    await writeFile(path.join(tempRunRoot, "trace.json"), "{}", "utf8");

    const [run] = await listWorkflowRuns({ root: tempRoot });
    assert.ok(run);
    const artifactIds = run.artifacts.map((artifact) => artifact.id);

    assert.equal(run.runId, "20260705-config-rollout-smoke");
    assert.ok(artifactIds.includes("coding-plan"));
    assert.ok(!artifactIds.includes("document-draft"));
    assert.ok(artifactIds.includes("doc-document-document-draft"));
    assert.ok(!artifactIds.includes("doc-document-document-manifest"));
    assert.ok(!artifactIds.includes("doc-document-template-cache"));
    assert.ok(artifactIds.includes("doc-md-debug-notes"));
    assert.ok(!artifactIds.includes("doc-scratch-internal-notes"));

    const documentDraft = await readWorkflowRunArtifact({
      artifactId: "doc-document-document-draft",
      root: tempRoot,
      runKey: run.runKey,
    });

    assert.ok("group" in documentDraft.artifact);
    assert.equal(documentDraft.artifact.group, "document");
    assert.equal(documentDraft.kind, "markdown");
    assert.match(documentDraft.displayMarkdown, /# 发布文档草稿/);
  });

  it("discovers folder-review Markdown recursively and titles documents from H1", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "dorey-folder-run-"));
    const runRoot = path.join(tempRoot, "folder-run");
    await mkdir(path.join(runRoot, "documents", "notes"), { recursive: true });
    await writeFile(
      path.join(runRoot, "workflow-run.json"),
      JSON.stringify({
        review: { root: "review" },
        runId: "folder-run",
        source: { mode: "folder" },
        taskTitle: "文档目录",
      }),
      "utf8",
    );
    await writeFile(
      path.join(runRoot, "documents", "蒸馏偏见.md"),
      "# 蒸馏偏见\n",
      "utf8",
    );
    await writeFile(
      path.join(runRoot, "documents", "notes", "说明.markdown"),
      "```md\n# 不是标题\n```\n\n真正标题\n===\n",
      "utf8",
    );
    await writeFile(
      path.join(runRoot, "documents", "notes", "ignored.html"),
      "<h1>Ignored</h1>",
      "utf8",
    );

    const [run] = await listWorkflowRuns({ root: tempRoot });
    assert.ok(run);
    assert.equal(run.sourceMode, "folder");
    assert.deepEqual(
      run.artifacts.map((artifact) => artifact.relativePath),
      ["documents/notes/说明.markdown", "documents/蒸馏偏见.md"],
    );
    assert.deepEqual(
      new Set(run.artifacts.map((artifact) => artifact.title)),
      new Set(["真正标题", "蒸馏偏见"]),
    );
    assert.equal(new Set(run.artifacts.map((artifact) => artifact.id)).size, 2);
  });

  it("writes submit trace and accept result under review without mutating source artifacts", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "workflow-runs-"));
    const fixture = await createWorkflowRunFixture(tempRoot, "demo-run");
    const [run] = await listWorkflowRuns({ root: tempRoot });
    assert.ok(run);

    const original = await readFile(
      path.join(fixture.runRoot, "document/document-draft.md"),
      "utf8",
    );
    const comments: QueuedComment[] = [
      {
        id: "comment-1",
        artifactId: "document-draft",
        anchor: {
          blockId: "document-draft:p:1",
          endOffset: 2,
          quote: "方案",
          startOffset: 0,
        },
        body: "补充边界说明。",
        category: "clarification",
        createdAt: "2026-07-05T10:00:00.000Z",
        status: "queued",
      },
    ];

    const trace = await writeWorkflowRevisionTrace({
      adapterName: "codex",
      artifactId: "document-draft",
      comments,
      contextSnapshot: {
        agentProvider: "codex",
        artifactId: "document-draft",
        contextSummary: "Reviewing workflow artifact.",
        createdAt: "2026-07-05T10:01:00.000Z",
        currentPhase: "technical_design",
        id: "snapshot-1",
        linkedSessionIds: ["session-1"],
        priorAcceptedRevisionSummaries: [],
        sessionId: "session-1",
        taskGoal: "Review workflow artifact.",
      },
      globalInstruction: "保持语气。",
      originalMarkdown: original,
      response: {
        addressedComments: [
          { commentId: "comment-1", resolution: "已补充。" },
        ],
        revisedMarkdown: `${original}\n\n补充说明。\n`,
        summary: "补充边界说明。",
      },
      root: tempRoot,
      runKey: run.runKey,
      submittedAt: "2026-07-05T10:02:00.000Z",
    });

    assert.match(trace.latestRevisionRequestPath, /revision-request-/);
    assert.match(trace.latestRevisionResponsePath, /revision-response-/);
    assert.match(
      await readFile(path.join(run.effectiveRunRoot, trace.latestRevisionRequestPath), "utf8"),
      /"sourceMarkdownPath": "document\/document-draft.md"/,
    );

    const accepted = await writeWorkflowReviewResult({
      acceptedAt: "2026-07-05T10:03:00.000Z",
      artifactId: "document-draft",
      latestRevisionRequestPath: trace.latestRevisionRequestPath,
      latestRevisionResponsePath: trace.latestRevisionResponsePath,
      response: {
        addressedComments: [
          { commentId: "comment-1", resolution: "已补充。" },
        ],
        revisedMarkdown: `${original}\n\n补充说明。\n`,
        summary: "补充边界说明。",
      },
      root: tempRoot,
      runKey: run.runKey,
    });

    assert.equal(accepted.acceptedRevisionPath, "review/document-draft/revised.md");
    assert.equal(
      await readFile(path.join(run.effectiveRunRoot, "document/document-draft.md"), "utf8"),
      original,
    );
    assert.match(
      await readFile(path.join(run.effectiveRunRoot, "review/document-draft/review-result.json"), "utf8"),
      /"artifactId": "document-draft"/,
    );
  });
});
