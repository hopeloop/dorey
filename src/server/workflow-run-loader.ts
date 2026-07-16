import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type {
  BatchRevisionResponse,
  ContextSnapshot,
  QueuedComment,
  RevisionSource,
} from "../contracts/index.js";
import { extractMarkdownH1 } from "../shared/markdown-document.js";

export type WorkflowArtifactGroup =
  | "scratch"
  | "document"
  | "execution"
  | "metadata";

export type WorkflowArtifactKind = "markdown" | "html" | "plantuml" | "json";

export type WorkflowAsset = {
  id: string;
  title: string;
  kind: "plantuml" | "json";
  relativePath: string;
  missing?: boolean;
  warning?: string;
};

export type NormalizedWorkflowArtifact = {
  id: string;
  title: string;
  stage: string;
  group: WorkflowArtifactGroup;
  kind: WorkflowArtifactKind;
  relativePath: string;
  reviewable: boolean;
  displayOrder: number;
  assets?: WorkflowAsset[];
  missing?: boolean;
  warning?: string;
};

export type WorkflowRunManifest = {
  schemaVersion?: "ai-coding-workflow.workflow-run.v1";
  runId: string;
  taskTitle: string;
  runRoot?: string;
  artifacts?: Record<string, unknown>;
  review?: {
    editorContract?: string;
    root?: string;
    writeRoot?: string;
  };
  source?: {
    mode?: "single-file" | "folder" | "demo";
  };
};

export type WorkflowRunSummary = {
  runKey: string;
  runId: string;
  taskTitle: string;
  manifestPath: string;
  effectiveRunRoot: string;
  runRootHint?: string;
  reviewRoot: string;
  sourceMode?: "single-file" | "folder" | "demo";
  artifacts: NormalizedWorkflowArtifact[];
};

export type WorkflowArtifactContent = {
  artifact: NormalizedWorkflowArtifact | WorkflowAsset;
  content: string;
  displayMarkdown: string;
  kind: WorkflowArtifactKind;
  missing?: boolean;
  relativePath: string;
  run: WorkflowRunSummary;
};

export type ListWorkflowRunsInput = {
  root: string;
};

export type ReadWorkflowRunArtifactInput = {
  artifactId: string;
  root: string;
  runKey: string;
};

export type ReadWorkflowRunAssetInput = {
  relativePath: string;
  root: string;
  runKey: string;
};

export type WorkflowRunAssetContent = {
  body: Buffer;
  contentType: string;
};

export type WriteWorkflowRevisionTraceInput = {
  adapterName: RevisionSource;
  artifactId: string;
  comments: QueuedComment[];
  contextSnapshot: ContextSnapshot;
  globalInstruction?: string;
  originalMarkdown: string;
  response: BatchRevisionResponse;
  root: string;
  runKey: string;
  submittedAt?: string;
};

export type WorkflowRevisionTraceResult = {
  latestRevisionRequestPath: string;
  latestRevisionResponsePath: string;
};

export type WriteWorkflowReviewResultInput = {
  acceptedAt?: string;
  artifactId: string;
  latestRevisionRequestPath: string;
  latestRevisionResponsePath: string;
  response: BatchRevisionResponse;
  root: string;
  runKey: string;
};

export type WorkflowReviewResult = {
  acceptedRevisionPath: string;
  reviewResultPath: string;
};

type ArtifactMapping = Omit<
  NormalizedWorkflowArtifact,
  "assets" | "missing" | "relativePath" | "warning"
> & {
  manifestKey: string;
  assetKey?: string;
};

