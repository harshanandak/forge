// Document nodes identify values; CST tokens retain every untouched byte, including CRLF.
import {
  Composer,
  CST,
  isMap,
  isNode,
  isScalar,
  isSeq,
  Parser,
  parseDocument,
  stringify,
  type Node,
} from "yaml";
import { jsonEqual } from "../../contract/schema.ts";
import { isObject } from "../../core/config/pointer.ts";

interface Layout {
  readonly newline: string;
  readonly step: number;
  readonly replaced: Array<readonly [number, number, number]>;
}

function comments(value: unknown): Array<{ offset: number; source: string }> {
  if (Array.isArray(value)) return value.flatMap(comments);
  if (!isObject(value)) return [];
  if (
    value.type === "comment" &&
    typeof value.offset === "number" &&
    typeof value.source === "string"
  )
    return [{ offset: value.offset, source: value.source }];
  return Object.values(value).flatMap(comments);
}

function tokenFor(
  value: unknown,
  indent: number,
  flow: boolean,
  layout: Layout,
): CST.Token {
  const text = stringify(value, {
    lineWidth: 0,
    indent: layout.step,
    ...(flow ? { collectionStyle: "flow" as const } : {}),
  });
  const padded = text
    .split("\n")
    .map((line) => (line ? " ".repeat(indent) + line : line))
    .join("\n");
  const token = parseDocument(padded.replaceAll("\n", layout.newline), {
    keepSourceTokens: true,
  }).contents?.srcToken;
  if (token === undefined) throw new Error("YAML value has no source token");
  return token;
}

function update(
  node: Node | null,
  value: unknown,
  indent: number,
  flow: boolean,
  layout: Layout,
): CST.Token {
  const token = node?.srcToken;
  if (token === undefined || node === null)
    return tokenFor(value, indent, true, layout);
  const before: unknown = node.toJSON();
  if (jsonEqual(before, value)) return token;
  if (
    isMap(node) &&
    isObject(value) &&
    (token.type === "block-map" || token.type === "flow-collection")
  ) {
    const items: CST.CollectionItem[] = [];
    const seen = new Set<string>();
    let carried: CST.SourceToken[] = [];
    for (const [index, pair] of node.items.entries()) {
      const item = token.items[index];
      if (item === undefined || !isScalar(pair.key)) continue;
      const key = String(pair.key.value);
      seen.add(key);
      if (!Object.hasOwn(value, key)) {
        for (const child of [pair.key, pair.value])
          if (isNode(child) && child.range) layout.replaced.push(child.range);
        // Standalone comments describe the surrounding file, not a deleted value.
        const start = [...item.start];
        if (start.at(-1)?.type === "space") start.pop();
        carried.push(...start.filter((part) => part.type !== "comma"));
        continue;
      }
      item.start = [...carried, ...item.start];
      carried = [];
      if (!item.value && value[key] === null) {
        items.push(item);
        continue;
      }
      if (!item.value && token.type === "block-map") {
        const childIndent = token.indent + layout.step;
        item.value = tokenFor(value[key], childIndent, false, layout);
        item.sep ??= [];
        while (item.sep.at(-1)?.type === "space") item.sep.pop();
        if (!item.sep.some((part) => part.type === "newline"))
          item.sep.push({
            type: "newline",
            offset: 0,
            indent: childIndent,
            source: layout.newline,
          });
        item.sep.push({
          type: "space",
          offset: 0,
          indent: childIndent,
          source: " ".repeat(childIndent),
        });
      } else
        item.value = update(
          isNode(pair.value) ? pair.value : null,
          value[key],
          token.indent + layout.step,
          token.type === "flow-collection",
          layout,
        );
      items.push(item);
    }
    for (const [key, child] of Object.entries(value)) {
      if (seen.has(key)) continue;
      const generated = tokenFor(
        { [key]: child },
        token.indent,
        token.type === "flow-collection",
        layout,
      );
      if (
        generated.type !== "block-map" &&
        generated.type !== "flow-collection"
      )
        continue;
      const item = generated.items[0];
      if (item === undefined) continue;
      item.start = [
        ...carried,
        {
          type: "space",
          offset: 0,
          indent: token.indent,
          source: " ".repeat(token.indent),
        },
      ];
      carried = [];
      if (token.type === "flow-collection") {
        item.start = items.length
          ? [
              { type: "comma", offset: 0, indent: token.indent, source: "," },
              { type: "space", offset: 0, indent: token.indent, source: " " },
            ]
          : [];
      } else {
        const last = items.at(-1);
        if (last && !CST.stringify(last).endsWith("\n"))
          item.start.unshift({
            type: "newline",
            offset: 0,
            indent: token.indent,
            source: layout.newline,
          });
      }
      items.push(item);
    }
    if (token.type === "flow-collection") {
      const first = items[0];
      if (first)
        first.start = first.start.filter((part) => part.type !== "comma");
      token.items = [...items, ...token.items.slice(node.items.length)];
      token.end.unshift(...carried);
    } else {
      if (items.length === 0) return tokenFor({}, indent, true, layout);
      if (items[0] !== token.items[0] && items[0]?.start[0]?.type === "space")
        items[0].start.shift();
      token.items = [
        ...items.filter(
          (
            item,
          ): item is CST.CollectionItem & {
            key: CST.Token | null;
            sep: CST.SourceToken[];
          } => item.key !== undefined && item.sep !== undefined,
        ),
        ...token.items.slice(node.items.length),
      ];
      if (carried.length) token.items.push({ start: carried });
    }
    return token;
  }
  if (
    isSeq(node) &&
    Array.isArray(value) &&
    value.length > 0 &&
    (token.type === "block-seq" || token.type === "flow-collection")
  ) {
    const previous = node.items.map((child): unknown =>
      isNode(child) ? child.toJSON() : child,
    );
    // Positional reuse would attach a removed or moved item's comments to another value.
    if (
      value.length < previous.length ||
      value.some(
        (child, index) =>
          !jsonEqual(previous[index], child) &&
          previous.some((old) => jsonEqual(old, child)),
      )
    ) {
      if (node.range) layout.replaced.push(node.range);
      return tokenFor(
        value,
        token.indent,
        token.type === "flow-collection",
        layout,
      );
    }
    const items: CST.CollectionItem[] = [];
    for (const [index, child] of value.entries()) {
      const item = token.items[index];
      const old = node.items[index];
      if (index < node.items.length && item) {
        item.value = update(
          isNode(old) ? old : null,
          child,
          token.indent + layout.step,
          token.type === "flow-collection",
          layout,
        );
        items.push(item);
      } else {
        const generated = tokenFor(
          [child],
          token.indent,
          token.type === "flow-collection",
          layout,
        );
        if (
          generated.type !== "block-seq" &&
          generated.type !== "flow-collection"
        )
          continue;
        const added = generated.items[0];
        if (!added) continue;
        if (token.type === "flow-collection") {
          added.start = [
            { type: "comma", offset: 0, indent: token.indent, source: ", " },
          ];
          const last = items.at(-1)?.value;
          if (
            last &&
            "end" in last &&
            last.end?.every((part) => part.type === "space")
          )
            last.end = [];
        } else {
          added.start.unshift({
            type: "space",
            offset: 0,
            indent: token.indent,
            source: " ".repeat(token.indent),
          });
          const last = items.at(-1);
          if (last && !CST.stringify(last).endsWith("\n"))
            added.start.unshift({
              type: "newline",
              offset: 0,
              indent: token.indent,
              source: layout.newline,
            });
        }
        items.push(added);
      }
    }
    token.items = [...items, ...token.items.slice(node.items.length)];
    return token;
  }
  if (isScalar(node) && CST.isScalar(token) && typeof value === "string") {
    const safe = parseDocument(stringify(value)).contents;
    const type =
      node.type !== undefined && node.type !== "PLAIN"
        ? node.type
        : isScalar(safe)
          ? safe.type
          : undefined;
    const originalIndent = token.indent;
    token.indent = indent;
    CST.setScalarValue(token, value, {
      ...(type === undefined ? {} : { type }),
      inFlow: flow,
    });
    token.indent = originalIndent;
    token.source = token.source.replace(/\r?\n/g, layout.newline);
    return token;
  }
  const replacement = tokenFor(value, indent, true, layout);
  if (node.range) layout.replaced.push(node.range);
  if ("end" in replacement) {
    const closing = (part: CST.SourceToken): boolean =>
      part.type === "flow-map-end" || part.type === "flow-seq-end";
    const trailing =
      token.type === "block-scalar"
        ? token.props.filter(
            (part): part is CST.SourceToken =>
              part.type === "space" ||
              part.type === "comment" ||
              part.type === "newline",
          )
        : "end" in token
          ? (token.end ?? []).filter((part) => !closing(part))
          : flow
            ? []
            : undefined;
    if (trailing !== undefined)
      replacement.end = [
        ...(replacement.end ?? []).filter(closing),
        ...trailing,
      ];
  }
  return replacement;
}

