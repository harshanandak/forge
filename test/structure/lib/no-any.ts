import type { SourceFile, Violation } from "./repo.ts";

interface Token {
  readonly text: string;
  readonly offset: number;
}

export function isTypeScriptFile(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/.test(path);
}

export function isAnyScanFile(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    isTypeScriptFile(normalized) && /^(?:src|test|tools)\//.test(normalized)
  );
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  const code = (templateExpression = false): void => {
    let braces = 0;
    while (offset < text.length) {
      const char = text[offset]!;
      if (/\s/.test(char)) {
        offset++;
      } else if (text.startsWith("//", offset)) {
        offset = text.indexOf("\n", offset + 2);
        if (offset < 0) offset = text.length;
      } else if (text.startsWith("/*", offset)) {
        const end = text.indexOf("*/", offset + 2);
        offset = end < 0 ? text.length : end + 2;
      } else if (char === "'" || char === '"') {
        offset = skipQuoted(text, offset, char);
      } else if (char === "`") {
        template();
      } else if (char === "}" && templateExpression && braces === 0) {
        offset++;
        return;
      } else if (char === "{") {
        braces++;
        tokens.push({ text: char, offset: offset++ });
      } else if (char === "}") {
        braces--;
        tokens.push({ text: char, offset: offset++ });
      } else if (/[A-Za-z_$]/.test(char)) {
        const start = offset++;
        while (offset < text.length && /[\w$]/.test(text[offset]!)) offset++;
        tokens.push({ text: text.slice(start, offset), offset: start });
      } else if (char === "/" && canStartRegex(tokens)) {
        offset = skipRegex(text, offset);
      } else {
        tokens.push({ text: char, offset: offset++ });
      }
    }
  };
  const template = (): void => {
    offset++;
    while (offset < text.length) {
      if (text[offset] === "\\") offset += 2;
      else if (text[offset] === "`") {
        offset++;
        return;
      } else if (text.startsWith("${", offset)) {
        offset += 2;
        code(true);
      } else offset++;
    }
  };
  code();
  return tokens;
}

function skipQuoted(text: string, start: number, quote: string): number {
  let offset = start + 1;
  while (offset < text.length) {
    if (text[offset] === "\\") offset += 2;
    else if (text[offset++] === quote) break;
  }
  return offset;
}

function canStartRegex(tokens: readonly Token[]): boolean {
  const previous = tokens.at(-1)?.text;
  return (
    previous === undefined ||
    /^[([{,:;=!?&|+*%^~<>-]$/.test(previous) ||
    /^(?:return|case|throw|delete|void|typeof|yield|await|in|of|instanceof)$/.test(
      previous,
    )
  );
}

function skipRegex(text: string, start: number): number {
  let offset = start + 1;
  let inClass = false;
  while (offset < text.length && text[offset] !== "\n") {
    const char = text[offset++]!;
    if (char === "\\") offset++;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) break;
  }
  while (/[A-Za-z]/.test(text[offset] ?? "")) offset++;
  return offset;
}

export function findAnyTypeViolations(
  files: readonly SourceFile[],
): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    if (!isAnyScanFile(file.path)) continue;
    const tokens = tokenize(file.text);
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      if (token.text !== "any") continue;
      const previous = tokens[index - 1]?.text;
      const next = tokens[index + 1]?.text;
      const typed =
        previous === ":" ||
        previous === "as" ||
        (next === "[" && tokens[index + 2]?.text === "]") ||
        (previous === "<" && next === ">");
      if (!typed) continue;
      violations.push({
        rule: "no-any",
        file: file.path,
        line: file.text.slice(0, token.offset).split("\n").length,
        message:
          "Use unknown at a boundary and narrow it, or use a precise type.",
      });
    }
  }
  return violations;
}
