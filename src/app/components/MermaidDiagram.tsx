import { useEffect, useState } from "react";

import { renderMermaidToSvg } from "../mermaid-renderer";

type MermaidDiagramProps = {
  blockId: string;
  source: string;
};

type RenderState =
  | { status: "loading"; svg?: undefined; error?: undefined }
  | { status: "ready"; svg: string; error?: undefined }
  | { status: "error"; svg?: undefined; error: string };

export function MermaidDiagram({ blockId, source }: MermaidDiagramProps) {
  const [renderState, setRenderState] = useState<RenderState>({
    status: "loading",
  });
  const [isSourceVisible, setIsSourceVisible] = useState(false);

  useEffect(() => {
    let isCancelled = false;

    setRenderState({ status: "loading" });
    setIsSourceVisible(false);

    void renderMermaidToSvg(source)
      .then((svg) => {
        if (!isCancelled) {
          setRenderState({ status: "ready", svg });
        }
      })
      .catch((error: unknown) => {
        if (!isCancelled) {
          setRenderState({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
          setIsSourceVisible(true);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [source]);

  return (
    <figure className="mermaid-diagram" data-block-id={blockId}>
      <figcaption className="mermaid-toolbar">
        <span>Mermaid</span>
        <button
          className="text-button"
          onClick={() => setIsSourceVisible((current) => !current)}
          type="button"
        >
          {isSourceVisible ? "隐藏源码" : "显示源码"}
        </button>
      </figcaption>

      {renderState.status === "loading" ? (
        <div className="mermaid-placeholder">正在渲染 Mermaid...</div>
      ) : null}

      {renderState.status === "ready" && !isSourceVisible ? (
        <div
          className="mermaid-svg"
          dangerouslySetInnerHTML={{ __html: renderState.svg }}
        />
      ) : null}

      {renderState.status === "error" ? (
        <p className="error-message mermaid-error">{renderState.error}</p>
      ) : null}

      {isSourceVisible ? (
        <pre className="mermaid-source">
          <code>{source}</code>
        </pre>
      ) : null}
    </figure>
  );
}
