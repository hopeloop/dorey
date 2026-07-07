export type LineDiffEntry = {
  type: "unchanged" | "added" | "removed";
  line: string;
  oldLineNumber?: number;
  newLineNumber?: number;
};

export type InlineDiffSegment = {
  type: "unchanged" | "added" | "removed";
  text: string;
};

export type RenderedDiffEntry =
  | RenderedMarkdownDiffEntry
  | RenderedMarkdownChangeEntry
  | RenderedCodeDiffEntry
  | RenderedTableDiffEntry;

export type RenderedMarkdownDiffEntry = {
  kind: "markdown";
  type: "unchanged" | "added" | "removed";
  blockKind: MarkdownTextBlockKind;
  headingLevel?: number;
  listMarker?: string;
  markdown: string;
  text: string;
};

export type RenderedMarkdownChangeEntry = {
  kind: "markdown-change";
  type: "changed";
  blockKind: MarkdownTextBlockKind;
  headingLevel?: number;
  listMarker?: string;
  segments: InlineDiffSegment[];
};

export type RenderedCodeDiffEntry = {
  kind: "code";
  type: "changed";
  language?: string;
  lines: RenderedCodeDiffLine[];
};

export type RenderedCodeDiffLine =
  | {
      type: "unchanged" | "added" | "removed";
      segments: InlineDiffSegment[];
      oldLineNumber?: number;
      newLineNumber?: number;
    }
  | {
      type: "changed";
      oldSegments: InlineDiffSegment[];
      newSegments: InlineDiffSegment[];
      oldLineNumber?: number;
      newLineNumber?: number;
    };

export type RenderedTableDiffEntry = {
  kind: "table";
  type: "changed";
  oldTable: RenderedTableSnapshot;
  newTable: RenderedTableSnapshot;
  rows: RenderedTableDiffRow[];
  structureChanged: boolean;
};

export type RenderedTableSnapshot = {
  header: string[];
  rows: string[][];
};

export type RenderedTableDiffRow = {
  type: "unchanged" | "added" | "removed";
  cells: InlineDiffSegment[][];
} | {
  type: "changed";
  cells: InlineDiffSegment[][];
};

type MarkdownBlock = MarkdownTextBlock | MarkdownCodeBlock | MarkdownTableBlock;

export type MarkdownTextBlockKind =
  | "heading"
  | "paragraph"
  | "listItem"
  | "blockquote"
  | "markdown";

type MarkdownTextBlock = {
  kind: "markdown";
  blockKind: MarkdownTextBlockKind;
  headingLevel?: number;
  listMarker?: string;
  markdown: string;
  text: string;
};

type MarkdownCodeBlock = {
  kind: "code";
  markdown: string;
  language?: string;
  content: string;
};

type MarkdownTableBlock = {
  kind: "table";
  markdown: string;
  header: string[];
  rows: string[][];
};

type RawBlockDiffEntry = {
  type: "unchanged" | "added" | "removed";
  block: MarkdownBlock;
};

export function createRenderedDiff(
  originalMarkdown: string,
  revisedMarkdown: string,
): RenderedDiffEntry[] {
  const rawDiff = createBlockDiff(
    parseMarkdownBlocks(originalMarkdown),
    parseMarkdownBlocks(revisedMarkdown),
  );

  const diff: RenderedDiffEntry[] = [];

  for (let index = 0; index < rawDiff.length; index += 1) {
    const current = rawDiff[index];
    const next = rawDiff[index + 1];

    if (
      current?.type === "removed" &&
      next?.type === "added" &&
      current.block.kind === "markdown" &&
      next.block.kind === "markdown" &&
      canRenderInlineMarkdownChange(current.block, next.block)
    ) {
      diff.push(createMarkdownChangeEntry(current.block, next.block));
      index += 1;
      continue;
    }

    if (
      current?.type === "removed" &&
      next?.type === "added" &&
      current.block.kind === "code" &&
      next.block.kind === "code"
    ) {
      diff.push(createCodeDiffEntry(current.block, next.block));
      index += 1;
      continue;
    }

    if (
      current?.type === "removed" &&
      next?.type === "added" &&
      current.block.kind === "table" &&
      next.block.kind === "table"
    ) {
      diff.push(createTableDiffEntry(current.block, next.block));
      index += 1;
      continue;
    }

    if (current) {
      diff.push(createRenderedMarkdownEntry(current.type, current.block));
    }
  }

  return diff;
}

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