const imageContentTypes = new Map<string, string>([
  [".avif", "image/avif"],
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

const artifactMappings: ArtifactMapping[] = [
  {
    displayOrder: 10,
    group: "scratch",
    id: "requirement-orientation",
    kind: "markdown",
    manifestKey: "requirementOrientation",
    reviewable: true,
    stage: "requirement_orientation",
    title: "需求定向",
  },
  {
    assetKey: "currentStateDiagrams",
    displayOrder: 20,
    group: "scratch",
    id: "current-state-modeling",
    kind: "markdown",
    manifestKey: "currentStateModeling",
    reviewable: true,
    stage: "current_state_modeling",
    title: "现状建模",
  },
  {
    assetKey: "changeConvergenceDiagrams",
    displayOrder: 30,
    group: "scratch",
    id: "change-convergence",
    kind: "markdown",
    manifestKey: "changeConvergence",
    reviewable: true,
    stage: "change_convergence",
    title: "改动收敛",
  },
  {
    displayOrder: 35,
    group: "scratch",
    id: "open-questions",
    kind: "markdown",
    manifestKey: "openQuestions",
    reviewable: true,
    stage: "open_questions",
    title: "待确认问题",
  },
  {
    displayOrder: 36,
    group: "metadata",
    id: "convergence-status",
    kind: "json",
    manifestKey: "convergenceStatus",
    reviewable: false,
    stage: "convergence_status",
    title: "收敛状态",
  },
  {
    displayOrder: 40,
    group: "document",
    id: "document-draft",
    kind: "markdown",
    manifestKey: "documentDraft",
    reviewable: true,
    stage: "technical_design",
    title: "发布文档草稿",
  },
  {
    displayOrder: 45,
    group: "metadata",
    id: "document-manifest",
    kind: "json",
    manifestKey: "documentManifest",
    reviewable: false,
    stage: "document_manifest",
    title: "发布文档 Manifest",
  },
  {
    displayOrder: 50,
    group: "execution",
    id: "coding-plan",
    kind: "markdown",
    manifestKey: "codingPlan",
    reviewable: true,
    stage: "coding_plan",
    title: "Coding Plan",
  },
  {
    displayOrder: 60,
    group: "execution",
    id: "verification-plan",
    kind: "markdown",
    manifestKey: "verificationPlan",
    reviewable: true,
    stage: "verification",
    title: "Verification Plan",
  },
  {
    displayOrder: 90,
    group: "metadata",
    id: "trace",
    kind: "json",
    manifestKey: "trace",
    reviewable: false,
    stage: "trace",
    title: "Trace",
  },
];

export function normalizeWorkflowRunManifest(
  manifest: unknown,
  manifestPath: string,
): NormalizedWorkflowArtifact[] {
  const parsed = parseWorkflowRunManifest(manifest);
  const effectiveRunRoot = path.dirname(path.resolve(manifestPath));
  const artifactsMap = parsed.artifacts ?? {};
  const manifestRelativePaths = collectManifestRelativePaths(artifactsMap);

  return [
    ...artifactMappings.flatMap((mapping) => {
      const rawPath = artifactsMap[mapping.manifestKey];

      if (typeof rawPath !== "string") {
        return [];
      }

      const relativePath =
        normalizeManifestRelativePath(rawPath);
      const kind = inferWorkflowArtifactKind(mapping.kind, relativePath);
      const assets = mapping.assetKey
        ? normalizeAssets(artifactsMap[mapping.assetKey], mapping.id, effectiveRunRoot)
        : undefined;
      const diskPath = resolveWorkflowRelativePath(effectiveRunRoot, relativePath);
      const missing = !fileExistsSyncSafe(diskPath);

      const artifact: NormalizedWorkflowArtifact = {
        displayOrder: mapping.displayOrder,
        group: mapping.group,
        id: mapping.id,
        kind,
        relativePath,
        reviewable:
          mapping.reviewable && !missing && (kind === "markdown" || kind === "html"),
        stage: mapping.stage,
        title: mapping.title,
        ...(assets && assets.length > 0 ? { assets } : {}),
        ...(missing
          ? {
              missing: true,
              warning: `Artifact file not found: ${relativePath}`,
            }
          : {}),
      };

      return [artifact];
    }),
    ...discoverUserFacingDirectoryArtifacts(
      effectiveRunRoot,
      manifestRelativePaths,
      parsed.source?.mode,
    ),
  ].sort((left, right) => left.displayOrder - right.displayOrder);
}

function collectManifestRelativePaths(artifactsMap: Record<string, unknown>): Set<string> {
  const paths = new Set<string>();

  for (const value of Object.values(artifactsMap)) {
    if (typeof value === "string") {
      paths.add(normalizeManifestRelativePath(value));
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          paths.add(normalizeManifestRelativePath(item));
        }
      }
    }
  }

  return paths;
}

