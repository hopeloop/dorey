import type { Artifact, WorkflowStage } from "../contracts/artifact.js";
import type {
  GenerateArtifactInput,
  GenerateArtifactResult,
} from "./types.js";
import { getWorkflowStageSpec } from "./stages.js";
import { renderArtifactMarkdown } from "./stage-renderers.js";

export type ArtifactIdFactory = (input: {
  taskId: string;
  stage: WorkflowStage;
}) => string;

export type MarkdownRenderer = (input: GenerateArtifactInput) => string;

export type GenerateArtifactOptions = {
  now?: Date;
  idFactory?: ArtifactIdFactory;
  renderer?: MarkdownRenderer;
};

const defaultIdFactory: ArtifactIdFactory = ({ taskId, stage }) =>
  `${taskId}-${stage}`;

export function generateArtifact(
  input: GenerateArtifactInput,
  options: GenerateArtifactOptions = {},
): GenerateArtifactResult {
  const createdAt = (options.now ?? new Date()).toISOString();
  const spec = getWorkflowStageSpec(input.stage);
  const artifactId = (options.idFactory ?? defaultIdFactory)({
    taskId: input.taskId,
    stage: input.stage,
  });
  const renderer = options.renderer ?? renderArtifactMarkdown;
  const contextUsed = input.contextFiles?.map((file) => file.name) ?? [];
  const previousArtifactsUsed =
    input.previousArtifacts?.map((artifact) => artifact.id) ?? [];
  const humanNotesUsed = [...(input.humanNotes ?? [])];
  const artifact: Artifact = {
    id: artifactId,
    stage: input.stage,
    title: spec.title,
    markdown: renderer(input),
    metadata: {
      taskId: input.taskId,
      sourceRefs: [...contextUsed, ...previousArtifactsUsed],
      createdAt,
      updatedAt: createdAt,
    },
  };

  return {
    artifact,
    trace: {
      traceId: `${artifactId}-trace`,
      taskId: input.taskId,
      stage: input.stage,
      inputSummary: [
        `Task "${input.taskTitle}" (${input.taskId})`,
        `stage ${input.stage}`,
        `${contextUsed.length} context file(s)`,
        `${previousArtifactsUsed.length} previous artifact(s)`,
        `${humanNotesUsed.length} human note(s)`,
      ].join("; "),
      contextUsed,
      previousArtifactsUsed,
      humanNotesUsed,
      outputArtifactId: artifact.id,
      createdAt,
    },
  };
}
