type MermaidApi = (typeof import("mermaid"))["default"];

let mermaidPromise: Promise<MermaidApi> | null = null;
let renderQueue = Promise.resolve();
let diagramSequence = 0;

export function renderMermaidToSvg(source: string): Promise<string> {
  const renderJob = async () => {
    const mermaid = await loadMermaid();
    diagramSequence += 1;
    const diagramId = `dorey-mermaid-${diagramSequence}`;
    const { svg } = await mermaid.render(diagramId, source.trim());

    return svg;
  };
  const result = renderQueue.then(renderJob, renderJob);

  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
}

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "neutral",
      });

      return mermaid;
    });
  }

  return mermaidPromise;
}
