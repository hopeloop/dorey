import type { Artifact } from "../contracts/index.js";
import technicalDesignMarkdown from "../../samples/technical-design.md?raw";

export const initialArtifacts: Artifact[] = [
  {
    id: "sample-technical-design",
    stage: "technical_design",
    title: "技术方案：配置快照发布",
    markdown: technicalDesignMarkdown,
    metadata: {
      taskId: "ai-coding-pipeline-demo",
      sourceRefs: ["samples/technical-design.md"],
      createdAt: "2026-07-04T09:00:00.000Z",
    },
  },
];

export function cloneInitialArtifacts(): Artifact[] {
  return initialArtifacts.map((artifact) => ({
    ...artifact,
    metadata: artifact.metadata ? { ...artifact.metadata } : undefined,
  }));
}
