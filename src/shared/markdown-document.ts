export function extractMarkdownH1(markdown: string): string | undefined {
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/);
  let fence: "`" | "~" | undefined;
  let previousContentLine: string | undefined;

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);

    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0];

      if (!fence) {
        fence = marker === "~" ? "~" : "`";
      } else if (marker === fence) {
        fence = undefined;
      }

      continue;
    }

    if (fence) {
      continue;
    }

    const atxHeading = line.match(/^\s*#\s+(.+?)\s*#*\s*$/);

    if (atxHeading?.[1]) {
      return plainMarkdownTitle(atxHeading[1]);
    }

    if (/^\s*=+\s*$/.test(line) && previousContentLine) {
      return plainMarkdownTitle(previousContentLine);
    }

    if (line.trim()) {
      previousContentLine = line.trim();
    }
  }

  return undefined;
}

export function resolveMarkdownAssetPath(
  documentRelativePath: string,
  source: string,
): string | undefined {
  const trimmed = source.trim();

  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)
  ) {
    return undefined;
  }

  const sourcePath = decodePathSafely(trimmed.split(/[?#]/, 1)[0] ?? "").replaceAll("\\", "/");
  const documentSegments = documentRelativePath.replaceAll("\\", "/").split("/");
  documentSegments.pop();

  const resolved = [...documentSegments];

  for (const segment of sourcePath.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (resolved.length === 0) {
        return undefined;
      }

      resolved.pop();
      continue;
    }

    resolved.push(segment);
  }

  return resolved.length > 0 ? resolved.join("/") : undefined;
}

function plainMarkdownTitle(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, "$1")
    .trim();
}

function decodePathSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
