import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { resolveWorkflowRoot } from "../src/server/workflow-root.js";

const temporaryRoots: string[] = [];

describe("workflow root resolver", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("uses the workspace .local/ai-coding-workflow root when it has runs", async () => {
    const workspaceRoot = await makeTemporaryWorkspace();
    const defaultWorkflowRoot = path.join(
      workspaceRoot,
      ".local",
      "ai-coding-workflow",
    );
    await createWorkflowRun(defaultWorkflowRoot, "run-a");
    await createWorkflowRun(
      path.join(workspaceRoot, "domain", ".local", "ai-coding-workflow"),
      "run-b",
    );

    const resolution = resolveWorkflowRoot({ workspaceRoot });

    assert.equal(resolution.root, defaultWorkflowRoot);
    assert.equal(resolution.source, "workspace-default");
    assert.deepEqual(resolution.candidates, [defaultWorkflowRoot]);
  });

  it("uses a single nested domain workflow root when the workspace default is empty", async () => {
    const workspaceRoot = await makeTemporaryWorkspace();
    const domainWorkflowRoot = path.join(
      workspaceRoot,
      "domain-guides",
      "sample_config_platform",
      "feature-flag-rollout",
      ".local",
      "ai-coding-workflow",
    );
    await createWorkflowRun(domainWorkflowRoot, "20260705-config-rollout-smoke");

    const resolution = resolveWorkflowRoot({ workspaceRoot });

    assert.equal(resolution.root, domainWorkflowRoot);
    assert.equal(resolution.source, "nested-single");
    assert.deepEqual(resolution.candidates, [domainWorkflowRoot]);
  });

  it("uses the workspace as a scan root when multiple nested workflow roots exist", async () => {
    const workspaceRoot = await makeTemporaryWorkspace();
    const firstWorkflowRoot = path.join(
      workspaceRoot,
      "domain-a",
      ".local",
      "ai-coding-workflow",
    );
    const secondWorkflowRoot = path.join(
      workspaceRoot,
      "domain-b",
      ".local",
      "ai-coding-workflow",
    );
    await createWorkflowRun(firstWorkflowRoot, "run-a");
    await createWorkflowRun(secondWorkflowRoot, "run-b");

    const resolution = resolveWorkflowRoot({ workspaceRoot });

    assert.equal(resolution.root, workspaceRoot);
    assert.equal(resolution.source, "workspace-scan");
    assert.deepEqual(resolution.candidates, [firstWorkflowRoot, secondWorkflowRoot]);
  });

  it("keeps explicit AI_CODING_WORKFLOW_ROOT configuration authoritative", async () => {
    const workspaceRoot = await makeTemporaryWorkspace();
    const configuredRoot = "custom-workflow-root";

    const resolution = resolveWorkflowRoot({ configuredRoot, workspaceRoot });

    assert.equal(resolution.root, path.join(workspaceRoot, configuredRoot));
    assert.equal(resolution.source, "explicit");
    assert.deepEqual(resolution.candidates, []);
  });
});

async function makeTemporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "dorey-workflow-root-"));
  temporaryRoots.push(root);

  return root;
}

async function createWorkflowRun(workflowRoot: string, runId: string): Promise<void> {
  const runRoot = path.join(workflowRoot, runId);
  await mkdir(runRoot, { recursive: true });
  await writeFile(
    path.join(runRoot, "workflow-run.json"),
    JSON.stringify({
      artifacts: {},
      runId,
      schemaVersion: "ai-coding-workflow.workflow-run.v1",
      taskTitle: runId,
    }),
    "utf8",
  );
}
