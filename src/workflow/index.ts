export { workflowStages, type Artifact, type WorkflowStage } from "../contracts/artifact.js";
export {
  generateArtifact,
  type ArtifactIdFactory,
  type GenerateArtifactOptions,
  type MarkdownRenderer,
} from "./generator.js";
export {
  getWorkflowStageSpec,
  WORKFLOW_STAGE_SPECS,
} from "./stages.js";
export { STAGE_MARKDOWN_SECTIONS } from "./stage-sections.js";
export type {
  GenerateArtifactInput,
  GenerateArtifactResult,
  WorkflowStageSpec,
  WorkflowTrace,
} from "./types.js";
