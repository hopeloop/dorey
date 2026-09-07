import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  BatchRevisionResponse,
  QueuedComment,
} from "../src/contracts/index.js";
import {
  getCommentKind,
  hasRevisionIntent,
  normalizeCommentResponse,
} from "../src/review/comment-kind.js";

const baseComment: QueuedComment = {
  id: "comment-1",
  artifactId: "artifact-1",
  anchor: {
    blockId: "artifact-1:p:1",
    startOffset: 0,
    endOffset: 4,
    quote: "原文",
  },
  body: "这是什么意思？",
  status: "queued",
  createdAt: "2026-09-04T00:00:00.000Z",
};

const changedResponse: BatchRevisionResponse = {
  revisedMarkdown: "# 被 Agent 意外修改的文档\n",
  summary: "回答了问题。",
  addressedComments: [
    {
      commentId: baseComment.id,
      resolution: "这里表示复用现有链路。",
    },
  ],
};

describe("comment kind behavior", () => {
  it("treats comments without kind as revisions for backward compatibility", () => {
    assert.equal(getCommentKind(baseComment), "revision");
    assert.equal(hasRevisionIntent([baseComment]), true);
  });

  it("recognizes an explanation-only request", () => {
    const explanation = { ...baseComment, kind: "explanation" as const };

    assert.equal(getCommentKind(explanation), "explanation");
    assert.equal(hasRevisionIntent([explanation]), false);
  });

  it("treats a global instruction as revision intent", () => {
    const explanation = { ...baseComment, kind: "explanation" as const };

    assert.equal(hasRevisionIntent([explanation], "保持技术文档语气。"), true);
  });

  it("discards Markdown changes from an explanation-only response", () => {
    const sourceMarkdown = "# 原文\n";
    const response = normalizeCommentResponse({
      comments: [{ ...baseComment, kind: "explanation" }],
      response: changedResponse,
      sourceMarkdown,
    });

    assert.equal(response.revisedMarkdown, sourceMarkdown);
    assert.equal(response.addressedComments, changedResponse.addressedComments);
  });

  it("preserves Markdown changes when revision intent exists", () => {
    const response = normalizeCommentResponse({
      comments: [{ ...baseComment, kind: "revision" }],
      response: changedResponse,
      sourceMarkdown: "# 原文\n",
    });

    assert.equal(response, changedResponse);
  });
});