function createBlockDiff(
  originalBlocks: MarkdownBlock[],
  revisedBlocks: MarkdownBlock[],
): RawBlockDiffEntry[] {
  const lcs = buildLcsTable(
    originalBlocks.map((block) => block.markdown),
    revisedBlocks.map((block) => block.markdown),
  );
  const diff: RawBlockDiffEntry[] = [];

  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < originalBlocks.length || newIndex < revisedBlocks.length) {
    const originalBlock = originalBlocks[oldIndex];
    const revisedBlock = revisedBlocks[newIndex];

    if (
      originalBlock &&
      revisedBlock &&
      originalBlock.markdown === revisedBlock.markdown
    ) {
      diff.push({ type: "unchanged", block: originalBlock });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (
      revisedBlock &&
      (oldIndex === originalBlocks.length ||
        lcs[oldIndex]?.[newIndex + 1] > lcs[oldIndex + 1]?.[newIndex])
    ) {
      diff.push({ type: "added", block: revisedBlock });
      newIndex += 1;
      continue;
    }

    if (originalBlock) {
      diff.push({ type: "removed", block: originalBlock });
      oldIndex += 1;
    }
  }

  return diff;
}

function createCodeDiffEntry(
  originalBlock: MarkdownCodeBlock,
  revisedBlock: MarkdownCodeBlock,
): RenderedCodeDiffEntry {
  return {
    kind: "code",
    type: "changed",
    language: revisedBlock.language ?? originalBlock.language,
    lines: createCodeLineDiff(originalBlock.content, revisedBlock.content),
  };
}

function createRenderedMarkdownEntry(
  type: "unchanged" | "added" | "removed",
  block: MarkdownBlock,
): RenderedMarkdownDiffEntry {
  return block.kind === "markdown"
    ? {
        kind: "markdown",
        type,
        blockKind: block.blockKind,
        headingLevel: block.headingLevel,
        listMarker: block.listMarker,
        markdown: block.markdown,
        text: block.text,
      }
    : {
        kind: "markdown",
        type,
        blockKind: "markdown",
        markdown: block.markdown,
        text: block.markdown,
      };
}

function createMarkdownChangeEntry(
  originalBlock: MarkdownTextBlock,
  revisedBlock: MarkdownTextBlock,
): RenderedMarkdownChangeEntry {
  return {
    kind: "markdown-change",
    type: "changed",
    blockKind: revisedBlock.blockKind,
    headingLevel: revisedBlock.headingLevel ?? originalBlock.headingLevel,
    listMarker: revisedBlock.listMarker ?? originalBlock.listMarker,
    segments: createInlineDiff(originalBlock.text, revisedBlock.text),
  };
}

function canRenderInlineMarkdownChange(
  originalBlock: MarkdownTextBlock,
  revisedBlock: MarkdownTextBlock,
): boolean {
  return (
    originalBlock.blockKind === revisedBlock.blockKind &&
    originalBlock.headingLevel === revisedBlock.headingLevel &&
    originalBlock.listMarker === revisedBlock.listMarker &&
    originalBlock.text.trim() !== "" &&
    revisedBlock.text.trim() !== ""
  );
}

function createCodeLineDiff(
  originalCode: string,
  revisedCode: string,
): RenderedCodeDiffLine[] {
  const rawLines = createLineDiff(originalCode, revisedCode);
  const lines: RenderedCodeDiffLine[] = [];

  for (let index = 0; index < rawLines.length; index += 1) {
    const current = rawLines[index];

    if (!current) {
      continue;
    }

    if (current.type === "unchanged") {
      lines.push({
        type: "unchanged",
        oldLineNumber: current.oldLineNumber,
        newLineNumber: current.newLineNumber,
        segments: [
          {
            type: "unchanged",
            text: current.line || " ",
          },
        ],
      });
      continue;
    }

    const hunk = collectChangedLineHunk(rawLines, index);
    lines.push(...createCodeHunkDiff(hunk.removed, hunk.added));
    index = hunk.nextIndex - 1;
  }

  return lines;
}

function collectChangedLineHunk(
  lines: LineDiffEntry[],
  start: number,
): {
  added: LineDiffEntry[];
  nextIndex: number;
  removed: LineDiffEntry[];
} {
  const added: LineDiffEntry[] = [];
  const removed: LineDiffEntry[] = [];
  let index = start;

  while (index < lines.length && lines[index]?.type !== "unchanged") {
    const line = lines[index];

    if (line?.type === "added") {
      added.push(line);
    } else if (line?.type === "removed") {
      removed.push(line);
    }

    index += 1;
  }

  return { added, nextIndex: index, removed };
}

