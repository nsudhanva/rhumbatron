/**
 * Repairs harmless encoding slips in a model's tool arguments before schema validation.
 * Seen on prod: `"riskTier": "\"low\""`: a JSON string encoded twice. The schema is unchanged; only
 * wrapping quotes, surrounding whitespace, and string booleans are undone. Content is never altered.
 */
export function normalizeToolArgs(value: unknown): unknown {
  if (typeof value === "string") return unwrapString(value);
  if (Array.isArray(value)) return value.map(normalizeToolArgs);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeToolArgs(v)]),
    );
  }
  return value;
}

function unwrapString(text: string): string | boolean {
  let out = text.trim();
  // A string that is itself a JSON string literal: `"low"` → low. At most twice.
  for (let i = 0; i < 2 && out.length >= 2 && out.startsWith('"') && out.endsWith('"'); i++) {
    try {
      const inner = JSON.parse(out);
      if (typeof inner !== "string") break;
      out = inner.trim();
    } catch {
      break;
    }
  }
  if (out === "true") return true;
  if (out === "false") return false;
  return out === text.trim() ? text : out;
}
