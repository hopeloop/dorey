type PlantUmlCore = typeof import("@plantuml/core");

const renderTimeoutMs = 20_000;

let plantUmlCorePromise: Promise<PlantUmlCore> | null = null;
let renderQueue = Promise.resolve();

export function renderPlantUmlToSvg(source: string): Promise<string> {
  const renderJob = () => renderPlantUmlToSvgNow(source);
  const result = renderQueue.then(renderJob, renderJob);

  renderQueue = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
}

function renderPlantUmlToSvgNow(source: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("PlantUML 渲染超时。"));
      }
    }, renderTimeoutMs);

    void loadPlantUmlCore()
      .then(({ renderToString }) => {
        renderToString(
          normalizePlantUmlLines(source),
          (svg) => {
            if (settled) {
              return;
            }

            settled = true;
            window.clearTimeout(timeout);
            resolve(svg);
          },
          (message) => {
            if (settled) {
              return;
            }

            settled = true;
            window.clearTimeout(timeout);
            reject(new Error(message || "PlantUML 渲染失败。"));
          },
        );
      })
      .catch((error: unknown) => {
        if (settled) {
          return;
        }

        settled = true;
        window.clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

function loadPlantUmlCore(): Promise<PlantUmlCore> {
  if (!plantUmlCorePromise) {
    plantUmlCorePromise = import("@plantuml/core/viz-global.js").then(() =>
      import("@plantuml/core"),
    );
  }

  return plantUmlCorePromise;
}

function normalizePlantUmlLines(source: string): string[] {
  return source.trim().split(/\r\n|\r|\n/);
}
