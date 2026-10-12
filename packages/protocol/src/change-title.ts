/**
 * Short Change titles for lists, breadcrumbs, and timeline rows. The Root Planner writes the title
 * (`WorkGraphPlan.title`); `fallbackTitle` derives one from the goal when no title is stored, for
 * example before planning, for a Change created with `startPlanning: false`, or after a planning
 * failure. Both are display text only. No decision reads a title.
 */

export const MAX_TITLE_CHARS = 48;
export const MAX_TITLE_WORDS = 6;

/** Opening words that carry no subject, removed again until none is left. Case-insensitive. */
const LEADING_FILLER = [
  /^(?:hey|hi|hello|ok|okay|so)\b[\s,.!:;-]*/i,
  /^(?:please|pls|kindly)\b[\s,.!:;-]*/i,
  /^(?:can|could|would|will) you\b[\s,.!:;-]*/i,
  /^(?:i|we)(?: would|'d)? (?:want|like|need)(?: to)?\b[\s,.!:;-]*/i,
  /^let'?s\b[\s,.!:;-]*/i,
  /^(?:the|my|our) (?:idea|goal|plan) is(?: to| that)?\b[\s,.!:;-]*/i,
  // A complaint before the request: "The UI sucks, ...", "The UI is not good. ...".
  /^(?:the |this |my |our )?(?:ui|app|site|website|design|page|layout|look|frontend)(?: really| just)? (?:sucks|is (?:not good|not great|bad|ugly|terrible|awful|boring|broken))\b[\s,.!:;-]*/i,
];

/** Words a title must not end with after a cut, for example "Use React with". */
const TRAILING_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "at",
  "but",
  "by",
  "for",
  "from",
  "in",
  "into",
  "it",
  "its",
  "my",
  "of",
  "on",
  "or",
  "our",
  "so",
  "some",
  "that",
  "the",
  "their",
  "to",
  "using",
  "which",
  "who",
  "with",
  "your",
]);

const TRAILING_PUNCTUATION = /[\s.,;:!?…"'`\-–—]+$/;

function stripFiller(text: string): string {
  let current = text;
  for (let changed = true; changed; ) {
    changed = false;
    for (const pattern of LEADING_FILLER) {
      const next = current.replace(pattern, "");
      if (next !== current) {
        current = next;
        changed = true;
      }
    }
  }
  return current;
}

/** The first sentence, then its first clause when that clause has at least two words. */
function firstClause(text: string): string {
  const sentence = text.split(/[.!?](?:\s|$)|\n/)[0] ?? "";
  const clause = sentence.split(/[,;:]\s|\s[-–—]\s|\s\(/)[0] ?? "";
  return clause.trim().split(/\s+/).length >= 2 ? clause : sentence;
}

function dropTrailingStopWords(words: string[]): string[] {
  const kept = [...words];
  while (kept.length > 1 && TRAILING_STOP_WORDS.has((kept.at(-1) ?? "").toLowerCase())) kept.pop();
  return kept;
}

/** Cuts to MAX_TITLE_CHARS at a word boundary; a single longer word is cut hard. */
function cutToChars(words: string[]): string[] {
  const kept = [...words];
  while (kept.length > 1 && kept.join(" ").length > MAX_TITLE_CHARS) kept.pop();
  const only = kept.join(" ");
  return only.length > MAX_TITLE_CHARS ? [only.slice(0, MAX_TITLE_CHARS)] : kept;
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`“‘]+|["'`”’]+$/g, "")
    .replace(TRAILING_PUNCTUATION, "")
    .trim();
}

/** A planner title, trimmed and cut to MAX_TITLE_CHARS at a word boundary. Null when blank. */
export function clampTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = tidy(raw);
  if (!text) return null;
  const words = text.split(" ");
  const cut = cutToChars(words);
  // Only a cut can leave a dangling word such as "and"; a title the planner ended is kept as is.
  const title = tidy((cut.length < words.length ? dropTrailingStopWords(cut) : cut).join(" "));
  return title || null;
}

/**
 * A deterministic title from a goal: the first sentence or clause without opening filler, at most
 * MAX_TITLE_WORDS words and MAX_TITLE_CHARS characters, with a capital first letter.
 */
export function fallbackTitle(goal: string): string {
  const text = goal.replace(/[ \t]+/g, " ").trim();
  const stripped = stripFiller(text);
  const clause = tidy(firstClause(stripped)) || tidy(firstClause(text)) || tidy(text);
  const words = clause.split(" ").filter(Boolean).slice(0, MAX_TITLE_WORDS);
  const cut = dropTrailingStopWords(cutToChars(dropTrailingStopWords(words)));
  const title = tidy(cut.join(" "));
  if (!title) return "Untitled change";
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** The title to show: the stored title when there is one, else `fallbackTitle(goal)`. */
export function changeTitle(title: string | null | undefined, goal: string): string {
  return clampTitle(title) ?? fallbackTitle(goal);
}
