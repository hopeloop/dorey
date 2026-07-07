export type LineDiffEntry = {
  type: "unchanged" | "added" | "removed";
  line: string;
  oldLineNumber?: number;
  newLineNumber?: number;
};

export function createLineDiff(
  originalMarkdown: string,
  revisedMarkdown: string,
): LineDiffEntry[] {
  const originalLines = splitMarkdownLines(originalMarkdown);
  const revisedLines = splitMarkdownLines(revisedMarkdown);
  const lcs = buildLcsTable(originalLines, revisedLines);
  const diff: LineDiffEntry[] = [];

  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < originalLines.length || newIndex < revisedLines.length) {
    if (
      oldIndex < originalLines.length &&
      newIndex < revisedLines.length &&
      originalLines[oldIndex] === revisedLines[newIndex]
    ) {
      diff.push({
        type: "unchanged",
        line: originalLines[oldIndex] ?? "",
        oldLineNumber: oldIndex + 1,
        newLineNumber: newIndex + 1,
      });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (
      newIndex < revisedLines.length &&
      (oldIndex === originalLines.length ||
        lcs[oldIndex]?.[newIndex + 1] > lcs[oldIndex + 1]?.[newIndex])
    ) {
      diff.push({
        type: "added",
        line: revisedLines[newIndex] ?? "",
        newLineNumber: newIndex + 1,
      });
      newIndex += 1;
      continue;
    }

    if (oldIndex < originalLines.length) {
      diff.push({
        type: "removed",
        line: originalLines[oldIndex] ?? "",
        oldLineNumber: oldIndex + 1,
      });
      oldIndex += 1;
    }
  }

  return diff;
}

function splitMarkdownLines(markdown: string): string[] {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");

  if (lines.at(-1) === "") {
    lines.pop();
  }

  return lines;
}

function buildLcsTable(a: string[], b: string[]): number[][] {
  const table = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j]
          ? (table[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(table[i + 1]?.[j] ?? 0, table[i]?.[j + 1] ?? 0);
    }
  }

  return table;
}
