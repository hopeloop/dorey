import type {
  BatchRevisionResponse,
  CommentKind,
  QueuedComment,
} from "../contracts/index.js";

export function getCommentKind(
  comment: Pick<QueuedComment, "kind">,
): CommentKind {
  return comment.kind === "explanation" ? "explanation" : "revision";
}

export function hasRevisionIntent(
  comments: QueuedComment[],
  globalInstruction?: string,
): boolean {
  return (
    Boolean(globalInstruction?.trim()) ||
    comments.some((comment) => getCommentKind(comment) === "revision")
  );
}

export function normalizeCommentResponse(input: {
  comments: QueuedComment[];
  globalInstruction?: string;
  response: BatchRevisionResponse;
  sourceMarkdown: string;
}): BatchRevisionResponse {
  if (hasRevisionIntent(input.comments, input.globalInstruction)) {
    return input.response;
  }

  return {
    ...input.response,
    revisedMarkdown: input.sourceMarkdown,
  };
}
