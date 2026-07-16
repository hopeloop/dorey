import { Children, isValidElement, memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { PlantUmlDiagram } from "./PlantUmlDiagram";

type MarkdownDocumentProps = {
  artifactId: string;
  markdown: string;
  enableSelection?: boolean;
  onMouseUp?: () => void;
  resolveImageUrl?: (source: string) => string;
};

export const MarkdownDocument = memo(function MarkdownDocument({
  artifactId,
  markdown,
  enableSelection = false,
  onMouseUp,
  resolveImageUrl,
}: MarkdownDocumentProps) {
  let blockSequence = 0;
  const nextBlockId = (kind: string) => {
    blockSequence += 1;
    return `${artifactId}:${kind}:${blockSequence}`;
  };

  const components: Components = {
    h1: ({ node: _node, ...props }) => (
      <h1 data-block-id={nextBlockId("h1")} {...props} />
    ),
    h2: ({ node: _node, ...props }) => (
      <h2 data-block-id={nextBlockId("h2")} {...props} />
    ),
    h3: ({ node: _node, ...props }) => (
      <h3 data-block-id={nextBlockId("h3")} {...props} />
    ),
    h4: ({ node: _node, ...props }) => (
      <h4 data-block-id={nextBlockId("h4")} {...props} />
    ),
    h5: ({ node: _node, ...props }) => (
      <h5 data-block-id={nextBlockId("h5")} {...props} />
    ),
    h6: ({ node: _node, ...props }) => (
      <h6 data-block-id={nextBlockId("h6")} {...props} />
    ),
    p: ({ node: _node, ...props }) => (
      <p data-block-id={nextBlockId("p")} {...props} />
    ),
    li: ({ node: _node, ...props }) => (
      <li data-block-id={nextBlockId("li")} {...props} />
    ),
    img: ({ node: _node, src, ...props }) => (
      <img src={src && resolveImageUrl ? resolveImageUrl(src) : src} {...props} />
    ),
    blockquote: ({ node: _node, ...props }) => (
      <blockquote data-block-id={nextBlockId("blockquote")} {...props} />
    ),
    pre: ({ node: _node, children, ...props }) => {
      const child = Children.toArray(children)[0];

      if (isValidElement(child) && child.type === PlantUmlDiagram) {
        return child;
      }

      return (
        <pre data-block-id={nextBlockId("code")} {...props}>
          {children}
        </pre>
      );
    },
    code: ({ node: _node, className, children, ...props }) => {
      if (isPlantUmlCodeBlock(className)) {
        return (
          <PlantUmlDiagram
            blockId={nextBlockId("plantuml")}
            source={String(children).replace(/\n$/, "")}
          />
        );
      }

      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
    table: ({ node: _node, ...props }) => (
      <table data-block-id={nextBlockId("table")} {...props} />
    ),
    tr: ({ node: _node, ...props }) => (
      <tr data-block-id={nextBlockId("tr")} {...props} />
    ),
  };

  return (
    <div
      className="markdown-body review-markdown"
      data-block-id={`${artifactId}:document:1`}
      data-selection-enabled={enableSelection ? "true" : "false"}
      onMouseUp={enableSelection ? onMouseUp : undefined}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
});

function isPlantUmlCodeBlock(className?: string): boolean {
  return Boolean(
    className
    ?.split(/\s+/)
      .includes("language-plantuml"),
  );
}
