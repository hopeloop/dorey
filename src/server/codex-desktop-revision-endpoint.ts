import type { IncomingMessage, ServerResponse } from "node:http";

import type { QueuedRevisionSubmission } from "../contracts/revision.js";
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
>;

export async function handleCodexDesktopRevisionRequest(
  req: CodexDesktopRevisionHttpRequest,
  options: CodexDesktopRevisionHandlerOptions,
): Promise<CodexDesktopRevisionHttpResponse> {
  return await handleAgentRevisionSubmitRequest(req, {
    ...options,
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
      ...options,
      targetResolver: resolveCodexDesktopPollTarget,
    })(req, res, next);
}
