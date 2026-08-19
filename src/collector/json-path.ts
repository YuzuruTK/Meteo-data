/**
 * Small, dependency-free JSONPath evaluator.
 *
 * Supports a practical subset:
 *   $.root.child[0].nested.name   (dot notation)
 *   $.root['child with spaces']   (bracket notation with or without quotes)
 *   $['a'][0]['b']
 *
 * Only reads values; does not support filters, wildcards or unions.
 */

export interface JsonPathSegment {
  type: "property" | "index";
  value: string | number;
}

/**
 * Tokenize a JSONPath string into segments.
 * Throws on malformed paths.
 */
export function parseJsonPath(path: string): JsonPathSegment[] {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error(`Invalid JSON path: ${JSON.stringify(path)}`);
  }

  const trimmed = path.trim();
  if (!trimmed.startsWith("$")) {
    throw new Error(`JSON path must start with '$': ${path}`);
  }

  const segments: JsonPathSegment[] = [];
  let i = 1; // skip '$'

  while (i < trimmed.length) {
    const ch = trimmed[i];

    if (ch === ".") {
      i++;
      const { value, next } = readProperty(trimmed, i);
      segments.push({ type: "property", value });
      i = next;
      continue;
    }

    if (ch === "[") {
      const { segment, next } = readBracket(trimmed, i);
      segments.push(segment);
      i = next;
      continue;
    }

    throw new Error(`Unexpected character '${ch}' at position ${i} in path: ${path}`);
  }

  return segments;
}

function readProperty(str: string, start: number): { value: string; next: number } {
  let end = start;
  while (end < str.length && str[end] !== "." && str[end] !== "[") {
    end++;
  }
  if (end === start) {
    throw new Error(`Expected property name after '.' in path: ${str}`);
  }
  return { value: str.slice(start, end), next: end };
}

interface BracketResult {
  segment: JsonPathSegment;
  next: number;
}

function readBracket(str: string, start: number): BracketResult {
  // start points at '['
  let i = start + 1;

  // Skip whitespace
  while (i < str.length && /\s/.test(str[i] ?? "")) i++;

  if (i >= str.length) throw new Error(`Unterminated bracket in path: ${str}`);

  // Numeric index
  if (/^\d/.test(str[i] ?? "")) {
    let end = i;
    while (end < str.length && /\d/.test(str[end] ?? "")) end++;
    expectClose(str, end);
    return { segment: { type: "index", value: Number(str.slice(i, end)) }, next: end + 1 };
  }

  // Quoted property
  const quote = str[i];
  if (quote === "'" || quote === '"') {
    let end = i + 1;
    let closed = false;
    while (end < str.length) {
      if (str[end] === quote) {
        closed = true;
        break;
      }
      end++;
    }
    if (!closed) throw new Error(`Unterminated string in path: ${str}`);
    const value = str.slice(i + 1, end);
    expectClose(str, end + 1);
    return { segment: { type: "property", value }, next: end + 2 };
  }

  // Unquoted property in brackets
  let end = i;
  while (end < str.length && str[end] !== "]") end++;
  if (end === i) throw new Error(`Empty bracket in path: ${str}`);
  const value = str.slice(i, end).trim();
  expectClose(str, end);
  return { segment: { type: "property", value }, next: end + 1 };
}

function expectClose(str: string, idx: number): void {
  if (str[idx] !== "]") {
    throw new Error(`Expected ']' at position ${idx} in path: ${str}`);
  }
}

/**
 * Traverse a decoded JSON value using a parsed path.
 * Returns `undefined` when any segment is missing (for optional fields).
 */
export function getByPath<T = unknown>(root: unknown, segments: JsonPathSegment[]): T | undefined {
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (segment.type === "index") {
      if (!Array.isArray(current)) return undefined;
      const idx = segment.value as number;
      if (idx < 0 || idx >= current.length) return undefined;
      current = current[idx];
    } else {
      if (typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[segment.value as string];
    }
  }
  return current as T | undefined;
}

/**
 * Convenience: parse and evaluate a JSONPath string against a root value.
 */
export function jsonPath<T = unknown>(root: unknown, path: string): T | undefined {
  const segments = parseJsonPath(path);
  return getByPath<T>(root, segments);
}