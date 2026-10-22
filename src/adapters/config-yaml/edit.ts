import { isMap, isNode, isScalar, parseDocument } from "yaml";
import type { ConfigTextEdit } from "../../ports/config-codec.ts";

/** LCS over lines, retaining positions and multiplicity, with a bounded scratch budget. */
function lostLines(
  before: string,
  after: string,
  allowed: ReadonlySet<number>,
): boolean {
  const a = before.split("\n"),
    b = after.split("\n");
  if (a.length * b.length > 2_000_000) return true;
  const rows = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      rows[i]![j] =
        a[i] === b[j]
          ? rows[i + 1]![j + 1]! + 1
          : Math.max(rows[i + 1]![j]!, rows[i]![j + 1]!);
  let i = 0,
    j = 0;
  while (i < a.length) {
    if (j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < b.length && rows[i]![j + 1]! > rows[i + 1]![j]!) j++;
    else {
      if (!allowed.has(i)) return true;
      i++;
    }
  }
  return false;
}

export function editText(
  original: string,
  edits: readonly ConfigTextEdit[],
): { text: string; formattingLost: boolean } {
  if (edits.length === 0) return { text: original, formattingLost: false };
  const input = original.replace(/\r\n/g, "\n");
  const doc = parseDocument(input);
  const allowed = new Set<number>();
  const line = (offset: number) =>
    input.slice(0, offset).split("\n").length - 1;
  // Capture ranges before mutation; deleting a pair includes its key and inline comment.
  for (const edit of edits) {
    const path = edit.from ?? edit.path;
    const node = doc.getIn(path, true);
    const parent = doc.getIn(path.slice(0, -1), true);
    const pair = isMap(parent)
      ? parent.items.find((p) => isScalar(p.key) && p.key.value === path.at(-1))
      : undefined;
    const start = isNode(pair?.key)
      ? pair.key.range?.[0]
      : isNode(node)
        ? node.range?.[0]
        : undefined;
    const valueEnd = isNode(node) ? node.range?.[1] : undefined;
    const end =
      valueEnd === undefined
        ? undefined
        : input[valueEnd - 1] === "\n"
          ? valueEnd
          : input.indexOf("\n", valueEnd) < 0
            ? input.length
            : input.indexOf("\n", valueEnd) + 1;
    if (start !== undefined && end !== undefined)
      for (let n = line(start); n <= line(Math.max(start, end - 1)); n++)
        allowed.add(n);
  }
  for (const edit of edits) {
    const previous = doc.getIn(edit.from ?? edit.path, true);
    if (edit.from) doc.deleteIn(edit.from);
    if (!Object.hasOwn(edit, "value")) {
      doc.deleteIn(edit.path);
      continue;
    }
    const node =
      edit.from &&
      isNode(previous) &&
      JSON.stringify(previous.toJSON()) === JSON.stringify(edit.value)
        ? previous
        : doc.createNode(edit.value);
    if (isNode(previous)) {
      if (previous.comment !== undefined) node.comment = previous.comment;
      if (previous.commentBefore !== undefined)
        node.commentBefore = previous.commentBefore;
      if (previous.spaceBefore !== undefined)
        node.spaceBefore = previous.spaceBefore;
      if (isScalar(previous) && isScalar(node) && previous.type !== undefined)
        node.type = previous.type;
    }
    // A bare `check:` is a scalar null, so replace scalar ancestors before setIn.
    for (let n = 1; n < edit.path.length; n++) {
      const path = edit.path.slice(0, n),
        old = doc.getIn(path, true);
      if (isScalar(old)) {
        const map = doc.createNode({});
        if (old.comment !== undefined) map.commentBefore = old.comment;
        doc.setIn(path, map);
      }
    }
    doc.setIn(edit.path, node);
  }
  const indent = /^ +(?![ #])/m.exec(input)?.[0].length ?? 2;
  let text = doc.toString({ indent, lineWidth: 0, collectionStyle: "any" });
  if (input.trim() === "") text = input + text;
  if (original.startsWith("\uFEFF")) text = "\uFEFF" + text;
  if (original.includes("\r\n")) text = text.replaceAll("\n", "\r\n");
  const formattingLost = lostLines(original, text, allowed);
  return { text, formattingLost };
}
