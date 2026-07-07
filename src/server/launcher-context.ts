import type { LauncherContext } from "../contracts/index.js";

export type Env = Record<string, string | undefined>;

export function resolveRevisionPollTargetFromEnv(env: Env): string | undefined {
  const explicitTarget = firstEnv(env, "MARKDOWN_REVIEW_TARGET_KEY");

  if (explicitTarget) {
    return explicitTarget;
  }

  const context = resolveLauncherContextFromEnv(env);

  if (!context) {
    return undefined;
  }

  return launcherContextToTargetKey(context);
}

export function resolveLauncherContextFromEnv(env: Env): LauncherContext | undefined {
  const explicitTarget = firstEnv(env, "MARKDOWN_REVIEW_TARGET_KEY");
  const explicitTargetContext = explicitTarget
    ? launcherContextFromTargetKey(explicitTarget)
    : undefined;

  if (explicitTargetContext) {
    return explicitTargetContext;
  }

  const traexCliSessionId =
    firstEnv(env, "TRAEX_CLI_SESSION_ID", "TRAE_CLI_SESSION_ID") ??
    resolveTraeCliSessionIdFromInboxPath(
      firstEnv(env, "TRAECLI_SESSION_INBOX", "TRAEX_CLI_SESSION_INBOX", "TRAE_CLI_SESSION_INBOX"),
    );

  if (traexCliSessionId) {
    return traexCliContext(traexCliSessionId);
  }

  const codexCliSessionId = firstEnv(env, "CODEX_CLI_SESSION_ID");

  if (codexCliSessionId) {
    return codexCliContext(codexCliSessionId);
  }

  const traexThreadId = firstEnv(env, "TRAEX_THREAD_ID");

  if (traexThreadId) {
    return traexThreadContext(traexThreadId);
  }

  const codexThreadId = firstEnv(env, "CODEX_THREAD_ID");

  if (codexThreadId) {
    return codexThreadContext(codexThreadId);
  }

  const normalizedTraexCliSessionId = firstEnv(env, "MARKDOWN_REVIEW_TRAEX_CLI_SESSION_ID");

  if (normalizedTraexCliSessionId) {
    return traexCliContext(normalizedTraexCliSessionId);
  }

  const normalizedCodexCliSessionId = firstEnv(env, "MARKDOWN_REVIEW_CODEX_CLI_SESSION_ID");

  if (normalizedCodexCliSessionId) {
    return codexCliContext(normalizedCodexCliSessionId);
  }

  const normalizedTraexThreadId = firstEnv(env, "MARKDOWN_REVIEW_TRAEX_THREAD_ID");

  if (normalizedTraexThreadId) {
    return traexThreadContext(normalizedTraexThreadId);
  }

  const normalizedCodexThreadId = firstEnv(env, "MARKDOWN_REVIEW_CODEX_THREAD_ID");

  if (normalizedCodexThreadId) {
    return codexThreadContext(normalizedCodexThreadId);
  }

  return undefined;
}

export function launcherContextToTargetKey(context: LauncherContext): string {
  if (context.sessionKind === "codex_thread") {
    return `codex-desktop:${context.sessionId}`;
  }

  if (context.sessionKind === "codex_cli_session") {
    return `codex-cli:${context.sessionId}`;
  }

  return `traex-cli:${context.sessionId}`;
}

export function targetKeyToServerEnv(targetKey: string | undefined): Env {
  if (!targetKey) {
    return {};
  }

  const context = launcherContextFromTargetKey(targetKey);

  if (!context) {
    return {
      MARKDOWN_REVIEW_TARGET_KEY: targetKey,
    };
  }

  const env: Env = {
    MARKDOWN_REVIEW_TARGET_KEY: targetKey,
  };

  if (context.sessionKind === "traex_cli_session") {
    env.MARKDOWN_REVIEW_TRAEX_CLI_SESSION_ID = context.sessionId;
  } else if (context.sessionKind === "codex_cli_session") {
    env.MARKDOWN_REVIEW_CODEX_CLI_SESSION_ID = context.sessionId;
  } else if (context.sessionKind === "codex_thread") {
    env.MARKDOWN_REVIEW_CODEX_THREAD_ID = context.sessionId;
  } else if (context.sessionKind === "traex_thread") {
    env.MARKDOWN_REVIEW_TRAEX_THREAD_ID = context.sessionId;
  }

  return env;
}

export function launcherContextFromTargetKey(targetKey: string): LauncherContext | undefined {
  const separatorIndex = targetKey.indexOf(":");

  if (separatorIndex <= 0) {
    return undefined;
  }

  const prefix = targetKey.slice(0, separatorIndex);
  const sessionId = targetKey.slice(separatorIndex + 1).trim();

  if (!sessionId) {
    return undefined;
  }

  if (prefix === "traex-cli") {
    return traexCliContext(sessionId);
  }

  if (prefix === "codex-cli") {
    return codexCliContext(sessionId);
  }

  if (prefix === "codex-desktop") {
    return codexThreadContext(sessionId);
  }

  return undefined;
}

export function resolveTraeCliSessionIdFromInboxPath(inboxPath: string | undefined): string | undefined {
  const normalized = inboxPath?.trim();

  if (!normalized) {
    return undefined;
  }

  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  const inboxIndex = parts.lastIndexOf("inbox.d");
  const artifactPart = inboxIndex > 0 ? parts[inboxIndex - 1] : parts.at(-1);

  if (!artifactPart?.endsWith(".artifacts")) {
    return undefined;
  }

  return artifactPart.slice(0, -".artifacts".length) || undefined;
}

function traexCliContext(sessionId: string): LauncherContext {
  return {
    provider: "traex",
    sessionId,
    sessionKind: "traex_cli_session",
    label: "当前 TraeX CLI 会话",
  };
}

function traexThreadContext(sessionId: string): LauncherContext {
  return {
    provider: "traex",
    sessionId,
    sessionKind: "traex_thread",
    label: "当前 TraeX 对话",
  };
}

function codexCliContext(sessionId: string): LauncherContext {
  return {
    provider: "codex",
    sessionId,
    sessionKind: "codex_cli_session",
    label: "当前 Codex CLI 会话",
  };
}

function codexThreadContext(sessionId: string): LauncherContext {
  return {
    provider: "codex",
    sessionId,
    sessionKind: "codex_thread",
    label: "当前 Codex Desktop 对话",
  };
}

function firstEnv(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();

    if (value) {
      return value;
    }
  }

  return undefined;
}
