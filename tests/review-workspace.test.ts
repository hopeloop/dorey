import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLineDiff, createRenderedDiff } from "../src/review/diff.js";

describe("line diff", () => {
  it("keeps unchanged lines and marks added/removed lines", () => {
    const diff = createLineDiff(
      "# 技术方案\n旧方案\n## 验证\n",
      "# 技术方案\n新方案\n## 验证\n- smoke case\n",
    );

    assert.deepEqual(diff, [
      { type: "unchanged", line: "# 技术方案", oldLineNumber: 1, newLineNumber: 1 },
      { type: "removed", line: "旧方案", oldLineNumber: 2 },
      { type: "added", line: "新方案", newLineNumber: 2 },
      { type: "unchanged", line: "## 验证", oldLineNumber: 3, newLineNumber: 3 },
      { type: "added", line: "- smoke case", newLineNumber: 4 },
    ]);
  });
});

describe("rendered markdown diff", () => {
  it("keeps ordinary markdown as renderable blocks", () => {
    const diff = createRenderedDiff(
      "# 标题\n\n旧段落\n",
      "# 标题\n\n新段落\n",
    );

    assert.deepEqual(diff, [
      {
        kind: "markdown",
        type: "unchanged",
        blockKind: "heading",
        headingLevel: 1,
        listMarker: undefined,
        markdown: "# 标题",
        text: "标题",
      },
      {
        kind: "markdown-change",
        type: "changed",
        blockKind: "paragraph",
        headingLevel: undefined,
        listMarker: undefined,
        segments: [
          { type: "removed", text: "旧" },
          { type: "added", text: "新" },
          { type: "unchanged", text: "段落" },
        ],
      },
    ]);
  });

  it("keeps changed code blocks renderable while diffing their lines", () => {
    const diff = createRenderedDiff(
      "```ts\nconst count = 1;\nexport { count };\n```",
      "```ts\nconst count = 2;\nexport { count };\n```",
    );

    assert.deepEqual(diff, [
      {
        kind: "code",
        type: "changed",
        language: "ts",
        lines: [
          {
            type: "changed",
            oldLineNumber: 1,
            newLineNumber: 1,
            oldSegments: [
              { type: "unchanged", text: "const count = " },
              { type: "removed", text: "1" },
              { type: "unchanged", text: ";" },
            ],
            newSegments: [
              { type: "unchanged", text: "const count = " },
              { type: "added", text: "2" },
              { type: "unchanged", text: ";" },
            ],
          },
          {
            type: "unchanged",
            oldLineNumber: 2,
            newLineNumber: 2,
            segments: [{ type: "unchanged", text: "export { count };" }],
          },
        ],
      },
    ]);
  });

  it("diffs table rows when the header stays the same", () => {
    const diff = createRenderedDiff(
      "| 模块 | 责任 |\n| --- | --- |\n| A | 读取 |\n",
      "| 模块 | 责任 |\n| --- | --- |\n| A | 读取 |\n| B | 写入 |\n",
    );

    assert.deepEqual(diff, [
      {
        kind: "table",
        type: "changed",
        oldTable: { header: ["模块", "责任"], rows: [["A", "读取"]] },
        newTable: {
          header: ["模块", "责任"],
          rows: [
            ["A", "读取"],
            ["B", "写入"],
          ],
        },
        rows: [
          {
            type: "unchanged",
            cells: [
              [{ type: "unchanged", text: "A" }],
              [{ type: "unchanged", text: "读取" }],
            ],
          },
          {
            type: "added",
            cells: [
              [{ type: "added", text: "B" }],
              [{ type: "added", text: "写入" }],
            ],
          },
        ],
        structureChanged: false,
      },
    ]);
  });

  it("diffs changed table cells inline when row identity is stable", () => {
    const diff = createRenderedDiff(
      "| 模块 | 责任 |\n| --- | --- |\n| A | 读取旧配置 |\n",
      "| 模块 | 责任 |\n| --- | --- |\n| A | 读取新配置 |\n",
    );

    assert.deepEqual(diff, [
      {
        kind: "table",
        type: "changed",
        oldTable: { header: ["模块", "责任"], rows: [["A", "读取旧配置"]] },
        newTable: { header: ["模块", "责任"], rows: [["A", "读取新配置"]] },
        rows: [
          {
            type: "changed",
            cells: [
              [{ type: "unchanged", text: "A" }],
              [
                { type: "unchanged", text: "读取" },
                { type: "removed", text: "旧" },
                { type: "added", text: "新" },
                { type: "unchanged", text: "配置" },
              ],
            ],
          },
        ],
        structureChanged: false,
      },
    ]);
  });

  it("keeps old and new tables separate when the header changes", () => {
    const diff = createRenderedDiff(
      "| 模块 | 责任 |\n| --- | --- |\n| A | 读取 |\n",
      "| 模块 | 责任 | 风险 |\n| --- | --- | --- |\n| A | 读取 | 低 |\n",
    );

    assert.equal(diff.length, 1);
    assert.equal(diff[0]?.kind, "table");
    assert.equal(diff[0]?.type, "changed");
    assert.equal(diff[0]?.structureChanged, true);
  });
});
