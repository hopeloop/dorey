import type { IncomingMessage, ServerResponse } from "node:http";

import type { QueuedRevisionSubmission } from "../contracts/revision.js";
import type { BatchRevisionRequest } from "../contracts/revision.js";
import {
  createAgentRevisionSubmitMiddleware,
  handleAgentRevisionSubmitRequest,
  resolveCodexDesktopPollTarget,
  type AgentRevisionSubmitHandlerOptions,
} from "./revision-poll-endpoint.js";

export type CodexDesktopRevisionHttpRequest = {
  baseUrl?: string;
  body: string;
  method?: string;
};

export type CodexDesktopRevisionHttpResponse =
  | {
      status: 200;
      body: QueuedRevisionSubmission;
    }
  | {
      status: 400 | 405 | 500;
      body: {
        error: string;
      };
    };

export type CodexDesktopRevisionHandlerOptions = Omit<
  AgentRevisionSubmitHandlerOptions,
  "targetResolver"
> & {
  onWakeError?: (error: unknown) => void;
  wake?: (input: {
    request: BatchRevisionRequest;
    submission: QueuedRevisionSubmission;
  }) => Promise<void>;
};

export async function handleCodexDesktopRevisionRequest(
  req: CodexDesktopRevisionHttpRequest,
  options: CodexDesktopRevisionHandlerOptions,
): Promise<CodexDesktopRevisionHttpResponse> {
  return await handleAgentRevisionSubmitRequest(req, {
    ...buildWakeSubmitOptions(options),
    targetResolver: resolveCodexDesktopPollTarget,
  });
}

export function createCodexDesktopRevisionMiddleware(
  options: CodexDesktopRevisionHandlerOptions,
) {
  return (
    req: IncomingMessage,
    res: ServerResponse,
    next?: (error?: unknown) => void,
  ) =>
    createAgentRevisionSubmitMiddleware({
      ...buildWakeSubmitOptions(options),
      targetResolver: resolveCodexDesktopPollTarget,
    })(req, res, next);
}

function buildWakeSubmitOptions(
  options: CodexDesktopRevisionHandlerOptions,
): AgentRevisionSubmitHandlerOptions {
  const { onWakeError, wake, ...submitOptions } = options;

  return {
    ...submitOptions,
    onQueued: wake
      ? ({ request, submission }) => {
          submission.message = `已排队给 ${submission.target.label}，并已请求唤醒原 Codex task。`;
          void wake({ request, submission }).catch((error) => onWakeError?.(error));
        }
      : submitOptions.onQueued,
    targetResolver: resolveCodexDesktopPollTarget,
  };
}
