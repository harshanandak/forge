export const MAX_BYTES: number = 8 * 1024 * 1024;
const sensitiveName =
  /(?:^|[_\-\s])(?:authorization|proxy.authorization|cookie|set.cookie|secret|token|password|passwd|credential|api.?key|access.?key|private.?key|database.?url|dsn)(?:$|[_\-\s])|(?:access|refresh|id|auth|bearer)token|clientsecret|(?:api|access|private)key|databaseurl/i;
const assignment =
  /(\b(?:[\w-]*_)?(?:authorization|proxy-authorization|cookie|secret|token|password|passwd|credential|api[_-]?key|access[_-]?key|private[_-]?key|database[_-]?url|dsn)(?:[_-]\w+)*\b(?:\\*["'])?\s*[:=]\s*)(?:bearer\s+|basic\s+)?(?:\\+["'][^\r\n]*|"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}\]]+)/gi;

export function createOutputGate(
  values: readonly unknown[] = [],
): (text: string) => string {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== "string")
  )
    throw new Error("Invalid credential registration");
  const representations = new Set<string>();
  const percentPatterns: RegExp[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !value) continue;
    const encoded = encodeURIComponent(value);
    const base64 = Buffer.from(value).toString("base64");
    const formEncoded = new URLSearchParams({ value }).toString().slice(6);
    for (const form of [
      value,
      JSON.stringify(value).slice(1, -1),
      encoded,
      encoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
      formEncoded,
      formEncoded.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()),
      base64,
      base64.replace(/=+$/, ""),
      Buffer.from(value).toString("base64url"),
    ])
      representations.add(form);
    if (encoded.includes("%")) {
      const pattern = encoded
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(
          /%([0-9A-F]{2})/g,
          (_, hex: string) =>
            `%${hex.replace(/[A-F]/g, (letter) => `[${letter}${letter.toLowerCase()}]`)}`,
        );
      percentPatterns.push(new RegExp(pattern, "g"));
    }
  }
  const known = [...representations].sort((a, b) => b.length - a.length);

  const scrub = (text: string, depth = 0): string => {
    if (depth > 40) throw new Error("Protected output nesting limit");
    if (known.includes(text)) return "[REDACTED]";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (
      typeof parsed === "string" ||
      (parsed !== null && typeof parsed === "object")
    ) {
      const visit = (value: unknown, level: number): unknown => {
        if (level > 40) throw new Error("Protected output nesting limit");
        if (typeof value === "string") return scrub(value, level + 1);
        if (Array.isArray(value))
          return value.map((item) => visit(item, level + 1));
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
              scrub(key, level + 1),
              sensitiveName.test(key) ? "[REDACTED]" : visit(item, level + 1),
            ]),
          );
        return known.includes(String(value)) ? "[REDACTED]" : value;
      };
      if (typeof parsed !== "string")
        return JSON.stringify(visit(parsed, depth + 1));
      return JSON.stringify(scrub(parsed, depth + 1));
    }
    let result = text;
    for (const value of known) result = result.split(value).join("[REDACTED]");
    for (const pattern of percentPatterns)
      result = result.replace(pattern, "[REDACTED]");
    return result
      .replace(assignment, "$1[REDACTED]")
      .replace(/\b(?:bearer|basic)\s+[^\s,"';}\]]+/gi, "[REDACTED]")
      .replace(
        /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi,
        "[REDACTED]",
      )
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
      .replace(
        /\b(?:gh[pousr]|github_pat|glpat|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g,
        "[REDACTED]",
      )
      .replace(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
        "[REDACTED]",
      )
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
        "[REDACTED]",
      );
  };

  return (text: string): string => {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES)
      throw new Error("Protected output size limit");
    return scrub(text);
  };
}
