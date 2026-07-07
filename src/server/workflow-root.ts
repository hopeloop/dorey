import { existsSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

export type WorkflowRootSource =
  | "explicit"
  | "workspace-default"
  | "workspace-default-empty"
  | "nested-single"
  | "workspace-scan";

export type WorkflowRootResolution = {
  root: string;
  source: WorkflowRootSource;
  candidates: string[];
};

export type ResolveWorkflowRootInput = {
  configuredRoot?: string;
  workspaceRoot: string;
};

const ignoredDirectoryNames = new Set([".git", "node_modules"]);

export function resolveWorkflowRoot({
  configuredRoot,
  workspaceRoot,
}: ResolveWorkflowRootInput): WorkflowRootResolution {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const trimmedConfiguredRoot = configuredRoot?.trim();

  if (trimmedConfiguredRoot) {
    return {
      candidates: [],
      root: path.resolve(resolvedWorkspaceRoot, trimmedConfiguredRoot),
      source: "explicit",
    };
  }

  const defaultRoot = path.join(
    resolvedWorkspaceRoot,
    ".local",
    "ai-coding-workflow",
  );

  if (hasWorkflowRunManifest(defaultRoot)) {
    return {
      candidates: [defaultRoot],
      root: defaultRoot,
      source: "workspace-default",
    };
  }

  const nestedRoots = discoverWorkflowRoots(resolvedWorkspaceRoot).filter(
    (candidate) => path.resolve(candidate) !== path.resolve(defaultRoot),
  );

  if (nestedRoots.length === 1) {
    return {
      candidates: nestedRoots,
      root: nestedRoots[0],
      source: "nested-single",
    };
  }

  if (nestedRoots.length > 1) {
    return {
      candidates: nestedRoots,
      root: resolvedWorkspaceRoot,
      source: "workspace-scan",
    };
  }

  return {
    candidates: [],
    root: defaultRoot,
    source: "workspace-default-empty",
  };
}

export function discoverWorkflowRoots(
  workspaceRoot: string,
  maxDepth = 8,
): string[] {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const roots = new Set<string>();

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth || !isDirectory(dir)) {
      return;
    }

    const candidate = path.join(dir, ".local", "ai-coding-workflow");

    if (hasWorkflowRunManifest(candidate)) {
      roots.add(candidate);
    }

    for (const entry of readDirectorySafe(dir)) {
      if (!entry.isDirectory() || ignoredDirectoryNames.has(entry.name)) {
        continue;
      }

      if (entry.name === ".local") {
        continue;
      }

      walk(path.join(dir, entry.name), depth + 1);
    }
  }

  walk(resolvedWorkspaceRoot, 0);

  return [...roots].sort();
}

export function hasWorkflowRunManifest(root: string, maxDepth = 4): boolean {
  const resolvedRoot = path.resolve(root);

  function walk(dir: string, depth: number): boolean {
    if (depth > maxDepth || !isDirectory(dir)) {
      return false;
    }

    for (const entry of readDirectorySafe(dir)) {
      const entryPath = path.join(dir, entry.name);

      if (entry.isFile() && entry.name === "workflow-run.json") {
        return true;
      }

      if (entry.isDirectory() && !ignoredDirectoryNames.has(entry.name)) {
        if (walk(entryPath, depth + 1)) {
          return true;
        }
      }
    }

    return false;
  }

  return walk(resolvedRoot, 0);
}

function isDirectory(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function readDirectorySafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