function discoverUserFacingDirectoryArtifacts(
  effectiveRunRoot: string,
  manifestRelativePaths: Set<string>,
  sourceMode?: "single-file" | "folder" | "demo",
): NormalizedWorkflowArtifact[] {
  return [
    ...discoverArtifactsInDirectory({
      baseOrder: 31,
      dirName: "documents",
      effectiveRunRoot,
      group: "document",
      includeFileName:
        sourceMode === "folder" ? (fileName) => isMarkdownDocument(fileName) : undefined,
      manifestRelativePaths,
      recursive: true,
      stage: "document",
      titleFromContent: true,
    }),
    ...discoverArtifactsInDirectory({
      baseOrder: 41,
      dirName: "document",
      effectiveRunRoot,
      group: "document",
      includeFileName: (fileName) => fileName.startsWith("document-"),
      manifestRelativePaths,
      stage: "technical_design",
    }),
    ...discoverArtifactsInDirectory({
      baseOrder: 51,
      dirName: "md",
      effectiveRunRoot,
      group: "execution",
      manifestRelativePaths,
      stage: "workflow_document",
    }),
  ];
}

function discoverArtifactsInDirectory({
  baseOrder,
  dirName,
  effectiveRunRoot,
  group,
  includeFileName = () => true,
  manifestRelativePaths,
  recursive = false,
  stage,
  titleFromContent = false,
}: {
  baseOrder: number;
  dirName: string;
  effectiveRunRoot: string;
  group: WorkflowArtifactGroup;
  includeFileName?: (fileName: string) => boolean;
  manifestRelativePaths: Set<string>;
  recursive?: boolean;
  stage: string;
  titleFromContent?: boolean;
}): NormalizedWorkflowArtifact[] {
  const dirPath = path.join(effectiveRunRoot, dirName);
  const entries = recursive
    ? discoverFilesRecursively(dirPath).filter((relativePath) =>
        includeFileName(path.posix.basename(relativePath)),
      )
    : readDirectorySyncSafe(dirPath)
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter(includeFileName)
        .sort();

  return entries
    .flatMap((mapping) => {
      const relativePath = `${dirName}/${mapping}`;
      const kind = inferUserFacingDocumentKind(relativePath);

      if (!kind) {
        return [];
      }

      const artifact: NormalizedWorkflowArtifact = {
        displayOrder: baseOrder,
        group,
        id: createDiscoveredArtifactId(relativePath, recursive),
        kind,
        relativePath,
        reviewable: kind === "markdown" || kind === "html",
        stage,
        title: titleFromContent
          ? titleFromDocumentFile(
              resolveWorkflowRelativePath(effectiveRunRoot, relativePath),
              relativePath,
            )
          : titleFromRelativePath(relativePath),
      };

      return [artifact];
    })
    .filter(
      (artifact) =>
        !manifestRelativePaths.has(artifact.relativePath),
    )
    .map((artifact, index) => ({
      ...artifact,
      displayOrder: baseOrder + index / 100,
    }));
}

function discoverFilesRecursively(root: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string, relativeDir: string): void {
    for (const entry of readDirectorySyncSafe(currentDir)) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }

      const entryPath = path.join(currentDir, entry.name);
      const relativePath = relativeDir
        ? path.posix.join(relativeDir, entry.name)
        : entry.name;

      if (entry.isDirectory()) {
        walk(entryPath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  walk(root, "");
  return files.sort();
}

export function resolveWorkflowRelativePath(
  effectiveRunRoot: string,
  relativePath: string,
): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Workflow artifact path is outside workflow run root: ${relativePath}`);
  }

  const root = path.resolve(effectiveRunRoot);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Workflow artifact path is outside workflow run root: ${relativePath}`);
  }

  return resolved;
}

