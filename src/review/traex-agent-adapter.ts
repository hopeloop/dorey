import type {
  AgentAdapter,
  AgentRevisionOptions,
  BatchRevisionRequest,
  BatchRevisionResponse,
} from "../contracts/revision.js";

export type TraexAgentAdapterOptions = {
  endpoint?: string;
  fetchImpl?: typeof fetch;
};

export class TraexAgentAdapter implements AgentAdapter {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TraexAgentAdapterOptions = {}) {
    this.endpoint = options.endpoint ?? "/api/agent/traex/revise";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async reviseArtifact(
    req: BatchRevisionRequest,
    options: AgentRevisionOptions = {},
  ): Promise<BatchRevisionResponse> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req),
      signal: options.signal,
    });

    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    return (await response.json()) as BatchRevisionResponse;
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text();

  if (!text) {
    return `TraeX adapter request failed with HTTP ${response.status}.`;
  }

  try {
    const body = JSON.parse(text) as { error?: unknown };

    if (typeof body.error === "string") {
      return body.error;
    }
  } catch {
    return text;
  }

  return text;
}
