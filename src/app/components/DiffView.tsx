import type {
  InlineDiffSegment,
  MarkdownTextBlockKind,
  RenderedCodeDiffLine,
  RenderedDiffEntry,
  RenderedMarkdownChangeEntry,
  RenderedTableDiffEntry,
  RenderedTableSnapshot,
} from "../../review/diff.js";
import { MarkdownDocument } from "./MarkdownDocument";
import type { ReactNode } from "react";

type DiffViewProps = {
  diff: RenderedDiffEntry[];
};

export function DiffView({ diff }: DiffViewProps) {
  return (
    <div className="diff-view rendered-diff-view" aria-label="Rendered Markdown diff">
      {diff.map((entry, index) => (
        <DiffEntryView entry={entry} index={index} key={`${entry.kind}-${index}`} />
      ))}
    </div>
  );
}

function DiffEntryView({
  entry,
  index,
}: {
  entry: RenderedDiffEntry;
  index: number;
}) {
  if (entry.kind === "code") {
    return <CodeDiff lines={entry.lines} language={entry.language} />;
  }

  if (entry.kind === "markdown-change") {
    return <MarkdownChange entry={entry} />;
  }

  if (entry.kind === "table") {
    return <TableDiff entry={entry} />;
  }

  return (
    <section className={`rendered-diff-block rendered-diff-block-${entry.type}`}>
      <MarkdownDocument artifactId={`diff:${index}`} markdown={entry.markdown} />
    </section>
  );
}

function CodeDiff({
  language,
  lines,
}: {
  language?: string;
  lines: RenderedCodeDiffLine[];
}) {
  return (
    <section className="rendered-diff-block rendered-diff-code-block">
      <pre className="rendered-diff-code">
        <code className={language ? `language-${language}` : undefined}>
          {lines.map((line, index) => (
            <CodeDiffLine line={line} index={index} key={`${line.type}-${index}`} />
          ))}
        </code>
      </pre>
    </section>
  );
}

function CodeDiffLine({
  index,
  line,
}: {
  index: number;
  line: RenderedCodeDiffLine;
}) {
  if (line.type === "changed") {
    return (
      <>
        <span
          className="rendered-diff-code-line rendered-diff-code-line-changed rendered-diff-code-line-old"
          key={`old-${index}-${line.oldLineNumber ?? "old"}`}
        >
          <InlineSegments segments={line.oldSegments} />
        </span>
        <span
          className="rendered-diff-code-line rendered-diff-code-line-changed rendered-diff-code-line-new"
          key={`new-${index}-${line.newLineNumber ?? "new"}`}
        >
          <InlineSegments segments={line.newSegments} />
        </span>
      </>
    );
  }

  return (
    <span
      className={`rendered-diff-code-line rendered-diff-line-${line.type}`}
      key={`${line.type}-${index}-${line.oldLineNumber ?? "new"}-${line.newLineNumber ?? "old"}`}
    >
      <InlineSegments segments={line.segments} />
    </span>
  );
}

function MarkdownChange({ entry }: { entry: RenderedMarkdownChangeEntry }) {
  const content = <InlineSegments segments={entry.segments} />;

  return (
    <section className="rendered-diff-block rendered-diff-inline-block">
      {renderMarkdownChangeBlock(entry.blockKind, content, {
        headingLevel: entry.headingLevel,
        listMarker: entry.listMarker,
      })}
    </section>
  );
}

function TableDiff({ entry }: { entry: RenderedTableDiffEntry }) {
  if (entry.structureChanged) {
    return (
      <section className="rendered-diff-block rendered-diff-table-pair">
        <RenderedTable table={entry.oldTable} type="removed" />
        <RenderedTable table={entry.newTable} type="added" />
      </section>
    );
  }

  return (
    <section className="rendered-diff-block rendered-diff-table-block">
      <table>
        <thead>
          <tr>
            {entry.newTable.header.map((cell, index) => (
              <th key={`${cell}-${index}`}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entry.rows.map((row, index) => (
            <tr className={`rendered-diff-line-${row.type}`} key={`${row.type}-${index}`}>
              {row.cells.map((cellSegments, cellIndex) => (
                <td key={`${row.type}-${index}-${cellIndex}`}>
                  <InlineSegments segments={cellSegments} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function InlineSegments({ segments }: { segments: InlineDiffSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => (
        <span
          className={`rendered-diff-inline rendered-diff-inline-${segment.type}`}
          key={`${segment.type}-${index}-${segment.text}`}
        >
          {segment.text}
        </span>
      ))}
    </>
  );
}

function renderMarkdownChangeBlock(
  blockKind: MarkdownTextBlockKind,
  content: ReactNode,
  options: {
    headingLevel?: number;
    listMarker?: string;
  },
) {
  if (blockKind === "heading") {
    return renderHeading(options.headingLevel ?? 2, content);
  }

  if (blockKind === "listItem") {
    return (
      <div className="rendered-diff-list-item">
        <span className="rendered-diff-list-marker" aria-hidden="true">
          {options.listMarker?.match(/^\d/) ? options.listMarker : "•"}
        </span>
        <span>{content}</span>
      </div>
    );
  }

  if (blockKind === "blockquote") {
    return (
      <blockquote>
        <p>{content}</p>
      </blockquote>
    );
  }

  return <p>{content}</p>;
}

function renderHeading(level: number, content: ReactNode) {
  if (level === 1) {
    return <h1>{content}</h1>;
  }

  if (level === 3) {
    return <h3>{content}</h3>;
  }

  if (level === 4) {
    return <h4>{content}</h4>;
  }

  if (level === 5) {
    return <h5>{content}</h5>;
  }

  if (level === 6) {
    return <h6>{content}</h6>;
  }

  return <h2>{content}</h2>;
}

function RenderedTable({
  table,
  type,
}: {
  table: RenderedTableSnapshot;
  type: "added" | "removed";
}) {
  return (
    <div className={`rendered-diff-table-snapshot rendered-diff-block-${type}`}>
      <table>
        <thead>
          <tr>
            {table.header.map((cell, index) => (
              <th key={`${cell}-${index}`}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={`${type}-${index}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${cell}-${cellIndex}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
