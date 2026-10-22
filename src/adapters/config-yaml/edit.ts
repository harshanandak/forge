import { isMap, isNode, isScalar, parseDocument } from "yaml";
import type { ConfigTextEdit } from "../../ports/config-codec.ts";

/** Protected lines must survive in order, including repeated lines and their endings. */
function lostLines(
  before: string,
  after: string,
  allowed: ReadonlySet<number>,
): boolean {
  const a = before.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [],
    b = after.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    if (allowed.has(i)) continue;
    while (j < b.length && a[i] !== b[j]) j++;
    if (j === b.length) return true;
    j++;
  }
  return false;
}

export function editText(
  original: string,
  edits: readonly ConfigTextEdit[],
): { text: string; formattingLost: boolean } {
  if (edits.length === 0) return { text: original, formattingLost: false };
  const input = original.replace(/\r\n|\r/g, "\n");
  const doc = parseDocument(input);
  const allowed = new Set<number>();
  const lineStarts = [0];
  for (let i = 0; i < input.length; i++)
    if (input[i] === "\n") lineStarts.push(i + 1);
  const line = (offset: number) => {
    let low = 0,
      high = lineStarts.length;
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (lineStarts[mid]! <= offset) low = mid;
      else high = mid;
    }
    return low;
  };
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
    if (start !== undefined && end !== undefined) {
      const last = line(Math.max(start, end - 1));
      for (let n = line(start); n <= last; n++) allowed.add(n);
    }
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
  else if (original.includes("\r")) text = text.replaceAll("\n", "\r");
  const formattingLost = lostLines(original, text, allowed);
  return { text, formattingLost };
}
