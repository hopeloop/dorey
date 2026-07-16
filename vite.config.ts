import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

import { createCodexDesktopRevisionMiddleware } from "./src/server/codex-desktop-revision-endpoint.js";
import { createCodexRevisionMiddleware } from "./src/server/codex-revision-endpoint.js";
import { createTraexRevisionMiddleware } from "./src/server/traex-revision-endpoint.js";
import { createRevisionPollBroker } from "./src/server/revision-poll-broker.js";
import {
  createRevisionPollMiddleware,
  createRevisionSubmissionMiddleware,
} from "./src/server/revision-poll-endpoint.js";
import type { RevisionSubmissionRecord } from "./src/server/revision-poll-broker.js";
import type { DoreyLaunchMode } from "./src/server/revision-agent-poll-cli.js";
import { resolveLauncherContextFromEnv } from "./src/server/launcher-context.js";
import { createWorkflowRunMiddleware } from "./src/server/workflow-run-endpoint.js";
import { resolveWorkflowRoot } from "./src/server/workflow-root.js";

const defaultAutoStopIdleMs = 1_800_000;
const launcherContext = resolveLauncherContextFromEnv(process.env);
const launchMode = parseDoreyLaunchMode(process.env.DOREY_LAUNCH_MODE);
const previewOnly = process.env.DOREY_PREVIEW_ONLY === "1" || !launcherContext;
const workspaceRoot = path.resolve(process.env.DOREY_WORKSPACE_ROOT?.trim() || process.cwd());
const workflowRootResolution = resolveWorkflowRoot({
  configuredRoot: process.env.AI_CODING_WORKFLOW_ROOT,
  workspaceRoot,
});
const workflowRoot = workflowRootResolution.root;
const autoStopAfterReply = process.env.DOREY_AUTO_STOP_ON_REPLY === "1";
const autoStopIdleMs = numberOption(
  process.env.DOREY_AUTO_STOP_IDLE_MS,
  defaultAutoStopIdleMs,
);
let onRevisionFeedbackDelivered:
  | ((record: RevisionSubmissionRecord) => void)
  | undefined;
const revisionPollBroker = createRevisionPollBroker({
  onFeedbackDelivered: (record) => {
    onRevisionFeedbackDelivered?.(record);
  },
  payloadRoot: path.join(workspaceRoot, ".local", "markdown-review-submits"),
});

export default defineConfig({
  define: {
    __REVIEW_WORKSPACE_BOOTSTRAP__: JSON.stringify({
      currentAgentProvider: launcherContext?.provider,
      currentLauncherContext: launcherContext,
      currentSessionLabel: launcherContext?.label,
      launchMode,
      previewOnly,
    }),
  },
  plugins: [
    react(),
    {
      name: "markdown-review-codex-agent",
      configureServer(server) {
        let shutdownTimer: NodeJS.Timeout | undefined;
        let shuttingDown = false;
        const scheduleAutoStop = (reason: string, delayMs: number) => {
          if (!autoStopAfterReply || shuttingDown) {
            return;
          }

          if (shutdownTimer) {
            clearTimeout(shutdownTimer);
          }

          shutdownTimer = setTimeout(() => {
            if (shuttingDown) {
              return;
            }

            shuttingDown = true;
            process.stderr.write(`[dorey] Auto-stopping server: ${reason}.\n`);
            server.close().finally(() => {
              process.exit(0);
            });
          }, Math.max(0, delayMs));
          shutdownTimer.unref?.();
        };
        onRevisionFeedbackDelivered = (record) => {
          scheduleAutoStop(
            `idle timeout after delivering ${record.requestId}`,
            autoStopIdleMs,
          );
        };
        server.middlewares.use("/api/dorey/health", (_req, res) => {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              app: "dorey",
              launchMode,
              launcherContext,
              previewOnly,
              workspaceRoot,
              workflowRoot,
              autoStopAfterReply,
              autoStopIdleMs,
              workflowRootCandidates: workflowRootResolution.candidates,
              workflowRootSource: workflowRootResolution.source,
            }),
          );
        });
        server.middlewares.use("/api/dorey/shutdown", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ error: "Method not allowed." }));
            return;
          }

          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ status: "stopping" }));

          setTimeout(() => {
            if (shutdownTimer) {
              clearTimeout(shutdownTimer);
            }
            shuttingDown = true;
            server.close().finally(() => {
              process.exit(0);
            });
          }, 50);
        });
        server.middlewares.use(
          "/api/workflow-runs",
          createWorkflowRunMiddleware({ root: workflowRoot }),
        );
        server.middlewares.use(
          "/api/agent/poll",
          createRevisionPollMiddleware({ broker: revisionPollBroker }),
        );
        server.middlewares.use(
          "/api/agent/submissions",
          createRevisionSubmissionMiddleware({ broker: revisionPollBroker }),
        );
        server.middlewares.use(
          "/api/agent/codex/revise",
          createCodexRevisionMiddleware({
            broker: revisionPollBroker,
            cwd: workspaceRoot,
          }),
        );
        server.middlewares.use(
          "/api/agent/codex-desktop/revise",
          createCodexDesktopRevisionMiddleware({
            broker: revisionPollBroker,
            cwd: workspaceRoot,
          }),
        );
        server.middlewares.use(
          "/api/agent/traex/revise",
          createTraexRevisionMiddleware({
            broker: revisionPollBroker,
            cwd: workspaceRoot,
          }),
        );
      },
    },
  ],
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
  },
});

function numberOption(value: string | undefined, fallback: number): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function parseDoreyLaunchMode(value: string | undefined): DoreyLaunchMode | undefined {
  return value === "single-file" || value === "folder" || value === "demo"
    ? value
    : undefined;
}
