import {
  Check,
  FileText,
  MessageSquarePlus,
  Pencil,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  AgentAdapter,
  AgentProvider,
  ArtifactSessionLink,
  Artifact,
  ArtifactWorkflowMetadata,
  BatchRevisionRequest,
  BatchRevisionResponse,
  BatchRevisionSubmitResponse,
  CliSessionKind,
  CommentCategory,
  ContextSnapshot,
  QueuedRevisionSubmission,
  QueuedComment,
  RevisionSubmissionStatus,
  ReviewRunRecord,
  ReviewSession,
} from "../contracts/index.js";
import type {
  NormalizedWorkflowArtifact,
  WorkflowArtifactContent,
  WorkflowAsset,
  WorkflowRevisionTraceResult,
  WorkflowRunSummary,
} from "../server/workflow-run-loader.js";
import { CodexCliAgentAdapter } from "../review/codex-cli-agent-adapter.js";
import { CodexDesktopAgentAdapter } from "../review/codex-desktop-agent-adapter.js";
import { createRenderedDiff, type RenderedDiffEntry } from "../review/diff.js";
import { getPopoverPosition } from "../review/popover-position.js";
import { TraexAgentAdapter } from "../review/traex-agent-adapter.js";
import { DiffView } from "./components/DiffView";
import { HtmlDocument } from "./components/HtmlDocument";
import { MarkdownDocument } from "./components/MarkdownDocument";
import {
  getReviewWorkspaceBootstrap,
  type ReviewWorkspaceBootstrap,
} from "./bootstrap";
import { cloneInitialArtifacts } from "./sample-artifacts";
import { getPendingSelection, type PendingSelection } from "./selection";
import {
  acceptReviewRun,
  attachReviewSession,
  buildSessionRevisionRequest,
  createInitialReviewSessions,
  createReviewRunRecord,
  linkReviewSessionToArtifact,
  updateReviewSession,
} from "./session-state";
import {
  getWorkflowArtifact,
  getWorkflowRun,
  listWorkflowRuns,
  saveWorkflowReviewResult,
  saveWorkflowRevisionTrace,
} from "./workflow-run-client";

type ViewerMode = "current" | "revised" | "diff";
type AgentMode = AgentProvider;
type AgentExecutionTarget = "codex_desktop" | "codex_cli" | "traex_cli";

type CommentDraft = {
  body: string;
  category: CommentCategory;
};

type AgentResult = {
  sourceMarkdown: string;
  response: BatchRevisionResponse;
  diff: RenderedDiffEntry[];
  runId: string;
  contextSnapshot: ContextSnapshot;
  revisionSource: "agent" | "manual";
  workflowRevisionTrace?: WorkflowRevisionTraceResult;
};

type PendingAgentSubmission = {
  agentPollCommand: string;
  artifactId: string;
  comments: QueuedComment[];
  contextSnapshot: ContextSnapshot;
  executionProvider: AgentProvider;
  payloadPath: string;
  pollCommand: string;
  replyCommand: string;
  request: BatchRevisionRequest;
  requestId: string;
  sourceMarkdown: string;
  submittedAt: string;
  targetLabel: string;
  workflow?: {
    artifactId: string;
    runKey: string;
  };
};

const categories: CommentCategory[] = [
  "clarification",
  "correction",
  "rewrite",
  "missing_info",
  "structure",
];

const executionTargetLabels: Record<AgentExecutionTarget, string> = {
  codex_desktop: "Codex Desktop（原对话）",
  codex_cli: "Codex CLI（本地）",
  traex_cli: "TraeX CLI（本地）",
};

const submitTimeoutMs = 90_000;

const categoryLabels: Record<CommentCategory, string> = {
  clarification: "澄清",
  correction: "纠错",
  rewrite: "改写",
  missing_info: "补充信息",
  structure: "结构调整",
};

const stageLabels: Record<string, string> = {
  requirement_orientation: "需求定向",
  current_state_modeling: "现状建模",
  change_convergence: "改动收敛",
  open_questions: "待确认问题",
  convergence_status: "收敛状态",
  system_modeling: "系统建模",
  technical_design: "技术方案",
  document_manifest: "发布文档 Manifest",
  coding_plan: "编码计划",
  verification: "验证",
  debug: "排障",
  asset_feedback: "资产反馈",
  trace: "Trace",
};

const workflowGroupLabels: Record<ArtifactWorkflowMetadata["group"], string> = {
  scratch: "Scratch 草稿",
  document: "Document 发布文档",
  execution: "Execution 执行",
  metadata: "Metadata 元数据",
};

const workflowGroupOrder: ArtifactWorkflowMetadata["group"][] = [
  "scratch",
  "document",
  "execution",
  "metadata",
];

const workflowKindLabels: Record<ArtifactWorkflowMetadata["kind"], string> = {
  markdown: "Markdown",
  html: "HTML",
  plantuml: "PlantUML",
  json: "JSON",
};

