import type { WorkflowStage } from "../contracts/artifact.js";
import type { WorkflowStageSpec } from "./types.js";
import { STAGE_MARKDOWN_SECTIONS } from "./stage-sections.js";

type StageSpecSeed = Omit<WorkflowStageSpec, "promptTemplate"> & {
  promptFocus: string[];
};

const stageSpecSeeds: StageSpecSeed[] = [
  {
    stage: "requirement_orientation",
    title: "需求定向",
    description: "明确本期需求、关注点、做什么、不做什么和待确认问题。",
    expectedInputs: ["PRD 或任务描述", "评审记录", "人工补充说明", "domain context"],
    expectedOutputs: ["本期目标", "范围边界", "关键产品问题", "待确认问题", "人工确认点"],
    humanCheckpoint: {
      required: true,
      description: "在进入现状建模前确认需求边界和不做事项。",
    },
    promptFocus: [
      "先给出本期目标，再拆出做什么和不做什么。",
      "把业务问题写成后续可回到代码或链路确认的问题。",
      "待确认问题必须能被人类 reviewer 逐条处理。",
    ],
  },
  {
    stage: "system_modeling",
    title: "现状建模",
    description: "梳理当前系统怎么跑、入口在哪里、链路是什么、上下游是谁。",
    expectedInputs: ["需求定向 artifact", "domain service map", "repo code map", "链路或日志证据"],
    expectedOutputs: ["当前链路", "关键入口", "相关模块", "上下游依赖", "系统约束"],
    humanCheckpoint: {
      required: true,
      description: "在进入技术方案前确认当前系统模型没有把猜测当事实。",
    },
    promptFocus: [
      "优先描述已知链路和入口，避免把假设写成结论。",
      "把 repo、模块、RPC、配置和数据流分开列清楚。",
      "保留仍需回代码确认的问题，避免在本阶段提前设计。",
    ],
  },
  {
    stage: "technical_design",
    title: "技术方案",
    description: "输出可评审的人类阅读友好方案，包括目标、方案、影响面、风险和验证方式。",
    expectedInputs: ["需求定向 artifact", "现状建模 artifact", "PRD", "技术评审记录"],
    expectedOutputs: ["方案概述", "详细设计", "影响面", "风险与兼容性", "验证方案"],
    humanCheckpoint: {
      required: true,
      description: "在拆 coding plan 前确认方案方向和关键取舍。",
    },
    promptFocus: [
      "从背景和目标开始，确保方案能被非当前实现者 review。",
      "详细设计要能映射到后续文件级计划。",
      "风险、兼容性和验证方案必须和影响面对应。",
    ],
  },
  {
    stage: "coding_plan",
    title: "Coding Plan",
    description: "把技术方案拆成可执行步骤，包括 repo、文件、改动顺序和检查点。",
    expectedInputs: ["技术方案 artifact", "repo code map", "repo-for-codegen context"],
    expectedOutputs: ["执行原则", "涉及 repo", "改动步骤", "文件级计划", "checkpoint", "完成定义"],
    humanCheckpoint: {
      required: true,
      description: "在动代码前确认改动顺序、检查点和完成定义。",
    },
    promptFocus: [
      "计划要按可执行顺序展开，并标注每一步的检查点。",
      "文件级计划要说明为什么碰这些文件，而不是只列文件名。",
      "完成定义必须能被测试、构建或 smoke 证据验证。",
    ],
  },
  {
    stage: "verification",
    title: "验证闭环",
    description: "定义 UT、smoke、日志、联调、回归验证路径。",
    expectedInputs: ["coding plan artifact", "测试策略", "日志和联调环境说明"],
    expectedOutputs: ["UT", "Smoke", "联调", "日志与证据", "回归范围", "验证通过标准"],
    humanCheckpoint: {
      required: false,
      description: "需要 reviewer 确认 smoke case 是否覆盖关键业务路径。",
    },
    promptFocus: [
      "验证路径必须覆盖单测、smoke、联调、日志证据和回归范围。",
      "写清楚通过标准，避免只有测试命令没有证据要求。",
      "失败时要能自然衔接 debug 收敛阶段。",
    ],
  },
  {
    stage: "debug",
    title: "Debug 收敛",
    description: "定义失败时如何基于日志、错误、配置、测试数据和代码路径定位根因。",
    expectedInputs: ["验证失败现象", "日志", "配置", "测试租户", "repo-for-debug context"],
    expectedOutputs: ["失败现象", "首查路径", "证据来源", "排查顺序", "可能根因", "修复后验证"],
    humanCheckpoint: {
      required: false,
      description: "当根因影响方案边界或数据口径时再回到人工确认。",
    },
    promptFocus: [
      "先描述失败现象，再列首查路径和证据来源。",
      "排查顺序要从最高信号、最低成本的证据开始。",
      "可能根因必须能回连到日志、配置、测试数据或代码路径。",
    ],
  },
  {
    stage: "asset_feedback",
    title: "资产回流",
    description: "将任务结束后的经验拆成 context patch、skill patch、eval case 建议。",
    expectedInputs: ["完整任务 artifacts", "最终验证证据", "debug 结论", "人工复盘 notes"],
    expectedOutputs: ["Context Patch 建议", "Skill / Workflow Patch 建议", "Eval Case 建议", "审核项"],
    humanCheckpoint: {
      required: true,
      description: "沉淀为长期资产前必须人工审核，避免把一次性现象写成通用规则。",
    },
    promptFocus: [
      "区分应该沉淀的 context、workflow/skill 和 eval case。",
      "显式列出不应沉淀的内容，避免污染长期知识。",
      "所有资产建议都要保留人工审核口径。",
    ],
  },
];

function buildPromptTemplate(seed: StageSpecSeed): string {
  const sections = STAGE_MARKDOWN_SECTIONS[seed.stage]
    .map((section) => `- ${section}`)
    .join("\n");
  const focus = seed.promptFocus.map((item) => `- ${item}`).join("\n");

  return [
    `You are producing a stable Markdown artifact for the "${seed.title}" workflow stage.`,
    "Use only the task description, context files, previous artifacts, and human notes provided in the input.",
    "Output a Markdown artifact with exactly these headings in this order:",
    sections,
    "Focus requirements:",
    focus,
    "Keep the artifact evidence-oriented, reviewable by humans, and ready for an agent to revise later.",
  ].join("\n");
}

export const WORKFLOW_STAGE_SPECS: WorkflowStageSpec[] = stageSpecSeeds.map(
  (seed) => ({
    ...seed,
    promptTemplate: buildPromptTemplate(seed),
  }),
);

export function getWorkflowStageSpec(stage: WorkflowStage): WorkflowStageSpec {
  const spec = WORKFLOW_STAGE_SPECS.find((candidate) => candidate.stage === stage);

  if (!spec) {
    throw new Error(`Unknown workflow stage: ${stage}`);
  }

  return spec;
}
