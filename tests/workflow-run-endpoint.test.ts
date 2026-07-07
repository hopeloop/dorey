import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { handleWorkflowRunRequest } from "../src/server/workflow-run-endpoint.js";
import type {
  WorkflowArtifactContent,
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
