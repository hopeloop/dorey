import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  workflowStages,
  type Artifact,
  type WorkflowStage,
} from "../contracts/artifact.js";
import {
  generateArtifact,
  type GenerateArtifactOptions,
} from "../workflow/generator.js";
import type { GenerateArtifactInput, WorkflowTrace } from "../workflow/types.js";

export type DemoTask = {
  id: string;
  title: string;
  description: string;
};

export type DemoTraceDocument = {
  task: DemoTask;
  generatedAt: string;
  stages: WorkflowStage[];
  contextFiles: string[];
  entries: WorkflowTrace[];
};

export type DemoOutputFile = {
  name: string;
  content: string;
};

export type DemoBuildResult = {
  task: DemoTask;
  contextFiles: NonNullable<GenerateArtifactInput["contextFiles"]>;
  artifacts: Artifact[];
  trace: DemoTraceDocument;
  files: DemoOutputFile[];
};

export type DemoBuildOptions = Pick<GenerateArtifactOptions, "now"> & {
  projectRoot?: string;
};

export const DEMO_TASK: DemoTask = {
  id: "demo-task",
  title: "配置快照发布 / 多环境功能开关改造",
  description:
    "本任务涉及多个应用模块的配置快照发布链路。需要从 PRD、评审记录、现有技术方案和 domain context 出发，理解当前不同应用模块的发布链路，确认可复用路径，输出技术方案和 coding plan，并在实现后通过 smoke case 验证。如果 smoke 失败，需要基于日志、超时配置、测试租户和链路证据收敛根因。任务完成后，需要生成 context patch、skill patch 和 eval case 建议。",
};

export const DEMO_CONTEXT_FILES = [
  {
    name: "domain-service-map.md",
    content:
      "配置评审入口负责接收用户请求、汇总模块状态，并调用配置控制服务生成或读取配置快照。",
  },
  {
    name: "domain-end-to-end-flow.md",
    content:
      "端到端流程从用户提交配置草稿开始，经由评审入口、配置控制服务、快照存储和发布回显完成闭环。",
  },
  {
    name: "repo-code-map.md",
    content:
      "核心代码分布在 server launch、workflow loader、review queue 和 web editor 四个模块。",
  },
  {
    name: "repo-for-codegen.md",
    content:
      "编码阶段优先修改 contract、loader、server endpoint，再更新 UI 状态与回归测试。",
  },
  {
    name: "repo-for-debug.md",
    content:
      "排障时优先检查 request payload、workflow-run.json、review 写回目录和浏览器 network 结果。",
  },
] as const satisfies NonNullable<GenerateArtifactInput["contextFiles"]>;

export const DEMO_CONTEXT_FILE_NAMES = DEMO_CONTEXT_FILES.map(
  (file) => file.name,
);

export const DEMO_ARTIFACT_FILE_NAMES = [
  "01-requirement-orientation.md",
  "02-system-modeling.md",
  "03-technical-design.md",
  "04-coding-plan.md",
  "05-verification.md",
  "06-debug.md",
  "07-asset-feedback.md",
] as const;

const demoHumanNotes: Record<WorkflowStage, string[]> = {
  requirement_orientation: [
    "先确认本期只覆盖配置快照发布链路，不扩展到配置生成策略。",
    "需要 reviewer 确认可复用路径和不做事项。",
  ],
  system_modeling: [
    "现状建模必须区分多个应用模块的发布入口、字段差异和下游 RPC。",
  ],
  technical_design: [
    "技术方案需要把共用发布能力和模块差异适配拆开。",
  ],
  coding_plan: [
    "Coding plan 需要标注 repo、文件级落点、改动顺序和 checkpoint。",
  ],
  verification: [
    "Smoke case 至少覆盖一个共用链路成功场景和一个模块差异场景。",
  ],
  debug: [
    "Smoke 失败时先看日志、超时配置、测试租户和下游 RPC，再调整代码。",
  ],
  asset_feedback: [
    "资产回流只沉淀可复用经验，不沉淀一次性租户、requestId 或临时配置。",
  ],
};

export function buildDemoTaskArtifacts(
  options: DemoBuildOptions = {},
): DemoBuildResult {
  const createdAt = (options.now ?? new Date()).toISOString();
  const contextFiles = loadDemoContextFiles(options.projectRoot ?? process.cwd());
  const artifacts: Artifact[] = [];
  const entries: WorkflowTrace[] = [];
  const files: DemoOutputFile[] = [];

  workflowStages.forEach((stage, index) => {
    const result = generateArtifact(
      {
        taskId: DEMO_TASK.id,
        taskTitle: DEMO_TASK.title,
        taskDescription: DEMO_TASK.description,
        stage,
        contextFiles,
        previousArtifacts: artifacts,
        humanNotes: demoHumanNotes[stage],
      },
      {
        now: options.now,
      },
    );

    artifacts.push(result.artifact);
    entries.push(result.trace);
    files.push({
      name: DEMO_ARTIFACT_FILE_NAMES[index],
      content: result.artifact.markdown,
    });
  });

  const trace: DemoTraceDocument = {
    task: DEMO_TASK,
    generatedAt: createdAt,
    stages: [...workflowStages],
    contextFiles: [...DEMO_CONTEXT_FILE_NAMES],
    entries,
  };

  files.push({
    name: "trace.json",
    content: `${JSON.stringify(trace, null, 2)}\n`,
  });

  return {
    task: DEMO_TASK,
    contextFiles,
    artifacts,
    trace,
    files,
  };
}

export function writeDemoTaskArtifacts(
  outputDir = path.join(process.cwd(), "generated/demo-task"),
  options: DemoBuildOptions = {},
): DemoBuildResult {
  const result = buildDemoTaskArtifacts(options);
  mkdirSync(outputDir, { recursive: true });

  for (const file of result.files) {
    writeFileSync(path.join(outputDir, file.name), file.content, "utf8");
  }

  return result;
}

function loadDemoContextFiles(
  _projectRoot: string,
): NonNullable<GenerateArtifactInput["contextFiles"]> {
  return DEMO_CONTEXT_FILES.map((file) => ({ ...file }));
}
