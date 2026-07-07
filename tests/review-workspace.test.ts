import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLineDiff } from "../src/review/diff.js";

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