export async function listWorkflowRuns({
  root,
}: ListWorkflowRunsInput): Promise<WorkflowRunSummary[]> {
  const resolvedRoot = path.resolve(root);
  const manifestPaths = await findWorkflowRunManifests(resolvedRoot);
  const runs = await Promise.all(
    manifestPaths.map(async (manifestPath) => {
      const manifest = parseWorkflowRunManifest(
        JSON.parse(await readFile(manifestPath, "utf8")),
      );
      const effectiveRunRoot = path.dirname(manifestPath);
      const artifacts = normalizeWorkflowRunManifest(manifest, manifestPath);

      return {
        artifacts,
        effectiveRunRoot,
        manifestPath,
        reviewRoot: manifest.review?.writeRoot ?? manifest.review?.root ?? "review",
        runId: manifest.runId,
        runKey: createRunKey(resolvedRoot, manifestPath),
        runRootHint: manifest.runRoot,
        sourceMode: manifest.source?.mode,
        taskTitle: manifest.taskTitle,
      } satisfies WorkflowRunSummary;
    }),
  );

  return runs.sort((left, right) => left.runId.localeCompare(right.runId));
}

export async function readWorkflowRunArtifact({
  artifactId,
  root,
  runKey,
}: ReadWorkflowRunArtifactInput): Promise<WorkflowArtifactContent> {
  const run = await findRunByKey(root, runKey);
  const artifact = findArtifactOrAsset(run, artifactId);
  const artifactPath = resolveWorkflowRelativePath(
    run.effectiveRunRoot,
    artifact.relativePath,
  );
  const content = await readFile(artifactPath, "utf8").catch(() => undefined);
  const kind = artifact.kind;
  const missing =
    content === undefined || ("missing" in artifact && artifact.missing === true);

  return {
    artifact,
    content: content ?? "",
    displayMarkdown: formatArtifactDisplayMarkdown(content ?? "", kind),
    kind,
    missing,
    relativePath: artifact.relativePath,
    run,
  };
}

export async function readWorkflowRunAsset({
  relativePath,
  root,
  runKey,
}: ReadWorkflowRunAssetInput): Promise<WorkflowRunAssetContent> {
  const run = await findRunByKey(root, runKey);
  const extension = path.posix.extname(relativePath).toLowerCase();
  const contentType = imageContentTypes.get(extension);

  if (!contentType) {
    throw new Error(`Unsupported workflow image type: ${relativePath}`);
  }

  const assetPath = resolveWorkflowRelativePath(run.effectiveRunRoot, relativePath);
  const assetStat = await stat(assetPath).catch(() => undefined);

  if (!assetStat?.isFile()) {
    throw new Error(`Workflow image not found: ${relativePath}`);
  }

  return {
    body: await readFile(assetPath),
    contentType,
  };
}

export async function writeWorkflowRevisionTrace({
  adapterName,
  artifactId,
  comments,
  contextSnapshot,
  globalInstruction,
  originalMarkdown,
  response,
  root,
  runKey,
  submittedAt = new Date().toISOString(),
}: WriteWorkflowRevisionTraceInput): Promise<WorkflowRevisionTraceResult> {
  const run = await findRunByKey(root, runKey);
  const artifact = findTopLevelArtifact(run, artifactId);
  const writeDir = await ensureArtifactReviewDir(run, artifact.id);
  const timestamp = formatTimestampForFile(submittedAt);
  const requestPath = toRunRelativePath(
    run.effectiveRunRoot,
    path.join(writeDir, `revision-request-${timestamp}.json`),
  );
  const responsePath = toRunRelativePath(
    run.effectiveRunRoot,
    path.join(writeDir, `revision-response-${timestamp}.json`),
  );

  await writeJson(resolveWorkflowRelativePath(run.effectiveRunRoot, requestPath), {
    adapterName,
    artifactId: artifact.id,
    artifactTitle: artifact.title,
    comments,
    contextSnapshot,
    globalInstruction,
    originalMarkdown,
    runId: run.runId,
    sourceMarkdownPath: artifact.relativePath,
    submittedAt,
  });
  await writeJson(resolveWorkflowRelativePath(run.effectiveRunRoot, responsePath), {
    adapterName,
    addressedComments: response.addressedComments,
    artifactId: artifact.id,
    receivedAt: new Date().toISOString(),
    revisedMarkdown: response.revisedMarkdown,
    runId: run.runId,
    summary: response.summary,
  });

  return {
    latestRevisionRequestPath: requestPath,
    latestRevisionResponsePath: responsePath,
  };
}