function createCodeHunkDiff(
  removedLines: LineDiffEntry[],
  addedLines: LineDiffEntry[],
): RenderedCodeDiffLine[] {
  const pairings = new Map<number, LineDiffEntry>();
  const usedRemoved = new Set<number>();

  for (let addedIndex = 0; addedIndex < addedLines.length; addedIndex += 1) {
    const addedLine = addedLines[addedIndex];
    let bestRemovedIndex = -1;
    let bestSimilarity = 0;

    for (let removedIndex = 0; removedIndex < removedLines.length; removedIndex += 1) {
      if (usedRemoved.has(removedIndex)) {
        continue;
      }

      const removedLine = removedLines[removedIndex];
      const similarity = calculateTokenSimilarity(
        removedLine?.line ?? "",
        addedLine?.line ?? "",
      );

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestRemovedIndex = removedIndex;
      }
    }

    if (bestRemovedIndex >= 0 && bestSimilarity >= 0.45) {
      const removedLine = removedLines[bestRemovedIndex];

      if (removedLine) {
        pairings.set(addedIndex, removedLine);
        usedRemoved.add(bestRemovedIndex);
      }
    }
  }

  const hunkLines: RenderedCodeDiffLine[] = [];

  for (let removedIndex = 0; removedIndex < removedLines.length; removedIndex += 1) {
    if (usedRemoved.has(removedIndex)) {
      continue;
    }

    const removedLine = removedLines[removedIndex];
    if (removedLine) {
      hunkLines.push(createWholeCodeDiffLine(removedLine, "removed"));
    }
  }

  for (let addedIndex = 0; addedIndex < addedLines.length; addedIndex += 1) {
    const addedLine = addedLines[addedIndex];
    const removedLine = pairings.get(addedIndex);

    if (addedLine && removedLine) {
      const segments = createInlineDiff(removedLine.line, addedLine.line);
      hunkLines.push({
        type: "changed",
        oldLineNumber: removedLine.oldLineNumber,
        newLineNumber: addedLine.newLineNumber,
        oldSegments: segments.filter((segment) => segment.type !== "added"),
        newSegments: segments.filter((segment) => segment.type !== "removed"),
      });
      continue;
    }

    if (addedLine) {
      hunkLines.push(createWholeCodeDiffLine(addedLine, "added"));
    }
  }

  return hunkLines;
}

function createWholeCodeDiffLine(
  line: LineDiffEntry,
  type: "added" | "removed",
): RenderedCodeDiffLine {
  return {
    type,
    oldLineNumber: line.oldLineNumber,
    newLineNumber: line.newLineNumber,
    segments: [{ type, text: line.line || " " }],
  };
}

function createTableDiffEntry(
  originalBlock: MarkdownTableBlock,
  revisedBlock: MarkdownTableBlock,
): RenderedTableDiffEntry {
  const structureChanged = !hasSameTableStructure(originalBlock, revisedBlock);

  return {
    kind: "table",
    type: "changed",
    oldTable: {
      header: originalBlock.header,
      rows: originalBlock.rows,
    },
    newTable: {
      header: revisedBlock.header,
      rows: revisedBlock.rows,
    },
    rows: structureChanged
      ? []
      : createTableRowDiff(originalBlock.rows, revisedBlock.rows),
    structureChanged,
  };
}

