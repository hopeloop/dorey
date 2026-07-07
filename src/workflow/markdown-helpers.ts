import type { Artifact } from "../contracts/artifact.js";
import type { GenerateArtifactInput } from "./types.js";

export function bulletList(items: readonly string[], fallback: string): string {
  if (items.length === 0) {
    return `- ${fallback}`;
  }

  return items.map((item) => `- ${item}`).join("\n");
}

export function numberedList(items: readonly string[], fallback: string): string {
  if (items.length === 0) {
    return `1. ${fallback}`;
  }

  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

export function compactText(value: string, maxLength = 220): string {
  const compacted = value.replace(/\s+/g, " ").trim();

  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, maxLength - 3)}...`;
}

export function formatTask(input: GenerateArtifactInput): string {
  return [
    `- 任务：${input.taskTitle}`,
    `- Task ID：${input.taskId}`,
    `- 任务描述：${compactText(input.taskDescription, 360)}`,
  ].join("\n");
}

export function formatContextFiles(
  contextFiles: NonNullable<GenerateArtifactInput["contextFiles"]> = [],
): string {
  if (contextFiles.length === 0) {
    return "- 暂无输入的 context 文件，需要人工补充 source refs。";
  }

  return contextFiles
    .map((file) => `- ${file.name}：${compactText(file.content)}`)
    .join("\n");
}

export function formatPreviousArtifacts(
  artifacts: readonly Artifact[] = [],
): string {
  if (artifacts.length === 0) {
    return "- 暂无前序 artifact，本阶段应只依赖任务描述和 context。";
  }

  return artifacts
    .map((artifact) => `- ${artifact.id}（${artifact.stage}）：${artifact.title}`)
    .join("\n");
}

export function formatHumanNotes(notes: readonly string[] = []): string {
  return bulletList(notes, "暂无人工补充说明；需要 reviewer 在本节确认是否补充。");
}
