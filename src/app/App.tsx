import {
  Check,
  FileText,
  FolderOpen,
  MessageSquarePlus,
  Pencil,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import {
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
  CommentKind,
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
import {
  getCommentKind,
  hasRevisionIntent,
  normalizeCommentResponse,
} from "../review/comment-kind.js";
import { getPopoverPosition } from "../review/popover-position.js";
import { TraexAgentAdapter } from "../review/traex-agent-adapter.js";
import { extractMarkdownH1 } from "../shared/markdown-document.js";
import { DiffView } from "./components/DiffView";
import { HtmlDocument } from "./components/HtmlDocument";
import { MarkdownDocument } from "./components/MarkdownDocument";
import doreyPronunciationUrl from "./assets/dorey-pronunciation.m4a?url";
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
  getWorkflowAssetUrl,
  getWorkflowRun,
  listWorkflowRuns,
  saveWorkflowReviewResult,
  saveWorkflowRevisionTrace,
} from "./workflow-run-client";

type ViewerMode = "current" | "revised" | "diff";
type AgentMode = AgentProvider;
type AgentExecutionTarget = "codex_desktop" | "codex_cli" | "traex_cli";
type AgentPresenceState = "waiting" | "listening" | "working";
type ReviewLifecycleState =
  | "listening"
  | "queued"
  | "working"
  | "completed"
  | "review_closed"
  | "waiting";

type CommentDraft = {
  body: string;
  kind: CommentKind;
};

type AgentResult = {
  requestId?: string;
  comments: QueuedComment[];
  sourceMarkdown: string;
  response: BatchRevisionResponse;
  diff: RenderedDiffEntry[];
  hasMarkdownChanges: boolean;
  hasRevisionIntent: boolean;
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
  targetKey: string;
  targetLabel: string;
  workflow?: {
    artifactId: string;
    runKey: string;
  };
};

const executionTargetLabels: Record<AgentExecutionTarget, string> = {
  codex_desktop: "Codex Desktop（原对话）",
  codex_cli: "Codex CLI（本地）",
  traex_cli: "TraeX CLI（本地）",
};

const submitTimeoutMs = 90_000;

export function App() {
  const [artifacts, setArtifacts] = useState<Artifact[]>(cloneInitialArtifacts);
  const [bootstrap] = useState(getReviewWorkspaceBootstrap);
  const [isPreviewOnlyLaunchMode] = useState(() =>
    isPreviewOnlyLaunch(bootstrap),
  );
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRunSummary[]>([]);
  const [workflowBootstrapComplete, setWorkflowBootstrapComplete] = useState(false);
  const [activeWorkflowRunKey, setActiveWorkflowRunKey] = useState<
    string | null
  >(null);
  const [isLoadingWorkflow, setIsLoadingWorkflow] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
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
  const [pendingSubmissionStatus, setPendingSubmissionStatus] = useState<
    RevisionSubmissionStatus["status"] | null
  >(null);
  const [viewerMode, setViewerMode] = useState<ViewerMode>("current");
  const [agentMode, setAgentMode] = useState<AgentMode>(
    bootstrap.currentAgentProvider ?? "codex",
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [explanationDeliveryNotice, setExplanationDeliveryNotice] = useState<
    string | null
  >(null);
  const [reviewClosed, setReviewClosed] = useState(false);
  const [agentPresence, setAgentPresence] = useState<AgentPresenceState | null>(null);
  const submitAbortRef = useRef<AbortController | null>(null);
  const appliedSubmissionIdsRef = useRef(new Set<string>());
  const recoveredSubmissionTargetRef = useRef<string | null>(null);
  const markdownRootRef = useRef<HTMLDivElement>(null);
  const presenceTargetKey = pendingSubmission?.targetKey || bootstrap.targetKey;

  useEffect(() => {
    setAgentPresence(null);
    if (!presenceTargetKey || isPreviewOnlyLaunchMode) return;

    let cancelled = false;
    let timer: number | undefined;
    const checkPresence = async () => {
      try {
        const response = await fetch(
          `/api/agent/presence?target=${encodeURIComponent(presenceTargetKey)}`,
        );
        if (!response.ok) throw new Error(await response.text());
        const body = (await response.json()) as { state?: AgentPresenceState };
        if (!cancelled && body.state) setAgentPresence(body.state);
      } catch {
        if (!cancelled) setAgentPresence(null);
      } finally {
        if (!cancelled) timer = window.setTimeout(checkPresence, 1500);
      }
    };

    void checkPresence();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [isPreviewOnlyLaunchMode, presenceTargetKey]);

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
  const commentCounts = useMemo(
    () =>
      commentsForArtifact.reduce(
        (counts, comment) => {
          counts[getCommentKind(comment)] += 1;
          return counts;
        },
        { revision: 0, explanation: 0 } satisfies Record<CommentKind, number>),
    [commentsForArtifact],
  );

  const navigationArtifacts = useMemo(
    () => artifacts.filter(isDefaultUserVisibleArtifact),
    [artifacts],
  );
  const activeRun = useMemo(
    () => workflowRuns.find((run) => run.runKey === activeWorkflowRunKey),
    [activeWorkflowRunKey, workflowRuns],
  );
  const resolveActiveImageUrl = useCallback(
    (source: string) => {
      const workflow = activeArtifact?.metadata?.workflow;

      return workflow
        ? getWorkflowAssetUrl(workflow.runKey, workflow.relativePath, source)
        : source;
    },
    [
      activeArtifact?.metadata?.workflow?.relativePath,
      activeArtifact?.metadata?.workflow?.runKey,
    ],
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

    void fetch("/api/dorey/review")
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as { status?: string })
          : undefined,
      )
      .then((status) => {
        if (!cancelled && status?.status === "review_closed") {
          setReviewClosed(true);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (reviewClosed) {
      setPendingSubmission(null);
      setPendingSubmissionStatus(null);
    }
  }, [reviewClosed]);

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
      } finally {
        if (!cancelled) setWorkflowBootstrapComplete(true);
      }
    }

    void bootstrapWorkflowRuns();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const targetKey = bootstrap.targetKey;
    if (
      !workflowBootstrapComplete ||
      isPreviewOnlyLaunchMode ||
      reviewClosed ||
      !targetKey ||
      recoveredSubmissionTargetRef.current === targetKey
    ) {
      return;
    }

    recoveredSubmissionTargetRef.current = targetKey;
    let cancelled = false;

    void fetchLatestUnacknowledgedSubmission(targetKey)
      .then((status) => {
        if (cancelled || !status) return;
        const recovered = pendingSubmissionFromStatus(status, artifacts);
        if (recovered) {
          setPendingSubmission(recovered);
          setPendingSubmissionStatus(status.status);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSubmitError(
            `恢复最近一次评审提交失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [artifacts, bootstrap.targetKey, isPreviewOnlyLaunchMode, reviewClosed, workflowBootstrapComplete]);

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

        setPendingSubmissionStatus(status.status);

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
    setExplanationDeliveryNotice(null);
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
      setPendingSubmissionStatus(null);
      setPendingSelection(null);
      setCommentDraft(null);
      setExpandedCommentId(null);
      setSourceEditDraft(null);
      setExternalSessionDraft("");
      setGlobalInstruction("");
      setExplanationDeliveryNotice(null);
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
  const submitButtonLabel =
    commentCounts.explanation > 0 &&
    commentCounts.revision === 0 &&
    globalInstruction.trim().length === 0
      ? "提交问题"
      : commentCounts.explanation === 0
        ? "提交修订"
        : "提交全部";
  const canSubmit =
    hasSubmitContent &&
    !reviewClosed &&
    !isSubmitting &&
    pendingSubmission === null &&
    activeSession !== undefined &&
    activeSessionLink !== undefined &&
    isActiveArtifactReviewable;
  const visibleMarkdown =
    viewerMode === "revised" && agentResult
      ? agentResult.response.revisedMarkdown
      : active.markdown;
  const reviewLifecycleState = getReviewLifecycleState({
    agentPresence,
    hasCompletedRevision: agentResult !== null,
    pendingSubmissionStatus,
    reviewClosed,
  });
  const reviewLifecycleCopy = getReviewLifecycleCopy(reviewLifecycleState);

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
      kind: "revision",
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
      kind: commentDraft.kind,
      status: "queued",
      createdAt: new Date().toISOString(),
    };

    setQueuedComments((current) => [...current, comment]);
    cancelCommentDraft();
  }

  function updateComment(
    commentId: string,
    patch: Partial<Pick<QueuedComment, "body" | "kind">>,
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
    setExplanationDeliveryNotice(null);
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
        targetKey: bootstrap.targetKey ?? "",
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
          targetKey: response.target.key,
          targetLabel: response.target.label,
        });
        setPendingSubmissionStatus("queued");
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

  async function closeReview() {
    const response = await fetch("/api/dorey/review", { method: "POST" });

    if (!response.ok) {
      setSubmitError(`结束评审失败：${await response.text()}`);
      return;
    }

    setReviewClosed(true);
    setPendingSubmission(null);
    setPendingSubmissionStatus(null);
    setSubmitStatus("评审已结束；foreground poll 已停止。");
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
        comments: [],
        sourceMarkdown,
        response,
        diff: createRenderedDiff(sourceMarkdown, response.revisedMarkdown),
        hasMarkdownChanges: true,
        hasRevisionIntent: true,
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
    const containsRevisionIntent = hasRevisionIntent(
      pending.comments,
      pending.request.globalInstruction,
    );
    const normalizedResponse = normalizeCommentResponse({
      comments: pending.comments,
      globalInstruction: pending.request.globalInstruction,
      response,
      sourceMarkdown: pending.sourceMarkdown,
    });
    const hasMarkdownChanges =
      pending.sourceMarkdown !== normalizedResponse.revisedMarkdown;
    // Completed results stay durable and recoverable until their changes are accepted.
    // Explanation-only and no-change responses have no acceptance step.
    const shouldAcknowledge =
      !pending.requestId.startsWith("direct-") && !hasMarkdownChanges;
    if (appliedSubmissionIdsRef.current.has(pending.requestId)) {
      if (shouldAcknowledge) await acknowledgeRevisionSubmission(pending.requestId);
      setPendingSubmission((current) =>
        current?.requestId === pending.requestId ? null : current,
      );
      setPendingSubmissionStatus(null);
      return;
    }

    const proposedReviewRun = createReviewRunRecord({
      adapter: pending.executionProvider,
      artifactId: pending.artifactId,
      comments: pending.comments,
      contextSnapshot: pending.contextSnapshot,
      now: completedAt,
      sessionId: pending.request.session?.id ?? activeSession?.id ?? "session-main",
      summary: normalizedResponse.summary,
    });
    const reviewRun: ReviewRunRecord = hasMarkdownChanges
      ? proposedReviewRun
      : { ...proposedReviewRun, status: "completed" };
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
        response: normalizedResponse,
        runKey: pending.workflow.runKey,
        submittedAt: pending.submittedAt,
      });
    }

    setActiveArtifactId(pending.artifactId);
    const explanationCount = pending.comments.filter(
      (comment) => getCommentKind(comment) === "explanation",
    ).length;

    setExplanationDeliveryNotice(
      explanationCount > 0
        ? `${explanationCount} 个问题已在原 Agent 对话中回答。`
        : null,
    );
    setAgentResult(
      containsRevisionIntent
        ? {
            requestId: pending.requestId.startsWith("direct-") ? undefined : pending.requestId,
            comments: pending.comments,
            sourceMarkdown: pending.sourceMarkdown,
            response: normalizedResponse,
            diff: createRenderedDiff(
              pending.sourceMarkdown,
              normalizedResponse.revisedMarkdown,
            ),
            hasMarkdownChanges,
            hasRevisionIntent: containsRevisionIntent,
            runId: reviewRun.id,
            contextSnapshot: pending.contextSnapshot,
            revisionSource: "agent",
            workflowRevisionTrace,
          }
        : null,
    );
    setReviewRuns((current) => [...current, reviewRun]);
    const completedCommentIds = new Set(
      pending.comments
        .filter(
          (comment) =>
            !hasMarkdownChanges || getCommentKind(comment) === "explanation",
        )
        .map((comment) => comment.id),
    );
    setQueuedComments((current) => {
      const remaining = current.filter((comment) => !completedCommentIds.has(comment.id));
      // A refreshed page starts with an empty queue; restore only revisions still awaiting acceptance.
      const existingIds = new Set(remaining.map((comment) => comment.id));
      return [...remaining, ...pending.comments.filter(
        (comment) => !completedCommentIds.has(comment.id) && !existingIds.has(comment.id),
      )];
    });
    appliedSubmissionIdsRef.current.add(pending.requestId);
    if (shouldAcknowledge) await acknowledgeRevisionSubmission(pending.requestId);
    setPendingSubmission((current) =>
      current?.requestId === pending.requestId ? null : current,
    );
    setPendingSubmissionStatus(null);
    setSubmitError(null);
    setSubmitStatus(null);
    setViewerMode(hasMarkdownChanges ? "revised" : "current");
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

    if (agentResult.requestId) {
      try {
        await acknowledgeRevisionSubmission(agentResult.requestId, true);
      } catch (error) {
        // Keep the result available for retry. Workflow source writeback is idempotent.
        setSubmitError(
          `修订已写回，但确认结果失败，请重试接受：${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }
    setSubmitError(null);

    setArtifacts((current) =>
      current.map((artifact) =>
        artifact.id === active.id
          ? {
              ...artifact,
              markdown: agentResult.response.revisedMarkdown,
              title:
                extractMarkdownH1(agentResult.response.revisedMarkdown) ?? artifact.title,
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
    setPendingSubmissionStatus(null);
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
    setExplanationDeliveryNotice(null);
    window.getSelection()?.removeAllRanges();
  }

  function changeAgentMode(nextMode: AgentMode) {
    setAgentMode(nextMode);
    setExplanationDeliveryNotice(null);
    setAgentResult(null);
    setSourceEditDraft(null);
    setViewerMode("current");
    setSubmitError(null);
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
    setExplanationDeliveryNotice(null);
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
    setExplanationDeliveryNotice(null);
    setAgentResult(null);
    setSourceEditDraft(null);
    setViewerMode("current");
  }

  function chooseArtifact(artifactId: string) {
    setActiveArtifactId(artifactId);
    setPendingSelection(null);
    setCommentDraft(null);
    setExpandedCommentId(null);
    setExplanationDeliveryNotice(null);
    setAgentResult(null);
    setSourceEditDraft(null);
    setViewerMode("current");
  }

  function playDoreyPronunciation() {
    const audio = new Audio(doreyPronunciationUrl);
    audio.volume = 0.72;
    void audio.play().catch(() => undefined);
  }

  return (
    <main className="app-shell">
      <aside className="artifact-sidebar">
        <div className="sidebar-heading">
          <div className="sidebar-brand-row">
            <h1>Dorey</h1>
            <button
              aria-label="播放 Dorey 发音"
              className="pronunciation-button"
              onClick={playDoreyPronunciation}
              title="播放 Dorey 发音"
              type="button"
            >
              <Volume2 size={11} aria-hidden="true" />
            </button>
          </div>
          <p>Doc Review · 本地审阅闭环</p>
        </div>

        {workflowError ? (
          <p className="error-message workflow-error">{workflowError}</p>
        ) : null}

        <div className="document-tree-heading">
          <strong>文档</strong>
          <span>{navigationArtifacts.length} 篇</span>
        </div>

        <div className="document-tree-root">
          <FolderOpen size={16} aria-hidden="true" />
          <span>{activeRun?.taskTitle ?? "本地文档"}</span>
        </div>

        {isLoadingWorkflow ? (
          <p className="document-tree-loading">正在加载文档…</p>
        ) : (
          <DocumentTree
            activeArtifactId={activeArtifact.id}
            artifacts={navigationArtifacts}
            onChoose={chooseArtifact}
          />
        )}
        <p className="sidebar-signature">Powered by JO</p>
      </aside>

      <section className="reader-column">
        <div className="workspace-toolbar">
          <div className="workspace-document-heading">
            <h2>{activeArtifact.title}</h2>
            <p>{displayPathForArtifact(activeArtifact)}</p>
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
              disabled={reviewClosed}
              onClick={() => void closeReview()}
              title="结束评审并通知 Agent 停止监听"
              type="button"
            >
              <X size={16} aria-hidden="true" />
              <span>{reviewClosed ? "评审已结束" : "结束评审"}</span>
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
            <DiffView diff={agentResult.diff} resolveImageUrl={resolveActiveImageUrl} />
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
                resolveImageUrl={resolveActiveImageUrl}
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
              <p>
                {commentCounts.revision} 条修订 · {commentCounts.explanation} 条解释
              </p>
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
                        <span
                          className={`comment-kind-badge comment-kind-${getCommentKind(comment)}`}
                        >
                          {getCommentKind(comment) === "revision" ? "修订" : "解释"}
                        </span>
                        <small>{comment.anchor.blockId}</small>
                      </div>
                      <div className="comment-item-actions">
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
                        <CommentKindControl
                          kind={getCommentKind(comment)}
                          onChange={(kind) => updateComment(comment.id, { kind })}
                        />
                        <textarea
                          aria-label="评论正文"
                          onChange={(event) =>
                            updateComment(comment.id, { body: event.target.value })
                          }
                          value={comment.body}
                        />
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
              <h2>全文修订要求（可选）</h2>
              <p>这里的内容始终会作为文档修改要求</p>
            </div>
            <button
              aria-label="清空全文修订要求"
              className="text-button clear-global-comment"
              disabled={globalInstruction.length === 0 || isSubmitting}
              onClick={() => setGlobalInstruction("")}
              type="button"
            >
              <Trash2 size={14} aria-hidden="true" />
              <span>清空</span>
            </button>
          </div>

          <textarea
            aria-label="全文修订要求"
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
                  : submitButtonLabel}
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
          {explanationDeliveryNotice ? (
            <p className="conversation-reply-notice" role="status">
              {explanationDeliveryNotice}
            </p>
          ) : null}
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

          {!isPreviewOnlyLaunchMode && presenceTargetKey ? (
            <div
              className="agent-note agent-presence-note review-lifecycle"
              data-state={reviewLifecycleState}
              role="status"
            >
              <span>Agent 状态 · 评审链路 · {reviewLifecycleCopy.label}</span>
              <p>{reviewLifecycleCopy.nextAction}</p>
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
                    已排队到 {pendingSubmission.targetLabel}。原 Agent 会话的
                    foreground poll 会自动领取；请保持启动 Dorey 的 turn 运行。
                  </p>
                </div>
                <span className="status-chip">{reviewLifecycleCopy.label}</span>
              </div>

              <section className="result-section">
                <h4>
                  配置原会话命令
                </h4>
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
                onClick={() => {
                  setPendingSubmission(null);
                  setPendingSubmissionStatus(null);
                }}
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
                  <p>
                    {agentResult.hasMarkdownChanges
                      ? "已生成修订，当前文档已切到“修订”视图。"
                      : "Agent 已处理评论，但没有修改文档。"}
                  </p>
                </div>
                <span className="status-chip">
                  {agentResult.hasMarkdownChanges
                    ? "待接受"
                    : "无需接受"}
                </span>
              </div>

              <section className="result-section">
                <h4>摘要</h4>
                <p className="result-text">
                  {agentResult.response.summary.trim() || "Agent 未返回摘要。"}
                </p>
              </section>

              <section className="result-section">
                <h4>
                  修订处理结果
                </h4>
                  {getRevisionAddressedComments(agentResult).length > 0 ? (
                    <ol className="addressed-comment-list">
                    {getRevisionAddressedComments(agentResult).map((item) => {
                      const sourceComment = agentResult.comments.find(
                        (comment) => comment.id === item.commentId,
                      );

                      return (
                        <li key={item.commentId}>
                          <div className="result-comment-meta">
                            {sourceComment ? (
                              <span
                                className={`comment-kind-badge comment-kind-${getCommentKind(sourceComment)}`}
                              >
                                修订
                              </span>
                            ) : null}
                            <span className="comment-id">{item.commentId}</span>
                          </div>
                          {sourceComment ? (
                            <blockquote>{sourceComment.anchor.quote}</blockquote>
                          ) : null}
                          <p className="result-text">{item.resolution}</p>
                        </li>
                      );
                    })}
                  </ol>
                  ) : (
                  <p className="result-empty">暂无逐条修订说明。</p>
                )}
              </section>

              {agentResult.hasMarkdownChanges ? (
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
              ) : null}

              {agentResult.workflowRevisionTrace ? (
                <section className="result-section">
                  <h4>
                    {agentResult.hasMarkdownChanges ? "写回文件" : "处理记录"}
                  </h4>
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

              {agentResult.hasMarkdownChanges ? (
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
              ) : (
                <div className="result-actions">
                  <button
                    className="text-button"
                    onClick={() => setAgentResult(null)}
                    type="button"
                  >
                    完成本轮
                  </button>
                </div>
              )}
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

type WorkflowArtifactDescriptor = {
  artifact: NormalizedWorkflowArtifact | WorkflowAsset;
};

type DocumentTreeNode = {
  artifacts: Artifact[];
  directories: DocumentTreeNode[];
  name: string;
  path: string;
};

function DocumentTree({
  activeArtifactId,
  artifacts,
  onChoose,
}: {
  activeArtifactId: string;
  artifacts: Artifact[];
  onChoose: (artifactId: string) => void;
}) {
  const root = buildDocumentTree(artifacts);

  return (
    <div className="document-tree" role="tree">
      <DocumentTreeLevel
        activeArtifactId={activeArtifactId}
        node={root}
        onChoose={onChoose}
      />
    </div>
  );
}

function DocumentTreeLevel({
  activeArtifactId,
  node,
  onChoose,
}: {
  activeArtifactId: string;
  node: DocumentTreeNode;
  onChoose: (artifactId: string) => void;
}) {
  return (
    <>
      {node.directories.map((directory) => (
        <div className="document-tree-directory" key={directory.path} role="treeitem">
          <div className="document-tree-folder">
            <FolderOpen size={14} aria-hidden="true" />
            <span>{directory.name}</span>
          </div>
          <div className="document-tree-children" role="group">
            <DocumentTreeLevel
              activeArtifactId={activeArtifactId}
              node={directory}
              onChoose={onChoose}
            />
          </div>
        </div>
      ))}

      {node.artifacts.map((artifact) => {
        const fileName = fileNameForArtifact(artifact);
        const selected = artifact.id === activeArtifactId;

        return (
          <button
            aria-selected={selected}
            className={selected ? "document-tree-file active" : "document-tree-file"}
            key={artifact.id}
            onClick={() => onChoose(artifact.id)}
            role="treeitem"
            type="button"
          >
            <FileText size={14} aria-hidden="true" />
            <span className="document-tree-file-label">
              <strong>{fileName}</strong>
              {artifact.title !== titleFromFileName(fileName) ? (
                <small>{artifact.title}</small>
              ) : null}
            </span>
          </button>
        );
      })}
    </>
  );
}

function buildDocumentTree(artifacts: Artifact[]): DocumentTreeNode {
  const root: DocumentTreeNode = {
    artifacts: [],
    directories: [],
    name: "",
    path: "",
  };

  for (const artifact of artifacts) {
    const segments = displayPathForArtifact(artifact).split("/").filter(Boolean);
    const fileName = segments.pop();

    if (!fileName) {
      continue;
    }

    let current = root;

    for (const segment of segments) {
      const directoryPath = current.path ? `${current.path}/${segment}` : segment;
      let directory = current.directories.find((item) => item.name === segment);

      if (!directory) {
        directory = {
          artifacts: [],
          directories: [],
          name: segment,
          path: directoryPath,
        };
        current.directories.push(directory);
      }

      current = directory;
    }

    current.artifacts.push(artifact);
  }

  sortDocumentTree(root);
  return root;
}

function sortDocumentTree(node: DocumentTreeNode): void {
  node.directories.sort((left, right) =>
    left.name.localeCompare(right.name, "en", { numeric: true }),
  );
  node.artifacts.sort((left, right) =>
    fileNameForArtifact(left).localeCompare(fileNameForArtifact(right), "en", { numeric: true }),
  );

  for (const directory of node.directories) {
    sortDocumentTree(directory);
  }
}

function displayPathForArtifact(artifact: Artifact): string {
  const relativePath =
    artifact.metadata?.workflow?.relativePath ?? artifact.metadata?.sourceRefs?.[0] ?? artifact.title;

  return relativePath.replaceAll("\\", "/").replace(/^documents\//, "");
}

function fileNameForArtifact(artifact: Artifact): string {
  return displayPathForArtifact(artifact).split("/").pop() ?? artifact.title;
}

function titleFromFileName(fileName: string): string {
  return fileName.replace(/\.(?:md|markdown|html|htm)$/i, "").replace(/[-_]+/g, " ");
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
    title:
      content.kind === "markdown"
        ? extractMarkdownH1(content.content) ?? artifact.title
        : artifact.title,
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

type CommentKindControlProps = {
  kind: CommentKind;
  onChange: (kind: CommentKind) => void;
};

function CommentKindControl({ kind, onChange }: CommentKindControlProps) {
  return (
    <div aria-label="评论类型" className="comment-kind-control" role="group">
      <button
        aria-pressed={kind === "revision"}
        className={kind === "revision" ? "active" : undefined}
        onClick={() => onChange("revision")}
        type="button"
      >
        修订
      </button>
      <button
        aria-pressed={kind === "explanation"}
        className={kind === "explanation" ? "active" : undefined}
        onClick={() => onChange("explanation")}
        type="button"
      >
        解释
      </button>
    </div>
  );
}

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
      <CommentKindControl
        kind={draft.kind}
        onChange={(kind) => onDraftChange({ ...draft, kind })}
      />
      <p className="comment-kind-help">
        {draft.kind === "revision"
          ? "Agent 会根据评论修改原文。"
          : "Agent 会在原对话回答，不修改原文。"}
      </p>
      <textarea
        autoFocus
        onChange={(event) =>
          onDraftChange({ ...draft, body: event.target.value })
        }
        placeholder={
          draft.kind === "revision" ? "说明希望如何修改" : "你想了解什么？"
        }
        value={draft.body}
      />
      <div className="popover-actions">
        <button className="text-button" onClick={onCancel} type="button">
          取消
        </button>
        <button className="icon-button primary" disabled={!draft.body.trim()} type="submit">
          <Check size={16} aria-hidden="true" />
          <span>{draft.kind === "revision" ? "添加修订" : "添加解释"}</span>
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

  if (status === "completed") {
    return "已处理";
  }

  return "待确认";
}

function formatAgentPresence(state: AgentPresenceState | null): string {
  if (state === "listening") return "正在监听；Submit 会自动送达原 Agent 会话。";
  if (state === "working") return "已领取反馈，Agent 正在处理。";
  if (state === "waiting") return "当前没有 Agent poll；Submit 会保留在队列中。";
  return "暂时无法确认 Agent 是否正在监听。";
}

function getReviewLifecycleState(input: {
  agentPresence: AgentPresenceState | null;
  hasCompletedRevision: boolean;
  pendingSubmissionStatus: RevisionSubmissionStatus["status"] | null;
  reviewClosed: boolean;
}): ReviewLifecycleState {
  if (input.reviewClosed) return "review_closed";
  if (input.hasCompletedRevision || input.pendingSubmissionStatus === "completed") {
    return "completed";
  }
  if (input.pendingSubmissionStatus === "delivered" || input.agentPresence === "working") {
    return "working";
  }
  if (input.pendingSubmissionStatus === "queued") return "queued";
  if (input.agentPresence === "listening") return "listening";
  return "waiting";
}

function getReviewLifecycleCopy(state: ReviewLifecycleState): {
  label: string;
  nextAction: string;
} {
  if (state === "listening") {
    return {
      label: "正在监听",
      nextAction: "可以提交评审意见，Dorey 会自动送达原 Agent 会话。",
    };
  }
  if (state === "queued") {
    return {
      label: "已排队",
      nextAction: "已排队，等待 Agent 领取；请保持启动 Dorey 的任务运行。",
    };
  }
  if (state === "working") {
    return {
      label: "处理中",
      nextAction: "Agent 已领取，正在处理；完成后处理结果会自动回到页面。",
    };
  }
  if (state === "completed") {
    return {
      label: "已返回",
      nextAction: "处理结果已返回；有修订时可以查看差异并接受。",
    };
  }
  if (state === "review_closed") {
    return { label: "已结束", nextAction: "评审已结束，不再领取新任务。" };
  }
  return {
    label: "未监听",
    nextAction: "当前没有 foreground poll；从原 Agent 任务重新运行 Dorey 打开命令。",
  };
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

function getRevisionAddressedComments(result: AgentResult) {
  return result.response.addressedComments.filter((item) => {
    const sourceComment = result.comments.find(
      (comment) => comment.id === item.commentId,
    );

    return !sourceComment || getCommentKind(sourceComment) === "revision";
  });
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

async function fetchLatestUnacknowledgedSubmission(
  targetKey: string,
): Promise<RevisionSubmissionStatus | undefined> {
  const search = new URLSearchParams({
    limit: "1",
    target: targetKey,
    unacknowledged: "1",
  });
  const response = await fetch(`/api/agent/submissions?${search.toString()}`);
  if (!response.ok) throw new Error(await readHttpError(response));
  const body = (await response.json()) as { submissions?: RevisionSubmissionStatus[] };
  return body.submissions?.[0];
}

async function acknowledgeRevisionSubmission(requestId: string, accepted = false): Promise<void> {
  const response = await fetch(
    `/api/agent/submissions/${encodeURIComponent(requestId)}/acknowledge`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accepted }),
    },
  );
  if (!response.ok) throw new Error(await readHttpError(response));
}

function pendingSubmissionFromStatus(
  status: RevisionSubmissionStatus,
  artifacts: Artifact[],
): PendingAgentSubmission | undefined {
  if (status.acknowledgedAt || !status.request.contextSnapshot) return undefined;
  const artifact = artifacts.find((candidate) => candidate.id === status.request.artifact.id);
  if (!artifact) return undefined;
  const workflow = artifact.metadata?.workflow;

  return {
    agentPollCommand: status.agentPollCommand,
    artifactId: artifact.id,
    comments: status.request.comments,
    contextSnapshot: status.request.contextSnapshot,
    executionProvider: status.target.provider,
    payloadPath: status.payloadPath,
    pollCommand: status.pollCommand,
    replyCommand: status.replyCommand,
    request: status.request,
    requestId: status.requestId,
    sourceMarkdown: status.request.artifact.markdown,
    submittedAt: status.queuedAt,
    targetKey: status.target.key,
    targetLabel: status.target.label,
    workflow: workflow
      ? { artifactId: workflow.artifactId, runKey: workflow.runKey }
      : undefined,
  };
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
