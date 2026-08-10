import type { IncomingMessage, ServerResponse } from "node:http";

import type { RevisionPollBroker } from "./revision-poll-broker.js";

export type RevisionReviewHttpResponse =
  | {
      status: 200;
      body: { status: "open" | "review_closed" };
    }
  | {
      status: 405;
      body: { error: string };
    };

export function handleRevisionReviewRequest(
  req: { method?: string },
  options: { broker: RevisionPollBroker },
): RevisionReviewHttpResponse {
  if (req.method === "GET") {
    return { status: 200, body: options.broker.getReviewStatus() };
  }

  if (req.method === "POST") {
    return { status: 200, body: options.broker.closeReview() };
  }

  return { status: 405, body: { error: "Method not allowed." } };
}

export function createRevisionReviewMiddleware(options: {
  broker: RevisionPollBroker;
}) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const result = handleRevisionReviewRequest(req, options);
    res.statusCode = result.status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(result.body));
  };
}
