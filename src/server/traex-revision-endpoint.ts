import type { IncomingMessage, ServerResponse } from "node:http";

import type { QueuedRevisionSubmission } from "../contracts/revision.js";
import {
  createAgentRevisionSubmitMiddleware,
  handleAgentRevisionSubmitRequest,
  resolveTraexCliPollTarget,
  type AgentRevisionSubmitHandlerOptions,
} from "./revision-poll-endpoint.js";

export type TraexRevisionHttpRequest = {
  baseUrl?: string;
  body: string;
  method?: string;
};

export type TraexRevisionHttpResponse =
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

export type TraexRevisionHandlerOptions = Omit<
  AgentRevisionSubmitHandlerOptions,
  "targetResolver"
>;

export async function handleTraexRevisionRequest(
  req: TraexRevisionHttpRequest,
  options: TraexRevisionHandlerOptions,
): Promise<TraexRevisionHttpResponse> {
  return await handleAgentRevisionSubmitRequest(req, {
    ...options,
    targetResolver: resolveTraexCliPollTarget,
  });
}

export function createTraexRevisionMiddleware(
  options: TraexRevisionHandlerOptions,
) {
  return (
    req: IncomingMessage,
    res: ServerResponse,
    next?: (error?: unknown) => void,
  ) =>
    createAgentRevisionSubmitMiddleware({
      ...options,
      targetResolver: resolveTraexCliPollTarget,
    })(req, res, next);
}
