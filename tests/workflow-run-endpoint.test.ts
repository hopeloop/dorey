import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { handleWorkflowRunRequest } from "../src/server/workflow-run-endpoint.js";
import { prepareDoreyLaunchWorkspace } from "../src/server/revision-agent-poll-cli.js";
import type {
  WorkflowArtifactContent,
  WorkflowReviewResult,
  WorkflowRevisionTraceResult,
  WorkflowRunSummary,
} from "../src/server/workflow-run-loader.js";
import { createWorkflowRunFixture } from "./workflow-run-test-fixture.js";

describe("workflow run endpoint handler", () => {
  it("lists workflow runs and reads artifact display content", async () => {
    const { root } = await createWorkflowRunFixture();
    const list = await handleWorkflowRunRequest({
      body: "",
      method: "GET",
      root,
      url: "/api/workflow-runs",
    });

    assert.equal(list.status, 200);
    const listBody = list.body as { runs: WorkflowRunSummary[] };
    assert.equal(listBody.runs.length, 1);

    const runKey = listBody.runs[0]!.runKey;
    const detail = await handleWorkflowRunRequest({
      body: "",
      method: "GET",
      root,
      url: `/api/workflow-runs/${runKey}`,
    });

    assert.equal(detail.status, 200);
    const detailBody = detail.body as { run: WorkflowRunSummary };
    assert.equal(detailBody.run.artifacts.length, 10);

    const artifact = await handleWorkflowRunRequest({
      body: "",
      method: "GET",
      root,
      url: `/api/workflow-runs/${runKey}/artifacts/current-state-modeling-asset-1`,
    });

    assert.equal(artifact.status, 200);
    const artifactBody = artifact.body as WorkflowArtifactContent;
    assert.equal(artifactBody.artifact.kind, "plantuml");
    assert.match(artifactBody.displayMarkdown, /^```plantuml\n@startuml/m);
  });

  it("serves run-local images with their real content type", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workflow-image-endpoint-"));
    const runRoot = path.join(root, "image-run");
    await mkdir(path.join(runRoot, "documents", "assets"), { recursive: true });
    await writeFile(
      path.join(runRoot, "workflow-run.json"),
      JSON.stringify({ runId: "image-run", taskTitle: "Images" }),
      "utf8",
    );
    await writeFile(path.join(runRoot, "documents", "doc.md"), "# Doc\n", "utf8");
    await writeFile(
      path.join(runRoot, "documents", "assets", "diagram.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const list = await handleWorkflowRunRequest({
      body: "",
      method: "GET",
      root,
      url: "/api/workflow-runs",
    });
    assert.equal(list.status, 200);
    const runKey = (list.body as { runs: WorkflowRunSummary[] }).runs[0]!.runKey;
    const image = await handleWorkflowRunRequest({
      body: "",
      method: "GET",
      root,
      url: `/api/workflow-runs/${runKey}/assets/${encodeURIComponent("documents/assets/diagram.png")}`,
    });

    assert.equal(image.status, 200);
    assert.ok("contentType" in image);

    if ("contentType" in image) {
      assert.equal(image.contentType, "image/png");
      assert.deepEqual(image.body, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
  });

  it("writes revision traces and accepted review results", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workflow-endpoint-"));
    await createWorkflowRunFixture(root, "demo-run");
    const list = await handleWorkflowRunRequest({
      body: "",
      method: "GET",
      root,
      url: "/api/workflow-runs",
    });
    assert.equal(list.status, 200);
    const listBody = list.body as { runs: WorkflowRunSummary[] };
    const runKey = listBody.runs[0]!.runKey;
    const original = await readFile(
      path.join(root, "demo-run/document/document-draft.md"),
      "utf8",
    );

    const revision = await handleWorkflowRunRequest({
      body: JSON.stringify({
        adapterName: "codex",
        comments: [],
        contextSnapshot: {
          agentProvider: "codex",
          artifactId: "document-draft",
          contextSummary: "",
          createdAt: "2026-07-05T10:00:00.000Z",
          currentPhase: "technical_design",
          id: "snapshot-1",
          linkedSessionIds: ["session-1"],
          priorAcceptedRevisionSummaries: [],
          sessionId: "session-1",
          taskGoal: "Review",
        },
        globalInstruction: "",
        originalMarkdown: original,
        response: {
          addressedComments: [],
          revisedMarkdown: `${original}\nAccepted change.\n`,
          summary: "Accepted change.",
        },
        submittedAt: "2026-07-05T10:01:00.000Z",
      }),
      method: "POST",
      root,
      url: `/api/workflow-runs/${runKey}/artifacts/document-draft/revision`,
    });

    assert.equal(revision.status, 200);
    const revisionBody = revision.body as WorkflowRevisionTraceResult;
    assert.match(revisionBody.latestRevisionRequestPath, /^review\/document-draft\//);

    const accepted = await handleWorkflowRunRequest({
      body: JSON.stringify({
        acceptedAt: "2026-07-05T10:02:00.000Z",
        latestRevisionRequestPath: revisionBody.latestRevisionRequestPath,
        latestRevisionResponsePath: revisionBody.latestRevisionResponsePath,
        response: {
          addressedComments: [],
          revisedMarkdown: `${original}\nAccepted change.\n`,
          summary: "Accepted change.",
        },
      }),
      method: "POST",
      root,
      url: `/api/workflow-runs/${runKey}/artifacts/document-draft/accept`,
    });

    assert.equal(accepted.status, 200);
    assert.equal(
      (accepted.body as { acceptedRevisionPath: string }).acceptedRevisionPath,
      "review/document-draft/revised.md",
    );
    assert.deepEqual(
      (accepted.body as WorkflowReviewResult).sourceWriteBack,
      { status: "not-configured" },
    );
  });

  it("writes an accepted single-file revision back to the original source", async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "dorey-source-writeback-"));
    const sourcePath = path.join(sourceRoot, "design.md");
    await writeFile(sourcePath, "# Original\n", "utf8");
    const launch = await prepareDoreyLaunchWorkspace({
      launchMode: "single-file",
      reviewFilePath: sourcePath,
    });
    const list = await handleWorkflowRunRequest({
      body: "",
      method: "GET",
      root: launch.workflowRoot,
      url: "/api/workflow-runs",
    });
    assert.equal(list.status, 200);
    const run = (list.body as { runs: WorkflowRunSummary[] }).runs[0]!;
    const artifact = run.artifacts.find(
      (item) => item.relativePath === "documents/design.md",
    )!;
    const revisedMarkdown = "# Revised\n";

    const accepted = await handleWorkflowRunRequest({
      body: JSON.stringify({
        acceptedAt: "2026-08-31T05:00:00.000Z",
        latestRevisionRequestPath: "review/request.json",
        latestRevisionResponsePath: "review/response.json",
        response: {
          addressedComments: [],
          revisedMarkdown,
          summary: "Write back source.",
        },
      }),
      method: "POST",
      root: launch.workflowRoot,
      url: `/api/workflow-runs/${run.runKey}/artifacts/${artifact.id}/accept`,
    });

    assert.equal(accepted.status, 200);
    const result = accepted.body as WorkflowReviewResult;
    assert.deepEqual(result.sourceWriteBack, {
      sourcePath: await realpath(sourcePath),
      status: "written",
    });
    assert.equal(await readFile(sourcePath, "utf8"), revisedMarkdown);
    assert.equal(
      await readFile(
        path.join(launch.workflowRoot, launch.runId, "documents", "design.md"),
        "utf8",
      ),
      revisedMarkdown,
    );

    const acceptedAgain = await handleWorkflowRunRequest({
      body: JSON.stringify({
        acceptedAt: "2026-08-31T05:00:01.000Z",
        latestRevisionRequestPath: "review/request-2.json",
        latestRevisionResponsePath: "review/response-2.json",
        response: {
          addressedComments: [],
          revisedMarkdown: "# Revised again\n",
          summary: "Write back source again.",
        },
      }),
      method: "POST",
      root: launch.workflowRoot,
      url: `/api/workflow-runs/${run.runKey}/artifacts/${artifact.id}/accept`,
    });

    assert.equal(acceptedAgain.status, 200);
    assert.equal(await readFile(sourcePath, "utf8"), "# Revised again\n");
  });

  it("rejects accept when the original source changed after review launch", async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "dorey-source-conflict-"));
    const sourcePath = path.join(sourceRoot, "design.md");
    await writeFile(sourcePath, "# Original\n", "utf8");
    const launch = await prepareDoreyLaunchWorkspace({
      launchMode: "single-file",
      reviewFilePath: sourcePath,
    });
    const list = await handleWorkflowRunRequest({
      body: "",
      method: "GET",
      root: launch.workflowRoot,
      url: "/api/workflow-runs",
    });
    assert.equal(list.status, 200);
    const run = (list.body as { runs: WorkflowRunSummary[] }).runs[0]!;
    const artifact = run.artifacts.find(
      (item) => item.relativePath === "documents/design.md",
    )!;
    await writeFile(sourcePath, "# External edit\n", "utf8");

    const accepted = await handleWorkflowRunRequest({
      body: JSON.stringify({
        acceptedAt: "2026-08-31T05:01:00.000Z",
        latestRevisionRequestPath: "review/request.json",
        latestRevisionResponsePath: "review/response.json",
        response: {
          addressedComments: [],
          revisedMarkdown: "# Dorey revision\n",
          summary: "Conflicting write back.",
        },
      }),
      method: "POST",
      root: launch.workflowRoot,
      url: `/api/workflow-runs/${run.runKey}/artifacts/${artifact.id}/accept`,
    });

    assert.equal(Number(accepted.status), 409);
    assert.match((accepted.body as { error: string }).error, /原文件.*已被修改/);
    assert.equal(await readFile(sourcePath, "utf8"), "# External edit\n");
    assert.equal(
      await readFile(
        path.join(launch.workflowRoot, launch.runId, "documents", "design.md"),
        "utf8",
      ),
      "# Original\n",
    );
    await assert.rejects(
      readFile(
        path.join(
          launch.workflowRoot,
          launch.runId,
          "review",
          artifact.id,
          "review-result.json",
        ),
        "utf8",
      ),
    );
  });

  it("writes a folder review artifact back to its matching source file", async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "dorey-folder-writeback-"));
    const sourcePath = path.join(sourceRoot, "guides", "intro.md");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "# Intro\n", "utf8");
    const launch = await prepareDoreyLaunchWorkspace({
      launchMode: "folder",
      reviewFolderPath: sourceRoot,
    });
    const list = await handleWorkflowRunRequest({
      body: "",
      method: "GET",
      root: launch.workflowRoot,
      url: "/api/workflow-runs",
    });
    assert.equal(list.status, 200);
    const run = (list.body as { runs: WorkflowRunSummary[] }).runs[0]!;
    const artifact = run.artifacts.find(
      (item) => item.relativePath === "documents/guides/intro.md",
    )!;

    const accepted = await handleWorkflowRunRequest({
      body: JSON.stringify({
        latestRevisionRequestPath: "review/request.json",
        latestRevisionResponsePath: "review/response.json",
        response: {
          addressedComments: [],
          revisedMarkdown: "# Updated intro\n",
          summary: "Update nested source.",
        },
      }),
      method: "POST",
      root: launch.workflowRoot,
      url: `/api/workflow-runs/${run.runKey}/artifacts/${artifact.id}/accept`,
    });

    assert.equal(accepted.status, 200);
    assert.equal(await readFile(sourcePath, "utf8"), "# Updated intro\n");
  });

  it("writes manual source edit traces through the same revision endpoint", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workflow-manual-edit-"));
    await createWorkflowRunFixture(root, "demo-run");
    const list = await handleWorkflowRunRequest({
      body: "",
      method: "GET",
      root,
      url: "/api/workflow-runs",
    });
    assert.equal(list.status, 200);
    const listBody = list.body as { runs: WorkflowRunSummary[] };
    const runKey = listBody.runs[0]!.runKey;
    const original = await readFile(
      path.join(root, "demo-run/document/document-draft.md"),
      "utf8",
    );

    const revision = await handleWorkflowRunRequest({
      body: JSON.stringify({
        adapterName: "manual",
        comments: [],
        contextSnapshot: {
          agentProvider: "codex",
          artifactId: "document-draft",
          contextSummary: "",
          createdAt: "2026-07-07T10:00:00.000Z",
          currentPhase: "technical_design",
          id: "snapshot-manual",
          linkedSessionIds: ["session-1"],
          priorAcceptedRevisionSummaries: [],
          sessionId: "session-1",
          taskGoal: "Direct source edit",
        },
        globalInstruction: "Manual Markdown source edit in Dorey.",
        originalMarkdown: original,
        response: {
          addressedComments: [
            {
              commentId: "manual-source-edit",
              resolution: "已按源码编辑发布为修订。",
            },
          ],
          revisedMarkdown: original.replace("需求详情", "需求说明"),
          summary: "手动编辑 Markdown 源码。",
        },
        submittedAt: "2026-07-07T10:01:00.000Z",
      }),
      method: "POST",
      root,
      url: `/api/workflow-runs/${runKey}/artifacts/document-draft/revision`,
    });

    assert.equal(revision.status, 200);
    const revisionBody = revision.body as WorkflowRevisionTraceResult;
    assert.match(revisionBody.latestRevisionRequestPath, /^review\/document-draft\//);
    assert.match(
      await readFile(
        path.join(root, "demo-run", revisionBody.latestRevisionRequestPath),
        "utf8",
      ),
      /"adapterName": "manual"/,
    );
  });
});
