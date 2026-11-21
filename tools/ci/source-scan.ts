const scanners = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

/** Import specifiers of a code file, including `import type` (erased at run time, but still a leak). */
export function scanImports(
  file: { readonly path: string; readonly text: string },
  onNonliteral?: () => void,
): string[] {
  const found = new Set<string>();
  // Keep type-only dependencies visible in JavaScript-named inputs too.
  const loader = /\.[jt]sx$/.test(file.path) ? "tsx" : "ts";
  const source = file.text.replace(/^\uFEFF/, "").replace(/^#![^\r\n]*/, "");
  try {
    for (const entry of scanners[loader].scan(source).imports)
      found.add(entry.path);
  } catch (cause) {
    throw new Error(`Cannot parse ${file.path} for dependency scanning`, {
      cause,
    });
  }
  const typeImports =
    /^[ \t]*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm;
  for (const match of source.matchAll(typeImports)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  const withStrings = maskSource(source, false);
  const codeOnly = maskSource(source, true);
  const calls =
    /(?<![\w$.])(?:import|require)\s*\(\s*(?:["']([^"']+)["']\s*[,)]|)/g;
  for (const match of withStrings.matchAll(calls)) {
    if (codeOnly[match.index] !== match[0][0]) continue;
    if (match[1] === undefined) onNonliteral?.();
    else found.add(match[1]);
  }
  return [...found];
}

/** Blank out comments (and, when asked, string contents) so patterns match code only; positions and newlines are kept. */
export function maskSource(text: string, maskStrings: boolean): string {
  const out: string[] = [];
  const blank = (ch: string): string => (ch === "\n" || ch === "\r" ? ch : " ");
  const literal = (chars: string): string =>
    maskStrings ? [...chars].map(blank).join("") : chars;
  // Brace depth at each open `${`, so the template resumes at the matching `}`.
  const resume: number[] = [];
  let depth = 0;
  let inTemplate = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (inTemplate) {
      if (ch === "\\") {
        out.push(literal(ch + next));
        i += 2;
      } else if (ch === "`") {
        out.push(ch);
        inTemplate = false;
        i += 1;
      } else if (ch === "$" && next === "{") {
        out.push("${");
        resume.push(depth);
        depth += 1;
        inTemplate = false;
        i += 2;
      } else {
        out.push(literal(ch));
        i += 1;
      }
    } else if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out.push([...text.slice(i, stop)].map(blank).join(""));
      i = stop;
    } else if (ch === "'" || ch === '"') {
      out.push(ch);
      i += 1;
      while (i < n && text[i] !== ch && text[i] !== "\n") {
        const escaped = text[i] === "\\" && i + 1 < n;
        out.push(
          literal(
            escaped ? (text[i] ?? "") + (text[i + 1] ?? "") : (text[i] ?? ""),
          ),
        );
        i += escaped ? 2 : 1;
      }
      if (text[i] === ch) {
        out.push(ch);
        i += 1;
      }
    } else if (ch === "`") {
      out.push(ch);
      inTemplate = true;
      i += 1;
    } else {
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (resume[resume.length - 1] === depth) {
          resume.pop();
          inTemplate = true;
        }
      }
      out.push(ch);
      i += 1;
    }
  }
  return out.join("");
}

function blank(text: string, from: number, to: number): string {
  return text.slice(from, to).replace(/[^\n]/g, " ");
}

/** Index just past the template literal whose opening backtick is at `start`. */
function templateEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== "`") {
    if (text[i] === "\\") {
      i += 2;
    } else if (text[i] === "$" && text[i + 1] === "{") {
      let depth = 0;
      for (; i < text.length; i += 1) {
        if (text[i] === "{") depth += 1;
        if (text[i] === "}" && --depth === 0) break;
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  return i + 1;
}

/** Same text with comment and string contents blanked, so scanning sees only code. */
export function maskLiterals(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    let end = i;
    if (ch === "/" && next === "/") {
      end = text.indexOf("\n", i);
      if (end === -1) end = text.length;
    } else if (ch === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2);
      end = close === -1 ? text.length : close + 2;
    } else if (ch === '"' || ch === "'") {
      end = i + 1;
      while (end < text.length && text[end] !== ch && text[end] !== "\n") {
        end += text[end] === "\\" ? 2 : 1;
      }
      end += 1;
    } else if (ch === "`") {
      end = templateEnd(text, i);
    }
    if (end > i) {
      out += blank(text, i, Math.min(end, text.length));
      i = end;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

const PROCESS_CALL =
  /\b(?:spawn|spawnSync|execSync|execFile|execFileSync|fork|createProcessPort|listRepoFiles)\s*\(|(?<![\w.])exec\s*\(|\bBun\.spawn(?:Sync)?\s*\(/;

export function processCall(text: string): RegExpExecArray | null {
  return PROCESS_CALL.exec(maskLiterals(text));
}
