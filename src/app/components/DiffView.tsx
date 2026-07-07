import type { LineDiffEntry } from "../../review/diff.js";

type DiffViewProps = {
  diff: LineDiffEntry[];
};

export function DiffView({ diff }: DiffViewProps) {
  return (
    <div className="diff-view" aria-label="Line based diff">
      {diff.map((entry, index) => (
        <div
          className={`diff-row diff-row-${entry.type}`}
          key={`${entry.type}-${index}-${entry.oldLineNumber ?? "new"}-${entry.newLineNumber ?? "old"}`}
        >
          <span className="diff-gutter">{entry.oldLineNumber ?? ""}</span>
          <span className="diff-gutter">{entry.newLineNumber ?? ""}</span>
          <span className="diff-marker">
            {entry.type === "added" ? "+" : entry.type === "removed" ? "-" : " "}
          </span>
          <code>{entry.line || " "}</code>
        </div>
      ))}
    </div>
  );
}
