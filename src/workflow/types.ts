import type { Artifact, WorkflowStage } from "../contracts/artifact.js";

export type WorkflowStageSpec = {
  stage: WorkflowStage;
  title: string;
  description: string;
  expectedInputs: string[];
  expectedOutputs: string[];
  humanCheckpoint?: {
    required: boolean;
    description: string;
  };
  promptTemplate: string;
};

export type GenerateArtifactInput = {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  stage: WorkflowStage;
  contextFiles?: {
    name: string;
    content: string;
  }[];
  previousArtifacts?: Artifact[];
  humanNotes?: string[];
};

export type WorkflowTrace = {
  traceId: string;
  taskId: string;
  stage: WorkflowStage;
  inputSummary: string;
  contextUsed: string[];
  previousArtifactsUsed: string[];
  humanNotesUsed: string[];
  outputArtifactId: string;
  createdAt: string;
};

export type GenerateArtifactResult = {
  artifact: Artifact;
  trace: WorkflowTrace;
};
