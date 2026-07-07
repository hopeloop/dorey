import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  workflowStages,
  type Artifact,
  type WorkflowStage,
} from "../src/contracts/artifact.js";
import {
  getWorkflowStageSpec,
  WORKFLOW_STAGE_SPECS,
} from "../src/workflow/stages.js";
import { generateArtifact } from "../src/workflow/generator.js";
import {
  buildDemoTaskArtifacts,
  DEMO_ARTIFACT_FILE_NAMES,
  DEMO_CONTEXT_FILE_NAMES,
  DEMO_TASK,
} from "../src/demo/demo-task.js";

const expectedStages: WorkflowStage[] = [
  "requirement_orientation",
  "system_modeling",
  "technical_design",
  "coding_plan",
  "verification",
  "debug",
  "asset_feedback",
];

const expectedSections: Record<WorkflowStage, string[]> = {
  requirement_orientation: [
    "# 需求定向",
    "## 本期目标",
    "## 做什么",
    "## 不做什么",
    "## 关键产品问题",
    "## 待确认问题",
    "## 人工确认点",
  ],
  system_modeling: [
    "# 现状建模",
    "## 当前链路",
    "## 关键入口",
    "## 相关 repo / 模块",
    "## 上下游依赖",
    "## 当前系统约束",
    "## 仍需回到代码确认的问题",
  ],
  technical_design: [
    "# 技术方案",
    "## 背景",
    "## 目标",
    "## 方案概述",
    "## 详细设计",
    "## 影响面",
    "## 风险与兼容性",
    "## 验证方案",
    "## 人工决策点",
  ],
  coding_plan: [
    "# Coding Plan",
    "## 执行原则",
    "## 涉及 repo",
    "## 改动步骤",
    "## 文件级计划",
    "## Checkpoint",
    "## 完成定义",
  ],
  verification: [
    "# 验证闭环",
    "## UT",
    "## Smoke",
    "## 联调",
    "## 日志与证据",
    "## 回归范围",
    "## 验证通过标准",
  ],
  debug: [
    "# Debug 收敛",
    "## 失败现象",
    "## 首查路径",
    "## 证据来源",
    "## 排查顺序",
    "## 可能根因",
    "## 修复后验证",
  ],
  asset_feedback: [
    "# 资产回流",
    "## Context Patch 建议",
    "## Skill / Workflow Patch 建议",
    "## Eval Case 建议",
    "## 不应沉淀的内容",
    "## 需要人工审核的内容",
  ],
};

describe("artifact contract", () => {
  it("defines the exact workflow stage union used by artifacts", () => {
    assert.deepEqual(workflowStages, expectedStages);

    const artifact: Artifact = {
      id: "task-1-debug",
      stage: "debug",
      title: "Debug 收敛",
      markdown: "# Debug 收敛\n",
      metadata: {
        taskId: "task-1",
        sourceRefs: ["smoke-log.md"],
        createdAt: "2026-07-04T09:00:00.000Z",
        updatedAt: "2026-07-04T09:00:00.000Z",
      },
    };

    assert.equal(artifact.stage, "debug");
  });
});

describe("workflow stage specs", () => {
  it("provides one prompt-backed spec per stage", () => {
    assert.equal(WORKFLOW_STAGE_SPECS.length, expectedStages.length);

    for (const stage of expectedStages) {
      const spec = getWorkflowStageSpec(stage);
      assert.equal(spec.stage, stage);
      assert.ok(spec.title.length > 0);
      assert.ok(spec.description.length > 0);
      assert.ok(spec.expectedInputs.length > 0);
      assert.ok(spec.expectedOutputs.length > 0);
      assert.ok(spec.promptTemplate.includes("Markdown artifact"));
      assert.ok(spec.promptTemplate.includes(expectedSections[stage][0]));
    }
  });
});

describe("artifact generator", () => {
  it("generates stable markdown sections and a trace for a stage", () => {
    const previousArtifact: Artifact = {
      id: "demo-task-requirement_orientation",
      stage: "requirement_orientation",
      title: "需求定向",
      markdown: "# 需求定向\n",
    };

    const result = generateArtifact(
      {
        taskId: "demo-task",
        taskTitle: "配置快照发布 / 多环境功能开关改造",
        taskDescription:
          "理解多个应用模块的配置快照发布链路，确认可复用路径，并输出技术方案。",
        stage: "system_modeling",
        contextFiles: [
          {
            name: "domain-service-map.md",
            content: "应用模块发布链路会经过配置快照服务、配置发布服务和下游 RPC。",
          },
        ],
        previousArtifacts: [previousArtifact],
        humanNotes: ["先确认不同应用模块是否共享发布入口。"],
      },
      {
        now: new Date("2026-07-04T09:00:00.000Z"),
        idFactory: ({ taskId, stage }) => `${taskId}-${stage}`,
      },
    );

    assert.equal(result.artifact.id, "demo-task-system_modeling");
    assert.equal(result.artifact.stage, "system_modeling");
    assert.equal(result.artifact.metadata?.taskId, "demo-task");
    assert.deepEqual(result.artifact.metadata?.sourceRefs, [
      "domain-service-map.md",
      "demo-task-requirement_orientation",
    ]);

    for (const section of expectedSections.system_modeling) {
      assert.ok(result.artifact.markdown.includes(section), section);
    }
    assert.ok(result.artifact.markdown.includes("配置快照发布 / 多环境功能开关改造"));
    assert.ok(result.artifact.markdown.includes("domain-service-map.md"));
    assert.ok(result.artifact.markdown.includes("先确认不同应用模块是否共享发布入口。"));

    assert.equal(result.trace.taskId, "demo-task");
    assert.equal(result.trace.stage, "system_modeling");
    assert.deepEqual(result.trace.contextUsed, ["domain-service-map.md"]);
    assert.deepEqual(result.trace.previousArtifactsUsed, [
      "demo-task-requirement_orientation",
    ]);
    assert.deepEqual(result.trace.humanNotesUsed, [
      "先确认不同应用模块是否共享发布入口。",
    ]);
    assert.equal(result.trace.outputArtifactId, result.artifact.id);
    assert.equal(result.trace.createdAt, "2026-07-04T09:00:00.000Z");
  });

  it("can build the complete demo task artifact set", () => {
    const demo = buildDemoTaskArtifacts({
      now: new Date("2026-07-04T09:00:00.000Z"),
    });

    assert.equal(DEMO_TASK.title, "配置快照发布 / 多环境功能开关改造");
    assert.deepEqual(DEMO_CONTEXT_FILE_NAMES, [
      "domain-service-map.md",
      "domain-end-to-end-flow.md",
      "repo-code-map.md",
      "repo-for-codegen.md",
      "repo-for-debug.md",
    ]);
    assert.deepEqual(
      demo.files.map((file) => file.name),
      [...DEMO_ARTIFACT_FILE_NAMES, "trace.json"],
    );
    assert.equal(demo.artifacts.length, 7);
    assert.equal(demo.trace.entries.length, 7);
    assert.equal(demo.trace.entries[0]?.stage, "requirement_orientation");
    assert.equal(demo.trace.entries[6]?.stage, "asset_feedback");

    for (const artifact of demo.artifacts) {
      const stage = artifact.stage as keyof typeof expectedSections;

      assert.ok(artifact.markdown.startsWith(expectedSections[stage][0]));
      assert.ok(artifact.metadata?.sourceRefs?.length);
    }
  });
});
