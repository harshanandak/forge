// Shape detection over TOML text, not a TOML parser: enough to see which tables and simple string
// values a manifest declares. Anything it cannot read plainly is reported as absent, never guessed.

/** The lines of one `[table]` (exact name or a dotted sub-table), without the header. */
export function tomlTable(text: string, table: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inside = false;
  for (const raw of lines) {
    const line = raw.trim();
    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header !== null) {
      const name = (header[1] as string).replace(/\s+/g, "");
      inside = name === table || name.startsWith(`${table}.`);
      continue;
    }
    if (inside) out.push(raw);
  }
  return out;
}

export function hasTomlTable(text: string, table: string): boolean {
  return new RegExp(
    `^\\s*\\[\\[?\\s*${table.replace(/\./g, "\\s*\\.\\s*")}(?:\\s*\\.[^\\]]*)?\\s*\\]\\]?`,
    "m",
  ).test(text);
}

/** `key = "value"` or `key = 'value'` inside one table. */
export function tomlString(
  text: string,
  table: string,
  key: string,
): string | undefined {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  for (const line of tomlTable(text, table)) {
    const match = pattern.exec(line);
    if (match !== null) return match[1] ?? match[2];
  }
  return undefined;
}
