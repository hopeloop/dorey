import type { AgentProvider, LauncherContext } from "../contracts/index.js";

export type ReviewWorkspaceBootstrap = {
  currentAgentProvider?: AgentProvider;
  currentLauncherContext?: LauncherContext;
  currentSessionLabel?: string;
  launchMode?: "single-file" | "folder" | "demo";
  previewOnly?: boolean;
};

declare const __REVIEW_WORKSPACE_BOOTSTRAP__:
  | ReviewWorkspaceBootstrap
  | undefined;

export function getReviewWorkspaceBootstrap(): ReviewWorkspaceBootstrap {
  if (typeof __REVIEW_WORKSPACE_BOOTSTRAP__ === "undefined") {
    return {};
  }

  return __REVIEW_WORKSPACE_BOOTSTRAP__;
}
