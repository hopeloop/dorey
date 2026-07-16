import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extractMarkdownH1,
  resolveMarkdownAssetPath,
} from "../src/shared/markdown-document.js";
import { getWorkflowAssetUrl } from "../src/app/workflow-run-client.js";

describe("Markdown document helpers", () => {
  it("extracts the first real H1 and ignores fenced examples", () => {
    assert.equal(
      extractMarkdownH1("```md\n# Example\n```\n\n# **Real** title\n"),
      "Real title",
    );
    assert.equal(extractMarkdownH1("Document title\n===\n"), "Document title");
    assert.equal(extractMarkdownH1("## Only H2\n"), undefined);
  });

  it("resolves local image paths beside nested Markdown without accepting remote or escaping paths", () => {
    assert.equal(
      resolveMarkdownAssetPath("documents/notes/doc.md", "../assets/diagram.png"),
      "documents/assets/diagram.png",
    );
    assert.equal(
      resolveMarkdownAssetPath("documents/doc.md", "assets/%E5%9B%BE.png?rev=1"),
      "documents/assets/图.png",
    );
    assert.equal(resolveMarkdownAssetPath("documents/doc.md", "https://example.com/a.png"), undefined);
    assert.equal(resolveMarkdownAssetPath("documents/doc.md", "../../secret.png"), undefined);
    assert.equal(
      getWorkflowAssetUrl("run-1", "documents/doc.md", "assets/图.png"),
      "/api/workflow-runs/run-1/assets/documents%2Fassets%2F%E5%9B%BE.png",
    );
  });
});
