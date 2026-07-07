export type CommentCategory =
  | "clarification"
  | "correction"
  | "rewrite"
  | "missing_info"
  | "structure";

export type CommentAnchor = {
  blockId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  prefix?: string;
  suffix?: string;
};

export type QueuedComment = {
  id: string;
  artifactId: string;
  anchor: CommentAnchor;
  body: string;
  category?: CommentCategory;
  status: "queued" | "submitted" | "resolved";
  createdAt: string;
};
