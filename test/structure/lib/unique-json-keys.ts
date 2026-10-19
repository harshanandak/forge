/** Validate JSON without allowing a later object member to hide an earlier one. */
export function parseJsonWithUniqueKeys(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const objects: (Set<string> | undefined)[] = [];

  // JSON.parse validates the grammar; retain the original tokens to inspect keys
  // before duplicate members disappear from the resulting object.
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}]|\[|\]/g)) {
    const token = match[0];
    if (token === "{" || token === "[") {
      objects.push(token === "{" ? new Set<string>() : undefined);
    } else if (token === "}" || token === "]") {
      objects.pop();
    } else if (/^\s*:/.test(text.slice(match.index + token.length))) {
      const key: unknown = JSON.parse(token);
      const keys = objects.at(-1);
      if (typeof key !== "string" || keys === undefined) {
        throw new SyntaxError("Object key outside an object");
      }
      if (keys.has(key)) {
        const line = text.slice(0, match.index).split("\n").length;
        throw new SyntaxError(
          `Duplicate JSON key ${JSON.stringify(key)} at line ${line}`,
        );
      }
      keys.add(key);
    }
  }
  return value;
}
