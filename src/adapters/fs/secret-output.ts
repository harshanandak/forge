export const MAX_BYTES: number = 8 * 1024 * 1024;
const sensitiveName =
  /(?:^|[_\-\s])(?:authorization|proxy.authorization|cookie|set.cookie|secret|token|password|passwd|credential|api.?key|access.?key|private.?key|database.?url|dsn)(?:$|[_\-\s])|(?:access|refresh|id|auth|bearer)token|clientsecret|(?:api|access|private)key|databaseurl/i;
const assignmentName =
  /(?:^|[_-])(?:authorization|proxy-authorization|cookie|secret|token|password|passwd|credential|api[_-]?key|access[_-]?key|private[_-]?key|database[_-]?url|dsn)(?=$|[_-])/gi;

function isSensitiveAssignmentName(name: string): boolean {
  if (name.endsWith("-")) return false;
  const lastDoubleHyphen = name.lastIndexOf("--");
  for (const match of name.matchAll(assignmentName)) {
    const suffixStart = match.index + match[0].length;
    const validSuffix =
      suffixStart === name.length ||
      (suffixStart + 1 < name.length && name[suffixStart + 1] !== "-");
    if (suffixStart > lastDoubleHyphen && validSuffix) return true;
  }
  return false;
}

function redactAssignments(text: string): string {
  const names = /[\w-]+/g;
  const value =
    /((?:\\*["'])?\s*[:=]\s*)(?:bearer\s+|basic\s+)?(?:\[REDACTED\](?=$|[\s,;}])|\\+["'][^\r\n]*|"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}\]]+)/iy;
  const parts: string[] = [];
  let copied = 0;
  for (let match = names.exec(text); match; match = names.exec(text)) {
    if (!isSensitiveAssignmentName(match[0])) continue;
    value.lastIndex = names.lastIndex;
    const assigned = value.exec(text);
    if (!assigned) continue;
    const assignedValue = assigned[0].slice(assigned[1]!.length);
    parts.push(
      text.slice(copied, assigned.index),
      assigned[1]!,
      /^(["']?)(?:(?:bearer|basic)\s+)?\[REDACTED\]\1$/i.test(assignedValue)
        ? assignedValue
        : "[REDACTED]",
    );
    copied = value.lastIndex;
    names.lastIndex = copied;
  }
  parts.push(text.slice(copied));
  return parts.join("");
}

function keySeparators(json: string): number {
  let count = 0;
  for (const token of json.matchAll(/"(?:\\.|[^"\\])*"|:/g))
    if (token[0] === ":") count += 1;
  return count;
}

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
  const unescaped = known
    .map((form) => form.replace(/\\/g, ""))
    .filter((form) => form.length > 0);
  const exposed = (text: string): boolean => {
    const flat = text.replace(/\\/g, "");
    return (
      unescaped.some((form) => flat.includes(form)) ||
      percentPatterns.some((pattern) => text.search(pattern) !== -1)
    );
  };

  const scrub = (text: string, depth = 0): string => {
    if (depth > 40) throw new Error("Protected output nesting limit");
    if (known.includes(text)) return "[REDACTED]";
    let parsed: unknown;
    let keys = -1;
    try {
      parsed = JSON.parse(text, function (this: unknown, _, value: unknown) {
        if (!Array.isArray(this)) keys += 1;
        return value;
      });
    } catch {
      parsed = undefined;
    }
    if (
      typeof parsed === "string" ||
      (parsed !== null && typeof parsed === "object")
    ) {
      if (keys !== keySeparators(text)) return "[REDACTED]";
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
    return redactAssignments(result)
      .replace(
        /\b(?:bearer|basic)\s+(?!\[REDACTED\](?![^\s,"';}\]]))[^\s,"';}\]]+/gi,
        "[REDACTED]",
      )
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
    return exposed(text) ? "[REDACTED]" : scrub(text);
  };
}
