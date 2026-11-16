import tracker from "../../../schemas/tracker.json" with { type: "json" };

/** Preserve whole list entries; the omission marker and prefix share the schema's body budget. */
export function formatComment(
  base: string,
  entries: readonly string[],
): string {
  const limit = tracker.$defs.CommentInput.properties.body.maxLength;
  const length = (text: string) => Array.from(text).length;
  const prefix = Array.from(base);
  const sizes = entries.map(length);
  if (
    prefix.length +
      sizes.reduce((n, size) => n + size, 0) +
      Math.max(0, entries.length - 1) <=
    limit
  )
    return base + entries.join("\n");
  const marker = (omitted: number) =>
    `\n[Note shortened; ${omitted} retained commits omitted]`;
  const body = prefix
    .slice(0, Math.max(0, limit - marker(entries.length).length))
    .join("");
  let used = length(body),
    kept = 0;
  for (const size of sizes) {
    const extra = size + (kept ? 1 : 0);
    if (used + extra + marker(entries.length - kept - 1).length > limit) break;
    used += extra;
    kept++;
  }
  return (
    body + entries.slice(0, kept).join("\n") + marker(entries.length - kept)
  );
}