export function App() {
  const [artifacts, setArtifacts] = useState<Artifact[]>(cloneInitialArtifacts);
  const [bootstrap] = useState(getReviewWorkspaceBootstrap);
  const [isPreviewOnlyLaunchMode] = useState(() =>
    isPreviewOnlyLaunch(bootstrap),
  );
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunSummary[]>([]);
  const [activeWorkflowRunKey, setActiveWorkflowRunKey] = useState<
    string | null
  >(null);
  const [isLoadingWorkflow, setIsLoadingWorkflow] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [showHiddenWorkflowArtifacts, setShowHiddenWorkflowArtifacts] =
    useState(false);
  const [initialSessionState] = useState(() =>
    createInitialReviewSessions(
      artifacts,
      new Date().toISOString(),
      bootstrap.currentAgentProvider ?? "codex",
      {
        launcherContext: bootstrap.currentLauncherContext,
        label: bootstrap.currentSessionLabel ?? "当前 Codex 会话",
      },
    ),
  );
  const [reviewSessions, setReviewSessions] = useState<ReviewSession[]>(
    initialSessionState.sessions,
  );
  const [artifactSessionLinks, setArtifactSessionLinks] = useState<
    ArtifactSessionLink[]
  >(initialSessionState.links);
  const [reviewRuns, setReviewRuns] = useState<ReviewRunRecord[]>([]);
  const [activeArtifactId, setActiveArtifactId] = useState(artifacts[0]?.id ?? "");
  const [queuedComments, setQueuedComments] = useState<QueuedComment[]>([]);
  const [pendingSelection, setPendingSelection] =
    useState<PendingSelection | null>(null);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [expandedCommentId, setExpandedCommentId] = useState<string | null>(null);
  const [globalInstruction, setGlobalInstruction] = useState("");
  const [externalSessionDraft, setExternalSessionDraft] = useState("");
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [sourceEditDraft, setSourceEditDraft] = useState<string | null>(null);
  const [pendingSubmission, setPendingSubmission] =
    useState<PendingAgentSubmission | null>(null);
  const [viewerMode, setViewerMode] = useState<ViewerMode>("current");
  const [agentMode, setAgentMode] = useState<AgentMode>(
    bootstrap.currentAgentProvider ?? "codex",
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const submitAbortRef = useRef<AbortController | null>(null);
  const markdownRootRef = useRef<HTMLDivElement>(null);

  const activeArtifact = useMemo(
    () => artifacts.find((artifact) => artifact.id === activeArtifactId),
    [activeArtifactId, artifacts],
  );
  const activeSessionLink = useMemo(
    () =>
      artifactSessionLinks.find(
        (link) => link.artifactId === activeArtifact?.id,
      ),
    [activeArtifact?.id, artifactSessionLinks],
  );
  const activeSession = useMemo(
    () =>
      reviewSessions.find(
        (session) => session.id === activeSessionLink?.activeSessionId,
      ),
    [activeSessionLink?.activeSessionId, reviewSessions],
  );
  const reviewRunsForArtifact = useMemo(
    () => reviewRuns.filter((run) => run.artifactId === activeArtifact?.id),
    [activeArtifact?.id, reviewRuns],
  );
  const acceptedRunsForArtifact = useMemo(
    () => reviewRunsForArtifact.filter((run) => run.status === "accepted"),
    [reviewRunsForArtifact],
  );
  const activeExecutionTarget = useMemo(
    () =>
      activeSession
        ? resolveAgentExecutionTarget(agentMode, activeSession)
        : agentMode === "traex"
          ? "traex_cli"
          : "codex_cli",
    [activeSession, agentMode],
  );
  const activeExecutionProvider = useMemo(
    () => providerForExecutionTarget(activeExecutionTarget),
    [activeExecutionTarget],
  );
  const agentAdapter = useMemo<AgentAdapter>(
    () => {
      if (activeExecutionTarget === "codex_desktop") {
        return new CodexDesktopAgentAdapter();
      }

      if (activeExecutionTarget === "codex_cli") {
        return new CodexCliAgentAdapter();
      }

      return new TraexAgentAdapter();
    },
    [activeExecutionTarget],
  );

  const commentsForArtifact = useMemo(
    () =>
      queuedComments.filter(
        (comment) => comment.artifactId === activeArtifact?.id,
      ),
    [activeArtifact?.id, queuedComments],
  );

  const sidebarGroups = useMemo(
    () =>
      groupArtifactsForSidebar(artifacts, {
        showHidden: showHiddenWorkflowArtifacts,
      }),
    [artifacts, showHiddenWorkflowArtifacts],
  );
  const hasHiddenWorkflowArtifacts = useMemo(
    () =>
      artifacts.some(
        (artifact) =>
          artifact.metadata?.workflow && !isDefaultUserVisibleArtifact(artifact),
      ),
    [artifacts],
  );
  const activeExecutionVisibility = useMemo(
    () =>
      activeSession
        ? getExecutionVisibility(activeExecutionTarget, activeSession)
        : undefined,
    [activeExecutionTarget, activeSession],
  );

  useEffect(() => {
    let cancelled = false;

    async function bootstrapWorkflowRuns() {
      try {
        setWorkflowError(null);
        const runs = await listWorkflowRuns();

        if (cancelled) {
          return;
        }

        setWorkflowRuns(runs);

        if (runs.length > 0) {
          await loadWorkflowRunByKey(runs[0].runKey);
        }
      } catch (error) {
        if (!cancelled) {
          setWorkflowError(error instanceof Error ? error.message : String(error));
        }
      }
    }

    void bootstrapWorkflowRuns();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!pendingSubmission) {
      return;
    }

    let cancelled = false;
    let retryTimer: number | undefined;

    async function checkSubmission() {
      try {
        const status = await fetchRevisionSubmissionStatus(
          pendingSubmission?.requestId ?? "",
        );

        if (cancelled || !pendingSubmission) {
          return;
        }

        if (status.status === "completed") {
          await applyAgentRevisionResponse(pendingSubmission, status.response);
          return;
        }

        retryTimer = window.setTimeout(checkSubmission, 1500);
      } catch (error) {
        if (!cancelled) {
          setSubmitError(
            `检查 Agent 返回失败：${error instanceof Error ? error.message : String(error)}`,
          );
          retryTimer = window.setTimeout(checkSubmission, 3000);
        }
      }
    }

    void checkSubmission();

    return () => {
      cancelled = true;

      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [pendingSubmission?.requestId]);

  async function loadWorkflowRunByKey(runKey: string) {
    setIsLoadingWorkflow(true);
    setWorkflowError(null);
    setSubmitError(null);
    setAgentResult(null);
    setViewerMode("current");

    try {
      const run = await getWorkflowRun(runKey);
      const descriptors = flattenWorkflowArtifacts(run);
      const loadedArtifacts = await Promise.all(
        descriptors.map(async ({ artifact }) =>
          workflowContentToArtifact(await getWorkflowArtifact(run.runKey, artifact.id)),
        ),
      );
      const defaultArtifact =
        loadedArtifacts.find(isDefaultUserVisibleArtifact) ??
        loadedArtifacts.find(
          (artifact) => artifact.metadata?.workflow?.reviewable,
        ) ??
        loadedArtifacts[0];
      const now = new Date().toISOString();
      const sessionState = createInitialReviewSessions(
        loadedArtifacts,
        now,
        bootstrap.currentAgentProvider ?? "codex",
        {
          launcherContext: bootstrap.currentLauncherContext,
          label: run.taskTitle,
        },
      );

      setActiveWorkflowRunKey(run.runKey);
      setArtifacts(loadedArtifacts);
      setActiveArtifactId(defaultArtifact?.id ?? "");
      setReviewSessions(sessionState.sessions);
      setArtifactSessionLinks(sessionState.links);
      setReviewRuns([]);
      setQueuedComments([]);
      setPendingSubmission(null);
      setPendingSelection(null);
      setCommentDraft(null);
      setExpandedCommentId(null);
      setSourceEditDraft(null);
      setExternalSessionDraft("");
      setGlobalInstruction("");
      setShowHiddenWorkflowArtifacts(false);
      setAgentMode(bootstrap.currentAgentProvider ?? "codex");
      window.getSelection()?.removeAllRanges();
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoadingWorkflow(false);
    }
  }

  if (!activeArtifact) {
    return <main className="empty-app">未加载文档。</main>;
  }

  const active = activeArtifact;
  const activeWorkflow = active.metadata?.workflow;
  const isActiveArtifactReviewable = activeWorkflow?.reviewable ?? true;
  const isMarkdownSourceEditable =
    isActiveArtifactReviewable &&
    (activeWorkflow ? activeWorkflow.kind === "markdown" : true);
  const isSourceEditing = sourceEditDraft !== null;
  const sourceEditHasChanges =
    sourceEditDraft !== null && sourceEditDraft !== active.markdown;
  const canStartSourceEdit =
    isMarkdownSourceEditable &&
    !agentResult &&
    pendingSubmission === null &&
    !isSubmitting &&
    !isSourceEditing;
  const hasSubmitContent =
    commentsForArtifact.length > 0 || globalInstruction.trim().length > 0;
  const canSubmit =
    hasSubmitContent &&
    !isSubmitting &&
    pendingSubmission === null &&
    activeSession !== undefined &&
    activeSessionLink !== undefined &&
    isActiveArtifactReviewable;
  const visibleMarkdown =
    viewerMode === "revised" && agentResult
      ? agentResult.response.revisedMarkdown
      : active.markdown;

  const handleSelectionMouseUp = useCallback(() => {
    if (viewerMode !== "current" || !isActiveArtifactReviewable || isSourceEditing) {
      return;
    }

    window.requestAnimationFrame(() => {
      const root = markdownRootRef.current;
      setPendingSelection(root ? getPendingSelection(root) : null);
      setCommentDraft(null);
    });
  }, [isActiveArtifactReviewable, isSourceEditing, viewerMode]);

  function startCommentDraft() {
    setCommentDraft({
      body: "",
      category: "clarification",
    });
  }

  function cancelCommentDraft() {
    setPendingSelection(null);
    setCommentDraft(null);
    window.getSelection()?.removeAllRanges();
  }

  function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!pendingSelection || !commentDraft || !commentDraft.body.trim()) {
      return;
    }

    const comment: QueuedComment = {
      id: createCommentId(),
      artifactId: active.id,
      anchor: pendingSelection.anchor,
      body: commentDraft.body.trim(),
      category: commentDraft.category,
      status: "queued",
      createdAt: new Date().toISOString(),
    };

    setQueuedComments((current) => [...current, comment]);
    cancelCommentDraft();
  }

  function updateComment(
    commentId: string,
    patch: Partial<Pick<QueuedComment, "body" | "category">>,
  ) {
    setQueuedComments((current) =>
      current.map((comment) =>
        comment.id === commentId ? { ...comment, ...patch } : comment,
      ),
    );
  }

  function deleteComment(commentId: string) {
    setQueuedComments((current) =>
      current.filter((comment) => comment.id !== commentId),
    );
    setExpandedCommentId((current) => (current === commentId ? null : current));
  }

  function clearQueue() {
    setQueuedComments((current) =>
      current.filter((comment) => comment.artifactId !== active.id),
    );
    setExpandedCommentId(null);
  }

  async function submitAll() {
    if (!canSubmit || !activeSession || !activeSessionLink) {
      return;
    }

    const abortController = new AbortController();
    let didTimeout = false;
    const timeout = window.setTimeout(() => {
      didTimeout = true;
      abortController.abort();
    }, submitTimeoutMs);

    submitAbortRef.current = abortController;
    setIsSubmitting(true);
    setSubmitError(null);
    setSubmitStatus(
      `正在排队提交到 ${executionTargetLabels[activeExecutionTarget]}，最长 90 秒。`,
    );

    try {
      const now = new Date().toISOString();
      const submission = buildSessionRevisionRequest({
        agentProvider: activeExecutionProvider,
        artifact: active,
        comments: commentsForArtifact,
        globalInstruction,
        link: activeSessionLink,
        now,
        reviewRuns,
        session: activeSession,
      });
      const pendingBase: PendingAgentSubmission = {
        agentPollCommand: "",
        artifactId: active.id,
        comments: commentsForArtifact,
        contextSnapshot: submission.contextSnapshot,
        executionProvider: activeExecutionProvider,
        payloadPath: "",
        pollCommand: "",
        replyCommand: "",
        request: submission.request,
        requestId: `direct-${Date.now()}`,
        sourceMarkdown: active.markdown,
        submittedAt: now,
        targetLabel: executionTargetLabels[activeExecutionTarget],
        workflow: activeWorkflow
          ? {
              artifactId: activeWorkflow.artifactId,
              runKey: activeWorkflow.runKey,
            }
          : undefined,
      };
      const response = await agentAdapter.reviseArtifact(submission.request, {
        signal: abortController.signal,
      });

      if (isQueuedRevisionSubmission(response)) {
        setPendingSubmission({
          ...pendingBase,
          payloadPath: response.payloadPath,
          agentPollCommand: response.agentPollCommand,
          pollCommand: response.pollCommand,
          replyCommand: response.replyCommand,
          requestId: response.requestId,
          targetLabel: response.target.label,
        });
        setSubmitStatus(response.message);
        return;
      }

      await applyAgentRevisionResponse(pendingBase, response);
    } catch (error) {
      if (didTimeout) {
        setSubmitError(
          `${executionTargetLabels[activeExecutionTarget]} 超过 90 秒未返回，已停止等待。请检查本地服务是否可用，或稍后重试。`,
        );
      } else if (isAbortError(error)) {
        setSubmitError(`${executionTargetLabels[activeExecutionTarget]} 已取消。`);
      } else {
        setSubmitError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      window.clearTimeout(timeout);
      submitAbortRef.current = null;
      setIsSubmitting(false);
      setSubmitStatus(null);
    }
  }

  function cancelSubmit() {
    submitAbortRef.current?.abort();
  }

  function startSourceEdit() {
    if (!canStartSourceEdit) {
      return;
    }

    setSourceEditDraft(active.markdown);
    setPendingSelection(null);
    setCommentDraft(null);
    setViewerMode("current");
    window.getSelection()?.removeAllRanges();
  }

  function cancelSourceEdit() {
    setSourceEditDraft(null);
    setSubmitError(null);
  }

  async function applyManualSourceEdit() {
    if (
      !sourceEditHasChanges ||
      sourceEditDraft === null ||
      !activeSession ||
      !activeSessionLink ||
      !isMarkdownSourceEditable
    ) {
      return;
    }

    const now = new Date().toISOString();
    const sourceMarkdown = active.markdown;
    const response: BatchRevisionResponse = {
      addressedComments: [
        {
          commentId: "manual-source-edit",
          resolution: "已按源码编辑发布为修订。",
        },
      ],
      revisedMarkdown: sourceEditDraft,
      summary: "手动编辑 Markdown 源码。",
    };
    const submission = buildSessionRevisionRequest({
      agentProvider: activeSession.provider,
      artifact: active,
      comments: [],
      globalInstruction: "Manual Markdown source edit in Dorey.",
      link: activeSessionLink,
      now,
      reviewRuns,
      session: activeSession,
    });
    const reviewRun = createReviewRunRecord({
      adapter: "manual",
      artifactId: active.id,
      comments: [],
      contextSnapshot: submission.contextSnapshot,
      now,
      sessionId: activeSession.id,
      summary: response.summary,
    });
    let workflowRevisionTrace: WorkflowRevisionTraceResult | undefined;

    setIsSubmitting(true);
    setSubmitError(null);
    setSubmitStatus("正在发布 Markdown 源码编辑。");

    try {
      if (activeWorkflow) {
        workflowRevisionTrace = await saveWorkflowRevisionTrace({
          adapterName: "manual",
          artifactId: activeWorkflow.artifactId,
          comments: [],
          contextSnapshot: submission.contextSnapshot,
          globalInstruction: submission.request.globalInstruction,
          originalMarkdown: sourceMarkdown,
          response,
          runKey: activeWorkflow.runKey,
          submittedAt: now,
        });
      }

      setAgentResult({
        sourceMarkdown,
        response,
        diff: createRenderedDiff(sourceMarkdown, response.revisedMarkdown),
        runId: reviewRun.id,
        contextSnapshot: submission.contextSnapshot,
        revisionSource: "manual",
        workflowRevisionTrace,
      });
      setReviewRuns((current) => [...current, reviewRun]);
      setSourceEditDraft(null);
      setViewerMode("revised");
    } catch (error) {
      setSubmitError(
        `发布手动修订失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsSubmitting(false);
      setSubmitStatus(null);
    }
  }

  async function applyAgentRevisionResponse(
    pending: PendingAgentSubmission,
    response: BatchRevisionResponse,
  ) {
    const completedAt = new Date().toISOString();
    const reviewRun = createReviewRunRecord({
      adapter: pending.executionProvider,
      artifactId: pending.artifactId,
      comments: pending.comments,
      contextSnapshot: pending.contextSnapshot,
      now: completedAt,
      sessionId: pending.request.session?.id ?? activeSession?.id ?? "session-main",
      summary: response.summary,
    });
    let workflowRevisionTrace: WorkflowRevisionTraceResult | undefined;

    if (pending.workflow) {
      setSubmitStatus("正在写入 Workflow review 记录。");
      workflowRevisionTrace = await saveWorkflowRevisionTrace({
        adapterName: pending.executionProvider,
        artifactId: pending.workflow.artifactId,
        comments: pending.comments,
        contextSnapshot: pending.contextSnapshot,
        globalInstruction: pending.request.globalInstruction,
        originalMarkdown: pending.sourceMarkdown,
        response,
        runKey: pending.workflow.runKey,
        submittedAt: pending.submittedAt,
      });
    }

    setActiveArtifactId(pending.artifactId);
    setAgentResult({
      sourceMarkdown: pending.sourceMarkdown,
      response,
      diff: createRenderedDiff(pending.sourceMarkdown, response.revisedMarkdown),
      runId: reviewRun.id,
      contextSnapshot: pending.contextSnapshot,
      revisionSource: "agent",
      workflowRevisionTrace,
    });
    setReviewRuns((current) => [...current, reviewRun]);
    setPendingSubmission((current) =>
      current?.requestId === pending.requestId ? null : current,
    );
    setSubmitError(null);
    setSubmitStatus(null);
    setViewerMode("revised");
  }

  async function acceptRevised() {
    if (!agentResult) {
      return;
    }

    const acceptedAt = new Date().toISOString();

    if (activeWorkflow) {
      if (!agentResult.workflowRevisionTrace) {
        setSubmitError("缺少 Workflow revision 写回记录，无法接受修订。");
        return;
      }

      try {
        await saveWorkflowReviewResult({
          acceptedAt,
          artifactId: activeWorkflow.artifactId,
          latestRevisionRequestPath:
            agentResult.workflowRevisionTrace.latestRevisionRequestPath,
          latestRevisionResponsePath:
            agentResult.workflowRevisionTrace.latestRevisionResponsePath,
          response: agentResult.response,
          runKey: activeWorkflow.runKey,
        });
      } catch (error) {
        setSubmitError(
          `接受修订写回失败：${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }

    setArtifacts((current) =>
      current.map((artifact) =>
        artifact.id === active.id
          ? {
              ...artifact,
              markdown: agentResult.response.revisedMarkdown,
              metadata: {
                ...artifact.metadata,
                updatedAt: new Date().toISOString(),
              },
            }
          : artifact,
      ),
    );
    const accepted = acceptReviewRun({
      acceptedAt,
      reviewRuns,
      runId: agentResult.runId,
      sessions: reviewSessions,
    });
    setReviewRuns(accepted.reviewRuns);
    setReviewSessions(accepted.sessions);
    clearQueue();
    setAgentResult(null);
    setSourceEditDraft(null);
    setViewerMode("current");
  }

  function resetDemo() {
    submitAbortRef.current?.abort();

    if (activeWorkflowRunKey) {
      void loadWorkflowRunByKey(activeWorkflowRunKey);
      return;
    }

    const freshArtifacts = cloneInitialArtifacts();
    const freshSessionState = createInitialReviewSessions(
      freshArtifacts,
      new Date().toISOString(),
      bootstrap.currentAgentProvider ?? "codex",
      {
        launcherContext: bootstrap.currentLauncherContext,
        label: bootstrap.currentSessionLabel ?? "当前 Codex 会话",
      },
    );

    setArtifacts(freshArtifacts);
    setActiveArtifactId(freshArtifacts[0]?.id ?? "");
    setReviewSessions(freshSessionState.sessions);
    setArtifactSessionLinks(freshSessionState.links);
    setReviewRuns([]);
    setPendingSubmission(null);
    setQueuedComments([]);
    setPendingSelection(null);
    setCommentDraft(null);
    setExpandedCommentId(null);
    setSourceEditDraft(null);
    setExternalSessionDraft("");
    setGlobalInstruction("");
    setAgentResult(null);
    setViewerMode("current");
    setAgentMode(bootstrap.currentAgentProvider ?? "codex");
    setSubmitError(null);
    setSubmitStatus(null);
    window.getSelection()?.removeAllRanges();
  }

  function changeAgentMode(nextMode: AgentMode) {
    setAgentMode(nextMode);
    setAgentResult(null);
    setSourceEditDraft(null);
    setViewerMode("current");
    setSubmitError(null);
  }

  function chooseWorkflowRun(runKey: string) {
    if (runKey === activeWorkflowRunKey || isLoadingWorkflow) {
      return;
    }

    void loadWorkflowRunByKey(runKey);
  }

  function changeHiddenWorkflowArtifactsVisibility(nextVisible: boolean) {
    setShowHiddenWorkflowArtifacts(nextVisible);

    if (!nextVisible && !isDefaultUserVisibleArtifact(active)) {
      const nextArtifact = artifacts.find(isDefaultUserVisibleArtifact);

      if (nextArtifact) {
        chooseArtifact(nextArtifact.id);
      }
    }
  }

  function updateActiveSession(
    patch: Partial<
      Pick<ReviewSession, "contextSummary" | "currentPhase" | "label" | "taskGoal">
    >,
  ) {
    if (!activeSession) {
      return;
    }

    setReviewSessions((current) =>
      updateReviewSession(current, activeSession.id, patch),
    );
  }

  function attachActiveSession() {
    if (!activeSession || !externalSessionDraft.trim()) {
      return;
    }

    const externalSessionKind = getCliSessionKind(activeSession.provider);

    if (!externalSessionKind) {
      return;
    }

    setReviewSessions((current) =>
      attachReviewSession({
        externalSessionId: externalSessionDraft,
        externalSessionKind,
        provider: activeSession.provider,
        sessionId: activeSession.id,
        sessions: current,
      }),
    );
    setExternalSessionDraft("");
    setAgentResult(null);
    setSourceEditDraft(null);
    setViewerMode("current");
  }

  function chooseActiveSession(sessionId: string) {
    const linked = linkReviewSessionToArtifact({
      artifactId: active.id,
      links: artifactSessionLinks,
      sessionId,
      sessions: reviewSessions,
    });

    setArtifactSessionLinks(linked.links);
    setReviewSessions(linked.sessions);
    setExternalSessionDraft("");
    setAgentResult(null);
    setSourceEditDraft(null);
    setViewerMode("current");
  }

  function chooseArtifact(artifactId: string) {
    setActiveArtifactId(artifactId);
    setPendingSelection(null);
    setCommentDraft(null);
    setExpandedCommentId(null);
    setAgentResult(null);
    setSourceEditDraft(null);
    setViewerMode("current");
  }

  return (
    <main className="app-shell">
      <aside className="artifact-sidebar">
        <div className="sidebar-heading">
          <FileText size={20} aria-hidden="true" />
          <div>
            <h1>Dorey</h1>
            <p>Doc Review · AI coding artifacts 本地审阅闭环</p>
          </div>
        </div>

        {workflowRuns.length > 0 ? (
          <label className="workflow-run-picker">
            <span>Workflow Runs</span>
            <select
              aria-label="Workflow Run"
              disabled={isLoadingWorkflow}
              onChange={(event) => chooseWorkflowRun(event.target.value)}
              value={activeWorkflowRunKey ?? ""}
            >
              {workflowRuns.map((run) => (
                <option key={run.runKey} value={run.runKey}>
                  {run.taskTitle}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {workflowError ? (
          <p className="error-message workflow-error">{workflowError}</p>
        ) : null}

        {hasHiddenWorkflowArtifacts ? (
          <label className="hidden-artifacts-toggle">
            <input
              checked={showHiddenWorkflowArtifacts}
              onChange={(event) =>
                changeHiddenWorkflowArtifactsVisibility(event.target.checked)
              }
              type="checkbox"
            />
            <span>显示隐藏产物</span>
          </label>
        ) : null}

        <div className="artifact-list">
          {sidebarGroups.map((group) => (
            <div className="artifact-group" key={group.key}>
              <div className="artifact-group-title">{group.label}</div>
              {group.items.map((artifact) => {
                const workflow = artifact.metadata?.workflow;

                return (
                  <button
                    className={[
                      "artifact-item",
                      artifact.id === activeArtifact.id
                        ? "artifact-item-active"
                        : "",
                      workflow?.reviewable === false
                        ? "artifact-item-readonly"
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    key={artifact.id}
                    onClick={() => chooseArtifact(artifact.id)}
                    type="button"
                  >
                    <span>{artifact.title}</span>
                    <small>
                      {stageLabels[artifact.stage] ?? artifact.stage}
                      {workflow ? ` · ${workflowKindLabels[workflow.kind]}` : ""}
                    </small>
                    {workflow?.warning ? (
                      <small className="artifact-warning">{workflow.warning}</small>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </aside>

      <section className="reader-column">
        <div className="workspace-toolbar">
          <div>
            <h2>{activeArtifact.title}</h2>
            <p>{activeArtifact.metadata?.sourceRefs?.join(" · ")}</p>
            {bootstrap.launchMode === "demo" ? (
              <p className="info-message launch-notice demo-notice">
                当前打开的是 Dorey 内置 Demo，不是在审阅本地文件或仓库产物。
              </p>
            ) : null}
            {activeWorkflow?.warning ? (
              <p className="warning-message">{activeWorkflow.warning}</p>
            ) : null}
            {!isActiveArtifactReviewable ? (
              <p className="info-message">该产物为只读预览，不支持评论提交。</p>
            ) : null}
          </div>

          <div className="toolbar-actions">
            <div className="segmented-control" aria-label="视图模式">
              <button
                className={viewerMode === "current" ? "active" : ""}
                onClick={() => setViewerMode("current")}
                type="button"
              >
                当前
              </button>
              <button
                className={viewerMode === "revised" ? "active" : ""}
                disabled={!agentResult}
                onClick={() => setViewerMode("revised")}
                type="button"
              >
                修订
              </button>
              <button
                className={viewerMode === "diff" ? "active" : ""}
                disabled={!agentResult}
                onClick={() => setViewerMode("diff")}
                type="button"
              >
                差异
              </button>
            </div>

            <button
              className="icon-button"
              disabled={!canStartSourceEdit}
              onClick={startSourceEdit}
              title="编辑 Markdown 源码"
              type="button"
            >
              <Pencil size={16} aria-hidden="true" />
              <span>编辑 Markdown</span>
            </button>
            <button
              className="icon-button"
              disabled={!agentResult}
              onClick={acceptRevised}
              title="接受修订"
              type="button"
            >
              <Check size={17} aria-hidden="true" />
              <span>接受</span>
            </button>
            <button
              className="icon-button"
              onClick={resetDemo}
              title="重置示例"
              type="button"
            >
              <RotateCcw size={16} aria-hidden="true" />
              <span>重置</span>
            </button>
          </div>
        </div>

        <div className="document-stage">
          {sourceEditDraft !== null ? (
            <form
              className="source-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void applyManualSourceEdit();
              }}
            >
              <div className="source-editor-header">
                <div>
                  <h3>编辑 Markdown</h3>
                  <p>{activeArtifact.title}</p>
                </div>
                <span>{sourceEditDraft.split("\n").length} 行</span>
              </div>
              <textarea
                aria-label="Markdown 源码"
                autoFocus
                onChange={(event) => setSourceEditDraft(event.target.value)}
                spellCheck={false}
                value={sourceEditDraft}
              />
              <div className="source-editor-actions">
                <button
                  className="text-button"
                  onClick={cancelSourceEdit}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="icon-button primary"
                  disabled={!sourceEditHasChanges || isSubmitting}
                  type="submit"
                >
                  <Check size={16} aria-hidden="true" />
                  <span>发布为修订</span>
                </button>
              </div>
            </form>
          ) : viewerMode === "diff" && agentResult ? (
            <DiffView diff={agentResult.diff} />
          ) : activeWorkflow?.kind === "html" ? (
            <div ref={markdownRootRef}>
              <HtmlDocument
                artifactId={activeArtifact.id}
                enableSelection={
                  viewerMode === "current" && isActiveArtifactReviewable
                }
                html={visibleMarkdown}
                onMouseUp={handleSelectionMouseUp}
              />
            </div>
          ) : (
            <div ref={markdownRootRef}>
              <MarkdownDocument
                artifactId={activeArtifact.id}
                enableSelection={
                  viewerMode === "current" && isActiveArtifactReviewable
                }
                markdown={visibleMarkdown}
                onMouseUp={handleSelectionMouseUp}
              />
            </div>
          )}
        </div>
      </section>

      <aside className="review-sidebar">
        <section className="queue-panel">
          <div className="panel-header">
            <div>
              <h2>评论队列</h2>
              <p>{commentsForArtifact.length} 条待处理 · 当前文档 · 队列可滚动</p>
            </div>
            <button
              className="icon-only"
              disabled={commentsForArtifact.length === 0}
              onClick={clearQueue}
              title="清空队列"
              type="button"
            >
              <Trash2 size={17} aria-hidden="true" />
            </button>
          </div>

          <div className="comment-list">
            {commentsForArtifact.length === 0 ? (
              <div className="empty-state">
                {isActiveArtifactReviewable
                  ? "暂无待处理评论"
                  : "只读产物不支持评论"}
              </div>
            ) : (
              commentsForArtifact.map((comment) => {
                const isExpanded = expandedCommentId === comment.id;

                return (
                  <article
                    className={
                      isExpanded ? "comment-item expanded" : "comment-item compact"
                    }
                    key={comment.id}
                    onClick={() =>
                      setExpandedCommentId(isExpanded ? null : comment.id)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setExpandedCommentId(isExpanded ? null : comment.id);
                      }
                    }}
                    tabIndex={0}
                  >
                    <div className="comment-item-header">
                      <div className="comment-item-meta">
                        <span className="category-pill">
                          {categoryLabels[comment.category ?? "clarification"]}
                        </span>
                      </div>
                      <div className="comment-item-actions">
                        <small>{comment.anchor.blockId}</small>
                        <button
                          className="icon-only"
                          onClick={(event) => {
                            event.stopPropagation();
                            setExpandedCommentId(isExpanded ? null : comment.id);
                          }}
                          title={isExpanded ? "收起编辑" : "编辑评论"}
                          type="button"
                        >
                          <Pencil size={13} aria-hidden="true" />
                        </button>
                        <button
                          className="icon-only"
                          onClick={(event) => {
                            event.stopPropagation();
                            deleteComment(comment.id);
                          }}
                          title="删除评论"
                          type="button"
                        >
                          <X size={15} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    <blockquote>{comment.anchor.quote}</blockquote>
                    <p className="comment-body-preview">{comment.body}</p>
                    {isExpanded ? (
                      <div
                        className="comment-edit-area"
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <textarea
                          aria-label="评论正文"
                          onChange={(event) =>
                            updateComment(comment.id, { body: event.target.value })
                          }
                          value={comment.body}
                        />
                        <div className="comment-controls">
                          <select
                            aria-label="评论类型"
                            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                              updateComment(comment.id, {
                                category: event.target.value as CommentCategory,
                              })
                            }
                            value={comment.category}
                          >
                            {categories.map((category) => (
                              <option key={category} value={category}>
                                {categoryLabels[category]}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    ) : null}
                  </article>
                );
              })
            )}
          </div>
        </section>

        <section className="global-comment-panel">
          <div className="panel-header">
            <div>
              <h2>全文评论（可选）</h2>
              <p>评论队列或全文评论有内容即可提交</p>
            </div>
          </div>

          <textarea
            aria-label="全文评论"
            className="global-instruction"
            disabled={!isActiveArtifactReviewable || isSubmitting}
            onChange={(event) => setGlobalInstruction(event.target.value)}
            placeholder="补充整体修改要求（可选）"
            value={globalInstruction}
          />

          <div className="submit-row">
            <button
              className="submit-button compact-submit"
              disabled={!canSubmit}
              onClick={submitAll}
              type="button"
            >
              <Send size={15} aria-hidden="true" />
              <span>
                {isSubmitting
                  ? `${executionTargetLabels[activeExecutionTarget]} 运行中`
                  : "提交全部"}
              </span>
            </button>

            {isSubmitting ? (
              <button
                className="text-button cancel-submit"
                onClick={cancelSubmit}
                type="button"
              >
                取消
              </button>
            ) : null}
          </div>

          {submitStatus ? <p className="info-message">{submitStatus}</p> : null}
          {submitError ? <p className="error-message">{submitError}</p> : null}
        </section>

        <section className="agent-panel">
          <div className="panel-header">
            <div>
              <h2>Agent 面板</h2>
              <p>只显示会影响提交去向的信息</p>
            </div>
            <Sparkles size={18} aria-hidden="true" />
          </div>

          {isPreviewOnlyLaunchMode ||
          (activeSession ? isPreviewOnlySession(activeSession) : false) ? (
            <div className="session-launch-warning" role="status">
              <strong>当前是本地预览模式</strong>
              <p>
                Dorey 没有检测到可承载任务上下文的 Codex/TraeX 会话。你仍然可以浏览文档、添加评论和调试 UI；但 Submit All 不会自动回到 Agent 对话中处理。
              </p>
              <p>要使用完整审阅闭环，请在当前任务所在的 Codex/TraeX 会话里启动 dorey。</p>
            </div>
          ) : null}

          {activeExecutionVisibility ? (
            <div className="agent-note session-execution-note">
              <span>提交去向</span>
              <p>{activeExecutionVisibility.body}</p>
            </div>
          ) : null}

          <details className="agent-debug-details">
            <summary>调试详情</summary>

            <select
              aria-label="Agent 适配器"
              className="agent-mode-select"
              disabled={isSubmitting}
              onChange={(event) => changeAgentMode(event.target.value as AgentMode)}
              value={agentMode}
            >
              <option value="codex">Codex（按启动来源）</option>
              <option value="traex">TraeX（按启动来源）</option>
            </select>

            {activeSession ? (
              <div className="session-context">
                <div className="session-title-row">
                  <h3>会话上下文</h3>
                </div>

                <label className="session-field">
                  <span>会话</span>
                  <select
                    aria-label="当前审阅会话"
                    disabled={isSubmitting}
                    onChange={(event) => chooseActiveSession(event.target.value)}
                    value={activeSession.id}
                  >
                    {reviewSessions.map((session) => (
                      <option key={session.id} value={session.id}>
                        {session.label} · {session.provider}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="session-field">
                  <span>任务目标</span>
                  <input
                    aria-label="会话任务目标"
                    disabled={isSubmitting}
                    onChange={(event) =>
                      updateActiveSession({ taskGoal: event.target.value })
                    }
                    value={activeSession.taskGoal}
                  />
                </label>

                <div className="session-grid">
                  <label className="session-field">
                    <span>阶段</span>
                    <input
                      aria-label="会话当前阶段"
                      disabled={isSubmitting}
                      onChange={(event) =>
                        updateActiveSession({ currentPhase: event.target.value })
                      }
                      value={activeSession.currentPhase}
                    />
                  </label>

                  <label className="session-field">
                    <span>来源</span>
                    <input
                      aria-label="会话来源"
                      disabled
                      value={activeSession.origin}
                    />
                  </label>
                </div>

                {activeSession.launcherContext ? (
                  <label className="session-field">
                    <span>启动上下文</span>
                    <input
                      aria-label="启动上下文"
                      disabled
                      value={`${formatLauncherProvider(activeSession.launcherContext.provider)} · ${activeSession.launcherContext.sessionId}`}
                    />
                  </label>
                ) : null}

                <label className="session-field">
                  <span>CLI 会话 ID</span>
                  <input
                    aria-label="CLI 会话 ID"
                    disabled={isSubmitting}
                    onChange={(event) =>
                      setExternalSessionDraft(event.target.value)
                    }
                    placeholder={formatCliSessionPlaceholder(activeSession.provider)}
                    value={externalSessionDraft}
                  />
                </label>

                <div className="session-actions">
                  <button
                    className="icon-button"
                    disabled={!externalSessionDraft.trim() || isSubmitting}
                    onClick={attachActiveSession}
                    type="button"
                  >
                    <Check size={15} aria-hidden="true" />
                    <span>绑定</span>
                  </button>
                  <span>{formatSessionBinding(activeSession)}</span>
                </div>

                <label className="session-field">
                  <span>上下文</span>
                  <textarea
                    aria-label="会话上下文摘要"
                    disabled={isSubmitting}
                    onChange={(event) =>
                      updateActiveSession({ contextSummary: event.target.value })
                    }
                    value={activeSession.contextSummary}
                  />
                </label>

                <div className="session-stats">
                  <span>{activeSessionLink?.linkedSessionIds.length ?? 0} 个关联会话</span>
                  <span>{acceptedRunsForArtifact.length} 次已接受</span>
                  <span>{reviewRunsForArtifact.length} 次运行</span>
                </div>
              </div>
            ) : (
              <div className="empty-state">未绑定会话</div>
            )}
          </details>

          {pendingSubmission ? (
            <div className="agent-result pending-result">
              <div className="result-header">
                <div>
                  <h3>等待原 Agent 会话处理</h3>
                  <p>
                    已排队到 {pendingSubmission.targetLabel}。请让启动 Workspace
                    的原 Agent 会话运行配置命令并保持等待；页面只会等待原会话
                    reply 返回。
                  </p>
                </div>
                <span className="status-chip">待处理</span>
              </div>

              <section className="result-section">
                <h4>配置原会话命令</h4>
                <code className="command-block">
                  {pendingSubmission.agentPollCommand}
                </code>
              </section>

              <section className="result-section">
                <h4>Raw Poll 命令</h4>
                <code className="command-block">{pendingSubmission.pollCommand}</code>
              </section>

              <section className="result-section">
                <h4>Reply 命令</h4>
                <code className="command-block">{pendingSubmission.replyCommand}</code>
              </section>

              <section className="result-section">
                <h4>Payload 文件</h4>
                <p className="result-text">{pendingSubmission.payloadPath}</p>
              </section>

              <button
                className="text-button cancel-submit"
                onClick={() => setPendingSubmission(null)}
                type="button"
              >
                取消页面等待
              </button>
            </div>
          ) : null}

          {agentResult ? (
            <div className="agent-result">
              <div className="result-header">
                <div>
                  <h3>
                    {agentResult.revisionSource === "manual"
                      ? "手动修订"
                      : "本次返回"}
                  </h3>
                  <p>已生成修订，当前文档已切到“修订”视图。</p>
                </div>
                <span className="status-chip">待接受</span>
              </div>

              <section className="result-section">
                <h4>摘要</h4>
                <p className="result-text">
                  {agentResult.response.summary.trim() || "Agent 未返回摘要。"}
                </p>
              </section>

              <section className="result-section">
                <h4>已处理评论</h4>
                  {agentResult.response.addressedComments.length > 0 ? (
                    <ol className="addressed-comment-list">
                    {agentResult.response.addressedComments.map((item) => {
                      const sourceComment = commentsForArtifact.find(
                        (comment) => comment.id === item.commentId,
                      );

                      return (
                        <li key={item.commentId}>
                          <span className="comment-id">{item.commentId}</span>
                          {sourceComment ? (
                            <blockquote>{sourceComment.anchor.quote}</blockquote>
                          ) : null}
                          <p className="result-text">{item.resolution}</p>
                        </li>
                      );
                    })}
                  </ol>
                  ) : (
                  <p className="result-empty">暂无逐条处理说明。</p>
                )}
              </section>

              <section className="result-section">
                <h4>修订信息</h4>
                <div className="result-meta-grid">
                  <div>
                    <span>修订规模</span>
                    <strong>
                      {agentResult.sourceMarkdown.split("\n").length} 行到{" "}
                      {agentResult.response.revisedMarkdown.split("\n").length} 行
                    </strong>
                  </div>
                  <div>
                    <span>会话快照</span>
                    <strong>{agentResult.contextSnapshot.id}</strong>
                  </div>
                </div>
              </section>

              {agentResult.workflowRevisionTrace ? (
                <section className="result-section">
                  <h4>写回文件</h4>
                  <div className="path-list">
                    <code>
                      {agentResult.workflowRevisionTrace.latestRevisionRequestPath}
                    </code>
                    <code>
                      {agentResult.workflowRevisionTrace.latestRevisionResponsePath}
                    </code>
                  </div>
                </section>
              ) : null}

              {agentResult.revisionSource === "agent" && activeExecutionVisibility ? (
                <section
                  className={`result-section execution-visibility execution-visibility-${activeExecutionVisibility.tone}`}
                >
                  <h4>执行可见性</h4>
                  <p className="result-text">{activeExecutionVisibility.body}</p>
                </section>
              ) : null}

              <div className="result-actions">
                <button
                  className="text-button"
                  onClick={() => setViewerMode("diff")}
                  type="button"
                >
                  查看差异
                </button>
                <button
                  className="icon-button primary"
                  onClick={acceptRevised}
                  type="button"
                >
                  <Check size={16} aria-hidden="true" />
                  <span>接受修订</span>
                </button>
              </div>
            </div>
          ) : null}

          {reviewRunsForArtifact.length > 0 ? (
            <div className="run-history">
              <h3>运行历史</h3>
              <ol>
                {reviewRunsForArtifact.map((run) => (
                  <li key={run.id}>
                    <span>{formatRunStatus(run.status)}</span>
                    <p>{run.summary ?? "暂无摘要"}</p>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </section>
      </aside>

      {pendingSelection ? (
        <SelectionPopover
          draft={commentDraft}
          onAdd={addComment}
          onCancel={cancelCommentDraft}
          onDraftChange={setCommentDraft}
          onStart={startCommentDraft}
          pendingSelection={pendingSelection}
        />
      ) : null}
    </main>
  );
}

type SidebarArtifactGroup = {
  key: string;
  label: string;
  items: Artifact[];
};

type SidebarArtifactGroupOptions = {
  showHidden: boolean;
};

type WorkflowArtifactDescriptor = {
  artifact: NormalizedWorkflowArtifact | WorkflowAsset;
};

function groupArtifactsForSidebar(
  artifacts: Artifact[],
  options: SidebarArtifactGroupOptions,
): SidebarArtifactGroup[] {
  const workflowArtifacts = artifacts.filter(
    (artifact) => artifact.metadata?.workflow,
  );

  if (workflowArtifacts.length === 0) {
    return [
      {
        key: "demo",
        label: "示例文档",
        items: artifacts,
      },
    ];
  }

  const visibleArtifacts = options.showHidden
    ? workflowArtifacts
    : workflowArtifacts.filter(isDefaultUserVisibleArtifact);

  return workflowGroupOrder
    .map((group) => ({
      key: group,
      label: workflowGroupLabels[group],
      items: visibleArtifacts.filter(
        (artifact) => artifact.metadata?.workflow?.group === group,
      ),
    }))
    .filter((group) => group.items.length > 0);
}

function isDefaultUserVisibleArtifact(artifact: Artifact): boolean {
  const workflow = artifact.metadata?.workflow;

  if (!workflow) {
    return true;
  }

  return (
    workflow.group !== "scratch" &&
    workflow.group !== "metadata" &&
    isUserVisibleDocumentKind(workflow)
  );
}

function isUserVisibleDocumentKind(
  workflow: ArtifactWorkflowMetadata,
): boolean {
  return (
    workflow.kind === "markdown" ||
    workflow.kind === "html" ||
    /\.(md|markdown|html|htm)$/i.test(workflow.relativePath)
  );
}

function flattenWorkflowArtifacts(
  run: WorkflowRunSummary,
): WorkflowArtifactDescriptor[] {
  return run.artifacts.flatMap((artifact) => [
    { artifact },
    ...(artifact.assets ?? []).map((asset) => ({ artifact: asset })),
  ]);
}

function workflowContentToArtifact(content: WorkflowArtifactContent): Artifact {
  const artifact = content.artifact;
  const parent = isTopLevelWorkflowArtifact(artifact)
    ? artifact
    : findWorkflowParentArtifact(content.run, artifact.id);
  const reviewable = isTopLevelWorkflowArtifact(artifact)
    ? artifact.reviewable
    : false;
  const group = parent?.group ?? "scratch";
  const stage = parent?.stage ?? "asset";

  return {
    id: artifact.id,
    stage,
    title: artifact.title,
    markdown: content.displayMarkdown,
    metadata: {
      taskId: content.run.runId,
      sourceRefs: [content.relativePath],
      workflow: {
        artifactId: artifact.id,
        group,
        kind: content.kind,
        parentArtifactId:
          !isTopLevelWorkflowArtifact(artifact) && parent
            ? parent.id
            : undefined,
        relativePath: content.relativePath,
        reviewable,
        runId: content.run.runId,
        runKey: content.run.runKey,
        warning: artifact.warning,
      },
    },
  };
}

function isTopLevelWorkflowArtifact(
  artifact: NormalizedWorkflowArtifact | WorkflowAsset,
): artifact is NormalizedWorkflowArtifact {
  return "group" in artifact;
}

function findWorkflowParentArtifact(
  run: WorkflowRunSummary,
  assetId: string,
): NormalizedWorkflowArtifact | undefined {
  return run.artifacts.find((artifact) =>
    artifact.assets?.some((asset) => asset.id === assetId),
  );
}

type SelectionPopoverProps = {
  pendingSelection: PendingSelection;
  draft: CommentDraft | null;
  onStart: () => void;
  onCancel: () => void;
  onAdd: (event: FormEvent<HTMLFormElement>) => void;
  onDraftChange: (draft: CommentDraft) => void;
};

function SelectionPopover({
  pendingSelection,
  draft,
  onStart,
  onCancel,
  onAdd,
  onDraftChange,
}: SelectionPopoverProps) {
  const style = getPopoverStyle(pendingSelection, draft !== null);

  if (!draft) {
    return (
      <div
        className="selection-popover compact-popover"
        style={style}
      >
        <button className="icon-button primary" onClick={onStart} type="button">
          <MessageSquarePlus size={17} aria-hidden="true" />
          <span>评论</span>
        </button>
      </div>
    );
  }

  return (
    <form
      className="selection-popover comment-popover"
      onSubmit={onAdd}
      style={style}
    >
      <blockquote>{pendingSelection.anchor.quote}</blockquote>
      <textarea
        autoFocus
        onChange={(event) =>
          onDraftChange({ ...draft, body: event.target.value })
        }
        placeholder="输入评论"
        value={draft.body}
      />
      <div className="comment-controls">
        <select
          aria-label="草稿评论类型"
          onChange={(event) =>
            onDraftChange({
              ...draft,
              category: event.target.value as CommentCategory,
            })
          }
          value={draft.category}
        >
          {categories.map((category) => (
            <option key={category} value={category}>
              {categoryLabels[category]}
            </option>
          ))}
        </select>
      </div>
      <div className="popover-actions">
        <button className="text-button" onClick={onCancel} type="button">
          取消
        </button>
        <button className="icon-button primary" disabled={!draft.body.trim()} type="submit">
          <Check size={16} aria-hidden="true" />
          <span>添加</span>
        </button>
      </div>
    </form>
  );
}

function getPopoverStyle(
  selection: PendingSelection,
  isExpanded: boolean,
): CSSProperties {
  const position = getPopoverPosition({
    selectionRect: selection.rect,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    popoverWidth: 320,
    estimatedHeight: isExpanded ? 390 : 58,
  });

  return {
    left: position.left,
    maxHeight: position.maxHeight,
    top: position.top,
    width: position.width,
  };
}

function createCommentId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `comment-${Date.now()}`;
}

function formatRunStatus(status: ReviewRunRecord["status"]): string {
  if (status === "accepted") {
    return "已接受";
  }

  if (status === "rejected") {
    return "已拒绝";
  }

  return "待确认";
}

function getCliSessionKind(provider: AgentProvider): CliSessionKind {
  if (provider === "codex") {
    return "codex_cli_session";
  }

  return "traex_cli_session";
}

function formatLauncherProvider(provider: AgentProvider): string {
  if (provider === "codex") {
    return "Codex 对话";
  }

  return "TraeX 对话";
}

function formatCliSessionPlaceholder(provider: AgentProvider): string {
  if (provider === "codex") {
    return "可选：粘贴 Codex CLI session id";
  }

  return "可选：粘贴 TraeX CLI session id";
}

function formatSessionBinding(session: ReviewSession): string {
  if (session.externalSessionId && session.externalSessionKind) {
    return session.externalSessionKind === "codex_cli_session"
      ? "已绑定 Codex CLI"
      : "已绑定 TraeX CLI";
  }

  if (session.launcherContext?.sessionKind === "codex_thread") {
    return "已连接 Codex Desktop 原对话";
  }

  if (session.launcherContext?.sessionKind === "traex_thread") {
    return "已记录 TraeX 对话启动来源，未绑定 CLI 会话";
  }

  if (session.launcherContext?.sessionKind === "codex_cli_session") {
    return "已连接 Codex CLI 启动会话";
  }

  if (session.launcherContext?.sessionKind === "traex_cli_session") {
    return "已连接 TraeX CLI 启动会话";
  }

  return "未绑定 CLI 会话";
}

function isPreviewOnlySession(session: ReviewSession): boolean {
  return (
    !session.launcherContext &&
    !session.externalSessionId &&
    !session.externalSessionKind
  );
}

function isPreviewOnlyLaunch(bootstrap: ReviewWorkspaceBootstrap): boolean {
  if (bootstrap.previewOnly) {
    return true;
  }

  if (typeof window === "undefined") {
    return false;
  }

  return new URLSearchParams(window.location.search).get("doreyMode") === "preview";
}

function resolveAgentExecutionTarget(
  agentMode: AgentMode,
  session: ReviewSession,
): AgentExecutionTarget {
  if (session.launcherContext?.sessionKind === "codex_thread") {
    return "codex_desktop";
  }

  if (session.externalSessionKind === "codex_cli_session" && session.externalSessionId) {
    return "codex_cli";
  }

  if (session.externalSessionKind === "traex_cli_session" && session.externalSessionId) {
    return "traex_cli";
  }

  if (session.launcherContext?.sessionKind === "codex_cli_session") {
    return "codex_cli";
  }

  if (session.launcherContext?.sessionKind === "traex_cli_session") {
    return "traex_cli";
  }

  return agentMode === "traex" ? "traex_cli" : "codex_cli";
}

function providerForExecutionTarget(target: AgentExecutionTarget): AgentProvider {
  if (target === "traex_cli") {
    return "traex";
  }

  return "codex";
}

type ExecutionVisibility = {
  body: string;
  tone: "attached" | "ephemeral";
};

function getExecutionVisibility(
  target: AgentExecutionTarget,
  session: ReviewSession,
): ExecutionVisibility {
  if (target === "codex_desktop" && session.launcherContext?.sessionId) {
    return {
      body: `本次 submit 会进入 Codex Desktop 原对话 ${session.launcherContext.sessionId} 的 poll 队列。原对话运行页面给出的 poll 命令后，会收到完整 payload 文件路径和回复地址。`,
      tone: "attached",
    };
  }

  if (target === "codex_cli" && session.externalSessionKind === "codex_cli_session" && session.externalSessionId) {
    return {
      body: `本次 submit 会进入 Codex CLI 会话 ${session.externalSessionId} 的 poll 队列；不会启动独立 resume 子进程。`,
      tone: "attached",
    };
  }

  if (target === "traex_cli" && session.externalSessionKind === "traex_cli_session" && session.externalSessionId) {
    return {
      body: `本次 submit 会进入 TraeX CLI 会话 ${session.externalSessionId} 的 poll 队列。请在当前 TraeX 会话里运行 poll 命令，prompt 会作为命令输出回到原会话。`,
      tone: "attached",
    };
  }

  const agentName = target === "traex_cli" ? "TraeX" : "Codex";

  return {
    body: `未绑定 CLI 会话。本次 submit 仍会进入本地 ${agentName} poll 队列；请按页面返回的 poll 命令在负责该审阅的 Agent 会话中处理。`,
    tone: "ephemeral",
  };
}

function isQueuedRevisionSubmission(
  response: BatchRevisionSubmitResponse,
): response is QueuedRevisionSubmission {
  return "status" in response && response.status === "queued";
}

async function fetchRevisionSubmissionStatus(
  requestId: string,
): Promise<RevisionSubmissionStatus> {
  const response = await fetch(
    `/api/agent/submissions/${encodeURIComponent(requestId)}`,
  );

  if (!response.ok) {
    throw new Error(await readHttpError(response));
  }

  return (await response.json()) as RevisionSubmissionStatus;
}

async function readHttpError(response: Response): Promise<string> {
  const text = await response.text();

  if (!text) {
    return `HTTP ${response.status}`;
  }

  try {
    const body = JSON.parse(text) as { error?: unknown };

    if (typeof body.error === "string") {
      return body.error;
    }
  } catch {
    return text;
  }

  return text;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
