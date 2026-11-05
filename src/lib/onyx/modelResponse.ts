export interface OnyxModelResponse {
  decisions?: Array<{
    action?: string;
    symbol?: string;
    turtle?: string | null;
    direction?: string | null;
    wallet?: string | null;
    priority?: number;
    rationale?: string;
  }>;
  narrative?: string;
}

type ContentPart = { text?: unknown; content?: unknown };

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const value = part as ContentPart;
      if (typeof value.text === "string") return value.text;
      return typeof value.content === "string" ? value.content : "";
    })
    .join("\n");
}

function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Together-compatible response parsing. Providers may return a string,
 * content-part arrays, fenced JSON, or reasoning text before the JSON body.
 */
export function parseOnyxModelResponse(content: unknown): OnyxModelResponse | null {
  const text = contentToText(content)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  if (!text) return null;
  const candidate = firstJsonObject(text) ?? text;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as OnyxModelResponse) : null;
  } catch {
    return null;
  }
}