export async function writeWorkflowReviewResult({
  acceptedAt = new Date().toISOString(),
  artifactId,
  latestRevisionRequestPath,
  latestRevisionResponsePath,
  response,
  root,
  runKey,
}: WriteWorkflowReviewResultInput): Promise<WorkflowReviewResult> {
  const run = await findRunByKey(root, runKey);
  const artifact = findTopLevelArtifact(run, artifactId);
  const writeDir = await ensureArtifactReviewDir(run, artifact.id);
  const revisedFilename = artifact.kind === "html" ? "revised.html" : "revised.md";
  const revisedPath = toRunRelativePath(
    run.effectiveRunRoot,
    path.join(writeDir, revisedFilename),
  );
  const reviewResultPath = toRunRelativePath(
    run.effectiveRunRoot,
    path.join(writeDir, "review-result.json"),
  );

  await writeFile(
    resolveWorkflowRelativePath(run.effectiveRunRoot, revisedPath),
    response.revisedMarkdown,
    "utf8",
  );
  await writeJson(resolveWorkflowRelativePath(run.effectiveRunRoot, reviewResultPath), {
    acceptedAt,
    acceptedRevisionPath: revisedPath,
    addressedComments: response.addressedComments,
    artifactId: artifact.id,
    latestRevisionRequestPath,
    latestRevisionResponsePath,
    runId: run.runId,
    sourceMarkdownPath: artifact.relativePath,
    summary: response.summary,
  });

  return {
    acceptedRevisionPath: revisedPath,
    reviewResultPath,
  };
}

function parseWorkflowRunManifest(value: unknown): WorkflowRunManifest {
  if (!isRecord(value)) {
    throw new Error("workflow-run.json must be a JSON object.");
  }

  if (
    "schemaVersion" in value &&
    value.schemaVersion !== undefined &&
    value.schemaVersion !== "ai-coding-workflow.workflow-run.v1"
  ) {
    throw new Error("Unsupported workflow-run.json schemaVersion.");
  }

  if (typeof value.runId !== "string" || typeof value.taskTitle !== "string") {
    throw new Error("workflow-run.json missing runId or taskTitle.");
  }

  return value as WorkflowRunManifest;
}

function normalizeAssets(
  value: unknown,
  parentId: string,
  effectiveRunRoot: string,
): WorkflowAsset[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item, index) => {
      const relativePath = normalizeManifestRelativePath(item);
      const diskPath = resolveWorkflowRelativePath(effectiveRunRoot, relativePath);
      const missing = !fileExistsSyncSafe(diskPath);

      return {
        id: `${parentId}-asset-${index + 1}`,
        kind: "plantuml",
        relativePath,
        title: path.posix.basename(relativePath),
        ...(missing
          ? {
              missing: true,
              warning: `Artifact asset file not found: ${relativePath}`,
            }
          : {}),
      } satisfies WorkflowAsset;
    });
}

async function findWorkflowRunManifests(root: string): Promise<string[]> {
  const rootStat = await stat(root).catch(() => null);

  if (!rootStat?.isDirectory()) {
    return [];
  }

  const manifests: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") {
          continue;
        }
        await walk(entryPath);
      } else if (entry.isFile() && entry.name === "workflow-run.json") {
        manifests.push(entryPath);
      }
    }
  }

  await walk(root);

  return manifests.sort();
}

async function findRunByKey(
  root: string,
  runKey: string,
): Promise<WorkflowRunSummary> {
  const runs = await listWorkflowRuns({ root });
  const run = runs.find((item) => item.runKey === runKey);

  if (!run) {
    throw new Error(`Workflow run not found for key: ${runKey}`);
  }

  return run;
}

function findArtifactOrAsset(
  run: WorkflowRunSummary,
  artifactId: string,
): NormalizedWorkflowArtifact | WorkflowAsset {
  const artifact = run.artifacts.find((item) => item.id === artifactId);

  if (artifact) {
    return artifact;
  }

  for (const item of run.artifacts) {
    const asset = item.assets?.find((candidate) => candidate.id === artifactId);

    if (asset) {
      return asset;
    }
  }

  throw new Error(`Workflow artifact not found: ${artifactId}`);
}

