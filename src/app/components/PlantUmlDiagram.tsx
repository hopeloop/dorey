import { useEffect, useState } from "react";

import { renderPlantUmlToSvg } from "../plantuml-renderer";

type PlantUmlDiagramProps = {
  blockId: string;
  source: string;
};

type RenderState =
  | { status: "loading"; svg?: undefined; error?: undefined }
  | { status: "ready"; svg: string; error?: undefined }
  | { status: "error"; svg?: undefined; error: string };

export function PlantUmlDiagram({ blockId, source }: PlantUmlDiagramProps) {
  const [renderState, setRenderState] = useState<RenderState>({
    status: "loading",
  });
  const [isSourceVisible, setIsSourceVisible] = useState(false);

  useEffect(() => {
    let isCancelled = false;

    setRenderState({ status: "loading" });
    setIsSourceVisible(false);

    void renderPlantUmlToSvg(source)
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
    <figure className="plantuml-diagram" data-block-id={blockId}>
      <figcaption className="plantuml-toolbar">
        <span>PlantUML</span>
        <button
          className="text-button"
          onClick={() => setIsSourceVisible((current) => !current)}
          type="button"
        >
          {isSourceVisible ? "隐藏源码" : "显示源码"}
        </button>
      </figcaption>

      {renderState.status === "loading" ? (
        <div className="plantuml-placeholder">正在渲染 PlantUML...</div>
      ) : null}

      {renderState.status === "ready" && !isSourceVisible ? (
        <div
          className="plantuml-svg"
          dangerouslySetInnerHTML={{ __html: renderState.svg }}
        />
      ) : null}

      {renderState.status === "error" ? (
        <p className="error-message plantuml-error">{renderState.error}</p>
      ) : null}

      {isSourceVisible ? (
        <pre className="plantuml-source">
          <code>{source}</code>
        </pre>
      ) : null}
    </figure>
  );
}
