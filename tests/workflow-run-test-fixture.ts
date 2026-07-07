import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type WorkflowRunFixture = {
  manifestPath: string;
  root: string;
  runRoot: string;
};

export async function createWorkflowRunFixture(
  root?: string,
  runId = "ai-coding-workflow-demo-20260704T170733Z",
): Promise<WorkflowRunFixture> {
  const fixtureRoot =
    root ?? (await mkdtemp(path.join(tmpdir(), "dorey-workflow-runs-")));
  const runRoot = path.join(fixtureRoot, runId);

  await mkdir(path.join(runRoot, "scratch/diagrams"), { recursive: true });
  await mkdir(path.join(runRoot, "document"), { recursive: true });
  await mkdir(path.join(runRoot, "md"), { recursive: true });
  await mkdir(path.join(runRoot, "review"), { recursive: true });

  const manifest = {
    artifacts: {
      changeConvergence: "scratch/03-change-convergence.md",
      changeConvergenceDiagrams: [
        "scratch/diagrams/change-convergence-target-flow.puml",
        "scratch/diagrams/change-convergence-validation-flow.puml",
      ],
      codingPlan: "md/coding-plan.md",
      convergenceStatus: "scratch/convergence-status.json",
      currentStateDiagrams: [
        "scratch/diagrams/current-state-entry-flow.puml",
        "scratch/diagrams/current-state-persistence-flow.puml",
      ],
      currentStateModeling: "scratch/02-current-state-modeling.md",
      documentDraft: "document/document-draft.md",
      documentManifest: "document/document-manifest.json",
      openQuestions: "scratch/open-questions.md",
      requirementOrientation: "scratch/01-requirement-orientation.md",
      trace: "trace.json",
      verificationPlan: "md/verification-plan.md",
    },
    review: {
      root: "review",
    },
    runId,
    taskTitle: "配置快照发布 / 多环境功能开关改造",
  };

  await writeFile(
    path.join(runRoot, "workflow-run.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(runRoot, "scratch/01-requirement-orientation.md"),
    "# 需求定向\n",
    "utf8",
  );
  await writeFile(
    path.join(runRoot, "scratch/02-current-state-modeling.md"),
    "# 现状建模\n",
    "utf8",
  );
  await writeFile(
    path.join(runRoot, "scratch/03-change-convergence.md"),
    "# 改动收敛\n",
    "utf8",
  );
  await writeFile(
    path.join(runRoot, "scratch/open-questions.md"),
    "# 待确认问题\n",
    "utf8",
  );
  await writeFile(
    path.join(runRoot, "scratch/convergence-status.json"),
    "{}\n",
    "utf8",
  );
  await writeFile(
    path.join(runRoot, "scratch/diagrams/current-state-entry-flow.puml"),
    "@startuml\nA -> B: entry\n@enduml\n",
    "utf8",
  );
  await writeFile(
    path.join(runRoot, "scratch/diagrams/current-state-persistence-flow.puml"),
    "@startuml\nB -> C: persist\n@enduml\n",
    "utf8",
  );
  await writeFile(
    path.join(runRoot, "scratch/diagrams/change-convergence-target-flow.puml"),
    "@startuml\nC -> D: target\n@enduml\n",
    "utf8",
  );
  await writeFile(
    path.join(runRoot, "scratch/diagrams/change-convergence-validation-flow.puml"),
    "@startuml\nD -> E: validate\n@enduml\n",
    "utf8",
  );
  await writeFile(
    path.join(runRoot, "document/document-draft.md"),
    "# 技术方案：配置快照发布\n\n## 需求详情\n\n当前 demo 用于本地审阅闭环验证。\n",
    "utf8",
  );
  await writeFile(
    path.join(runRoot, "document/document-manifest.json"),
    "{}\n",
    "utf8",
  );
  await writeFile(
    path.join(runRoot, "md/coding-plan.md"),
    "# Coding Plan\n",
    "utf8",
  );
  await writeFile(
    path.join(runRoot, "md/verification-plan.md"),
    "# Verification Plan\n",
    "utf8",
  );
  await writeFile(path.join(runRoot, "trace.json"), "{}\n", "utf8");

  return {
    manifestPath: path.join(runRoot, "workflow-run.json"),
    root: fixtureRoot,
    runRoot,
  };
}