function findTopLevelArtifact(
  run: WorkflowRunSummary,
  artifactId: string,
): NormalizedWorkflowArtifact {
  const artifact = run.artifacts.find((item) => item.id === artifactId);

  if (!artifact) {
    throw new Error(`Workflow artifact not found: ${artifactId}`);
  }

  if (
    !artifact.reviewable ||
    (artifact.kind !== "markdown" && artifact.kind !== "html")
  ) {
    throw new Error(`Workflow artifact is not reviewable: ${artifactId}`);
  }

  return artifact;
}

async function ensureArtifactReviewDir(
  run: WorkflowRunSummary,
  artifactId: string,
): Promise<string> {
  const writeRoot = run.reviewRoot || "review";
  const dir = resolveWorkflowRelativePath(
    run.effectiveRunRoot,
    path.posix.join(writeRoot, artifactId),
  );

  await mkdir(dir, { recursive: true });

  return dir;
}

function formatArtifactDisplayMarkdown(
  content: string,
  kind: WorkflowArtifactKind,
): string {
  if (kind === "markdown" || kind === "html") {
    return content;
  }

  if (kind === "json") {
    return `\`\`\`json\n${formatJsonContent(content)}\n\`\`\`\n`;
  }

  return `\`\`\`plantuml\n${content.trimEnd()}\n\`\`\`\n`;
}

function inferWorkflowArtifactKind(
  defaultKind: WorkflowArtifactKind,
  relativePath: string,
): WorkflowArtifactKind {
  if (defaultKind !== "markdown") {
    return defaultKind;
  }

  const extension = path.posix.extname(relativePath).toLowerCase();

  if (extension === ".html" || extension === ".htm") {
    return "html";
  }

  return defaultKind;
}

function inferUserFacingDocumentKind(
  relativePath: string,
): "markdown" | "html" | undefined {
  const extension = path.posix.extname(relativePath).toLowerCase();

  if (extension === ".md" || extension === ".markdown") {
    return "markdown";
  }

  if (extension === ".html" || extension === ".htm") {
    return "html";
  }

  return undefined;
}

function createDiscoveredArtifactId(relativePath: string, includeHash = false): string {
  const slug = relativePath
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "document";

  return includeHash
    ? `doc-${slug}-${createHash("sha256").update(relativePath).digest("hex").slice(0, 10)}`
    : `doc-${slug}`;
}

function titleFromRelativePath(relativePath: string): string {
  const extension = path.posix.extname(relativePath);
  const withoutExtension = relativePath.slice(0, -extension.length);

  return withoutExtension
    .split("/")
    .map((segment) => segment.replace(/[-_]+/g, " "))
    .join(" / ");
}

function titleFromDocumentFile(filePath: string, relativePath: string): string {
  if (!isMarkdownDocument(relativePath)) {
    return titleFromRelativePath(relativePath);
  }

  try {
    return extractMarkdownH1(readFileSync(filePath, "utf8")) || titleFromRelativePath(relativePath);
  } catch {
    return titleFromRelativePath(relativePath);
  }
}

function isMarkdownDocument(fileName: string): boolean {
  const extension = path.posix.extname(fileName).toLowerCase();
  return extension === ".md" || extension === ".markdown";
}

function formatJsonContent(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content.trimEnd();
  }
}

function normalizeManifestRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function createRunKey(root: string, manifestPath: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(manifestPath));

  return `run-${createHash("sha256").update(relative).digest("hex").slice(0, 16)}`;
}

function toRunRelativePath(effectiveRunRoot: string, absolutePath: string): string {
  return path.relative(effectiveRunRoot, absolutePath).split(path.sep).join("/");
}

function formatTimestampForFile(value: string): string {
  return value.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fileExistsSyncSafe(filePath: string): boolean {
  try {
    return statSyncSafe(filePath);
  } catch {
    return false;
  }
}

function readDirectorySyncSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function statSyncSafe(filePath: string): boolean {
  return existsSync(filePath) && statSync(filePath).isFile();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
