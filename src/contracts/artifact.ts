export const workflowStages = [
  "requirement_orientation",
  "system_modeling",
  "technical_design",
  "coding_plan",
  "verification",
  "debug",
  "asset_feedback",
] as const;

export type WorkflowStage = (typeof workflowStages)[number];

export type ArtifactWorkflowMetadata = {
  artifactId: string;
  group: "scratch" | "document" | "execution" | "metadata";
  kind: "markdown" | "html" | "plantuml" | "json";
  parentArtifactId?: string;
  relativePath: string;
  reviewable: boolean;
  runId: string;
  runKey: string;
  warning?: string;
};

export type Artifact = {
  id: string;
  stage: WorkflowStage | string;
  title: string;
  markdown: string;
  metadata?: {
    taskId?: string;
    sourceRefs?: string[];
    createdAt?: string;
    updatedAt?: string;
    workflow?: ArtifactWorkflowMetadata;
  };
};