export function editYaml(text: string, value: unknown): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const tokens = [...new Parser().parse(text)];
  const originalComments = comments(tokens);
  const [document] = new Composer({
    keepSourceTokens: true,
    version: "1.2",
    schema: "core",
  }).compose(tokens);
  const source = tokens.find((token) => token.type === "document");
  if (document === undefined || source?.type !== "document")
    return (
      text +
      (text === "" || text.endsWith("\n") ? "" : newline) +
      stringify(value).replaceAll("\n", newline)
    );
  const indents = [...text.matchAll(/^ +(?=\S)/gm)].map(
    (match) => match[0].length,
  );
  const layout: Layout = {
    newline,
    step: indents.length ? Math.min(...indents) : 2,
    replaced: [],
  };
  source.value = update(document.contents, value, 0, false, layout);
  const result = tokens.map((token) => CST.stringify(token)).join("");
  const checked = parseDocument(result, { version: "1.2", schema: "core" });
  if (
    checked.errors.length ||
    !jsonEqual(checked.toJS({ maxAliasCount: 0 }), value)
  )
    throw new Error("edited YAML does not match the planned values");
  const retained = new Map<string, number>();
  for (const comment of comments([...new Parser().parse(result)]))
    retained.set(comment.source, (retained.get(comment.source) ?? 0) + 1);
  for (const comment of originalComments) {
    if (
      layout.replaced.some(
        ([start, , end]) => comment.offset >= start && comment.offset < end,
      )
    )
      continue;
    const count = retained.get(comment.source) ?? 0;
    if (count === 0)
      throw new Error("edited YAML lost a comment outside a replaced value");
    retained.set(comment.source, count - 1);
  }
  return result;
}
