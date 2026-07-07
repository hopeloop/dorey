import type { IncomingMessage, ServerResponse } from "node:http";

import type { QueuedRevisionSubmission } from "../contracts/revision.js";
import {
  createAgentRevisionSubmitMiddleware,
  handleAgentRevisionSubmitRequest,
  resolveCodexCliPollTarget,
  type AgentRevisionSubmitHandlerOptions,
} from "./revision-poll-endpoint.js";

export type CodexRevisionHttpRequest = {
  baseUrl?: string;
  body: string;
  method?: string;
};

export type CodexRevisionHttpResponse =
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

export type CodexRevisionHandlerOptions = Omit<
  AgentRevisionSubmitHandlerOptions,
  "targetResolver"
>;

export async function handleCodexRevisionRequest(
  req: CodexRevisionHttpRequest,
  options: CodexRevisionHandlerOptions,
): Promise<CodexRevisionHttpResponse> {
  return await handleAgentRevisionSubmitRequest(req, {
    ...options,
    targetResolver: resolveCodexCliPollTarget,
  });
}

export function createCodexRevisionMiddleware(
  options: CodexRevisionHandlerOptions,
) {
  return (
    req: IncomingMessage,
    res: ServerResponse,
    next?: (error?: unknown) => void,
  ) =>
    createAgentRevisionSubmitMiddleware({
      ...options,
      targetResolver: resolveCodexCliPollTarget,
    })(req, res, next);
}