function createTableRowDiff(
  originalRows: string[][],
  revisedRows: string[][],
): RenderedTableDiffRow[] {
  const originalKeys = originalRows.map(createTableRowKey);
  const revisedKeys = revisedRows.map(createTableRowKey);
  const lcs = buildLcsTable(originalKeys, revisedKeys);
  const diff: RenderedTableDiffRow[] = [];

  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < originalRows.length || newIndex < revisedRows.length) {
    const originalRow = originalRows[oldIndex];
    const revisedRow = revisedRows[newIndex];

    if (
      originalRow &&
      revisedRow &&
      createTableRowKey(originalRow) === createTableRowKey(revisedRow)
    ) {
      diff.push({ type: "unchanged", cells: createWholeCellSegments(revisedRow, "unchanged") });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (
      originalRow &&
      revisedRow &&
      canPairChangedTableRows(originalRow, revisedRow)
    ) {
      diff.push({
        type: "changed",
        cells: originalRow.map((cell, cellIndex) =>
          createInlineDiff(cell, revisedRow[cellIndex] ?? ""),
        ),
      });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (
      revisedRow &&
      (oldIndex === originalRows.length ||
        lcs[oldIndex]?.[newIndex + 1] > lcs[oldIndex + 1]?.[newIndex])
    ) {
      diff.push({ type: "added", cells: createWholeCellSegments(revisedRow, "added") });
      newIndex += 1;
      continue;
    }

    if (originalRow) {
      diff.push({ type: "removed", cells: createWholeCellSegments(originalRow, "removed") });
      oldIndex += 1;
    }
  }

  return diff;
}

function createWholeCellSegments(
  row: string[],
  type: "unchanged" | "added" | "removed",
): InlineDiffSegment[][] {
  return row.map((cell) => [{ type, text: cell }]);
}

function canPairChangedTableRows(originalRow: string[], revisedRow: string[]): boolean {
  if (originalRow.length !== revisedRow.length) {
    return false;
  }

  if (originalRow[0]?.trim() !== "" && originalRow[0] === revisedRow[0]) {
    return true;
  }

  return calculateTokenSimilarity(
    originalRow.join("\u0000"),
    revisedRow.join("\u0000"),
  ) >= 0.55;
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = splitMarkdownLines(markdown);
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    if (lines[index]?.trim() === "") {
      index += 1;
      continue;
    }

    const codeBlock = readCodeBlock(lines, index);
    if (codeBlock) {
      blocks.push(codeBlock.block);
      index = codeBlock.nextIndex;
      continue;
    }

    const tableBlock = readTableBlock(lines, index);
    if (tableBlock) {
      blocks.push(tableBlock.block);
      index = tableBlock.nextIndex;
      continue;
    }

    const start = index;
    index += 1;

    const singleLineBlock = createSingleLineMarkdownBlock(lines[start] ?? "");
    if (singleLineBlock) {
      blocks.push(singleLineBlock);
      continue;
    }

    while (
      index < lines.length &&
      lines[index]?.trim() !== "" &&
      !readCodeBlock(lines, index) &&
      !readTableBlock(lines, index) &&
      !createSingleLineMarkdownBlock(lines[index] ?? "")
    ) {
      index += 1;
    }

    blocks.push({
      kind: "markdown",
      blockKind: "paragraph",
      markdown: lines.slice(start, index).join("\n"),
      text: lines.slice(start, index).join(" "),
    });
  }

  return blocks;
}

function createSingleLineMarkdownBlock(line: string): MarkdownTextBlock | null {
  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    return {
      kind: "markdown",
      blockKind: "heading",
      headingLevel: heading[1]?.length,
      markdown: line,
      text: heading[2] ?? "",
    };
  }

  const listItem = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
  if (listItem) {
    return {
      kind: "markdown",
      blockKind: "listItem",
      listMarker: listItem[2],
      markdown: line,
      text: listItem[3] ?? "",
    };
  }

  const blockquote = line.match(/^>\s?(.+)$/);
  if (blockquote) {
    return {
      kind: "markdown",
      blockKind: "blockquote",
      markdown: line,
      text: blockquote[1] ?? "",
    };
  }

  return null;
}

