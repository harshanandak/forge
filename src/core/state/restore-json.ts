// Restore-only JSON reading. JSON.parse keeps the last copy of a repeated label and SQLite json_extract the
// first, so a restored body that repeats a label would be read two ways. It is refused, and the text decides:
// by the time a parsed object exists the repeat is gone.

const REPEATED = "Restored JSON repeats a label";
const NOT_JSON = "Restored JSON is not valid";

/** The label a quoted token spells once its escapes are read; the token is the only text this decodes. */
function decoded(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    throw new Error(NOT_JSON);
  }
}

/** What a cloud restore admits in one JSON field: its depth, and its values (root, containers and scalars; labels excluded). */
const MAX_DEPTH = 32;
const MAX_VALUES = 5_000;

/**
 * Scans the text once, with a stack of label sets (one per open object, none for arrays), and refuses a
 * label that an object repeats. Labels compare after decoding, so "type" and "type" collide. A label in a
 * sibling object, and label-like text inside a string, are fine. Grammar and values are left to JSON.parse,
 * which the caller runs next, so this never reports on text that is not JSON.
 *
 * With `budget` the same pass instead counts depth and values and returns false at the first one past its
 * limit, and repeated labels are left to the verifier. A literal is a maximal run of characters outside
 * strings that are not whitespace or structure. Nothing is decoded or parsed.
 */
function scan(text: string, budget: boolean): boolean {
  // One entry per open bracket: the set of labels seen in that object, or undefined for an array.
  const frames: (Set<string> | undefined)[] = [];
  // True while the next string in the open object is a label (after "{" and after ",").
  let expectLabel = false;
  let values = 0;
  let literal = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (budget) {
      const word =
        ch > 0x20 &&
        ch !== 0x22 &&
        ch !== 0x2c &&
        ch !== 0x3a &&
        ch !== 0x5b &&
        ch !== 0x5d &&
        ch !== 0x7b &&
        ch !== 0x7d;
      if (word && !literal) values += 1;
      literal = word;
      if (values > MAX_VALUES) return false;
    }
    if (ch === 0x22) {
      const start = i + 1;
      for (i = start; i < text.length && text.charCodeAt(i) !== 0x22; i += 1)
        if (text.charCodeAt(i) === 0x5c) i += 1;
      const labels = frames.at(-1);
      if (expectLabel && labels !== undefined) {
        if (!budget) {
          const raw = text.slice(start, i);
          const label = raw.includes("\\") ? decoded(raw) : raw;
          if (labels.has(label)) throw new Error(REPEATED);
          labels.add(label);
        }
        expectLabel = false;
      } else if (budget) values += 1;
    } else if (ch === 0x7b || ch === 0x5b) {
      frames.push(ch === 0x7b ? new Set() : undefined);
      expectLabel = ch === 0x7b;
      if (budget) {
        values += 1;
        if (frames.length > MAX_DEPTH) return false;
      }
    } else if (ch === 0x7d || ch === 0x5d) {
      frames.pop();
      expectLabel = false;
    } else if (ch === 0x2c) expectLabel = frames.at(-1) !== undefined;
  }
  return !budget || values <= MAX_VALUES;
}

function checkLabels(text: string): void {
  scan(text, false);
}

/** True when a restored JSON text is within the cloud budget of 32 levels and 5,000 values. Reads the raw text only. */
export function withinRestoreBudget(text: string): boolean {
  return scan(text, true);
}

/** JSON.parse for a restored row body: a repeated label anywhere in it is refused with a fixed message. */
export function parseRestoreJson(text: string): unknown {
  checkLabels(text);
  try {
    return JSON.parse(text);
  } catch {
    // Never the native message: it quotes the body.
    throw new Error(NOT_JSON);
  }
}