function readCodeBlock(
  lines: string[],
  start: number,
): { block: MarkdownCodeBlock; nextIndex: number } | null {
  const opening = lines[start]?.match(/^(\s*)(`{3,}|~{3,})(.*)$/);

  if (!opening) {
    return null;
  }

  const fence = opening[2] ?? "";
  const fenceChar = fence[0] ?? "`";
  const fenceLength = fence.length;
  const info = opening[3]?.trim() ?? "";
  let index = start + 1;

  while (index < lines.length && !isClosingFence(lines[index] ?? "", fenceChar, fenceLength)) {
    index += 1;
  }

  const end = index < lines.length ? index + 1 : index;

  return {
    block: {
      kind: "code",
      markdown: lines.slice(start, end).join("\n"),
      language: info.length > 0 ? info.split(/\s+/)[0] : undefined,
      content: lines.slice(start + 1, index).join("\n"),
    },
    nextIndex: end,
  };
}

function readTableBlock(
  lines: string[],
  start: number,
): { block: MarkdownTableBlock; nextIndex: number } | null {
  const headerLine = lines[start];
  const separatorLine = lines[start + 1];

  if (!headerLine || !separatorLine || !isTableSeparatorLine(separatorLine)) {
    return null;
  }

  const header = splitTableCells(headerLine);
  const separator = splitTableCells(separatorLine);

  if (
    header.length < 2 ||
    separator.length !== header.length ||
    !headerLine.includes("|")
  ) {
    return null;
  }

  let index = start + 2;
  const rows: string[][] = [];

  while (index < lines.length && isTableBodyLine(lines[index] ?? "")) {
    rows.push(splitTableCells(lines[index] ?? ""));
    index += 1;
  }

  return {
    block: {
      kind: "table",
      markdown: lines.slice(start, index).join("\n"),
      header,
      rows,
    },
    nextIndex: index,
  };
}

function isClosingFence(line: string, fenceChar: string, fenceLength: number): boolean {
  const trimmed = line.trim();

  return (
    trimmed.length >= fenceLength &&
    [...trimmed].every((character) => character === fenceChar)
  );
}

function isTableSeparatorLine(line: string): boolean {
  const cells = splitTableCells(line);

  return (
    cells.length >= 2 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
  );
}

function isTableBodyLine(line: string): boolean {
  return line.trim() !== "" && line.includes("|") && !isTableSeparatorLine(line);
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim();
  const withoutOuterPipes = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;

  for (const character of withoutOuterPipes) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === "\\") {
      escaped = true;
      continue;
    }

    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  cells.push(current.trim());
  return cells;
}

function hasSameTableStructure(
  originalBlock: MarkdownTableBlock,
  revisedBlock: MarkdownTableBlock,
): boolean {
  return createTableRowKey(originalBlock.header) === createTableRowKey(revisedBlock.header);
}

function createTableRowKey(row: string[]): string {
  return row.map((cell) => cell.trim()).join("\u0000");
}

function createInlineDiff(originalText: string, revisedText: string): InlineDiffSegment[] {
  const originalTokens = tokenizeInlineText(originalText);
  const revisedTokens = tokenizeInlineText(revisedText);
  const lcs = buildLcsTable(originalTokens, revisedTokens);
  const segments: InlineDiffSegment[] = [];

  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < originalTokens.length || newIndex < revisedTokens.length) {
    const originalToken = originalTokens[oldIndex];
    const revisedToken = revisedTokens[newIndex];

    if (originalToken !== undefined && originalToken === revisedToken) {
      appendInlineSegment(segments, "unchanged", originalToken);
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (
      revisedToken !== undefined &&
      (oldIndex === originalTokens.length ||
        lcs[oldIndex]?.[newIndex + 1] > lcs[oldIndex + 1]?.[newIndex])
    ) {
      appendInlineSegment(segments, "added", revisedToken);
      newIndex += 1;
      continue;
    }

    if (originalToken !== undefined) {
      appendInlineSegment(segments, "removed", originalToken);
      oldIndex += 1;
    }
  }

  return segments.filter((segment) => segment.text.length > 0);
}

function appendInlineSegment(
  segments: InlineDiffSegment[],
  type: InlineDiffSegment["type"],
  text: string,
) {
  const previous = segments.at(-1);

  if (previous?.type === type) {
    previous.text += text;
    return;
  }

  segments.push({ type, text });
}

function tokenizeInlineText(text: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < text.length) {
    const character = text[index] ?? "";

    if (/\s/u.test(character)) {
      let token = character;
      index += 1;
      while (index < text.length && /\s/u.test(text[index] ?? "")) {
        token += text[index];
        index += 1;
      }
      tokens.push(token);
      continue;
    }

    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)) {
      tokens.push(character);
      index += 1;
      continue;
    }

    if (/[\p{Letter}\p{Number}_-]/u.test(character)) {
      let token = character;
      index += 1;
      while (index < text.length && /[\p{Letter}\p{Number}_-]/u.test(text[index] ?? "")) {
        token += text[index];
        index += 1;
      }
      tokens.push(token);
      continue;
    }

    tokens.push(character);
    index += 1;
  }

  return tokens;
}

function calculateTokenSimilarity(originalText: string, revisedText: string): number {
  const originalTokens = tokenizeInlineText(originalText).filter(
    (token) => token.trim() !== "",
  );
  const revisedTokens = tokenizeInlineText(revisedText).filter(
    (token) => token.trim() !== "",
  );

  if (originalTokens.length === 0 && revisedTokens.length === 0) {
    return 1;
  }

  const lcs = buildLcsTable(originalTokens, revisedTokens);
  const commonTokenCount = lcs[0]?.[0] ?? 0;

  return (2 * commonTokenCount) / (originalTokens.length + revisedTokens.length);
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
